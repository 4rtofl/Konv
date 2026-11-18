import type { PickResult, Source } from "./shared.js";

// This runs in the selected frame via executeScript, so it cannot use module bindings.
export function installPicker(id: string) {
  document.querySelector("[data-siaaf-picker]")?.dispatchEvent(new Event("siaaf-close"));
  const host = document.createElement("div");
  host.dataset.siaafPicker = "";
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;display:block;cursor:crosshair";
  const shadow = host.attachShadow({ mode: "closed" });
  const toolbar = document.createElement("div");
  toolbar.style.cssText = "position:absolute;left:50%;top:16px;transform:translateX(-50%);display:flex;align-items:center;gap:12px;max-width:calc(100% - 32px);width:max-content;padding:8px 12px;border-radius:12px;background:#171721;color:#ededf3;font:14px/1.5 system-ui,sans-serif";
  const instruction = document.createElement("span");
  instruction.textContent = "保存する画像・背景・SVG・Canvasをクリック";
  const cancel = document.createElement("button");
  cancel.textContent = "キャンセル";
  cancel.type = "button";
  cancel.style.cssText = "padding:4px 12px;border:1px solid #70707d;border-radius:32px;background:#272735;color:inherit;font:inherit;cursor:pointer";
  const highlight = document.createElement("div");
  highlight.style.cssText = "display:none;pointer-events:none;position:fixed;box-sizing:border-box;outline:2px solid #6a7cf5;background:#5266eb26";
  toolbar.append(instruction, cancel);
  shadow.append(highlight, toolbar);
  const before = document.activeElement;

  let finished = false;
  function finish(result: PickResult) {
    if (finished) return;
    finished = true;
    document.removeEventListener("keydown", onKey, true);
    host.remove();
    if (before instanceof HTMLElement) before.focus({ preventScroll: true });
    void chrome.runtime.sendMessage({ channel: "picker", id, result }).catch(() => {});
  }

  function onKey(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    finish({ canceled: true });
  }

  function backgrounds(element: Element): Source[] {
    const result: Source[] = [];
    const seen = new Set<string>();
    for (const pseudo of [null, "::before", "::after"]) {
      const value = getComputedStyle(element, pseudo).backgroundImage;
      for (const match of value.matchAll(/url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*))\s*\)/gi)) {
        const raw = match[1] ?? match[2] ?? match[3].trim();
        try {
          const url = new URL(raw.replace(/\\(["'\\ ])/g, "$1"), document.baseURI).href;
          if (!/^(https?:\/\/|data:image\/|blob:)/i.test(url) || seen.has(url)) continue;
          seen.add(url);
          result.push({ url });
        } catch {
          continue;
        }
      }
    }
    return result;
  }

  function targetAt(x: number, y: number) {
    for (let node = document.elementsFromPoint(x, y).find(element => element !== host) ?? null;
      node; node = node.parentElement) {
      if (node instanceof HTMLVideoElement || node instanceof HTMLAudioElement) return;
      if (node instanceof HTMLImageElement && (node.currentSrc || node.src)) {
        return { node, candidates: [{ url: node.currentSrc || node.src }] };
      }
      if (node instanceof SVGSVGElement || node instanceof HTMLCanvasElement) return { node };
      const candidates = backgrounds(node);
      if (candidates.length) return { node, candidates };
    }
  }

  function materializeSvg(svg: SVGSVGElement): Source {
    if (svg.getAnimations({ subtree: true }).length ||
      svg.querySelector("animate, animateMotion, animateTransform, set, discard")) {
      throw new Error("静止SVGを選んでください。");
    }
    const copy = svg.cloneNode(true) as SVGSVGElement;
    const sourceNodes = [svg, ...svg.querySelectorAll("*")];
    const copyNodes = [copy, ...copy.querySelectorAll("*")];
    const svgIds = new Set(sourceNodes.map(node => node.id).filter(Boolean));
    const externalReference = "外部の素材を参照するSVGです。表示範囲を保存できます。";
    const current = new URL(document.URL);

    function keepLocalUrls(value: string) {
      return value.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (_match, double, single, plain) => {
        const url = (double ?? single ?? plain).trim();
        const parsed = new URL(url, document.baseURI);
        const sameDocument = parsed.origin === current.origin && parsed.pathname === current.pathname
          && parsed.search === current.search;
        const fragment = url.startsWith("#") ? url : sameDocument ? parsed.hash : "";
        if (!svgIds.has(fragment.slice(1))) throw new Error(externalReference);
        return `url(${fragment})`;
      });
    }

    const styling = ["color", "display", "visibility", "fill", "fill-opacity", "fill-rule",
      "stroke", "stroke-opacity", "stroke-width", "stroke-linecap", "stroke-linejoin",
      "stroke-dasharray", "stroke-dashoffset", "opacity", "font-family", "font-size",
      "font-weight", "text-anchor", "stop-color", "stop-opacity", "clip-path", "filter",
      "marker-start", "marker-mid", "marker-end", "paint-order", "vector-effect"];
    for (const [index, original] of sourceNodes.entries()) {
      const clone = copyNodes[index];
      if (/^(script|style|foreignObject)$/i.test(clone.localName)) {
        if (clone.localName === "foreignObject") throw new Error("HTMLを含むSVGです。表示範囲を保存できます。");
        clone.remove();
        continue;
      }
      const computed = getComputedStyle(original);
      for (const attr of Array.from(clone.attributes)) {
        if (/^on/i.test(attr.localName) || attr.name === "style" || attr.name === "xml:base") {
          clone.removeAttributeNode(attr);
          continue;
        }
        if (attr.localName === "href") {
          if (clone.localName === "a") clone.removeAttributeNode(attr);
          else if (!attr.value.startsWith("#") || !svgIds.has(attr.value.slice(1))) {
            throw new Error(externalReference);
          }
        } else {
          attr.value = keepLocalUrls(attr.value);
        }
      }
      if (clone instanceof SVGElement) {
        for (const property of styling) {
          const value = keepLocalUrls(computed.getPropertyValue(property));
          if (value) clone.style.setProperty(property, value);
        }
      }
    }
    const rect = svg.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      copy.setAttribute("width", String(rect.width));
      copy.setAttribute("height", String(rect.height));
    }
    const xml = new XMLSerializer().serializeToString(copy);
    return { url: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml), name: "image.svg" };
  }

  host.addEventListener("siaaf-close", () => finish({ canceled: true }), { once: true });
  toolbar.addEventListener("click", event => event.stopPropagation());
  cancel.addEventListener("click", () => finish({ canceled: true }));
  host.addEventListener("pointermove", event => {
    const target = targetAt(event.clientX, event.clientY)?.node;
    highlight.style.display = target ? "block" : "none";
    if (!target) return;
    const rect = target.getBoundingClientRect();
    highlight.style.left = `${rect.left}px`;
    highlight.style.top = `${rect.top}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
  });
  host.addEventListener("click", event => {
    if (event.composedPath().includes(toolbar)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    const target = targetAt(event.clientX, event.clientY);
    if (!target) {
      instruction.textContent = "この場所に保存できる画像がありません";
      return;
    }
    try {
      if (target.candidates) finish({ candidates: target.candidates });
      else if (target.node instanceof SVGSVGElement) finish({ materialized: materializeSvg(target.node) });
      else if (target.node instanceof HTMLCanvasElement) {
        const url = target.node.toDataURL("image/png");
        if (!url.startsWith("data:image/png")) throw new Error("Canvasの描画を取得できませんでした。");
        if (url.length > 55_000_000) throw new Error("Canvasの画像が大きすぎます。表示範囲を保存できます。");
        finish({ materialized: { url, name: "canvas.png" } });
      }
    } catch (error) {
      const fallback = target.node instanceof HTMLCanvasElement
        ? "Canvasの元データを取得できませんでした。"
        : "このSVGを単体の静止画として取得できませんでした。";
      finish({ error: error instanceof Error && error.name === "Error" ? error.message : fallback });
    }
  });
  document.addEventListener("keydown", onKey, true);
  document.documentElement.append(host);
  cancel.focus({ preventScroll: true });
}
