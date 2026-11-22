export const formats = {
  original: { label: "元の形式", description: "画像データをそのまま保存" },
  png: { label: "PNG", mime: "image/png", extension: "png", description: "透過を保持" },
  jpeg: { label: "JPEG", mime: "image/jpeg", extension: "jpg", description: "写真向け・透過部分は白" },
  gif: { label: "GIF", mime: "image/gif", extension: "gif", description: "最大256色・透過は1ビット" },
  webp: { label: "WebP", mime: "image/webp", extension: "webp", description: "透過を保持" },
  avif: { label: "AVIF", mime: "image/avif", extension: "avif", description: "透過を保持" },
  bmp: { label: "BMP", mime: "image/bmp", extension: "bmp", description: "透過部分は白" },
  tiff: { label: "TIFF", mime: "image/tiff", extension: "tiff", description: "透過を保持・無圧縮" },
  nuv: { label: "NUV", mime: "video/x-nuppelvideo", extension: "nuv", description: "1フレームの動画・透過部分は白" },
  pdf: { label: "PDF", mime: "application/pdf", extension: "pdf", description: "画像を1ページに保存" },
  base64: { label: "Base64", extension: "base64.txt", description: "画像データをBase64のテキストで保存" },
} as const;

export type Format = keyof typeof formats;
export const formatIds = Object.keys(formats) as Format[];
export const settingsKey = "quickFormats";
// Keep the existing storage key so Base64 stays enabled for users who unlocked it.
export const hiddenFormatsKey = "base64Enabled";
export const defaultQuick = ["png", "jpeg", "gif"] as const;

export function isFormat(value: unknown): value is Format {
  return typeof value === "string" && Object.hasOwn(formats, value);
}

export function isHiddenFormat(format: Format): boolean {
  return format === "base64" || format === "nuv";
}

export async function getFormatSettings() {
  const { quickFormats, [hiddenFormatsKey]: hiddenFormatsEnabled } = await chrome.storage.local.get([settingsKey, hiddenFormatsKey]);
  const available = formatIds.filter(format => !isHiddenFormat(format) || hiddenFormatsEnabled === true);
  const saved: readonly unknown[] = Array.isArray(quickFormats) ? quickFormats : defaultQuick;
  return { available, quick: available.filter(format => saved.includes(format)) };
}

export interface Source {
  url: string;
  name?: string;
}

export interface View {
  tabId: number;
  windowId: number;
  frameId: number;
  pageUrl?: string;
}

export interface Asset {
  id: string;
  preview: string;
  name: string;
  extension: string;
  animated: boolean;
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Crop {
  asset: Asset;
  width: number;
  height: number;
}

export interface PickResult {
  candidates?: Source[];
  materialized?: Source;
  error?: string;
  canceled?: boolean;
}

export type Mode = Format | "other" | "all";

export interface SaveJob {
  view: View;
  mode: Mode;
  tabId?: number;
  asset?: Asset;
  crop?: Crop;
  candidates?: Source[];
  source?: Source;
  issue?: string;
  permission?: string;
}

export type OffscreenRequest =
  | { action: "prepare"; source: Source }
  | { action: "encode"; id: string; format: Format }
  | { action: "crop"; id: string; rect: PixelRect }
  | { action: "drop"; ids: string[] }
  | { action: "revoke"; url: string };

export interface Download {
  url: string;
  filename: string;
}

export type WorkbenchRequest =
  | { action: "read" | "capture" | "retry"; id: string }
  | { action: "source"; id: string; index: number }
  | { action: "crop"; id: string; rect: PixelRect }
  | { action: "save"; id: string; format: Format };

export type Reply<T> = { value: T } | { error: string };

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function unwrap<T>(reply: Reply<T>): T {
  if ("error" in reply) throw new Error(reply.error);
  return reply.value;
}

export function sitePattern(url: string): string | undefined {
  const parsed = new URL(url);
  if (parsed.protocol === "https:" || parsed.protocol === "http:") {
    return `${parsed.protocol}//${parsed.hostname}/*`;
  }
}
