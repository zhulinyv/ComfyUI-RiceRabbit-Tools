// 图片对比节点: 自动收集图里所有「图片类型」的 Get + 节点内手动切图预览 + 全屏对比窗口
//
// 节点没有输入接线点: 提交任务前会包装 app.graphToPrompt, 把收集到的 Get 上游
// 临时接到节点的 image1..N 上, 这样后端拿得到 tensor、上游节点也会进执行图。
// 图片由后端 (ricerabbit_compare.py) 落成 temp 下的 PNG, 前端只负责展示,
// 所以节点里显示的和对比窗口里看到的是同一份像素, 不会因为预览缩放而产生差异。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { apiPost, clear, el, themeClass, toast } from "./rr_common.js";

const NODE_TYPE = "RiceRabbitImageCompare";
const GET_TYPE = "RiceRabbitGetNode";



// ---------------------------------------------------------------- Get 收集

/** Get 输出的类型; 还没同步过 (还是 `*`) 时退回去看它对应的 Set 的输入类型。 */
function getSlotType(node) {
  const declared = node.outputs?.[0]?.type;
  if (declared && declared !== "*") return declared;
  try {
    for (const setter of node.findSetters?.() || []) {
      const type = setter?.inputs?.[0]?.type;
      if (type && type !== "*") return type;
    }
  } catch {
    /* 忽略 */
  }
  return declared || "*";
}

/**
 * Get 穿透到第一个有效 Set 上游的那条 link (Get 是虚拟节点, 自己没有输入)。
 * 返回 { originId, originSlot } —— 直接拿去拼 API prompt 的 [节点id, 输出槽]。
 */
function getUpstream(node) {
  try {
    const link = node.getInputLink?.();
    if (link && link.origin_id != null) {
      return { originId: String(link.origin_id), originSlot: Number(link.origin_slot) || 0 };
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

function nodePos(node) {
  const pos = node?.pos;
  if (!pos) return [0, 0];
  const x = typeof pos[0] === "number" ? pos[0] : (pos.x ?? 0);
  const y = typeof pos[1] === "number" ? pos[1] : (pos.y ?? 0);
  return [x, y];
}

/**
 * 收集图里所有「图片类型」的 Get。
 * - 跳过 Bypass / Never 的 Get
 * - 按画布位置从上到下、从左到右排 (和用户看到的顺序一致)
 * - 同一个 Set 上游被多个 Get 引用时只取一次 (那是同一张图)
 */
function collectImageGets() {
  const list = [];
  const seen = new Set();
  for (const node of app.graph?._nodes || []) {
    if (node?.type !== GET_TYPE) continue;
    if (node.mode === 2 || node.mode === 4) continue; // Never / Bypass
    if (String(getSlotType(node)).toUpperCase() !== "IMAGE") continue;
    const upstream = getUpstream(node);
    if (!upstream) continue;
    const key = `${upstream.originId}:${upstream.originSlot}`;
    if (seen.has(key)) continue; // 多个 Get 指向同一个上游 = 同一张图
    seen.add(key);
    list.push({
      node,
      originId: upstream.originId,
      originSlot: upstream.originSlot,
      name: String(node.widgets?.[0]?.value || node.title || `Get ${node.id}`).trim(),
    });
  }
  list.sort((a, b) => {
    const [ax, ay] = nodePos(a.node);
    const [bx, by] = nodePos(b.node);
    return ay - by || ax - bx;
  });
  return list;
}

// 提交任务时收集到的名字, 按节点 id 存: 执行完再读节点上的 Get 列表可能已经变了
const pendingNames = new Map();

// ---------------------------------------------------------------- 图片记录

// 图片条目按节点 id 存在模块级 Map 里, 不挂在 node 上:
// 实测执行完成后有的插件会把节点对象整个重建一遍 (旧对象被丢弃),
// 挂在 node 上的数据会跟着消失, 而 id 是不变的。
const imageStore = new Map();
const EMPTY_IMAGES = [];

/**
 * 把 node.__rrImages 接到 imageStore 上 (读写都走 Map)。
 * 节点被重建后扫描器会重新绑定一次, 图片还在 Map 里, 于是能立刻恢复。
 */
function bindImageStore(node) {
  const current = Object.getOwnPropertyDescriptor(node, "__rrImages");
  if (current && current.get) return;
  try {
    Object.defineProperty(node, "__rrImages", {
      configurable: true,
      enumerable: false,
      get() {
        return imageStore.get(String(node.id)) || EMPTY_IMAGES;
      },
      set(value) {
        imageStore.set(String(node.id), Array.isArray(value) ? value : EMPTY_IMAGES);
      },
    });
  } catch {
    /* 节点被冻结时退回普通属性 (极少见) */
  }
}

function imageUrl(record) {
  const params = new URLSearchParams({
    filename: record.filename || "",
    subfolder: record.subfolder || "",
    type: record.type || "temp",
    // 固定文件名 + 每次执行覆盖写, 不带随机数浏览器会给旧缓存
    rand: Math.random().toString(36).slice(2, 10),
  });
  return api.apiURL(`/view?${params.toString()}`);
}

/**
 * 把后端返回的记录变成可渲染的条目。
 * @param {object} node
 * @param {object[]} records 后端 ui.rr_images (或 workflow 里存的副本)
 * @param {{persist?: boolean, names?: string[]}} options
 *   persist=true 时同时写进 node.properties (刷新页面后还能恢复);
 *   names 是提交任务时收集到的 Get 变量名, 按顺序对应每张图
 */
function applyRecords(node, records, { persist = true, names = null } = {}) {
  const usable = (Array.isArray(records) ? records : []).filter((rec) => rec && rec.filename);
  const perSlot = new Map();
  for (const rec of usable) perSlot.set(rec.slot, (perSlot.get(rec.slot) || 0) + 1);

  const entries = usable.map((rec, index) => {
    // 恢复 workflow 时 records 里已经带好了 label, 直接用
    const base = (names && names[index]) || rec.label || `Image ${index + 1}`;
    const multi = perSlot.get(rec.slot) > 1 && !/\s#\d+$/.test(base);
    const label = multi ? `${base} #${(rec.batch ?? 0) + 1}` : base;

    const entry = {
      slot: rec.slot,
      order: rec.order || index + 1,
      batch: rec.batch ?? 0,
      filename: rec.filename,
      subfolder: rec.subfolder || "",
      type: rec.type || "temp",
      width: rec.width,
      height: rec.height,
      label,
      url: imageUrl(rec),
      broken: false,
      img: null,
    };
    const image = new Image();
    image.onload = () => {
      entry.broken = false;
      node.setDirtyCanvas(true, true);
    };
    image.onerror = () => {
      entry.broken = true;
      node.setDirtyCanvas(true, true);
    };
    image.src = entry.url;
    entry.img = image;
    return entry;
  });

  node.__rrImages = entries;
  node.__rrIndex = 0;

  if (persist) persistImages(node, entries);

  node.setDirtyCanvas(true, true);
}

/** 把图片记录写进 node.properties (随 workflow 一起保存, 刷新后还能显示)。 */
function persistImages(node, entries) {
  if (!node.properties) return;
  // 只存还原需要的字段 (不含 Image 对象)
  node.properties.rrImages = entries.map((entry) => ({
    slot: entry.slot,
    order: entry.order,
    batch: entry.batch ?? 0,
    filename: entry.filename,
    subfolder: entry.subfolder || "",
    type: entry.type || "temp",
    width: entry.width,
    height: entry.height,
    label: entry.label,
  }));
}

function restoreFromProperties(node) {
  const saved = node.properties?.rrImages;
  if (Array.isArray(saved) && saved.length) applyRecords(node, saved, { persist: false });
}

// ---------------------------------------------------------------- 节点内预览

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawPlaceholder(ctx, text, x, y, w, h) {
  const lines = String(text).split("\n");
  const lineH = 17;
  ctx.font = "12px -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif";
  ctx.fillStyle = "rgba(180, 186, 200, 0.62)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const startY = y + h / 2 - ((lines.length - 1) * lineH) / 2;
  lines.forEach((line, index) => {
    ctx.fillText(line, x + w / 2, startY + index * lineH, Math.max(w - 16, 20));
  });
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

// ---- 节点内面板布局 ----
//
// 节点没有输入点, 整个内容区都归面板: 上面预览, 中间切换条, 下面按钮。
const PANEL_PAD = 8;
const BAR_H = 24; // 切换条
const BTN_H = 26; // 打开对比窗口按钮
const DEFAULT_W = 520;
const DEFAULT_H = 460;

function panelLayout(node) {
  const width = node.size?.[0] ?? DEFAULT_W;
  const height = node.size?.[1] ?? DEFAULT_H;
  const x = PANEL_PAD;
  const right = width - PANEL_PAD;
  const bottom = height - PANEL_PAD;
  const w = Math.max(right - x, 40);

  const btn = { x, y: bottom - BTN_H, w, h: BTN_H };
  const bar = { x, y: btn.y - 6 - BAR_H, w, h: BAR_H };
  const img = { x, y: PANEL_PAD, w, h: Math.max(40, bar.y - 6 - PANEL_PAD) };
  return { img, bar, btn };
}

function inRect(pos, rect) {
  return pos && pos[0] >= rect.x && pos[0] <= rect.x + rect.w && pos[1] >= rect.y && pos[1] <= rect.y + rect.h;
}

/** 当前该显示第几张 (手动切换, 索引越界时夹回范围内的第一张)。 */
function currentIndex(node, total) {
  if (!total) return 0;
  const index = node.__rrIndex || 0;
  return ((index % total) + total) % total;
}

function drawPanel(ctx, node) {
  const L = panelLayout(node);
  const list = node.__rrImages || [];

  // 图片底板
  ctx.save();
  roundRect(ctx, L.img.x, L.img.y, L.img.w, L.img.h, 8);
  ctx.fillStyle = "rgba(0, 0, 0, 0.34)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.09)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  const index = currentIndex(node, list.length);
  const entry = list[index];
  const image = entry?.img;
  const hovering = node.__rrHover && inRect(node.__rrHover, L.img);

  if (!list.length) {
    drawPlaceholder(ctx, "No images yet\nRun the queue to collect every IMAGE-typed Get", L.img.x, L.img.y, L.img.w, L.img.h);
  } else if (!image || !image.naturalWidth) {
    drawPlaceholder(ctx, entry?.broken ? "Image expired\nRun the queue again" : "Loading image…", L.img.x, L.img.y, L.img.w, L.img.h);
  } else {
    // contain: 保持原始宽高比
    const scale = Math.min(L.img.w / image.naturalWidth, L.img.h / image.naturalHeight);
    const drawW = image.naturalWidth * scale;
    const drawH = image.naturalHeight * scale;
    ctx.save();
    roundRect(ctx, L.img.x, L.img.y, L.img.w, L.img.h, 8);
    ctx.clip();
    ctx.drawImage(
      image,
      L.img.x + (L.img.w - drawW) / 2,
      L.img.y + (L.img.h - drawH) / 2,
      drawW,
      drawH,
    );
    ctx.restore();
  }

  drawSwitchBar(ctx, L.bar, node, list, index, hovering);
  drawOpenButton(ctx, L.btn, hovering);
}

/** 切换条: ◀ 3/5 · 名称 ▶ —— 手动点箭头切图, 名称取上游 (Get 变量名)。 */
function drawSwitchBar(ctx, rect, node, list, index, hot) {
  ctx.save();
  roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 7);
  ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
  ctx.fill();
  ctx.strokeStyle = hot ? "rgba(255, 255, 255, 0.18)" : "rgba(255, 255, 255, 0.1)";
  ctx.lineWidth = 1;
  ctx.stroke();

  const total = list.length;
  const arrowW = 26;
  const prev = { x: rect.x, y: rect.y, w: arrowW, h: rect.h };
  const next = { x: rect.x + rect.w - arrowW, y: rect.y, w: arrowW, h: rect.h };

  ctx.font = "12px -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const midY = rect.y + rect.h / 2 + 0.5;

  const drawArrow = (box, glyph, enabled, hovered) => {
    ctx.fillStyle = !enabled
      ? "rgba(160, 166, 180, 0.32)"
      : hovered
        ? "rgba(255, 255, 255, 0.98)"
        : "rgba(226, 230, 240, 0.82)";
    ctx.fillText(glyph, box.x + box.w / 2, midY);
  };

  const canSwitch = total > 1;
  drawArrow(prev, "◀", canSwitch, node.__rrHoverArrow === -1);
  drawArrow(next, "▶", canSwitch, node.__rrHoverArrow === 1);

  const label = total ? `${index + 1}/${total} · ${list[index]?.label || "Image"}` : "No images";
  ctx.fillStyle = "rgba(232, 236, 244, 0.92)";
  const maxW = rect.w - arrowW * 2 - 8;
  let shown = label;
  if (ctx.measureText(shown).width > maxW) {
    while (shown.length > 4 && ctx.measureText(shown + "…").width > maxW) shown = shown.slice(0, -1);
    shown += "…";
  }
  ctx.fillText(shown, rect.x + rect.w / 2, midY);
  ctx.restore();
}

function drawOpenButton(ctx, rect, hot) {
  ctx.save();
  roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 7);
  ctx.fillStyle = hot ? "rgba(122, 162, 255, 0.3)" : "rgba(122, 162, 255, 0.16)";
  ctx.fill();
  ctx.strokeStyle = hot ? "rgba(150, 180, 255, 0.85)" : "rgba(122, 162, 255, 0.5)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.font = "12px -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif";
  ctx.fillStyle = hot ? "rgba(255, 255, 255, 0.98)" : "rgba(226, 236, 255, 0.9)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("🔍 Open compare window", rect.x + rect.w / 2, rect.y + rect.h / 2 + 0.5);
  ctx.restore();
}

/** 切换图片: step = ±1, 循环。 */
function stepImage(node, step) {
  const total = (node.__rrImages || []).length;
  if (total < 2) return;
  node.__rrIndex = (currentIndex(node, total) + step + total) % total;
  node.setDirtyCanvas(true, true);
}

// ---------------------------------------------------------------- 对比窗口

const OPEN_CLASS = "rr-cmp-overlay";

/**
 * 打开对比窗口。
 * @param {object} node
 */
function openCompareWindow(node) {
  const images = (node.__rrImages || []).filter((entry) => entry && entry.url);
  if (!images.length) {
    toast("No images yet: add an IMAGE-typed Get, then run the queue", "warn");
    return;
  }
  // 同一个工作流只留一个对比窗口
  document.querySelector(`.${OPEN_CLASS}`)?.remove();

  let idxA = 0;
  let idxB = images.length > 1 ? 1 : 0;
  let splitPct = 50;
  let follow = true;

  const overlay = el("div", { class: `rr-overlay ${OPEN_CLASS} ${themeClass()}` });
  const box = el("div", { class: "rr-modal rr-cmp" });

  const closeBtn = el("button", { class: "rr-btn rr-danger", type: "button", text: "✖ Close" });
  const head = el("div", { class: "rr-head" }, [
    el("div", { class: "rr-title", text: "🍚 Image Compare" }),
    el("span", { class: "rr-sub", text: `${images.length} image(s) · node #${node.id ?? "-"}` }),
    el("div", { class: "rr-spacer" }),
    el("span", { class: "rr-hint", text: "Move the mouse across the image to move the divider" }),
    closeBtn,
  ]);

  // ---------------- 左侧: 全部图片 ----------------

  const listBox = el("div", { class: "rr-cmp-list" });
  const side = el("div", { class: "rr-cmp-side" }, [
    el("div", { class: "rr-cmp-side-head" }, [
      el("span", { class: "rr-label", text: "📚 All images" }),
      el("div", { class: "rr-spacer" }),
      el("span", { class: "rr-hint", text: String(images.length) }),
    ]),
    listBox,
  ]);

  const rows = images.map((image, index) => {
    const thumb = el("img", { class: "rr-cmp-thumb", src: image.url, alt: "", loading: "lazy" });
    const name = el("div", {
      class: "rr-cmp-name",
      text: image.label || `Image ${index + 1}`,
      title: image.label || "",
    });
    const meta = el("div", {
      class: "rr-cmp-dim",
      text: `${image.width || "?"}×${image.height || "?"}`,
    });
    const pickA = el("button", { class: "rr-cmp-pick rr-pick-a", type: "button", text: "A", title: "Set as left image" });
    const pickB = el("button", { class: "rr-cmp-pick rr-pick-b", type: "button", text: "B", title: "Set as right image" });
    const saveOne = el("button", {
      class: "rr-cmp-pick rr-save-one",
      type: "button",
      text: "💾",
      title: "Save this image to output/ricerabbit_compare",
    });
    const row = el("div", { class: "rr-cmp-item", title: "Click to set as right image, double-click for left" }, [
      el("span", { class: "rr-cmp-no", text: String(index + 1) }),
      thumb,
      el("div", { class: "rr-cmp-meta" }, [name, meta]),
      el("div", { class: "rr-cmp-picks" }, [saveOne, pickA, pickB]),
    ]);

    row.addEventListener("click", () => setB(index));
    row.addEventListener("dblclick", (event) => {
      event.preventDefault();
      setA(index);
    });
    pickA.addEventListener("click", (event) => {
      event.stopPropagation();
      setA(index);
    });
    pickB.addEventListener("click", (event) => {
      event.stopPropagation();
      setB(index);
    });
    saveOne.addEventListener("click", (event) => {
      event.stopPropagation();
      saveImages([index]);
    });

    listBox.append(row);
    return { el: row, pickA, pickB };
  });

  // ---------------- 右侧: 对比区 ----------------

  const selA = el("select", { class: "rr-cmp-select", title: "Left image (shown left of the divider)" });
  const selB = el("select", { class: "rr-cmp-select", title: "Right image (shown right of the divider)" });
  for (const [index, image] of images.entries()) {
    const text = `${index + 1}. ${image.label || "Image"}`;
    selA.append(el("option", { value: String(index), text }));
    selB.append(el("option", { value: String(index), text }));
  }

  const swapBtn = el("button", { class: "rr-btn", type: "button", text: "⇄", title: "Swap sides" });
  const lockBtn = el("button", { class: "rr-btn rr-on", type: "button", text: "🖱 Follow cursor" });
  const resetBtn = el("button", {
    class: "rr-btn",
    type: "button",
    text: "↺ Reset view",
    title: "Back to 100% and centered (or press R)",
  });
  const bar = el("div", { class: "rr-cmp-bar" }, [
    el("span", { class: "rr-cmp-key rr-key-a", text: "L" }),
    selA,
    swapBtn,
    el("span", { class: "rr-cmp-key rr-key-b", text: "R" }),
    selB,
    el("div", { class: "rr-spacer" }),
    lockBtn,
    resetBtn,
  ]);

  const imgA = el("img", { class: "rr-cmp-img rr-cmp-img-a", alt: "", draggable: "false" });
  const imgB = el("img", { class: "rr-cmp-img rr-cmp-img-b", alt: "", draggable: "false" });
  const grip = el("div", { class: "rr-cmp-grip" }, [
    el("span", { class: "rr-cmp-arrow", text: "◀" }),
    el("span", { class: "rr-cmp-arrow", text: "▶" }),
  ]);
  const divider = el("div", { class: "rr-cmp-divider" }, [grip]);
  const frame = el("div", { class: "rr-cmp-frame" }, [imgB, imgA, divider]);
  const tagA = el("div", { class: "rr-cmp-tag rr-key-a" });
  const tagB = el("div", { class: "rr-cmp-tag rr-key-b" });
  const zoomLabel = el("div", { class: "rr-cmp-zoom", text: "" });
  const stage = el("div", { class: "rr-cmp-stage" }, [frame, tagA, tagB, zoomLabel]);

  const main = el("div", { class: "rr-cmp-main" }, [bar, stage]);
  const body = el("div", { class: "rr-cmp-body" }, [side, main]);
  box.append(head, body);
  overlay.append(box);
  document.body.append(overlay);

  // ---------------- 行为 ----------------

  function clampIndex(index) {
    const value = Number(index);
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(images.length - 1, Math.trunc(value)));
  }

  function setA(index) {
    const next = clampIndex(index);
    // A / B 撞到同一张时把原来那张让给另一边, 否则两个下拉选同一张就没法对比了
    if (next === idxB && images.length > 1) idxB = idxA;
    idxA = next;
    refresh();
  }

  function setB(index) {
    const next = clampIndex(index);
    if (next === idxA && images.length > 1) idxA = idxB;
    idxB = next;
    refresh();
  }

  function layoutFrame() {
    const naturalW = imgA.naturalWidth || imgB.naturalWidth || 0;
    const naturalH = imgA.naturalHeight || imgB.naturalHeight || 0;
    const ratio = naturalW > 0 && naturalH > 0 ? naturalW / naturalH : 1;
    const availW = stage.clientWidth - 24;
    const availH = stage.clientHeight - 24;
    if (availW < 8 || availH < 8) return;
    let w = availW;
    let h = availW / ratio;
    if (h > availH) {
      h = availH;
      w = availH * ratio;
    }
    frame.style.width = `${Math.floor(w)}px`;
    frame.style.height = `${Math.floor(h)}px`;
  }

  function applySplit() {
    const percent = Math.max(0, Math.min(100, splitPct));
    imgA.style.clipPath = percent >= 100 ? "none" : `inset(0 ${100 - percent}% 0 0)`;
    divider.style.left = `${percent}%`;
  }

  function updateSplit(clientX) {
    const rect = frame.getBoundingClientRect();
    if (!rect.width) return;
    splitPct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    applySplit();
  }

  function refresh() {
    selA.value = String(idxA);
    selB.value = String(idxB);
    const a = images[idxA];
    const b = images[idxB];
    if (imgA.getAttribute("src") !== a.url) imgA.src = a.url;
    if (imgB.getAttribute("src") !== b.url) imgB.src = b.url;
    tagA.textContent = `A · ${idxA + 1}. ${a.label || "Image"}`;
    tagB.textContent = `B · ${idxB + 1}. ${b.label || "Image"}`;
    rows.forEach((row, index) => {
      row.el.classList.toggle("rr-is-a", index === idxA);
      row.el.classList.toggle("rr-is-b", index === idxB);
      row.pickA.classList.toggle("rr-on", index === idxA);
      row.pickB.classList.toggle("rr-on", index === idxB);
    });
    layoutFrame();
    applySplit();
    applyView();
  }

  const observer = new ResizeObserver(() => layoutFrame());
  observer.observe(stage);

  imgA.addEventListener("load", layoutFrame);
  imgB.addEventListener("load", layoutFrame);

  // ---------------- 缩放 / 平移 ----------------
  //
  // 缩放作用在 frame 上 (两张图 + 分割线整体), 所以对比关系始终成立;
  // transform-origin 是 center, 缩放以画面中心为基准, 再配合 pan 做平移。

  const ZOOM_MIN = 1;
  const ZOOM_MAX = 8;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let drag = null;

  function applyView() {
    frame.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    // 分割线和手柄反着缩, 否则放大后线会越来越粗
    divider.style.width = `${2 / zoom}px`;
    divider.style.marginLeft = `${-1 / zoom}px`;
    grip.style.transform = `translate(-50%, -50%) scale(${1 / zoom})`;
    const zoomed = zoom > 1.001;
    zoomLabel.textContent = zoomed ? `${Math.round(zoom * 100)}%` : "";
    zoomLabel.style.display = zoomed ? "block" : "none";
    stage.style.cursor = !zoomed ? "ew-resize" : drag?.moved ? "grabbing" : "grab";
  }

  function clampPan() {
    if (zoom <= 1.001) {
      panX = 0;
      panY = 0;
      return;
    }
    const baseW = parseFloat(frame.style.width) || 0;
    const baseH = parseFloat(frame.style.height) || 0;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const scaledW = baseW * zoom;
    const scaledH = baseH * zoom;
    // 边界必须留得够松: 以鼠标为锚点缩放时画面一定会偏离中心,
    // 要是按"图片不能超出容器"去夹, 锚点就会被拽回中心, 看起来就不跟着鼠标了。
    // 这里只保证画面还有一小块留在视野里。
    const maxX = Math.max(0, (scaledW + sw) / 2 - 48);
    const maxY = Math.max(0, (scaledH + sh) / 2 - 48);
    panX = Math.max(-maxX, Math.min(maxX, panX));
    panY = Math.max(-maxY, Math.min(maxY, panY));
  }

  function resetView() {
    zoom = 1;
    panX = 0;
    panY = 0;
    applyView();
  }

  /** 以屏幕点 (clientX, clientY) 为锚点缩放: 锚点下的像素保持不动。 */
  function zoomAt(next, clientX, clientY) {
    const target = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    if (Math.abs(target - zoom) < 1e-4) return;
    if (target === ZOOM_MIN) {
      resetView();
      return;
    }
    const rect = stage.getBoundingClientRect();
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    const ratio = target / zoom;
    panX = dx - (dx - panX) * ratio;
    panY = dy - (dy - panY) * ratio;
    zoom = target;
    clampPan();
    applyView();
  }

  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      // 用指数曲线, 触控板的小 delta 也能平滑过渡
      zoomAt(zoom * Math.exp(-event.deltaY * 0.0016), event.clientX, event.clientY);
    },
    { passive: false },
  );

  stage.addEventListener("pointermove", (event) => {
    if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 3) drag.moved = true;
      if (drag.moved) {
        panX = drag.panX + dx;
        panY = drag.panY + dy;
        clampPan();
        applyView();
        return; // 拖动时不动分割线
      }
    }
    if (follow) updateSplit(event.clientX);
  });

  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, panX, panY, moved: false };
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      /* 忽略 */
    }
    if (follow) updateSplit(event.clientX);
  });

  const endDrag = () => {
    drag = null;
    applyView();
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  selA.addEventListener("change", () => setA(selA.value));
  selB.addEventListener("change", () => setB(selB.value));

  swapBtn.addEventListener("click", () => {
    const previous = idxA;
    idxA = idxB;
    idxB = previous;
    refresh();
  });

  lockBtn.addEventListener("click", () => {
    follow = !follow;
    lockBtn.classList.toggle("rr-on", follow);
    lockBtn.textContent = follow ? "🖱 Follow cursor" : "📌 Position locked";
  });

  resetBtn.addEventListener("click", resetView);

  // ---------------- 保存 ----------------
  //
  // 图片本身在 ComfyUI 的 temp 目录里 (每次执行都会重建), 所以"保存"是把它们
  // 复制一份到 output/ricerabbit_compare/<时间戳>/, 由后端完成。

  async function saveImages(picks) {
    try {
      const result = await apiPost("/ricerabbit/compare/save", {
        node_id: node.id,
        picks,
        names: images.map((entry) => entry.label || ""),
      });
      toast(`Saved ${result.count} image(s) → output/${result.relative}`, "success");
    } catch (error) {
      toast(`Save failed: ${error?.message || error}`, "error");
    }
  }

  selA.addEventListener("change", () => setA(selA.value));
  selB.addEventListener("change", () => setB(selB.value));

  swapBtn.addEventListener("click", () => {
    const previous = idxA;
    idxA = idxB;
    idxB = previous;
    refresh();
  });

  lockBtn.addEventListener("click", () => {
    follow = !follow;
    lockBtn.classList.toggle("rr-on", follow);
    lockBtn.textContent = follow ? "🖱 Follow cursor" : "📌 Position locked";
  });

  resetBtn.addEventListener("click", resetView);

  // ---------------- 保存 ----------------
  //
  // 图片本身在 ComfyUI 的 temp 目录里 (每次执行都会重建), 所以"保存"是把它们
  // 复制一份到 output/ricerabbit_compare/<时间戳>/, 由后端完成。

  function close() {
    try {
      observer.disconnect();
    } catch {
      /* 忽略 */
    }
    document.removeEventListener("keydown", onKeyDown, true);
    overlay.remove();
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "r" || event.key === "R") {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      event.preventDefault();
      resetView();
    }
  }

  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKeyDown, true);

  refresh();
}

// ---------------------------------------------------------------- 提交注入

/**
 * 提交前把 Get 的图临时接到节点的 image1..N 上。
 * 节点界面上没有输入点, 但后端要拿到 tensor 才能落盘; graphToPrompt 只看
 * input.link 指向的 link 的 origin, 所以给 inputs 塞上真实的 link id 就够了 ——
 * 同时上游节点也会被算进执行图 (这是关键, 光改 prompt 不加入依赖会被裁掉)。
 */
let patchedWrapper = null;

/**
 * 把收集到的 Get 接进 API prompt。
 *
 * 不走"临时给 node.inputs 塞 link"那条路 —— 实测 ComfyUI 在处理 link 时会把
 * 认不出来的 input.link 清成 null (link 的 target 不是本节点), 结果图丢了。
 * 这里直接在 graphToPrompt 的输出上补 [节点id, 输出槽], 不碰图状态;
 * 上游节点本来就在输出里 (graphToPrompt 会遍历整张图), 只要确认存在即可。
 */
function patchGraphToPrompt() {
  if (typeof app.graphToPrompt !== "function") return;
  // 别的插件 (VHS 等) 可能在我们之后再包一层, 每次扫描都检查, 保证我们在最外层
  if (app.graphToPrompt === patchedWrapper) return;

  const origin = app.graphToPrompt.bind(app);
  const wrapper = async function (...args) {
    const result = await origin(...args);
    try {
      const output = result?.output;
      if (!output) return result;
      for (const node of app.graph?._nodes || []) {
        if (node?.type !== NODE_TYPE || node.mode === 2 || node.mode === 4) continue;
        const entry = output[String(node.id)];
        if (!entry) continue;
        // 只取这一批 prompt 里确实存在的上游, 否则后端会报节点不存在
        const gets = collectImageGets().filter((item) => output[item.originId]);
        entry.inputs = entry.inputs || {};
        gets.forEach((item, index) => {
          entry.inputs[`image${index + 1}`] = [item.originId, item.originSlot];
        });
        pendingNames.set(String(node.id), gets.map((item) => item.name));
      }
    } catch (error) {
      console.warn("[RiceRabbit] Failed to inject image inputs", error);
    }
    return result;
  };

  patchedWrapper = wrapper;
  app.graphToPrompt = wrapper;
}

// ---------------------------------------------------------------- 节点装配

function setupNode(node) {
  if (node.__rrCompare) return;
  node.__rrCompare = true;

  bindImageStore(node);

  // 后端声明的 image1..20 只是注入用的槽, 界面上不要接线点。
  // 用 removeInput 而不是直接清数组: 旧版本工作流里这些槽上还挂着真实的线,
  // 清数组会让 link 悬空 (画布上留下找不到落点的连线)。
  if (node.inputs?.length) {
    for (let i = node.inputs.length - 1; i >= 0; i--) {
      try {
        node.removeInput(i);
      } catch {
        /* 忽略 */
      }
    }
  }

  if (!node.__rrSized) {
    node.__rrSized = true;
    const width = Math.max(node.size?.[0] ?? 0, DEFAULT_W);
    const height = Math.max(node.size?.[1] ?? 0, DEFAULT_H);
    node.setSize([width, height]);
  }

  // 自绘: 预览 + 切换条 + 按钮都画在节点上, 不占 widget 布局
  const originDraw = node.onDrawForeground;
  node.onDrawForeground = function (ctx) {
    originDraw?.apply(this, arguments);
    if (this.flags?.collapsed) return;
    try {
      drawPanel(ctx, this);
    } catch (error) {
      console.warn("[RiceRabbit] Failed to draw the preview", error);
    }
  };

  const originMove = node.onMouseMove;
  node.onMouseMove = function (event, pos, canvas) {
    const result = originMove?.apply(this, arguments);
    if (this.flags?.collapsed) return result;
    const L = panelLayout(this);
    const arrow = inRect(pos, { x: L.bar.x, y: L.bar.y, w: 26, h: L.bar.h })
      ? -1
      : inRect(pos, { x: L.bar.x + L.bar.w - 26, y: L.bar.y, w: 26, h: L.bar.h })
        ? 1
        : 0;
    const changed = this.__rrHoverArrow !== arrow || !this.__rrHover;
    this.__rrHover = pos;
    this.__rrHoverArrow = arrow;
    if (changed) this.setDirtyCanvas(true, true);
    return result;
  };

  // 点箭头切图 / 点按钮开窗口。图片本身不拦事件, 这样仍能拖节点。
  const originDown = node.onMouseDown;
  node.onMouseDown = function (event, pos, canvas) {
    const result = originDown?.apply(this, arguments);
    if (result) return result;
    if (this.flags?.collapsed) return result;
    const L = panelLayout(this);
    if (event?.button === 0) {
      if (inRect(pos, L.btn)) {
        openCompareWindow(this);
        return true;
      }
      if (inRect(pos, { x: L.bar.x, y: L.bar.y, w: 26, h: L.bar.h })) {
        stepImage(this, -1);
        return true;
      }
      if (inRect(pos, { x: L.bar.x + L.bar.w - 26, y: L.bar.y, w: 26, h: L.bar.h })) {
        stepImage(this, 1);
        return true;
      }
    }
    return result;
  };

  // 滚轮: 在预览区上滚也能切图
  const originWheel = node.onMouseWheel;
  node.onMouseWheel = function (event, pos, canvas) {
    const result = originWheel?.apply(this, arguments);
    if (result) return result;
    if (this.flags?.collapsed) return result;
    const L = panelLayout(this);
    if (!inRect(pos, L.img)) return result;
    const delta = event?.deltaY ?? 0;
    if (!delta) return result;
    stepImage(this, delta > 0 ? 1 : -1);
    return true;
  };

  // 后端返回 ui.rr_images: 顺序 = 提交时收集到的 Get 顺序。
  // 用闭包里的 node 而不是 this —— 有的前端版本调 onExecuted 时不带节点上下文。
  node.onExecuted = function (message) {
    const records = message?.rr_images;
    if (!Array.isArray(records)) return;
    try {
      // 从图里重新取一次: 加载工作流时节点可能被 ComfyUI 重建
      const target = app.graph?.getNodeById(node.id) || node;
      const names = pendingNames.get(String(target.id)) || pendingNames.get(String(node.id)) || null;
      applyRecords(target, records, { names });
      pendingNames.delete(String(target.id));
    } catch (error) {
      console.error("[RiceRabbit] Failed to apply compare images", error);
    }
  };
}

app.registerExtension({
  name: "RiceRabbit.ImageCompare",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onCreated?.apply(this, arguments);
      try {
        setupNode(this);
      } catch (error) {
        console.error("[RiceRabbit] Image Compare node init failed", error);
      }
      return result;
    };

    // 加载 workflow 时 inputs 会被 configure 覆盖回保存的数量, 图片记录也要还原
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = onConfigure?.apply(this, arguments);
      try {
        // configure 可能把后端声明的 image1..20 (以及旧工作流里的线) 恢复回来, 再清一次
        for (let i = (this.inputs?.length || 0) - 1; i >= 0; i--) {
          try {
            this.removeInput(i);
          } catch {
            /* 忽略 */
          }
        }
        restoreFromProperties(this);
      } catch (error) {
        console.warn("[RiceRabbit] Failed to restore the Image Compare node", error);
      }
      return result;
    };
  },

  // 兜底: 某些版本的节点定义注册早于扩展注册, beforeRegisterNodeDef 不会回调,
  // 这里在每次实例化节点后再装一遍 (setupNode 自带去重, 重复调用无害)。
  nodeCreated(node) {
    if (node?.type !== NODE_TYPE) return;
    try {
      setupNode(node);
    } catch (error) {
      console.error("[RiceRabbit] Image Compare node init failed", error);
    }
  },

  async setup() {
    startScanner();
  },
});

// ---------------------------------------------------------------- 扫描器
//
// 实测这个前端版本里扩展的 beforeRegisterNodeDef / nodeCreated 可能一次都不回调
// (扩展注册晚于节点定义注册), 所以不把 UI 装配押在钩子上: 直接定期扫当前图,
// 发现目标节点就补装。图里节点数量本来就不大, 1.2 秒一次遍历的开销可以忽略。

function scanNodes() {
  const nodes = app.graph?._nodes;
  if (!nodes) return;
  patchGraphToPrompt();
  for (const node of nodes) {
    if (node?.type !== NODE_TYPE) continue;
    try {
      // 节点被重建过一次时 (旧对象带 getter, 新对象是普通属性), 这里重新接上 Map
      bindImageStore(node);
      if (!node.__rrCompare) setupNode(node);
      const images = node.__rrImages || [];
      if (!images.length && node.properties?.rrImages?.length) {
        // 加载 workflow 时 configure 在节点实例创建之后才把 properties 填回来,
        // 这里补一次恢复; 一旦已经有图就不再覆盖 (重新执行会刷新)
        restoreFromProperties(node);
      } else if (images.length && !node.properties?.rrImages?.length) {
        // 节点被重建后 properties 丢了, 把读得到的图写回去 (保存 workflow 时才带得上)
        persistImages(node, images);
      }
    } catch (error) {
      console.error("[RiceRabbit] Image Compare node init failed", error);
    }
  }
}

let scanTimer = null;

function startScanner() {
  if (scanTimer) return;
  patchGraphToPrompt();
  scanTimer = setInterval(scanNodes, 1200);
  scanNodes();
}

// 模块顶层就开始扫: setup 钩子在某些加载顺序下不会触发
setTimeout(startScanner, 1200);

export { openCompareWindow };
