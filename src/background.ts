import { installPicker } from "./picker.js";
import {
  base64Key, errorText, formatIds, formats, getFormatSettings, isFormat, settingsKey, sitePattern, unwrap,
  type Asset, type Crop, type Download, type Format, type Mode, type OffscreenRequest,
  type PickResult, type Reply, type SaveJob, type Source, type View, type WorkbenchRequest,
} from "./shared.js";

const menuRoot = "save-image";
const menuPick = "pick-element";
const menuCapture = "capture-area";
const menuOther = "other";
const formatsDivider = "formats-divider";
const pagePatterns = ["http://*/*", "https://*/*", "file:///*"];
const workbenchUrl = chrome.runtime.getURL("save.html");
const offscreenUrl = chrome.runtime.getURL("offscreen.html");
const jobKey = (id: string) => `job:${id}`;
const tabKey = (id: number) => `workbench:${id}`;
const pickerKey = (tabId: number, frameId: number) => `picker:${tabId}:${frameId}`;
const downloadKey = (id: number) => `download:${id}`;

const session = chrome.storage.session;
let menuWork = Promise.resolve();
let offscreenOpening: Promise<void> | undefined;

function createItem(properties: chrome.contextMenus.CreateProperties): Promise<void> {
  return new Promise((resolve, reject) => chrome.contextMenus.create(properties, () => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message));
    else resolve();
  }));
}

async function registerMenu() {
  await chrome.contextMenus.removeAll();
  const { available, quick } = await getFormatSettings();
  await createItem({ id: menuRoot, title: "画像を任意の形式で保存", contexts: ["all"], documentUrlPatterns: pagePatterns });
  await createItem({ id: menuPick, parentId: menuRoot, title: "ページ上の対象を選ぶ…", contexts: ["all"] });
  await createItem({ id: menuCapture, parentId: menuRoot, title: "表示範囲を保存…", contexts: ["all"] });
  await createItem({ id: formatsDivider, parentId: menuRoot, type: "separator", contexts: ["image"] });
  for (const format of formatIds) {
    await createItem({
      id: format, parentId: menuRoot, title: formats[format].label, contexts: ["image"],
      visible: quick.includes(format),
    });
  }
  await createItem({ id: menuOther, parentId: menuRoot, title: "その他の形式…",
    contexts: ["image"], enabled: quick.length < available.length });
}

async function updateMenu() {
  const { available, quick } = await getFormatSettings();
  await Promise.all([
    ...formatIds.map(format => chrome.contextMenus.update(format, { visible: quick.includes(format) })),
    chrome.contextMenus.update(menuOther, { enabled: quick.length < available.length }),
  ]);
}

function queueMenu(operation: () => Promise<void>) {
  menuWork = menuWork.then(operation).catch(error => console.error("メニューを更新できませんでした。", error));
}

chrome.runtime.onInstalled.addListener(() => queueMenu(registerMenu));
chrome.runtime.onStartup.addListener(() => queueMenu(registerMenu));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (settingsKey in changes || base64Key in changes)) queueMenu(updateMenu);
});

async function ensureOffscreen() {
  offscreenOpening ??= (async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [offscreenUrl],
    });
    if (!contexts.length) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html", reasons: [chrome.offscreen.Reason.BLOBS],
        justification: "選んだ画像の検査・変換とダウンロード用Blob URLの保持",
      });
    }
  })().finally(() => { offscreenOpening = undefined; });
  await offscreenOpening;
}

class ImageAccessError extends Error {}

async function offscreen<T>(request: OffscreenRequest, capture = false, credentialed = false): Promise<T> {
  await ensureOffscreen();
  const reply = await chrome.runtime.sendMessage({ channel: "offscreen", request, capture, credentialed }) as
    Reply<T> & { access?: boolean };
  if ("error" in reply && reply.access) throw new ImageAccessError(reply.error);
  return unwrap(reply);
}

async function dropAssets(...assets: (Asset | undefined)[]) {
  const ids = assets.flatMap(asset => asset ? [asset.id] : []);
  if (ids.length) await offscreen({ action: "drop", ids });
}

// Serialized into the selected frame so blob: URLs and same-origin cookies are available.
async function readFromFrame(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { credentials: "same-origin", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (blob.size > 39 * 1024 * 1024) return null;
    const image = blob.type.startsWith("image/") ? blob : blob.slice(0, blob.size, "image/octet-stream");
    return await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(image);
    });
  } catch {
    return null;
  }
}

async function verifyPage(view: View) {
  const tab = await chrome.tabs.get(view.tabId);
  const stripHash = (url: string) => url.split("#")[0];
  if (tab.windowId !== view.windowId || (view.pageUrl && (!tab.url
      || stripHash(tab.url) !== stripHash(view.pageUrl)))) {
    throw new Error("元のページが移動しました。ページから画像を選び直してください。");
  }
  return tab;
}

async function pageData(view: View, url: string): Promise<string | null> {
  try {
    await verifyPage(view);
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: view.tabId, frameIds: [view.frameId] },
      func: readFromFrame, args: [url],
    });
    return result?.result ?? null;
  } catch {
    return null;
  }
}

function sourceName(source: Source): string | undefined {
  if (source.name) return source.name;
  if (!/^https?:/i.test(source.url)) return undefined;
  const tail = new URL(source.url).pathname.split("/").pop();
  try { return tail ? decodeURIComponent(tail) : undefined; } catch { return tail; }
}

async function prepare(view: View, source: Source): Promise<Asset> {
  const pattern = sitePattern(source.url);
  if (source.url.startsWith("blob:")) {
    const data = await pageData(view, source.url);
    if (!data) throw new Error("ページ内の画像データを取得できませんでした。");
    return offscreen({ action: "prepare", source: { url: data, name: source.name } });
  }
  const sameHost = pattern && view.pageUrl && new URL(source.url).origin === new URL(view.pageUrl).origin;
  if (sameHost) {
    const data = await pageData(view, source.url);
    if (data) return offscreen({ action: "prepare", source: { url: data, name: sourceName(source) } });
  }
  const allowed = pattern && await chrome.permissions.contains({ origins: [pattern] });
  try {
    return await offscreen({ action: "prepare", source }, false, Boolean(allowed));
  } catch (error) {
    if (!(error instanceof ImageAccessError) || !pattern || sameHost || allowed) throw error;
    const data = await pageData(view, source.url);
    if (!data) throw error;
    return offscreen({ action: "prepare", source: { url: data, name: sourceName(source) } });
  }
}

async function fillJob(job: SaveJob, source: Source): Promise<SaveJob> {
  const next = { view: job.view, mode: job.mode, tabId: job.tabId };
  try {
    return { ...next, asset: await prepare(job.view, source) };
  } catch (error) {
    const origin = error instanceof ImageAccessError ? sitePattern(source.url) : undefined;
    const permission = origin && !await chrome.permissions.contains({ origins: [origin] }) ? origin : undefined;
    return { ...next, issue: errorText(error), permission, source: permission ? source : undefined };
  }
}

async function cleanupDownload(id: number) {
  const key = downloadKey(id);
  const { [key]: url } = await session.get(key);
  if (typeof url !== "string") return;
  await session.remove(key);
  await offscreen({ action: "revoke", url });
}

chrome.downloads.onChanged.addListener(change => {
  if (change.state?.current === "complete" || change.state?.current === "interrupted") {
    void cleanupDownload(change.id).catch(console.error);
  }
});

async function download(asset: Asset, format: Format) {
  if (format === "base64" && !(await getFormatSettings()).available.includes(format)) {
    throw new Error("Base64は現在非表示です。");
  }
  const result = await offscreen<Download>({ action: "encode", id: asset.id, format });
  let id: number;
  try {
    id = await chrome.downloads.download({
      url: result.url, filename: result.filename, saveAs: true, conflictAction: "uniquify",
    });
  } catch (error) {
    await offscreen({ action: "revoke", url: result.url });
    if (/cancel|USER_CANCELED/i.test(errorText(error))) return false;
    throw error;
  }
  await session.set({ [downloadKey(id)]: result.url });
  const [item] = await chrome.downloads.search({ id });
  if (!item || item.state !== "in_progress") await cleanupDownload(id);
  return item?.error !== "USER_CANCELED";
}

async function openJob(job: SaveJob) {
  const id = crypto.randomUUID();
  await session.set({ [jobKey(id)]: job });
  try {
    const tab = await chrome.tabs.create({ url: `${workbenchUrl}#${id}`, windowId: job.view.windowId });
    if (tab.id !== undefined) await session.set({ [tabKey(tab.id)]: id });
  } catch (error) {
    await session.remove(jobKey(id));
    await dropAssets(job.asset, job.crop?.asset);
    throw error;
  }
}

chrome.tabs.onRemoved.addListener(tabId => {
  void (async () => {
    const key = tabKey(tabId);
    const { [key]: id } = await session.get(key);
    if (typeof id !== "string") return;
    const { [jobKey(id)]: job } = await session.get(jobKey(id)) as Record<string, SaveJob>;
    await session.remove([key, jobKey(id)]);
    if (job) await dropAssets(job.asset, job.crop?.asset);
  })().catch(console.error);
});

async function selectSource(view: View, source: Source, mode: Mode) {
  const job = await fillJob({ view, mode }, source);
  if (job.asset && isFormat(mode)) {
    try {
      await download(job.asset, mode);
      await dropAssets(job.asset);
      return;
    } catch (error) {
      job.issue = errorText(error);
      job.mode = "all";
    }
  }
  await openJob(job);
}

async function capture(view: View, workbenchTab?: number): Promise<Crop> {
  await verifyPage(view);
  try {
    if (workbenchTab !== undefined) await chrome.tabs.update(view.tabId, { active: true });
    const active = await verifyPage(view);
    if (!active.active) throw new Error("元のタブを表示してから範囲を保存してください。");
    const url = await chrome.tabs.captureVisibleTab(view.windowId, { format: "png" });
    if (!(await verifyPage(view)).active) throw new Error("表示するタブが変わったため、取り込みを中止しました。");
    return await offscreen({ action: "prepare", source: { url, name: "capture.png" } }, true);
  } finally {
    if (workbenchTab !== undefined) await chrome.tabs.update(workbenchTab, { active: true }).catch(() => {});
  }
}

async function onMenu(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) {
  if (tab?.id === undefined) return;
  const view = { tabId: tab.id, windowId: tab.windowId, frameId: info.frameId ?? 0, pageUrl: tab.url ?? info.pageUrl };
  const id = info.menuItemId;
  if (id === menuPick) {
    const key = pickerKey(view.tabId, view.frameId);
    const token = crypto.randomUUID();
    await session.set({ [key]: { token, view } });
    try {
      await chrome.scripting.executeScript({
        target: { tabId: view.tabId, frameIds: [view.frameId] }, func: installPicker, args: [token],
      });
    } catch {
      await session.remove(key);
      await openJob({ view, mode: "all", issue: "このページでは要素を選べません。表示範囲の保存を試せます。" });
    }
  } else if (id === menuCapture) {
    try {
      await openJob({ view, mode: "all", crop: await capture(view) });
    } catch (error) {
      await openJob({ view, mode: "all", issue: errorText(error) });
    }
  } else if (info.srcUrl && (id === menuOther || isFormat(id))) {
    await selectSource(view, { url: info.srcUrl }, id);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void onMenu(info, tab).catch(console.error);
});

async function onPick(id: string, result: PickResult, sender: chrome.runtime.MessageSender) {
  if (sender.tab?.id === undefined || sender.frameId === undefined) return;
  const key = pickerKey(sender.tab.id, sender.frameId);
  const { [key]: pending } = await session.get(key) as Record<string, { token: string; view: View }>;
  if (pending?.token !== id) return;
  await session.remove(key);
  if (result.canceled) return;
  const view = pending.view;
  if (result.materialized) await selectSource(view, result.materialized, "all");
  else if (result.candidates?.length === 1) await selectSource(view, result.candidates[0], "all");
  else await openJob({ view, mode: "all", candidates: result.candidates, issue: result.error });
}

async function onWorkbench(request: WorkbenchRequest, tabId?: number) {
  const key = jobKey(request.id);
  const { [key]: saved } = await session.get(key) as Record<string, SaveJob>;
  if (!saved) throw new Error("保存する画像が見つかりません。ページから選び直してください。");
  const job = { ...saved, tabId };
  let next: SaveJob;
  switch (request.action) {
    case "read":
      return job;
    case "source": {
      const source = job.candidates?.[request.index];
      if (!source) throw new Error("画像を選び直してください。");
      next = await fillJob(job, source);
      if (next.issue) next.candidates = job.candidates;
      break;
    }
    case "retry":
      if (!job.source) throw new Error("元画像を選び直してください。");
      next = await fillJob(job, job.source);
      if (next.issue) next.candidates = job.candidates;
      if (next.asset && isFormat(next.mode)) {
        try { await download(next.asset, next.mode); }
        catch (error) { next.issue = errorText(error); next.mode = "all"; }
      }
      break;
    case "capture": {
      const crop = await capture(job.view, job.tabId);
      await dropAssets(job.crop?.asset, job.asset);
      next = { view: job.view, tabId, mode: "all", crop };
      break;
    }
    case "crop": {
      if (!job.crop) throw new Error("表示範囲を選び直してください。");
      const asset = await offscreen<Asset>({ action: "crop", id: job.crop.asset.id, rect: request.rect });
      await dropAssets(job.crop.asset);
      next = { view: job.view, tabId, mode: "all", asset };
      break;
    }
    case "save":
      if (!job.asset || !isFormat(request.format)) throw new Error("画像形式を選び直してください。");
      return download(job.asset, request.format);
  }
  await session.set({ [key]: next });
  return next;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.channel === "picker") {
    void onPick(message.id, message.result, sender).catch(console.error);
    return;
  }
  if (message?.channel !== "workbench" || !sender.url?.startsWith(workbenchUrl + "#")) return;
  const request = message.request as WorkbenchRequest;
  if (sender.url !== `${workbenchUrl}#${request.id}`) return;
  void onWorkbench(request, sender.tab?.id).then(value => respond({ value }),
    error => respond({ error: errorText(error) }));
  return true;
});
