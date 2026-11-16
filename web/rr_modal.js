// 标签化提示词弹窗
//   - 提示词按逗号 / 换行 / "句点+空格" 拆成可点击的标签块, 支持 ▲▼ 权重、编辑、删除、拖动排序
//   - 权重两种写法: 通用权重 (标签:1.5) / NAI 新版权重 1.5::标签::
//   - 双击空白切到文本输入 (仍是同一个提示词), 输入时有标签自动补全
//   - 下方卡片库 (wildcards) 与提示词库, 点击多选、再点取消, 支持跨分类选择
//   - 中文译文常驻标签块副标题, 缺失的可以点 🌐 翻译在线补齐
import {
  $, $$, apiGet, apiPost, clear, el, insertSuggestion, themeClass, toast, wireAutocomplete,
} from "./rr_common.js";

const BREAK = "\n";
// 原文是 ",换行" 时单独记一笔, 否则拼回去会把这个逗号吃掉
const BREAK_COMMA = "\n,";
const isBreak = (tag) => tag === BREAK || tag === BREAK_COMMA;
const WEIGHT_MODE_KEY = "ricerabbit.weightMode";

// 译文缓存跨弹窗共享: 同一批标签只查一次, 再开窗口立刻就有中文
const ZH_CACHE = new Map();

let weightMode = "paren";
try {
  const saved = localStorage.getItem(WEIGHT_MODE_KEY);
  if (saved === "nai" || saved === "paren") weightMode = saved;
} catch { /* localStorage 不可用时用默认值 */ }

// ---------------------------------------------------------------- 文本 <-> 标签

/**
 * 按英文逗号 / 换行 / "句点+空格" 拆标签。
 * 括号内的分隔符不拆; NAI 权重块 数字::内容:: 内部不拆 (支持嵌套)。
 * 换行本身作为一个 BREAK 项保留, 拼回时还原成真正的换行。
 */
export function splitTags(value) {
  const out = [];
  let buf = "";
  let depth = 0;
  let wDepth = 0;
  let pendingComma = false;
  const text = String(value ?? "").replace(/\r\n?/g, "\n");
  const openRe = /^\d*\.?\d+::/;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch >= "0" && ch <= "9") || ch === ".") {
      const match = openRe.exec(text.slice(i));
      if (match) {
        wDepth++;
        buf += match[0];
        i += match[0].length - 1;
        continue;
      }
    }
    if (wDepth > 0 && ch === ":" && text[i + 1] === ":") {
      wDepth--;
      buf += "::";
      i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth = Math.max(0, depth - 1);
    const dotSep = ch === "." && text[i + 1] === " ";
    if ((ch === "," || ch === "\n" || dotSep) && depth === 0 && wDepth === 0) {
      if (ch === "\n") {
        // 换行: 保留 "换行前有没有逗号" 的信息, 拼回去时原样还原
        if (buf.trim()) out.push(buf);
        out.push(pendingComma ? BREAK_COMMA : BREAK);
        pendingComma = false;
        buf = "";
      } else {
        out.push(buf);
        if (dotSep) i++;
        buf = "";
        pendingComma = ch === ",";
      }
    } else {
      buf += ch;
      if (!/\s/.test(ch)) pendingComma = false;
    }
  }
  out.push(buf);
  const tags = out.map((t) => (isBreak(t) ? t : t.trim())).filter((t) => t !== "");
  const result = [];
  for (const tag of tags) {
    if (isBreak(tag) && !result.length) continue;
    result.push(tag);
  }
  while (result.length && isBreak(result[result.length - 1])) result.pop();
  return result;
}

export function joinTags(tags) {
  let text = "";
  let needSep = false;
  for (const tag of tags) {
    if (isBreak(tag)) {
      text += tag === BREAK_COMMA ? ",\n" : "\n";
      needSep = false;
      continue;
    }
    text += (needSep ? ", " : "") + tag;
    needSep = true;
  }
  return text;
}

/** 解析权重: (内容:1.5) / 1.5::内容:: / 1.5::内容 (未闭合) / 无权重。 */
export function parseWeight(raw) {
  let match = /^\((.+):(\d*\.?\d+)\)$/.exec(raw);
  if (match) return { content: match[1], weight: parseFloat(match[2]), style: "paren" };
  match = /^(\d*\.?\d+)::([\s\S]*)::$/.exec(raw);
  if (match) return { content: match[2], weight: parseFloat(match[1]), style: "nai" };
  match = /^(\d*\.?\d+)::([\s\S]+)$/.exec(raw);
  if (match) return { content: match[2], weight: parseFloat(match[1]), style: "nai" };
  return { content: raw, weight: 1, style: "plain" };
}

export function fmtTag(content, weight, mode = "paren") {
  if (weight === 1) return content;
  return mode === "nai" ? `${weight}::${content}::` : `(${content}:${weight})`;
}

const zhKey = (text) => (text || "").trim().toLowerCase().replace(/\s+/g, "_");

// ---------------------------------------------------------------- 弹窗

/**
 * 打开标签化提示词弹窗。
 * @param {{getValue: () => string, setValue: (v: string) => void, title?: string}} options
 */
export function openTagModal(options = {}) {
  const { getValue, setValue, title = "Prompt" } = options;
  if (typeof getValue !== "function" || typeof setValue !== "function") {
    throw new Error("openTagModal requires getValue/setValue");
  }

  const initial = getValue() ?? "";
  let text = initial;
  let mode = "tags";
  let activeLib = "cards";
  let activeCat = "";
  let closed = false;

  let translating = false;

  const cardSelection = new Map();   // 分类 -> Set(卡片名)
  const promptSelection = new Set(); // 提示词库选中的标签

  // 库数据 (声明提前: renderCats / refreshLibInfo 会在初始化阶段先读到它们)
  let types = [];
  const cardsCache = new Map();
  let promptGroups = new Map();
  // ANR 内置提示词库 (只读): 分组名 -> [[英文, 中文], ...]
  let builtinGroups = new Map();
  let dragIndex = -1;
  let dropIndex = -1;

  // ---------------- 骨架 ----------------

  const overlay = el("div", { class: `rr-overlay ${themeClass()}` });
  const box = el("div", { class: "rr-modal" });

  const titleEl = el("div", { class: "rr-title", text: "🃏 Tag Prompt" });
  const subEl = el("span", { class: "rr-sub", text: title });
  const closeBtn = el("button", { class: "rr-btn rr-danger", type: "button", text: "✖ Close" });

  const chipsView = el("div", { class: "rr-chips" });
  const textarea = el("textarea", { class: "rr-ta", spellcheck: "false", placeholder: "Type a prompt here..." });
  textarea.value = text;
  const editor = el("div", { class: "rr-editor" }, [chipsView, textarea]);

  const weightBtn = el("button", {
    class: "rr-btn",
    type: "button",
    title: "Switch weight syntax:\nGeneric (tag:1.5)\nNAI v3 1.5::tag::",
  });
  const addSelBtn = el("button", { class: "rr-btn rr-primary", type: "button", text: "➕ Add selected", disabled: true });
  const clearSelBtn = el("button", { class: "rr-btn", type: "button", text: "✖ Clear selection", disabled: true });
  const translateBtn = el("button", { class: "rr-btn", type: "button", text: "🌐 Translate" });
  const modeBtn = el("button", { class: "rr-btn", type: "button", text: "✏️ Text editor" });

  const promptHead = el("div", { class: "rr-prompt-head" }, [
    el("span", { class: "rr-label", text: "📝 " + title }),
    el("span", { class: "rr-hint", text: "Changes sync back to the node live" }),
    el("div", { class: "rr-spacer" }),
    weightBtn, addSelBtn, clearSelBtn, translateBtn, modeBtn,
  ]);

  const promptSec = el("div", { class: "rr-prompt" }, [promptHead, editor]);

  const tabCards = el("button", { class: "rr-tab rr-active", type: "button", text: "🃏 Card library" });
  const tabPrompts = el("button", { class: "rr-tab", type: "button", text: "💬 Prompt library" });
  const libInfo = el("span", { class: "rr-hint", text: "" });
  const newCardBtn = el("button", { class: "rr-btn", type: "button", text: "＋ New card" });
  const newCatBtn = el("button", { class: "rr-btn", type: "button", text: "＋ Category" });
  const favBtn = el("button", { class: "rr-btn", type: "button", text: "＋ Save prompt", style: { display: "none" } });
  const refreshBtn = el("button", {
    class: "rr-btn",
    type: "button",
    text: "🔄 Refresh",
    title: "Reload the card and prompt libraries (click after changing folders in settings)",
  });
  const tabs = el("div", { class: "rr-tabs" }, [
    tabCards, tabPrompts, el("div", { class: "rr-spacer" }), libInfo, refreshBtn, favBtn, newCardBtn, newCatBtn,
  ]);

  const catsBox = el("div", { class: "rr-cats" });
  const gridBox = el("div", { class: "rr-grid" });
  // 卡片内容预览: 点一张卡片就在下面显示它写了什么
  const previewBox = el("div", { class: "rr-preview", text: "Click a card to preview its content" });
  const mainBox = el("div", { class: "rr-main" }, [gridBox, previewBox]);
  const libBody = el("div", { class: "rr-lib-body" }, [catsBox, mainBox]);
  const libs = el("div", { class: "rr-libs" }, [tabs, libBody]);

  box.append(
    el("div", { class: "rr-head" }, [titleEl, subEl, el("div", { class: "rr-spacer" }), closeBtn]),
    promptSec,
    libs,
  );
  overlay.append(box);

  const suggest = wireAutocomplete(textarea, { comma: true });

  // ---------------- 提示词同步 ----------------

  function setText(next, { render = true } = {}) {
    text = next ?? "";
    if (textarea.value !== text) textarea.value = text;
    try {
      setValue(text);
    } catch (e) {
      console.warn("[RiceRabbit] Failed to sync the prompt", e);
    }
    if (render && mode === "tags") renderChips();
  }

  function applyTags(tags) {
    setText(joinTags(tags));
  }

  // ---------------- 标签块 ----------------

  const zhOf = (content) => ZH_CACHE.get(zhKey(content)) || "";
  const needZh = (content) => !!content && !zhOf(content);

  async function fetchTranslations(contents) {
    const missing = [...new Set(contents.filter((c) => c && needZh(c)).map(zhKey))];
    if (!missing.length || translating) return;
    translating = true;
    try {
      const res = await apiPost("/ricerabbit/translate", { tags: missing });
      Object.entries(res.translations || {}).forEach(([tag, zh]) => ZH_CACHE.set(zhKey(tag), zh || ""));
      if (!closed && mode === "tags") renderChips();
    } catch (e) {
      console.warn("[RiceRabbit] Translation failed", e);
    } finally {
      translating = false;
    }
  }

  function renderChips() {
    clear(chipsView);
    const tags = splitTags(text);
    if (!tags.length) {
      chipsView.append(
        el("div", { class: "rr-chips-empty", text: "Prompt is empty — click “＋ Tag” below to type one (Enter to add), or pick / drag cards from the library" }),
      );
      chipsView.append(makeAddChip());
      return;
    }
    tags.forEach((raw, index) => chipsView.append(makeChip(raw, index)));
    chipsView.append(makeAddChip());
    const need = tags
      .filter((raw) => !isBreak(raw))
      .map((raw) => parseWeight(raw).content)
      .filter((c) => c && !c.startsWith("<"));
    if (need.some((c) => needZh(c))) fetchTranslations(need);
  }

  function makeAddChip() {
    const chip = el("div", { class: "rr-chip rr-chip-add", title: "Add a tag", text: "＋ Tag" });
    chip.addEventListener("click", () => startAdd());
    return chip;
  }

  function startAdd() {
    const anchor = $(".rr-chip-add", chipsView);
    const holder = el("div", { class: "rr-chip rr-chip-add rr-chip-add-input" });
    const input = el("input", { class: "rr-chip-input", placeholder: "Type a tag and press Enter (comma-separated, Esc to cancel)" });
    const ac = wireAutocomplete(input, { comma: false });
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      ac.destroy();
      const parts = splitTags(input.value);
      if (parts.length) {
        const next = [...splitTags(text), ...parts];
        applyTags(next);
        requestAnimationFrame(() => {
          const add = $(".rr-chip-add", chipsView);
          if (add) startAdd();
        });
      } else {
        renderChips();
      }
    };
    const cancel = () => {
      if (done) return;
      done = true;
      ac.destroy();
      renderChips();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        event.stopPropagation();
        cancel();
      }
    });
    input.addEventListener("blur", () => {
      if (input.value.trim()) commit();
      else cancel();
    });
    holder.append(input);
    if (anchor) chipsView.replaceChild(holder, anchor);
    else chipsView.append(holder);
    input.focus();
  }

  function setWeight(index, delta) {
    const tags = splitTags(text);
    if (!tags[index]) return;
    const { content, weight } = parseWeight(tags[index]);
    const next = Math.min(10, Math.max(0.1, Math.round((weight + delta) * 10) / 10));
    tags[index] = fmtTag(content, next, weightMode);
    applyTags(tags);
  }

  function removeTag(index) {
    const tags = splitTags(text);
    tags.splice(index, 1);
    applyTags(tags);
  }

  function startEdit(index) {
    const tags = splitTags(text);
    const { content, weight, style } = parseWeight(tags[index] ?? "");
    const chip = chipsView.children[index];
    if (!chip) return;
    let done = false;
    clear(chip);
    chip.classList.add("rr-editing");
    chip.draggable = false;
    const input = el("input", { class: "rr-chip-input", value: content });
    const ac = wireAutocomplete(input, { comma: false });
    const commit = () => {
      if (done) return;
      done = true;
      ac.destroy();
      const value = input.value.trim();
      const next = splitTags(text);
      if (!value) next.splice(index, 1);
      else next[index] = fmtTag(value, weight, style === "plain" ? weightMode : style);
      applyTags(next);
    };
    const cancel = () => {
      if (done) return;
      done = true;
      ac.destroy();
      renderChips();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        event.stopPropagation();
        cancel();
      }
    });
    input.addEventListener("blur", commit);
    chip.append(input);
    input.focus();
    input.select();
  }

  function makeBreakChip(index) {
    const chip = el("div", { class: "rr-chip rr-break", title: "Line break (drag to reorder)" }, [
      el("div", { class: "rr-chip-row" }, [el("span", { class: "rr-chip-text", text: "⏎" })]),
      el("div", { class: "rr-chip-zh", text: "Line break" }),
    ]);
    chip.draggable = true;
    chip.addEventListener("dragstart", (event) => {
      dragIndex = index;
      dropIndex = -1;
      chip.classList.add("rr-dragging");
      try {
        event.dataTransfer.setData("text/plain", BREAK);
        event.dataTransfer.effectAllowed = "move";
      } catch { /* 忽略 */ }
    });
    chip.addEventListener("dragend", () => {
      dragIndex = -1;
      chip.classList.remove("rr-dragging");
      $$(".rr-chip.rr-drop-before", chipsView).forEach((c) => c.classList.remove("rr-drop-before"));
    });
    chip.append(el("div", { class: "rr-chip-ops" }, [
      el("span", { class: "rr-op rr-op-danger", title: "Remove this line break", text: "×", onclick: () => removeTag(index) }),
    ]));
    return chip;
  }

  function makeChip(raw, index) {
    if (isBreak(raw)) return makeBreakChip(index);
    const { content, weight } = parseWeight(raw);
    const chip = el("div", { class: "rr-chip", title: "Drag to reorder; double-click to edit; hover for actions" }, [
      el("div", { class: "rr-chip-row" }, [
        el("span", { class: "rr-chip-text", text: content }),
        weight !== 1 ? el("span", { class: "rr-chip-w", text: "×" + weight }) : null,
      ]),
      el("div", { class: "rr-chip-zh", text: zhOf(content) }),
    ]);
    chip.draggable = true;
    chip.addEventListener("dragstart", (event) => {
      dragIndex = index;
      dropIndex = -1;
      chip.classList.add("rr-dragging");
      try {
        event.dataTransfer.setData("text/plain", raw);
        event.dataTransfer.effectAllowed = "move";
      } catch { /* 忽略 */ }
    });
    chip.addEventListener("dragend", () => {
      dragIndex = -1;
      chip.classList.remove("rr-dragging");
      $$(".rr-chip.rr-drop-before", chipsView).forEach((c) => c.classList.remove("rr-drop-before"));
    });
    const ops = el("div", { class: "rr-chip-ops" }, [
      el("span", { class: "rr-op", title: "Lower weight (-0.1)", text: "▼", onclick: () => setWeight(index, -0.1) }),
      el("span", { class: "rr-op", title: "Raise weight (+0.1)", text: "▲", onclick: () => setWeight(index, +0.1) }),
      el("span", { class: "rr-op", title: "Edit", text: "✎", onclick: () => startEdit(index) }),
      el("span", { class: "rr-op rr-op-danger", title: "Delete", text: "×", onclick: () => removeTag(index) }),
    ]);
    ops.addEventListener("dblclick", (event) => event.stopPropagation());
    chip.append(ops);
    chip.addEventListener("dblclick", (event) => {
      if (event.target instanceof Element && event.target.closest(".rr-chip-ops")) return;
      if (event.target instanceof HTMLInputElement) return;
      event.stopPropagation();
      startEdit(index);
    });
    return chip;
  }

  // 标签块拖动排序 (dragIndex / dropIndex 在函数顶部声明)

  chipsView.addEventListener("dragover", (event) => {
    if (dragIndex < 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const chips = [...chipsView.querySelectorAll(".rr-chip:not(.rr-chip-add):not(.rr-chip-add-input)")];
    let target = -1;
    for (let i = 0; i < chips.length; i++) {
      if (i === dragIndex) continue;
      const rect = chips[i].getBoundingClientRect();
      const past = rect.bottom <= event.clientY + 2
        || (event.clientY >= rect.top && event.clientY <= rect.bottom && rect.left + rect.width / 2 <= event.clientX);
      if (!past) {
        target = i;
        break;
      }
    }
    $$(".rr-chip.rr-drop-before", chipsView).forEach((c) => c.classList.remove("rr-drop-before"));
    if (target < 0) {
      dropIndex = splitTags(text).length;
      const add = $(".rr-chip-add", chipsView);
      if (add) add.classList.add("rr-drop-before");
    } else {
      dropIndex = target;
      if (target !== dragIndex) chips[target].classList.add("rr-drop-before");
    }
  });

  chipsView.addEventListener("drop", (event) => {
    if (dragIndex < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const from = dragIndex;
    const to = dropIndex;
    dragIndex = -1;
    dropIndex = -1;
    const tags = splitTags(text);
    if (to < 0 || to === from) {
      renderChips();
      return;
    }
    const [moved] = tags.splice(from, 1);
    if (to >= tags.length) tags.push(moved);
    else tags.splice(to > from ? to - 1 : to, 0, moved);
    applyTags(tags);
  });

  // 双击空白 -> 文本编辑
  chipsView.addEventListener("dblclick", (event) => {
    if (!event.target.closest(".rr-chip")) setMode("text");
  });

  // ---------------- 模式切换 ----------------

  function setMode(next) {
    mode = next;
    chipsView.classList.toggle("rr-hidden", next !== "tags");
    textarea.classList.toggle("rr-shown", next !== "tags");
    modeBtn.textContent = next === "tags" ? "✏️ Text editor" : "🏷️ Tag view";
    if (next === "tags") renderChips();
    else textarea.focus();
  }

  modeBtn.addEventListener("click", () => setMode(mode === "tags" ? "text" : "tags"));

  textarea.addEventListener("input", () => {
    text = textarea.value;
    try {
      setValue(text);
    } catch { /* 忽略 */ }
    if (mode === "tags") renderChips();
  });

  // ---------------- 权重模式 ----------------

  function refreshWeightBtn() {
    weightBtn.textContent = weightMode === "nai" ? "⚖️ NAI weight" : "⚖️ Generic weight";
  }
  weightBtn.addEventListener("click", () => {
    weightMode = weightMode === "nai" ? "paren" : "nai";
    try {
      localStorage.setItem(WEIGHT_MODE_KEY, weightMode);
    } catch { /* 存不进去也不影响本次 */ }
    refreshWeightBtn();
    toast(weightMode === "nai" ? "Weight syntax: 1.5::tag::" : "Weight syntax: (tag:1.5)");
  });
  refreshWeightBtn();

  // ---------------- 翻译 ----------------

  translateBtn.addEventListener("click", async () => {
    const tags = [...new Set(
      splitTags(text)
        .filter((raw) => !isBreak(raw))
        .map((raw) => parseWeight(raw).content)
        .filter((c) => c && !c.startsWith("<") && needZh(c)),
    )];
    if (!tags.length) {
      toast("Every tag already has a translation ✨", "success");
      return;
    }
    translateBtn.disabled = true;
    const old = translateBtn.textContent;
    translateBtn.textContent = "⏳ Translating...";
    try {
      let count = 0;
      for (let i = 0; i < tags.length; i += 20) {
        const res = await apiPost("/ricerabbit/translate", { tags: tags.slice(i, i + 20) });
        Object.entries(res.translations || {}).forEach(([tag, zh]) => {
          ZH_CACHE.set(zhKey(tag), zh || "");
          if (zh) count++;
        });
        renderChips();
      }
      toast(count ? `Translated ${count} tag(s) 🌐` : "No translations returned, try again later", count ? "success" : "warn");
    } catch (e) {
      toast("Translation failed: " + e.message, "error");
    } finally {
      translateBtn.disabled = false;
      translateBtn.textContent = old;
    }
  });

  // ---------------- 选中项 ----------------

  function totalSelected() {
    let count = 0;
    for (const names of cardSelection.values()) count += names.size;
    return count;
  }

  function refreshSelBtns() {
    const count = activeLib === "prompts" ? promptSelection.size : totalSelected();
    addSelBtn.disabled = !count;
    clearSelBtn.disabled = !count;
    addSelBtn.textContent = count ? `➕ Add selected (${count})` : "➕ Add selected";
  }

  /** 把若干标签追加到提示词末尾 (空提示词时不带前导逗号)。 */
  function appendTags(tags) {
    const additions = tags.map((t) => t.trim()).filter(Boolean);
    if (!additions.length) return 0;
    const current = text.trim();
    const merged = current ? `${current.replace(/[,\s]+$/, "")}, ${additions.join(", ")}` : additions.join(", ");
    setText(merged);
    return additions.length;
  }

  addSelBtn.addEventListener("click", async () => {
    if (activeLib === "prompts") {
      const tags = [...promptSelection];
      if (!tags.length) return;
      const count = appendTags(tags);
      promptSelection.clear();
      renderPromptGrid();
      refreshSelBtns();
      toast(`Added ${count} prompt(s) 🌸`, "success");
      return;
    }
    const batch = [...cardSelection.entries()].filter(([, names]) => names.size);
    if (!batch.length) {
      toast("Pick cards in the library first (click again to deselect, multi-select across categories)", "warn");
      return;
    }
    let count = 0;
    for (const [type, names] of batch) {
      for (const name of names) {
        count += appendTags([`<${type}:${name}>`]);
      }
    }
    cardSelection.clear();
    renderCards();
    refreshSelBtns();
    toast(`Added ${count} card(s) to the prompt 🃏`, "success");
  });

  clearSelBtn.addEventListener("click", () => {
    if (activeLib === "prompts") {
      promptSelection.clear();
      renderPromptGrid();
    } else {
      cardSelection.clear();
      renderCards();
    }
    refreshSelBtns();
  });

  // ---------------- 小编辑弹层 ----------------

  /**
   * 通用的小编辑弹层。
   * @returns {Promise<{value: string, category?: string} | null>}
   */
  /** 卡片封面选择区 (只在编辑已有卡片时出现)。封面是独立文件, 选完立即上传。 */
  function makeCoverBox({ type, name, onChange }) {
    const box = el("div", { class: "rr-cover" });
    const preview = el("div", { class: "rr-cover-preview" });
    const img = el("img", { class: "rr-cover-img", alt: "Cover" });
    const empty = el("div", { class: "rr-cover-empty", text: "No cover" });
    img.style.display = "none";
    preview.append(img, empty);

    function reload() {
      const url = `/ricerabbit/cover?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}&v=${Date.now()}`;
      img.onload = () => {
        img.style.display = "block";
        empty.style.display = "none";
      };
      img.onerror = () => {
        img.style.display = "none";
        empty.style.display = "flex";
      };
      img.src = url;
    }
    reload();

    const file = el("input", { type: "file", accept: "image/*", style: { display: "none" } });
    const pickBtn = el("button", { class: "rr-btn", type: "button", text: "🖼 Choose image" });
    const clearBtn = el("button", { class: "rr-btn", type: "button", text: "✖ Remove cover" });

    pickBtn.addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const picked = file.files?.[0];
      file.value = "";
      if (!picked) return;
      if (picked.size > 8 * 1024 * 1024) {
        toast("Image is larger than 8 MB, pick a smaller one", "warn");
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          await apiPost("/ricerabbit/wildcards/cover", { type, name, data: reader.result });
          reload();
          onChange?.();
          toast("Cover updated 🌸", "success");
        } catch (e) {
          toast("Failed to set the cover: " + e.message, "error");
        }
      };
      reader.readAsDataURL(picked);
    });

    clearBtn.addEventListener("click", async () => {
      try {
        const res = await apiPost("/ricerabbit/wildcards/cover/delete", { type, name });
        reload();
        onChange?.();
        toast(res.removed ? "Cover removed" : "This card has no cover", res.removed ? "success" : "warn");
      } catch (e) {
        toast("Failed to remove the cover: " + e.message, "error");
      }
    });

    box.append(
      preview,
      el("div", { class: "rr-cover-side" }, [
        el("div", { class: "rr-cover-title", text: "Cover" }),
        el("div", { class: "rr-hint", text: `Image named after the card, stored as ${name}.png` }),
        el("div", { class: "rr-cover-actions" }, [pickBtn, clearBtn]),
        file,
      ]),
    );
    return box;
  }

  function openEditor({ title, value = "", category = null, name = null, placeholder = "", multiline = true, cover = null }) {
    return new Promise((resolve) => {
      const area = multiline
        ? el("textarea", { class: "rr-mini-area", placeholder, spellcheck: "false" })
        : el("input", { class: "rr-mini-input", placeholder });
      area.value = value;
      let catInput = null;
      if (category !== null) {
        catInput = el("input", { class: "rr-mini-input", placeholder: "Category name" });
        catInput.value = category;
      }
      let nameInput = null;
      if (name !== null) {
        nameInput = el("input", { class: "rr-mini-input", placeholder: "Card name" });
        nameInput.value = name;
      }
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKey, true);
        wrap.remove();
        resolve(result);
      };
      const buildResult = () => ({
        value: area.value,
        category: catInput ? catInput.value : undefined,
        name: nameInput ? nameInput.value : undefined,
      });
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          finish(null);
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey || !multiline)) {
          event.preventDefault();
          finish(buildResult());
        }
      };
      const okBtn = el("button", { class: "rr-btn rr-primary", type: "button", text: "Save", onclick: () => finish(buildResult()) });
      const cancelBtn = el("button", { class: "rr-btn", type: "button", text: "Cancel", onclick: () => finish(null) });
      const card = el("div", { class: "rr-mini" }, [
        el("div", { class: "rr-mini-title", text: title }),
        area,
        nameInput ? el("div", { class: "rr-mini-field" }, [el("label", { text: "Card name" }), nameInput]) : null,
        catInput ? el("div", { class: "rr-mini-field" }, [el("label", { text: "Category" }), catInput]) : null,
        cover ? makeCoverBox(cover) : null,
        el("div", { class: "rr-mini-actions" }, [
          el("span", { class: "rr-hint", text: multiline ? "Ctrl+Enter to save · Esc to cancel" : "Enter to save · Esc to cancel" }),
          el("div", { class: "rr-spacer" }),
          cancelBtn,
          okBtn,
        ]),
      ]);
      const wrap = el("div", { class: `rr-mini-overlay ${themeClass()}` }, [card]);
      wrap.addEventListener("mousedown", (event) => {
        if (event.target === wrap) finish(null);
      });
      document.addEventListener("keydown", onKey, true);
      document.body.append(wrap);
      area.focus();
      if (area.select) area.select();
    });
  }

  // ---------------- 卡片库 ----------------

  async function loadTypes() {
    const data = await apiGet("/ricerabbit/wildcards");
    types = data.types || [];
    if (!types.includes(activeCat)) activeCat = types[0] || "";
    renderCats();
    await loadCards(activeCat);
    refreshLibInfo();
  }

  function refreshLibInfo() {
    if (activeLib === "cards") {
      const count = (cardsCache.get(activeCat) || []).filter((c) => !c.special).length;
      libInfo.textContent = `${types.length} categories · ${count} cards`;
    } else {
      const count = builtinGroups.has(activeCat)
        ? (builtinGroups.get(activeCat) || []).length
        : (promptGroups.get(activeCat) || []).length;
      const total = builtinGroups.size + promptGroups.size;
      const extra = builtinGroups.size ? ` (built-in ${builtinGroups.size})` : "";
      libInfo.textContent = `${total} categories${extra} · ${count} entries`;
    }
  }

  function renderCats() {
    clear(catsBox);
    const items = activeLib === "cards"
      ? types
      // 提示词库: 内置分组 (ANR 预设) 在前, 自己的收藏分类在后
      : [...builtinGroups.keys(), ...promptGroups.keys()];
    catsBox.dataset.tab = activeLib;
    if (!items.length) {
      catsBox.append(el("div", { class: "rr-empty", text: activeLib === "cards" ? "No categories yet" : "The prompt library is empty" }));
      return;
    }
    if (!items.includes(activeCat)) activeCat = items[0];
    for (const name of items) {
      const isBuiltin = activeLib === "prompts" && builtinGroups.has(name);
      const cached = cardsCache.get(name);
      const count = activeLib === "cards"
        // 没加载过的分类不显示 0, 免得看起来像"这个分类是空的"
        ? (cached ? cached.filter((c) => !c.special).length : "")
        : (isBuiltin ? (builtinGroups.get(name)?.length ?? 0) : (promptGroups.get(name)?.length ?? ""));
      const node = el("div", { class: "rr-cat" + (name === activeCat ? " rr-active" : "") }, [
        el("span", { text: isBuiltin ? "📚 " + name : name }),
        el("span", { class: "rr-cat-count", text: count === "" ? "" : String(count) }),
      ]);
      node.addEventListener("click", () => {
        activeCat = name;
        renderCats();
        if (activeLib === "cards") loadCards(name);
        else renderPromptGrid();
      });
      catsBox.append(node);
    }
  }

  async function loadCards(category) {
    if (!category) {
      clear(gridBox);
      gridBox.append(el("div", { class: "rr-empty", text: "The card library is empty — point it at Auto-NovelAI-Refactor's data/state/wildcards in settings" }));
      return;
    }
    gridBox.append(el("div", { class: "rr-empty", text: "Loading..." }));
    try {
      const data = await apiGet(`/ricerabbit/wildcards/${encodeURIComponent(category)}`);
      cardsCache.set(category, data.cards || []);
      renderCards();
      renderCats();
      refreshLibInfo();
    } catch (e) {
      clear(gridBox);
      gridBox.append(el("div", { class: "rr-empty", text: "Load failed: " + e.message }));
    }
  }

  // 点卡片时把内容显示在网格下方的预览框里
  let previewToken = 0;
  async function showCardContent(card) {
    if (!previewBox) return;
    const token = ++previewToken;
    if (card.special === "random") {
      previewBox.textContent =
        "🎲 Random\nPicks a random card from this category at generation time; inserts <" + activeCat + ":random>";
      return;
    }
    if (card.special === "sequential") {
      previewBox.textContent =
        "🔢 Sequential\nWalks the cards in filename order (the cursor lives in the plugin's data folder); inserts <" +
        activeCat + ":sequential>";
      return;
    }
    previewBox.textContent = "Reading…";
    try {
      const data = await apiGet(`/ricerabbit/wildcards/${encodeURIComponent(activeCat)}/${encodeURIComponent(card.name)}`);
      if (token !== previewToken) return;
      const content = (data.content || "").trim();
      previewBox.textContent = content || "(this card is empty)";
    } catch (e) {
      if (token !== previewToken) return;
      previewBox.textContent = "Read failed: " + e.message;
    }
  }

  function renderCards() {
    if (activeLib !== "cards") return;
    clear(gridBox);
    const cards = cardsCache.get(activeCat) || [];
    if (!cards.length) {
      gridBox.append(el("div", { class: "rr-empty", text: "No cards in this category yet" }));
      return;
    }
    for (const card of cards) {
      const special = card.special;                            // random / sequential 虚拟卡片
      const selected = cardSelection.get(activeCat)?.has(card.name);
      const placeholder = special === "random" ? "🎲" : special === "sequential" ? "🔢" : "🃏";
      const cover = card.cover_url
        ? el("img", { class: "rr-card-cover", src: card.cover_url, alt: card.name, loading: "lazy" })
        : el("div", { class: "rr-card-cover rr-noimg" + (special ? " rr-special" : ""), text: placeholder });
      if (card.cover_url) {
        cover.addEventListener("error", () => {
          cover.replaceWith(el("div", { class: "rr-card-cover rr-noimg", text: placeholder }));
        });
      }
      const node = el("div", {
        class: "rr-card" + (selected ? " rr-selected" : "") + (special ? " rr-card-special" : ""),
        title: special === "random"
          ? "Pick a random card from this category; inserts <category:random>"
          : special === "sequential"
            ? "Walk the cards in filename order; inserts <category:sequential>"
            : card.name,
      }, [
        cover,
        el("div", { class: "rr-card-name", text: card.name }),
      ]);
      node.draggable = true;
      node.addEventListener("dragstart", (event) => {
        try {
          event.dataTransfer.setData("application/x-rr-card", JSON.stringify({ type: activeCat, name: card.name }));
          event.dataTransfer.effectAllowed = "copy";
        } catch { /* 忽略 */ }
      });
      node.addEventListener("click", () => {
        let bucket = cardSelection.get(activeCat);
        if (!bucket) {
          bucket = new Set();
          cardSelection.set(activeCat, bucket);
        }
        if (bucket.has(card.name)) bucket.delete(card.name);
        else bucket.add(card.name);
        if (!bucket.size) cardSelection.delete(activeCat);
        node.classList.toggle("rr-selected", bucket?.has(card.name) || false);
        refreshSelBtns();
        showCardContent(card);
      });
      if (!special) {
        node.addEventListener("dblclick", (event) => {
          event.stopPropagation();
          editCard(card.name);
        });
        node.append(el("div", { class: "rr-card-ops" }, [
          el("span", { class: "rr-op", title: "Edit card content / cover", text: "✎", onclick: (event) => { event.stopPropagation(); editCard(card.name); } }),
          el("span", { class: "rr-op rr-op-danger", title: "Delete card", text: "×", onclick: (event) => { event.stopPropagation(); deleteCard(card.name); } }),
        ]));
      }
      gridBox.append(node);
    }
  }

  async function editCard(name) {
    try {
      const data = await apiGet(`/ricerabbit/wildcards/${encodeURIComponent(activeCat)}/${encodeURIComponent(name)}`);
      const result = await openEditor({
        title: `Edit card <${activeCat}:${name}>`,
        value: data.content || "",
        placeholder: "Card content (multiple lines, one group per line; may reference other <category:card>)",
        name, // 卡片名可改: 保存时名字变了就先改名, 封面会跟着一起挪
        // 封面是独立文件, 选完立即保存, 关掉弹层也会保留
        cover: { type: activeCat, name, onChange: () => loadCards(activeCat) },
      });
      if (!result) return;

      const newName = String(result.name ?? name).trim() || name;
      if (newName !== name) {
        try {
          await apiPost("/ricerabbit/wildcards/rename", { type: activeCat, name, new_name: newName });
          const bucket = cardSelection.get(activeCat);
          if (bucket?.delete(name)) bucket.add(newName); // 选中集合同步改名
        } catch (e) {
          toast("Rename failed: " + e.message, "error");
          return;
        }
      }

      await apiPost("/ricerabbit/wildcards/save", { type: activeCat, name: newName, content: result.value });
      await loadCards(activeCat);
      toast(`Saved <${activeCat}:${newName}>`, "success");
    } catch (e) {
      toast("Edit failed: " + e.message, "error");
    }
  }

  async function deleteCard(name) {
    if (!window.confirm(`Delete card <${activeCat}:${name}>?\n(it is moved to the plugin's data/trash, not really deleted)`)) return;
    try {
      await apiPost("/ricerabbit/wildcards/delete", { type: activeCat, name });
      await loadCards(activeCat);
      toast("Deleted 🌸", "success");
    } catch (e) {
      toast("Delete failed: " + e.message, "error");
    }
  }

  newCardBtn.addEventListener("click", async () => {
    if (!activeCat) {
      toast("Pick a category first", "warn");
      return;
    }
    const name = window.prompt(`New card in “${activeCat}” — enter the card name:`);
    if (!name || !name.trim()) return;
    try {
      await apiPost("/ricerabbit/wildcards/save", { type: activeCat, name: name.trim(), content: "" });
      await loadCards(activeCat);
      toast(`Created <${activeCat}:${name.trim()}>`, "success");
    } catch (e) {
      toast("Create failed: " + e.message, "error");
    }
  });

  newCatBtn.addEventListener("click", async () => {
    const name = window.prompt("New category — enter the name:");
    if (!name || !name.trim()) return;
    try {
      await apiPost("/ricerabbit/wildcards/create-type", { name: name.trim() });
      activeCat = name.trim();
      await loadTypes();
      toast(`Created category ${name.trim()}`, "success");
    } catch (e) {
      toast("Create failed: " + e.message, "error");
    }
  });

  // ---------------- 提示词库 ----------------

  async function loadPromptLibrary() {
    const data = await apiGet("/ricerabbit/prompts");
    promptGroups = new Map(Object.entries(data.groups || {}));
    builtinGroups = new Map(Object.entries(data.builtin_groups || {}));
    if (activeLib === "prompts") {
      const all = [...builtinGroups.keys(), ...promptGroups.keys()];
      if (!all.includes(activeCat)) activeCat = all[0] || "";
      renderCats();
      renderPromptGrid();
    }
    refreshLibInfo();
  }

  function renderPromptGrid() {
    if (activeLib !== "prompts") return;
    clear(gridBox);

    // 内置库 (ANR 的预设, 只读): 标签是 [英文, 中文], 点击选中英文
    if (builtinGroups.has(activeCat)) {
      const tags = builtinGroups.get(activeCat) || [];
      if (!tags.length) {
        gridBox.append(el("div", { class: "rr-empty", text: "This built-in group is empty" }));
        return;
      }
      const cloud = el("div", { class: "rr-tagcloud" });
      for (const [en, zh] of tags) {
        // 和 ANR 一样做双语标签: 英文在上, 中文译文小字在下
        const node = el("div", {
          class: "rr-tag rr-tag-builtin" + (promptSelection.has(en) ? " rr-selected" : ""),
          title: "Click to select / deselect",
        }, zh ? [
          el("span", { text: en }),
          el("span", { class: "rr-tag-zh", text: zh }),
        ] : [el("span", { text: en })]);
        node.addEventListener("click", () => {
          if (promptSelection.has(en)) promptSelection.delete(en);
          else promptSelection.add(en);
          node.classList.toggle("rr-selected", promptSelection.has(en));
          refreshSelBtns();
        });
        cloud.append(node);
      }
      gridBox.append(cloud);
      return;
    }

    const tags = promptGroups.get(activeCat) || [];
    if (!tags.length) {
      gridBox.append(el("div", { class: "rr-empty", text: "No saved prompts in this category yet" }));
      return;
    }
    const cloud = el("div", { class: "rr-tagcloud" });
    for (const tag of tags) {
      const del = el("span", { class: "rr-tag-del", text: "×", title: "Delete from the prompt library" });
      const node = el("div", {
        class: "rr-tag" + (promptSelection.has(tag) ? " rr-selected" : ""),
        title: "Click to select / deselect",
      }, [el("span", { text: tag }), del]);
      node.addEventListener("click", () => {
        if (promptSelection.has(tag)) promptSelection.delete(tag);
        else promptSelection.add(tag);
        node.classList.toggle("rr-selected", promptSelection.has(tag));
        refreshSelBtns();
      });
      del.addEventListener("click", async (event) => {
        event.stopPropagation(); // 别把这次点击当成"选中标签"
        try {
          await apiPost("/ricerabbit/prompts/delete", { text: tag });
          promptSelection.delete(tag);
          await loadPromptLibrary();
          toast(`Removed from the prompt library: ${tag}`, "success");
        } catch (e) {
          toast("Delete failed: " + e.message, "error");
        }
      });
      cloud.append(node);
    }
    gridBox.append(cloud);
  }

  favBtn.addEventListener("click", async () => {
    const result = await openEditor({
      title: "Save a prompt to the library",
      value: "",
      category: activeCat || "Default",
      placeholder: "Tag or prompt to save",
      multiline: false,
    });
    if (!result || !result.value.trim()) return;
    try {
      await apiPost("/ricerabbit/prompts/add", {
        text: result.value.trim(),
        category: (result.category || "Default").trim() || "Default",
      });
      activeCat = (result.category || "Default").trim() || "Default";
      await loadPromptLibrary();
      renderCats();
      renderPromptGrid();
      toast("Saved 🌸", "success");
    } catch (e) {
      toast("Save failed: " + e.message, "error");
    }
  });

  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "⏳ Refreshing";
    try {
      await apiPost("/ricerabbit/refresh", {});
      cardsCache.clear();
      await loadTypes();
      await loadPromptLibrary();
      if (activeLib === "prompts") {
        if (!promptGroups.has(activeCat)) activeCat = [...promptGroups.keys()][0] || "";
        renderCats();
        renderPromptGrid();
      }
      refreshLibInfo();
      previewBox.textContent = "Library reloaded";
      toast("Card and prompt libraries reloaded", "success");
    } catch (e) {
      toast("Refresh failed: " + e.message, "error");
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = "🔄 Refresh";
    }
  });

  // ---------------- 库切换 ----------------
  function switchLib(which) {
    activeLib = which;
    const isCards = which === "cards";
    tabCards.classList.toggle("rr-active", isCards);
    tabPrompts.classList.toggle("rr-active", !isCards);
    newCardBtn.style.display = isCards ? "" : "none";
    newCatBtn.style.display = isCards ? "" : "none";
    favBtn.style.display = isCards ? "none" : "";
    // 卡片内容预览只在卡片库里有意义
    previewBox.style.display = isCards ? "" : "none";
    activeCat = isCards
      ? (types.includes(activeCat) ? activeCat : types[0] || "")
      : ([...builtinGroups.keys(), ...promptGroups.keys()][0] || "");
    renderCats();
    refreshSelBtns();
    refreshLibInfo();
    if (isCards) {
      if (cardsCache.has(activeCat)) renderCards();
      else loadCards(activeCat);
      previewBox.textContent = "Click a card to preview its content";
    } else {
      renderPromptGrid();
      // 每次切到提示词库都重新拉一次: 在设置里换过库目录能立刻看到新数据
      loadPromptLibrary();
    }
  }

  tabCards.addEventListener("click", () => switchLib("cards"));
  tabPrompts.addEventListener("click", () => switchLib("prompts"));

  // ---------------- 卡片拖入编辑器 ----------------

  editor.addEventListener("dragover", (event) => {
    if (!event.dataTransfer) return;
    if (![...event.dataTransfer.types].includes("application/x-rr-card")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    editor.classList.add("rr-drag-over");
  });
  editor.addEventListener("dragleave", (event) => {
    if (!editor.contains(event.relatedTarget)) editor.classList.remove("rr-drag-over");
  });
  editor.addEventListener("drop", (event) => {
    const raw = event.dataTransfer?.getData("application/x-rr-card");
    if (!raw) return;
    event.preventDefault();
    editor.classList.remove("rr-drag-over");
    try {
      const { type, name } = JSON.parse(raw);
      if (appendTags([`<${type}:${name}>`])) toast(`Added <${type}:${name}>`, "success");
    } catch { /* 忽略非法数据 */ }
  });

  // ---------------- 关闭 ----------------

  function close() {
    if (closed) return;
    closed = true;
    suggest.destroy();
    document.removeEventListener("keydown", onKey);
    document.body.style.overflow = "";
    overlay.remove();
    if (text !== initial) {
      try {
        setValue(text);
      } catch { /* 忽略 */ }
    }
  }

  function onKey(event) {
    if (event.key !== "Escape") return;
    // 更上层的弹层 (小编辑器 / 补全下拉) 先处理 Esc, 别把整个窗口关掉
    if (document.querySelector(".rr-mini-overlay")) return;
    if (document.querySelector(".rr-suggest:not(.rr-hidden)")) return;
    event.stopPropagation();
    close();
  }

  closeBtn.addEventListener("click", close);
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKey, true);

  document.body.append(overlay);
  document.body.style.overflow = "hidden";
  setMode("tags");
  refreshSelBtns();

  // 首次加载两个库
  (async () => {
    try {
      await loadTypes();
    } catch (e) {
      clear(gridBox);
      gridBox.append(el("div", { class: "rr-empty", text: "Failed to load the card library: " + e.message }));
    }
    try {
      await loadPromptLibrary();
    } catch { /* 提示词库缺失不阻塞弹窗 */ }
  })();

  return { close, overlay };
}
