import { base64Key, errorText, formats, getFormatSettings, settingsKey } from "./shared.js";

const list = document.querySelector<HTMLDivElement>("#formats")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const icon = document.querySelector<HTMLButtonElement>("#brand-icon")!;
let iconPresses = 0;

async function render() {
  const { available, quick } = await getFormatSettings();
  list.replaceChildren();
  for (const format of available) {
    const title = formats[format];
    const label = document.createElement("label");
    label.className = "check-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = format;
    input.checked = quick.includes(format);
    const name = document.createElement("span");
    name.textContent = title.label;
    label.append(input, name);
    if ("extension" in title) {
      const suffix = document.createElement("span");
      suffix.className = "suffix";
      suffix.setAttribute("aria-hidden", "true");
      suffix.textContent = "." + title.extension;
      label.append(suffix);
    }
    list.append(label);
  }
}

icon.addEventListener("click", () => {
  if (++iconPresses < 7) return;
  iconPresses = 0;
  icon.disabled = true;
  void (async () => {
    const { available, quick } = await getFormatSettings();
    const enabled = !available.includes("base64");
    if (enabled) {
      await chrome.storage.local.set({ [base64Key]: true });
    } else {
      await chrome.storage.local.set({ [base64Key]: false, [settingsKey]: quick.filter(format => format !== "base64") });
    }
    await render();
    status.textContent = enabled ? "Base64を表示しました。" : "Base64を非表示にしました。";
    status.hidden = false;
  })().catch(showError).finally(() => {
    icon.disabled = false;
    icon.focus();
  });
});

list.addEventListener("change", () => {
  const quick = Array.from(list.querySelectorAll<HTMLInputElement>("input:checked"), input => input.value);
  void chrome.storage.local.set({ [settingsKey]: quick }).then(() => {
    status.hidden = true;
  }, showError);
});

function showError(error: unknown) {
  status.textContent = "設定を保存できませんでした。 " + errorText(error);
  status.hidden = false;
}

void render().catch(showError);
