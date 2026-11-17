// 公共工具: DOM 小工具 / 接口封装 / 主题判断 / 提示条 / 标签自动补全
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

export const IS_STYLE_LOADED = (() => {
  const url = new URL("./ricerabbit_style.css", import.meta.url).href;
  if (document.querySelector(`link[href="${url}"]`)) return true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = url;
  document.head.append(link);
  return true;
})();

// ---------------------------------------------------------------- DOM

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "dataset" && typeof value === "object") Object.assign(node.dataset, value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// ---------------------------------------------------------------- 主题

/** ComfyUI 当前是不是深色主题 (读 body 背景亮度, 不依赖具体主题 class)。 */
export function isDarkTheme() {
  try {
    const bg = getComputedStyle(document.body).backgroundColor;
    const nums = bg.match(/[\d.]+/g);
    if (!nums || nums.length < 3) return true;
    const [r, g, b] = nums.map(Number);
    if (nums.length > 3 && Number(nums[3]) === 0) return true;
    return r * 0.299 + g * 0.587 + b * 0.114 < 128;
  } catch {
    return true;
  }
}

export function themeClass() {
  return isDarkTheme() ? "rr-dark" : "rr-light";
}

// ---------------------------------------------------------------- 接口

async function readError(res, fallback) {
  try {
    const data = await res.json();
    return data?.detail || data?.error || fallback;
  } catch {
    return fallback;
  }
}

export async function apiGet(path) {
  const res = await api.fetchApi(path, { cache: "no-store" });
  if (!res.ok) throw new Error(await readError(res, `Request failed (${res.status})`));
  return res.json();
}

export async function apiPost(path, body) {
  const res = await api.fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(await readError(res, `Request failed (${res.status})`));
  return res.json();
}

// ---------------------------------------------------------------- 提示条

let toastBox = null;

export function toast(message, type = "info", ms = 2600) {
  if (!message) return;
  if (!toastBox || !toastBox.isConnected) {
    toastBox = el("div", { class: "rr-toasts" });
    document.body.append(toastBox);
  }
  const item = el("div", { class: `rr-toast rr-${type}`, text: message });
  toastBox.append(item);
  setTimeout(() => {
    item.style.transition = "opacity .2s";
    item.style.opacity = "0";
    setTimeout(() => item.remove(), 220);
  }, ms);
}

// ---------------------------------------------------------------- 补全

const TAG_START_BREAK = /[,，\n([{<:]/;
const TAG_END_BREAK = /[,，\n)\]}>:]/;
const NO_SEP_AFTER = /^\s*[,，\n)\]}>:]/;
const NO_SEP_BEFORE = /[(（[\[{<:]\s*$/;

/** 光标所在的"当前标签"区间。选中了文本时按选中内容替换。 */
export function keywordRange(input) {
  const value = input.value ?? "";
  const caret = typeof input.selectionStart === "number" ? input.selectionStart : value.length;
  const selEnd = typeof input.selectionEnd === "number" ? input.selectionEnd : caret;
  if (selEnd > caret) {
    return { start: caret, end: selEnd, keyword: value.slice(caret, selEnd).trim(), selected: true };
  }
  let start = caret;
  while (start > 0 && !TAG_START_BREAK.test(value[start - 1])) start--;
  while (start < caret && /\s/.test(value[start])) start++;
  let end = caret;
  while (end < value.length && !TAG_END_BREAK.test(value[end])) end++;
  return { start, end, keyword: value.slice(start, caret).trim(), selected: false };
}

export function insertSuggestion(input, suggestion, opts = {}) {
  const tag = String(suggestion || "").split(",")[0].trim();
  if (!tag) return;
  const value = input.value ?? "";
  const { start, end } = keywordRange(input);
  const before = value.slice(0, start);
  const after = value.slice(end);
  let sep = "";
  // 选中替换也要补逗号: ComfyUI 的多行框在 input 事件里选择区偶尔是"有选中"的状态,
  // 之前带着 !selected 判断, 结果补全进去就是光秃秃一个词
  if (opts.comma !== false) {
    if (!after) sep = NO_SEP_BEFORE.test(before) ? "" : ", ";
    else if (!NO_SEP_AFTER.test(after) && !NO_SEP_BEFORE.test(before)) sep = ", ";
  }
  input.value = before + tag + sep + after;
  const caret = start + tag.length + sep.length;
  try {
    input.setSelectionRange(caret, caret);
  } catch {
    /* 少数控件不支持选区 */
  }
  input.dataset.rrSkipSuggest = "1";
  input.dispatchEvent(new Event("input", { bubbles: true }));

  // 有些前端 (Nodes 2.0 的 Vue 输入框) 只认状态里的值, 直接改 DOM 会在下一次
  // 渲染时被冲掉; 这里顺手把 widget 的值也写上, 保证光标后那半截 ", " 留得住
  const graph = window.comfyAPI?.app?.app?.graph;
  for (const node of graph?._nodes || []) {
    for (const widget of node.widgets || []) {
      const el = widget.element ?? widget.inputEl;
      if (el === input || el?.contains?.(input)) {
        widget.value = input.value;
        return;
      }
    }
  }
}

/** 光标在视口中的坐标 (textarea 没有原生 API, 用等宽等字体的隐藏镜像量)。 */
function caretPoint(input) {
  const cs = getComputedStyle(input);
  const rect = input.getBoundingClientRect();
  const mirror = document.createElement("div");
  const st = mirror.style;
  st.position = "fixed";
  st.top = "0";
  st.left = "0";
  st.visibility = "hidden";
  st.pointerEvents = "none";
  st.zIndex = "-1";
  st.border = "0";
  st.boxSizing = "border-box";
  st.width = (input.clientWidth || rect.width) + "px";
  st.overflow = "hidden";
  st.whiteSpace = input.tagName === "TEXTAREA" ? "pre-wrap" : "pre";
  for (const prop of [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing",
    "lineHeight", "textTransform", "textIndent", "tabSize", "direction",
    "wordBreak", "overflowWrap",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  ]) st[prop] = cs[prop];
  const caret = typeof input.selectionStart === "number" ? input.selectionStart : (input.value || "").length;
  mirror.textContent = (input.value || "").slice(0, caret);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  const lineH = parseFloat(cs.lineHeight) || marker.offsetHeight || 18;
  const x = rect.left + (input.clientLeft || 0) + marker.offsetLeft - (input.scrollLeft || 0);
  const y = rect.top + (input.clientTop || 0) + marker.offsetTop - (input.scrollTop || 0);
  mirror.remove();
  return { x, y, lineH };
}

function fmtCount(n) {
  if (!n) return "";
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

/**
 * 给某个 input / textarea 接上标签补全。
 * @param {HTMLInputElement|HTMLTextAreaElement} input
 * @param {{comma?: boolean, delay?: number}} opts comma=false 时不自动补逗号 (单标签编辑框)
 * @returns {{destroy: () => void}}
 */
export function wireAutocomplete(input, opts = {}) {
  const list = el("div", { class: `rr-suggest rr-hidden ${themeClass()}` });
  document.body.append(list);

  let items = [];
  let active = -1;
  let timer = null;
  let controller = null;
  let composing = false;
  let lastKeyword = "";

  function hide() {
    list.classList.add("rr-hidden");
    active = -1;
    lastKeyword = "";
    delete input.dataset.rrSuggestOpen;
    // 输入框已经从文档里移除 (节点被删 / 弹窗关了): 把挂在 body 上的下拉也收走
    if (!input.isConnected) list.remove();
  }

  function place() {
    const rect = input.getBoundingClientRect();
    const { x, y, lineH } = caretPoint(input);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(Math.round(rect.width), 340), vw - 24);
    // 宽度会影响到换行后高度, 先写宽度再量
    list.style.width = width + "px";
    const height = list.offsetHeight;
    const left = Math.min(Math.max(x, 8), Math.max(8, vw - width - 8));

    // 跟着光标走: 贴在当前这一行的下面, 不压住正在敲的字
    let top = y + lineH + 4;
    if (top + height > vh - 8) {
      const above = y - height - 4;
      top = above >= 8 ? above : Math.max(8, vh - height - 8);
    }
    list.style.left = Math.round(left) + "px";
    list.style.top = Math.round(top) + "px";
  }

  function setActive(index) {
    active = index;
    $$(".rr-sug", list).forEach((node, i) => node.classList.toggle("rr-active", i === index));
    const current = $(".rr-sug.rr-active", list);
    if (current) current.scrollIntoView({ block: "nearest" });
  }

  function highlight(text, keyword) {
    const frag = document.createDocumentFragment();
    if (!text) return frag;
    const at = keyword ? text.toLowerCase().indexOf(keyword.toLowerCase()) : -1;
    if (at < 0) {
      frag.append(document.createTextNode(text));
      return frag;
    }
    if (at > 0) frag.append(document.createTextNode(text.slice(0, at)));
    frag.append(el("b", { text: text.slice(at, at + keyword.length) }));
    frag.append(document.createTextNode(text.slice(at + keyword.length)));
    return frag;
  }

  function render(results, keyword) {
    items = results;
    active = -1;
    lastKeyword = keyword;
    clear(list);
    results.forEach((item, index) => {
      const row = el("div", { class: `rr-sug rr-cat-${item.category ?? 0}` }, [
        el("span", { class: "rr-sug-dot" }),
        el("span", { class: "rr-sug-tag" }, [highlight(item.tag, keyword)]),
        item.alias ? el("span", { class: "rr-sug-alias", title: "Alias: " + item.alias }, ["⇢ ", highlight(item.alias, keyword)]) : null,
        item.zh ? el("span", { class: "rr-sug-zh" }, [highlight(item.zh, keyword)]) : null,
        el("span", { class: "rr-sug-count", text: fmtCount(item.count) }),
      ]);
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        insertSuggestion(input, item.tag, opts);
        hide();
      });
      row.addEventListener("mousemove", () => setActive(index));
      list.append(row);
    });
    if (results.length) {
      list.classList.remove("rr-hidden");
      input.dataset.rrSuggestOpen = "1";
      place();
    } else {
      hide();
    }
  }

  async function query() {
    if (document.activeElement !== input) return hide();
    const { keyword } = keywordRange(input);
    if (!keyword || keyword.length < 1) return hide();
    if (controller) controller.abort();
    controller = new AbortController();
    try {
      const res = await api.fetchApi(`/ricerabbit/suggest?keyword=${encodeURIComponent(keyword)}`, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      if (document.activeElement !== input) return hide();
      if (data.keyword !== undefined && keywordRange(input).keyword !== keyword) return;
      render(data.items || [], keyword);
    } catch {
      /* 取消/网络问题都不打扰用户 */
    }
  }

  function onInput(event) {
    clearTimeout(timer);
    if (controller) {
      controller.abort();
      controller = null;
    }
    if (input.dataset.rrSkipSuggest) {
      delete input.dataset.rrSkipSuggest;
      return hide();
    }
    if (composing || event?.isComposing) return hide();
    timer = setTimeout(query, opts.delay ?? 130);
  }

  function onKeyDown(event) {
    if (event.isComposing) return;
    const open = !list.classList.contains("rr-hidden");
    if (!open) {
      if (event.key === "Tab" && event.ctrlKey) {
        // Ctrl+Tab 手动唤起补全
        event.preventDefault();
        query();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(Math.min(active + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(active - 1, 0));
    } else if (event.key === "Enter" || event.key === "Tab") {
      if (active < 0 && items.length) active = 0;
      const item = items[active];
      if (!item) return;
      event.preventDefault();
      event.stopPropagation();
      insertSuggestion(input, item.tag, opts);
      hide();
    } else if (event.key === "Escape") {
      event.stopPropagation();
      hide();
    }
  }

  const onBlur = () => setTimeout(() => {
    if (document.activeElement !== input) hide();
  }, 120);
  // ComfyUI 的画布点一下不会让 textarea 失焦, 所以额外监听一次全局按下
  const onOutsidePointerDown = (event) => {
    if (event.target === input || list.contains(event.target)) return;
    hide();
  };
  const onCompositionStart = () => { composing = true; };
  const onCompositionEnd = () => { composing = false; };
  const follow = () => {
    if (!input.isConnected) {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
      return;
    }
    if (!list.classList.contains("rr-hidden")) place();
  };

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeyDown, true);
  input.addEventListener("blur", onBlur);
  input.addEventListener("compositionstart", onCompositionStart);
  input.addEventListener("compositionend", onCompositionEnd);
  window.addEventListener("scroll", follow, true);
  window.addEventListener("resize", follow);
  document.addEventListener("pointerdown", onOutsidePointerDown, true);

  return {
    destroy() {
      clearTimeout(timer);
      if (controller) controller.abort();
      input.removeEventListener("input", onInput);
      input.removeEventListener("keydown", onKeyDown, true);
      input.removeEventListener("blur", onBlur);
      input.removeEventListener("compositionstart", onCompositionStart);
      input.removeEventListener("compositionend", onCompositionEnd);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
      document.removeEventListener("pointerdown", onOutsidePointerDown, true);
      list.remove();
    },
  };
}

export function comfyApp() {
  return app;
}
