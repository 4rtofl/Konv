import { errorText, formats, type Asset, type OffscreenRequest, type Source } from "./shared.js";
import { cropImage, detectType, downloadFile, encodeBase64, encodeImage, fileInfo, isAnimated, loadImage } from "./images.js";

const assets = new Map<string, { asset: Asset; blob: Blob; timeout: number }>();
const assetLifetime = 30 * 60_000;

function dropAsset(id: string) {
  const entry = assets.get(id);
  if (!entry) return;
  clearTimeout(entry.timeout);
  URL.revokeObjectURL(entry.asset.preview);
  assets.delete(id);
}

function keepAsset(blob: Blob, name: string, extension: string, animated: boolean): Asset {
  const id = crypto.randomUUID();
  const asset = { id, preview: URL.createObjectURL(blob), name, extension, animated };
  assets.set(id, { asset, blob, timeout: window.setTimeout(() => dropAsset(id), assetLifetime) });
  return asset;
}

class ImageAccessError extends Error {}

async function prepare(source: Source, credentialed = false): Promise<Asset> {
  if (!/^(https?:\/\/|data:image\/)/i.test(source.url)) {
    throw new Error("この画像のURLを読み込めませんでした。");
  }
  let response: Response;
  try {
    response = await fetch(source.url, {
      credentials: credentialed ? "include" : "omit", signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ImageAccessError("配信元から画像を取得できませんでした。");
  }
  if (!response.ok) {
    const message = `画像の取得に失敗しました（HTTP ${response.status}）。`;
    if (response.status === 401 || response.status === 403) throw new ImageAccessError(message);
    throw new Error(message);
  }
  const raw = await response.blob();
  const type = await detectType(raw);
  const blob = raw.slice(0, raw.size, type);
  const animated = await isAnimated(blob, type);
  if (animated && type !== "image/gif") {
    throw new Error("アニメーション画像はGIFの元形式保存に対応しています。");
  }
  const filename = fileInfo(type, source.url, source.name);
  return keepAsset(blob, filename.name, filename.extension, animated);
}

async function process(request: OffscreenRequest, credentialed: boolean) {
  if (request.action === "drop") {
    request.ids.forEach(dropAsset);
    return;
  }
  if (request.action === "revoke") {
    URL.revokeObjectURL(request.url);
    return;
  }
  if (request.action === "prepare") return prepare(request.source, credentialed);

  const entry = assets.get(request.id);
  if (!entry) throw new Error("画像の保持時間が過ぎました。ページから選び直してください。");
  if (request.action === "crop") {
    return keepAsset(await cropImage(entry.asset.preview, request.rect), "capture", "png", false);
  }
  const { format } = request;
  if (format === "original") return downloadFile(entry.blob, entry.asset.name, entry.asset.extension);
  if (format === "base64") {
    return downloadFile(await encodeBase64(entry.blob), entry.asset.name, formats[format].extension);
  }
  if (format === "gif" && entry.blob.type === formats.gif.mime) {
    return downloadFile(entry.blob, entry.asset.name, formats.gif.extension);
  }
  if (entry.asset.animated) throw new Error("アニメーションGIFは「GIF」または「元の形式」で保存してください。");
  const converted = await encodeImage(entry.asset.preview, format);
  return downloadFile(converted, entry.asset.name, formats[format].extension);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.channel !== "offscreen" || sender.id !== chrome.runtime.id) return;
  const request = message.request as OffscreenRequest;
  const result = request.action === "prepare" && message.capture
    ? prepare(request.source).then(async asset => {
      const image = await loadImage(asset.preview);
      return { asset, width: image.naturalWidth, height: image.naturalHeight };
    })
    : process(request, message.credentialed === true);
  void result.then(value => respond({ value: value ?? null }), error => respond({ error: errorText(error), access: error instanceof ImageAccessError }));
  return true;
});
