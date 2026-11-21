/// <reference path="../node_modules/@jsquash/avif/emscripten-types.d.ts" />

import { formats } from "./shared.js";

let avifEncoder: ReturnType<typeof loadAvifEncoder> | undefined;

async function loadAvifEncoder() {
  // Load the single-threaded encoder without requiring cross-origin isolation.
  const path = "./vendor/avif/";
  const { default: createEncoder } = await import(`${path}avif_enc.js`) as typeof import("@jsquash/avif/codec/enc/avif_enc.js");
  const { defaultOptions } = await import(`${path}meta.js`) as typeof import("@jsquash/avif/meta.js");
  return { encoder: await createEncoder(), options: { ...defaultOptions, quality: 90, qualityAlpha: 100 } };
}

export async function encodeAvif({ data, width, height }: ImageData): Promise<Blob> {
  const { encoder, options } = await (avifEncoder ??= loadAvifEncoder());
  const bytes = encoder.encode(data, width, height, options);
  if (!bytes) throw new Error("AVIFで画像を書き出せませんでした。");
  return new Blob([new Uint8Array(bytes)], { type: formats.avif.mime });
}

export function encodeBmp({ data, width, height }: ImageData): Blob {
  const stride = Math.ceil(width * 3 / 4) * 4;
  const pixelOffset = 54;
  const bytes = new Uint8Array(pixelOffset + stride * height);
  const header = new DataView(bytes.buffer);
  bytes.set([0x42, 0x4d]);
  header.setUint32(2, bytes.length, true);
  header.setUint32(10, pixelOffset, true);
  header.setUint32(14, 40, true); // BITMAPINFOHEADER size
  header.setInt32(18, width, true);
  header.setInt32(22, height, true);
  header.setUint16(26, 1, true); // color planes
  header.setUint16(28, 24, true);
  header.setUint32(34, stride * height, true);

  for (let y = 0; y < height; y++) {
    let target = pixelOffset + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4;
      bytes[target++] = data[source + 2];
      bytes[target++] = data[source + 1];
      bytes[target++] = data[source];
    }
  }
  return new Blob([bytes], { type: formats.bmp.mime });
}

export function encodeNuv(context: CanvasRenderingContext2D): Blob {
  const { width, height } = context.canvas;
  const frameWidth = Math.ceil(width / 2) * 2;
  const frameHeight = Math.ceil(height / 2) * 2;
  const lumaSize = frameWidth * frameHeight;
  const frameSize = lumaSize * 3 / 2;
  // NUV readers use a 24-bit packet size.
  if (frameSize > 0xffffff) throw new Error("画像が大きすぎてNUVで保存できません。");

  const { data } = context.getImageData(0, 0, frameWidth, frameHeight);
  const frame = new Uint8ClampedArray(frameSize);
  const chromaBlue = frame.subarray(lumaSize, lumaSize * 5 / 4);
  const chromaRed = frame.subarray(lumaSize * 5 / 4);
  // YUV 4:2:0 stores one chroma sample for each 2×2 block.
  for (let y = 0; y < frameHeight; y += 2) {
    for (let x = 0; x < frameWidth; x += 2) {
      let red = 0, green = 0, blue = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const pixel = (y + dy) * frameWidth + x + dx;
          const source = pixel * 4;
          // getImageData returns transparent black for padding outside the canvas.
          const white = 255 - data[source + 3];
          const r = data[source] + white;
          const g = data[source + 1] + white;
          const b = data[source + 2] + white;
          frame[pixel] = 16 + (65.481 * r + 128.553 * g + 24.966 * b) / 255;
          red += r;
          green += g;
          blue += b;
        }
      }
      const sample = y / 2 * (frameWidth / 2) + x / 2;
      // Padded pixels share chroma with the image edge. Use neutral chroma to keep the padding white.
      if (x + 1 === width || y + 1 === height) {
        chromaBlue[sample] = 128;
        chromaRed[sample] = 128;
        continue;
      }
      chromaBlue[sample] = 128 + (-37.797 * red - 74.203 * green + 112 * blue) / 1020;
      chromaRed[sample] = 128 + (112 * red - 93.786 * green - 18.214 * blue) / 1020;
    }
  }

  const fileHeader = new Uint8Array(72);
  const header = new DataView(fileHeader.buffer);
  const ascii = new TextEncoder();
  fileHeader.set(ascii.encode("NuppelVideo\0" + "0.05"));
  header.setUint32(20, frameWidth, true);
  header.setUint32(24, frameHeight, true);
  fileHeader.set(ascii.encode("P"), 36);
  // Some readers interpret an aspect ratio of 1 as the legacy 4:3 default.
  header.setFloat64(40, frameWidth === frameHeight ? 0 : frameWidth / frameHeight, true);
  header.setFloat64(48, 1, true);
  header.setUint32(56, 1, true);
  header.setUint32(68, 1, true);

  const codecHeader = new Uint8Array(12);
  // Readers look for this packet before reading video frames. Raw YUV has no codec data.
  codecHeader.set(ascii.encode("DR"));
  const frameHeader = new Uint8Array(12);
  frameHeader.set(ascii.encode("V0"));
  new DataView(frameHeader.buffer).setUint32(8, frameSize, true);
  return new Blob([fileHeader, codecHeader, frameHeader, frame], { type: formats.nuv.mime });
}
