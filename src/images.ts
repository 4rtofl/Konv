import { formats, type Download, type Format, type PixelRect } from "./shared.js";
import { encodeAvif, encodeBmp, encodeNuv, encodeTiff } from "./extra-formats.js";
import { applyPalette, GIFEncoder, quantize } from "./vendor/gifenc.esm.js";

declare const PDFLib: typeof import("pdf-lib");

const rasterTypes: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
};

const textDecoder = new TextDecoder();

function avifBrand(header: Uint8Array): "avif" | "avis" | undefined {
  if (header.length < 16 || textDecoder.decode(header.subarray(4, 8)) !== "ftyp") return;
  const boxLength = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0);
  const end = Math.min(boxLength, header.length);
  let still = false;
  for (let offset = 8; offset + 4 <= end; offset += 4) {
    if (offset === 12) continue;
    const brand = textDecoder.decode(header.subarray(offset, offset + 4));
    if (brand === "avis") return brand;
    if (brand === "avif") still = true;
  }
  if (still) return "avif";
}

export async function detectType(blob: Blob): Promise<string> {
  const header = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  const text = textDecoder.decode(header);
  if (header[0] === 0x89 && text.slice(1, 4) === "PNG") return "image/png";
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
  if (text.startsWith("GIF87a") || text.startsWith("GIF89a")) return "image/gif";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "image/webp";
  if (avifBrand(header)) return "image/avif";
  if (text.startsWith("BM")) return "image/bmp";
  if (text.startsWith("\0\0\u0001\0")) return "image/x-icon";
  if (text.startsWith("II*\0") || text.startsWith("MM\0*")) return "image/tiff";
  if (blob.type === "image/svg+xml" || /<(?:[\w.-]+:)?svg(?:\s|>)/i.test(text)) return "image/svg+xml";
  throw new Error("対応する画像ファイルを取得できませんでした。");
}

interface ImageTrackMetadata {
  frameCount: number;
}
interface ImageMetadataDecoder {
  completed: Promise<void>;
  tracks: { ready: Promise<void>; selectedTrack: ImageTrackMetadata | null };
  close(): void;
}
const MetadataDecoder = (globalThis as unknown as {
  ImageDecoder: new (init: { data: ReadableStream; type: string; preferAnimation: boolean }) => ImageMetadataDecoder;
}).ImageDecoder;

export async function isAnimated(blob: Blob, type: string): Promise<boolean> {
  if (type === "image/svg+xml") {
    const xml = new DOMParser().parseFromString(await blob.text(), "image/svg+xml");
    if (xml.documentElement.localName !== "svg" || xml.documentElement.namespaceURI !== "http://www.w3.org/2000/svg") {
      throw new Error("SVGの内容を読み込めませんでした。");
    }
    return Boolean(xml.querySelector("animate, animateMotion, animateTransform, set, discard"))
      || Array.from(xml.querySelectorAll("style, [style]"))
        .some(node => /animation(?:-[\w-]+)?\s*:|@(?:-webkit-)?keyframes\b/i.test(node.getAttribute("style") ?? node.textContent ?? ""));
  }
  if (type === "image/avif") {
    return avifBrand(new Uint8Array(await blob.slice(0, 4096).arrayBuffer())) === "avis";
  }
  if (!["image/gif", "image/png", "image/webp"].includes(type)) return false;

  const decoder = new MetadataDecoder({ data: blob.stream(), type, preferAnimation: true });
  try {
    await Promise.all([decoder.tracks.ready, decoder.completed]);
    const track = decoder.tracks.selectedTrack;
    if (!track) throw new Error("画像のフレーム情報を読み込めませんでした。");
    return track.frameCount > 1;
  } finally {
    decoder.close();
  }
}

export function fileInfo(type: string, url: string, preferred?: string) {
  const detected = rasterTypes[type];
  let name = preferred ?? "";
  if (!name && /^https?:/i.test(url)) {
    const segment = new URL(url).pathname.split("/").pop() ?? "";
    try { name = decodeURIComponent(segment); } catch { name = segment; }
  }
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+|[. ]+$/g, "");
  const dot = name.lastIndexOf(".");
  const suffix = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const extension = (suffix === detected || (detected === "jpg" && suffix === "jpeg")
    || (detected === "tiff" && suffix === "tif")) ? suffix : detected;
  const stem = (extension === suffix ? name.slice(0, dot) : name).slice(0, 100);
  return { name: stem || "image", extension };
}

export async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  // decode() can wait for a rendering update in a hidden extension document.
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("画像を読み込めませんでした。"));
    image.src = url;
  });
  if (!image.naturalWidth || !image.naturalHeight) throw new Error("画像サイズを読み込めませんでした。");
  return image;
}

function canvasFor(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasBlob(canvas: HTMLCanvasElement, mime: string): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (!blob || blob.type !== mime) {
      reject(new Error("選択した形式で画像を書き出せませんでした。画像サイズや形式を確認してください。"));
    } else {
      resolve(blob);
    }
  }, mime, 0.9));
}

async function singlePagePdf(canvas: HTMLCanvasElement): Promise<Blob> {
  const pdf = await PDFLib.PDFDocument.create();
  const png = await pdf.embedPng(await (await canvasBlob(canvas, "image/png")).arrayBuffer());
  const landscape = canvas.width > canvas.height;
  const [width, height] = landscape ? [841.89, 595.28] : [595.28, 841.89];
  const page = pdf.addPage([width, height]);
  const size = png.scaleToFit(width - 48, height - 48);
  page.drawImage(png, { ...size, x: (width - size.width) / 2, y: (height - size.height) / 2 });
  const bytes = new Uint8Array(await pdf.save());
  return new Blob([bytes], { type: formats.pdf.mime });
}

function encodeGif({ data, width, height }: ImageData): Blob {
  const transparent = data.some((value, index) => index % 4 === 3 && value < 128);
  let opaque = data;
  if (transparent) {
    opaque = new Uint8ClampedArray(data.length);
    let offset = 0;
    for (let source = 0; source < data.length; source += 4) {
      if (data[source + 3] < 128) continue;
      opaque[offset++] = data[source];
      opaque[offset++] = data[source + 1];
      opaque[offset++] = data[source + 2];
      opaque[offset++] = 255;
    }
    opaque = opaque.subarray(0, offset);
  }
  const palette = opaque.length ? quantize(opaque, transparent ? 255 : 256) : [];
  const opaquePixels = opaque.length ? applyPalette(opaque, palette) : new Uint8Array();
  let pixels = opaquePixels;
  const transparentIndex = palette.length;

  if (transparent) {
    palette.push([0, 0, 0]);
    pixels = new Uint8Array(width * height);
    let opaquePixel = 0;
    for (let pixel = 0; pixel < pixels.length; pixel++) {
      pixels[pixel] = data[pixel * 4 + 3] < 128 ? transparentIndex : opaquePixels[opaquePixel++];
    }
  }

  const gif = GIFEncoder();
  gif.writeFrame(pixels, width, height, { palette, transparent, transparentIndex });
  gif.finish();
  return new Blob([new Uint8Array(gif.bytes())], { type: formats.gif.mime });
}

export async function encodeImage(sourceUrl: string, format: Exclude<Format, "original" | "base64">): Promise<Blob> {
  const image = await loadImage(sourceUrl);
  if (format === "gif" && (image.naturalWidth > 0xffff || image.naturalHeight > 0xffff)) {
    throw new Error("GIFで保存できる画像の幅と高さは65,535ピクセルまでです。");
  }
  const canvas = canvasFor(image.naturalWidth, image.naturalHeight);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("画像を描画できませんでした。");
  if (format === "jpeg" || format === "bmp" || format === "nuv") {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(image, 0, 0);
  if (format === "gif") return encodeGif(context.getImageData(0, 0, canvas.width, canvas.height));
  if (format === "tiff") return encodeTiff(context.getImageData(0, 0, canvas.width, canvas.height));
  if (format === "nuv") return encodeNuv(context);
  if (format === "avif" || format === "bmp") {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    return format === "avif" ? encodeAvif(pixels) : encodeBmp(pixels);
  }
  return format === "pdf" ? singlePagePdf(canvas) : canvasBlob(canvas, formats[format].mime);
}

export async function encodeBase64(blob: Blob): Promise<Blob> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("画像をBase64に変換できませんでした。"));
    reader.readAsDataURL(blob);
  });
  return new Blob([dataUrl.slice(dataUrl.indexOf(",") + 1)], { type: "text/plain;charset=utf-8" });
}

export async function cropImage(sourceUrl: string, rect: PixelRect): Promise<Blob> {
  const image = await loadImage(sourceUrl);
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every(Number.isSafeInteger)
      || x < 0 || y < 0 || width < 1 || height < 1
      || x + width > image.naturalWidth || y + height > image.naturalHeight) {
    throw new Error("画像の内側に保存範囲を選んでください。");
  }
  const canvas = canvasFor(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("選んだ範囲を描画できませんでした。");
  context.drawImage(image, x, y, width, height, 0, 0, width, height);
  return canvasBlob(canvas, "image/png");
}

export function downloadFile(blob: Blob, stem: string, extension: string): Download {
  const name = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem) ? `_${stem}` : stem;
  return { url: URL.createObjectURL(blob), filename: `${name}.${extension}` };
}
