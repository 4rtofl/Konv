import {
  errorText, formats, getFormatSettings, hiddenFormatsKey, isFormat, unwrap,
  type Asset, type Crop, type PixelRect, type Reply, type SaveJob, type WorkbenchRequest,
} from "./shared.js";

const id = location.hash.slice(1);
const title = document.querySelector<HTMLHeadingElement>("#title")!;
const content = document.querySelector<HTMLDivElement>("#content")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const errorBox = document.querySelector<HTMLParagraphElement>("#error")!;
let busy = false;
let displayedJob: SaveJob | undefined;

async function send<T>(request: WorkbenchRequest): Promise<T> {
  return unwrap(await chrome.runtime.sendMessage({ channel: "workbench", request }) as Reply<T>);
}

function showError(message?: string) {
  errorBox.textContent = message ?? "";
  errorBox.hidden = !message;
}

function showStatus(message = "") {
  status.textContent = message;
  status.hidden = !message;
}

function setBusy(value: boolean) {
  busy = value;
  content.setAttribute("aria-busy", String(value));
  for (const button of content.querySelectorAll("button")) button.disabled = value;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = ""): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = text;
  if (cls) element.className = cls;
  return element;
}

function action(label: string, callback: () => Promise<void>, primary = false) {
  const button = node("button", label, primary ? "primary" : "");
  button.type = "button";
  button.addEventListener("click", () => void run(callback));
  return button;
}

async function run(callback: () => Promise<void>) {
  if (busy) return;
  setBusy(true);
  showError();
  showStatus("処理中…");
  try {
    await callback();
  } catch (error) {
    showError(errorText(error));
    showStatus();
  } finally {
    setBusy(false);
  }
}

async function update(request: WorkbenchRequest) {
  await render(await send<SaveJob>(request));
  title.focus();
}

function addChoice(field: HTMLFieldSetElement, value: string, label: string, description: string, checked: boolean) {
  const row = node("label", "", "choice");
  const radio = node("input");
  radio.type = "radio";
  radio.name = "choice";
  radio.value = value;
  radio.checked = checked;
  const text = node("span", label);
  if (description) text.append(node("small", description));
  row.append(radio, text);
  field.append(row);
}

function choiceForm(label: string, choices: { value: string; label: string; description: string }[], cta: string,
  callback: (value: string) => Promise<void>) {
  const form = node("form");
  const field = node("fieldset", "", "surface");
  field.append(node("legend", label));
  choices.forEach((choice, index) => addChoice(field, choice.value, choice.label, choice.description, index === 0));
  const submit = node("button", cta, "primary");
  submit.type = "submit";
  const actions = node("div", "", "actions");
  actions.append(submit);
  form.append(field, actions);
  form.addEventListener("submit", event => {
    event.preventDefault();
    const value = new FormData(form).get("choice");
    if (typeof value === "string") void run(() => callback(value));
  });
  return form;
}

function preview(asset: Asset) {
  const card = node("div", "", "surface card preview");
  const image = node("img");
  image.src = asset.preview;
  image.alt = "";
  const info = node("div");
  info.append(node("strong", `${asset.name}.${asset.extension}`));
  if (asset.animated) info.append(node("p", "アニメーションGIF", "muted"));
  card.append(image, info);
  return card;
}

function renderFormats(job: SaveJob, asset: Asset, { available, quick }: Awaited<ReturnType<typeof getFormatSettings>>) {
  const choicesForAsset = available.filter(format =>
    (!asset.animated || format === "original" || format === "base64")
      && (job.mode !== "other" || !quick.includes(format)));
  content.append(preview(asset));
  if (!choicesForAsset.length) {
    content.append(node("p", "この画像に使える形式は右クリックメニューに表示されています。",
    "surface card"));
    return;
  }
  const choices = choicesForAsset.map(format => ({
    value: format,
    label: format === "original" ? `元の形式（${asset.extension.toUpperCase()}）` : formats[format].label,
    description: formats[format].description,
  }));
  content.append(choiceForm("形式", choices, "保存…", async value => {
    if (!isFormat(value)) return;
    const started = await send<boolean>({ action: "save", id, format: value });
    showStatus(started ? "保存を開始しました。" : "保存をキャンセルしました。");
  }));
}

function renderCrop(crop: Crop) {
  const { width, height } = crop;
  const image = node("img");
  image.src = crop.asset.preview;
  image.alt = "表示中だったタブ";
  image.draggable = false;
  const stage = node("div", "", "crop-stage");
  const box = node("div", "", "crop-box");
  stage.append(image, box);
  const figure = node("div", "", "surface card capture");
  const details = node("details", "", "crop-fields");
  const fields = node("div", "", "coords");
  details.append(node("summary", "座標で範囲を調整"), fields);
  const labels = { x: "左端", y: "上端", width: "幅", height: "高さ" };
  const axes = Object.keys(labels) as (keyof PixelRect)[];
  const inputs = new Map<keyof PixelRect, HTMLInputElement>();
  const dimensions = node("p", "", "muted detail");
  const full = { x: 0, y: 0, width, height };
  let rect = { ...full };
  let anchor: { x: number; y: number } | undefined;

  for (const key of axes) {
    const label = node("label", labels[key]);
    const input = node("input");
    input.type = "number";
    input.step = "1";
    input.min = key === "width" || key === "height" ? "1" : "0";
    input.value = String(rect[key]);
    input.addEventListener("change", () => {
      if (Number.isInteger(input.valueAsNumber)) rect[key] = input.valueAsNumber;
      rect.x = Math.max(0, Math.min(width - 1, rect.x));
      rect.y = Math.max(0, Math.min(height - 1, rect.y));
      rect.width = Math.max(1, Math.min(width - rect.x, rect.width));
      rect.height = Math.max(1, Math.min(height - rect.y, rect.height));
      draw();
    });
    inputs.set(key, input);
    label.append(input);
    fields.append(label);
  }
  function draw() {
    box.style.left = `${100 * rect.x / width}%`;
    box.style.top = `${100 * rect.y / height}%`;
    box.style.width = `${100 * rect.width / width}%`;
    box.style.height = `${100 * rect.height / height}%`;
    dimensions.textContent = `${rect.width} × ${rect.height} px`;
    for (const [key, input] of inputs) input.value = String(rect[key]);
  }
  function point(event: PointerEvent) {
    const area = image.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(width, Math.round((event.clientX - area.left) * width / area.width))),
      y: Math.max(0, Math.min(height, Math.round((event.clientY - area.top) * height / area.height))),
    };
  }
  function drag(event: PointerEvent) {
    if (!anchor) return;
    const end = point(event);
    const x = Math.min(width - 1, anchor.x, end.x);
    const y = Math.min(height - 1, anchor.y, end.y);
    rect = { x, y, width: Math.max(1, Math.max(anchor.x, end.x) - x),
      height: Math.max(1, Math.max(anchor.y, end.y) - y) };
    draw();
  }
  stage.addEventListener("pointerdown", event => {
    if (event.button !== 0 || busy) return;
    anchor = point(event);
    stage.setPointerCapture(event.pointerId);
    drag(event);
  });
  stage.addEventListener("pointermove", drag);
  stage.addEventListener("pointerup", event => { drag(event); anchor = undefined; });
  stage.addEventListener("pointercancel", () => { anchor = undefined; });
  figure.append(stage, dimensions, details);
  const controls = node("div", "", "actions");
  controls.append(
    action("選んだ範囲を使う", () => update({ action: "crop", id, rect }), true),
    action("全体を選択", async () => { rect = { ...full }; draw(); showStatus(); }),
  );
  content.append(node("p", "画像の上をドラッグして保存する範囲を選べます。", "muted"), figure, controls);
  draw();
}

async function render(job: SaveJob) {
  displayedJob = job;
  const settings = job.asset ? await getFormatSettings() : undefined;
  if (displayedJob !== job) return;
  content.replaceChildren();
  showStatus();
  showError(job.issue);
  title.textContent = job.crop ? "表示範囲を選ぶ" : job.mode === "other" && job.asset
    ? "その他の形式" : job.candidates ? "画像を選ぶ" : "画像を保存";
  if (job.crop) {
    renderCrop(job.crop);
    return;
  }
  if (job.asset && settings) {
    renderFormats(job, job.asset, settings);
    return;
  }
  if (job.candidates) {
    const choices = job.candidates.map(({ url }, index) => {
      const parsed = new URL(url);
      let label = parsed.pathname.split("/").pop() || "";
      try { label = decodeURIComponent(label); } catch { /* keep the URL spelling */ }
      if (!/^https?:$/.test(parsed.protocol) || !label) label = `背景画像 ${index + 1}`;
      return { value: String(index), label, description: parsed.hostname };
    });
    content.append(choiceForm("背景画像", choices, "画像を選ぶ", value =>
      update({ action: "source", id, index: Number(value) })));
  }
  if (job.issue || job.permission) {
    const actions = node("div", "", "actions");
    if (job.permission) {
      const origin = job.permission;
      const host = new URL(origin).hostname;
      actions.append(action(`${host} へのアクセスを許可…`, async () => {
        const granted = await chrome.permissions.request({ origins: [origin] });
        if (!granted) throw new Error("アクセスを許可しませんでした。表示範囲の保存を試せます。");
        await update({ action: "retry", id });
      }, !job.candidates));
    }
    actions.append(action("表示範囲を保存…", () => update({ action: "capture", id })));
    content.append(actions);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && hiddenFormatsKey in changes && displayedJob?.asset) {
    void render(displayedJob).then(() => setBusy(busy), error => showError(errorText(error)));
  }
});

void send<SaveJob>({ action: "read", id }).then(render).catch(error => {
  showStatus();
  showError(errorText(error));
});
