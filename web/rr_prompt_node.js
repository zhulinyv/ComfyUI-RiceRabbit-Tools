// 节点 UI: 提示词框接自动补全, 高级设置折叠, 标签化弹窗入口
// 以及三个 ComfyUI 设置项 (ANR 目录 / 卡片库目录 / 提示词库文件)
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { apiGet, toast, wireAutocomplete } from "./rr_common.js";
import { openTagModal } from "./rr_modal.js";

const EXT_NAME = "RiceRabbit.Tools";

const SETTING_ANR = "RiceRabbit.ANRPath";
const SETTING_WILDCARDS = "RiceRabbit.WildcardsDir";
const SETTING_PROMPT_LIB = "RiceRabbit.PromptLibraryPath";

// ---------------------------------------------------------------- 设置

const SETTINGS = [
  {
    id: SETTING_ANR,
    name: "Auto-NovelAI-Refactor directory",
    type: "text",
    defaultValue: "",
    category: ["RiceRabbit", "ANR directory"],
    tooltip:
      "Root folder of your Auto-NovelAI-Refactor checkout (e.g. D:\\GitClone\\Auto-NovelAI-Refactor).\n" +
      "When set, the card library (data/state/wildcards) and prompt library (data/state/prompt_library.json) " +
      "are read from there, and its tag dictionary is reused. Leave empty to use the two settings below.",
  },
  {
    id: SETTING_WILDCARDS,
    name: "Wildcards card library folder",
    type: "text",
    defaultValue: "",
    category: ["RiceRabbit", "Card library"],
    tooltip:
      "Root folder of the card library, laid out as <category>/<card>.txt.\n" +
      "Defaults to wildcards/ inside this plugin; when the ANR directory above is set, that one wins.",
  },
  {
    id: SETTING_PROMPT_LIB,
    name: "Prompt library file",
    type: "text",
    defaultValue: "",
    category: ["RiceRabbit", "Prompt library"],
    tooltip:
      "Path to the prompt library json, shaped like [{\"text\": \"tag\", \"category\": \"group\"}].\n" +
      "Defaults to prompts/prompt_library.json inside this plugin; when the ANR directory above is set, that one wins.",
  },
];

function setSetting(id, value) {
  try {
    app.ui.settings.setSettingValue(id, value);
  } catch (e) {
    console.warn("[RiceRabbit] Failed to write setting", id, e);
  }
}

/**
 * 逐项注册设置。
 *
 * 不用 registerExtension 的 `settings` 数组: 那条路径在某些前端版本里会把数组当成
 * 单个对象处理 (只登记第一项), 表现为"设置面板里只出现一个配置"。这里直接调用
 * addSetting, 一项一项来; 已登记过的 id 会被 ComfyUI 自己跳过, 不会重复。
 */
function registerSettings(retries = 15) {
  if (!app.ui?.settings?.addSetting) {
    if (retries > 0) {
      // setup 偶尔早于设置模块就绪: 稍等再试
      setTimeout(() => registerSettings(retries - 1), 200);
      return;
    }
    console.warn("[RiceRabbit] app.ui.settings unavailable, settings not registered");
    return;
  }
  const failed = [];
  for (const item of SETTINGS) {
    try {
      app.ui.settings.addSetting(item);
    } catch (e) {
      failed.push(item.id);
      console.warn("[RiceRabbit] Failed to register setting:", item.id, e);
    }
  }
  if (failed.length) console.warn("[RiceRabbit] Settings that failed to register:", failed.join(", "));
}

/**
 * 只在设置项确实已注册时才写默认值。
 * 否则 setSettingValue 会给一个还没注册的 id 建出"只有值、没有名字/类型"的占位项，
 * 设置面板里那一行就渲染不出来。
 */
function writeDefaultIfRegistered(id, value) {
  if (!value) return;
  let current;
  try {
    current = app.ui.settings.getSettingValue(id, null);
  } catch {
    return;
  }
  if (current === null || current === undefined) return; // 未注册: 不碰
  if (String(current).trim()) return; // 用户已经填过: 不覆盖
  setSetting(id, value);
}

/** 首次使用时把两个"默认目录"落成真实路径, 让用户在设置里能看见并直接改。 */
async function initDefaultPaths() {
  try {
    const cfg = await apiGet("/ricerabbit/config");
    writeDefaultIfRegistered(SETTING_WILDCARDS, cfg.default_wildcards || "");
    writeDefaultIfRegistered(SETTING_PROMPT_LIB, cfg.default_prompt_lib || "");
  } catch (e) {
    console.warn("[RiceRabbit] Failed to read library config", e);
  }
}

// ---------------------------------------------------------------- widget 工具

/** 加一个纯 UI 按钮 (不参与序列化, 不会进 widgets_values)。 */
function addButton(node, label, onClick, height = 26) {
  const widget = node.addWidget("button", label, null, onClick);
  widget.serialize = false;
  widget.options = widget.options || {};
  widget.options.serialize = false;
  widget.computeSize = () => [0, height];
  return widget;
}

/**
 * 给一个 prompt 输入框挂上补全。
 *
 * 不按「这个 textarea 属于哪个节点」来认领 —— 新版 ComfyUI 的 node.pos 是 {x, y}
 * 而不是 [x, y], 按坐标认领在多节点时会把所有人算成同一个, 结果在 A 的弹窗里
 * 改内容而 B 节点上跟着动。这里改成: 谁获得焦点就给谁挂, 与节点归属无关。
 */
function attachAutocomplete(textarea) {
  if (!textarea || textarea.__rrAC) return;
  textarea.__rrAC = wireAutocomplete(textarea, { comma: true });
  textarea.setAttribute('spellcheck', 'false');
  textarea.placeholder = 'Type a prompt, <category:card> wildcards supported; tags autocomplete as you type, the button below opens the tag editor';
}

/**
 * 读节点的画布坐标。
 * 2.0 模式的 Vue 节点把 pos 包成 {x, y}, legacy 模式是 [x, y] / Float32Array —— 两种都要兼容。
 */
function posXY(node) {
  const pos = node?.pos;
  if (!pos) return [0, 0];
  const x = typeof pos[0] === "number" ? pos[0] : (typeof pos.x === "number" ? pos.x : 0);
  const y = typeof pos[1] === "number" ? pos[1] : (typeof pos.y === "number" ? pos.y : 0);
  return [x, y];
}

function sizeWH(node) {
  const size = node?.size;
  if (!size) return [0, 0];
  const w = typeof size[0] === "number" ? size[0] : (typeof size.width === "number" ? size.width : 0);
  const h = typeof size[1] === "number" ? size[1] : (typeof size.height === "number" ? size.height : 0);
  return [w, h];
}

/** 节点在视口里的矩形 (legacy / 2.0 通用)。 */
function nodeScreenRect(node) {
  try {
    const canvasEl = app.canvas?.canvas;
    const rect = canvasEl ? canvasEl.getBoundingClientRect() : { left: 0, top: 0 };
    const ds = app.canvas?.ds;
    const scale = ds?.scale ?? 1;
    const offset = ds?.offset ?? [0, 0];
    const [px, py] = posXY(node);
    const [w, h] = sizeWH(node);
    const left = rect.left + (px + offset[0]) * scale;
    const top = rect.top + (py + offset[1]) * scale;
    const box = { left, top, right: left + w * scale, bottom: top + h * scale };
    if (!Number.isFinite(box.left) || !Number.isFinite(box.bottom) || box.right <= box.left) return null;
    return box;
  } catch {
    return null;
  }
}

/**
 * Legacy canvas 模式下没有 .lg-node-widget 容器, textarea 与节点的对应关系
 * 直接用 widget.element 比对 (坐标换算在 1.58 里对不上, 别猜)。
 */
function findOwnPromptNode(textarea) {
  const rect = textarea.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return null;
  const nodes = app.graph?._nodes || [];
  const owners = nodes.filter((n) => n.type === "RiceRabbitPrompt");
  if (!owners.length) return null;
  // 优先按 widget 的 DOM 引用认领; 不同版本 ComfyUI 上这个引用可能叫 element,
  // 也可能是 widget 自己包了一层, 所以再退一步: 图里只有一个 Prompt 节点时直接认
  const matched = owners.filter((n) =>
    n.widgets?.some(
      (w) => w.name === "prompt" && (w.element === textarea || w.inputEl === textarea || w.element?.contains?.(textarea)),
    ),
  );
  if (matched.length === 1) return matched[0];
  if (owners.length === 1) return owners[0];
  return null;
}

document.addEventListener("focusin", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement)) return;
  if (target.__rrAC) return;

  // Nodes 2.0: 输入框在 .lg-node-widget 容器里
  if (target.closest('.lg-node-widget[data-widget-name="prompt"]')) {
    attachAutocomplete(target);
    return;
  }
  // Legacy canvas: ComfyUI 的 DOM widget textarea, 按位置认领归属
  if (!target.classList.contains("comfy-multiline-input")) return;
  if (target.closest(".d2-prompt-convert")) return; // 其他插件自己的多行框不碰
  if (findOwnPromptNode(target)) attachAutocomplete(target);
});


// ---------------------------------------------------------------- 节点增强

function setupPromptNode(node) {
  if (node.__rrSetup) return;
  node.__rrSetup = true;

  const promptWidget = node.widgets?.find((w) => w.name === "prompt");
  const formatWidget = node.widgets?.find((w) => w.name === "format");
  const sepWidget = node.widgets?.find((w) => w.name === "separator");

  if (promptWidget) {
    promptWidget.label = "Prompt";
    // 补全由 document 上的 focusin 委托负责 (见 attachAutocomplete),
    // 这里不再按节点去认领 textarea —— 多节点时认领错就会串内容。
  }

  if (sepWidget) sepWidget.label = "Separator";
  if (formatWidget) formatWidget.label = "Format prompt";
  // format / separator 由后端的 "advanced": True 交给 ComfyUI 自己折叠 ——
  // 与 KSampler (Advanced) 完全同一套机制 (节点底部出现 "Show advanced inputs"),
  // 这里不要再手工隐藏, 否则会和官方的折叠区打架。

  const openModal = () => {
    try {
      openTagModal({
        title: "Node prompt",
        getValue: () => promptWidget?.value ?? "",
        setValue: (value) => {
          if (!promptWidget) return;
          promptWidget.value = value;
          // 只写 widget 的值: ComfyUI 自己会把界面同步过去。
          // 这里绝对不要去碰 DOM 里那个 textarea —— 多节点时一旦认领错了,
          // 就会在 A 的弹窗里改内容而 B 节点上跟着变。
          try {
            promptWidget.setValue?.(value);
          } catch { /* 忽略 */ }
          try {
            promptWidget.callback?.(value, app.canvas, node);
          } catch { /* 忽略 */ }
          node.setDirtyCanvas(true, true);
        },
      });
    } catch (e) {
      toast("Failed to open the tag window: " + e.message, "error");
    }
  };

  addButton(node, "🃏 Tag Prompt", openModal, 28);

  // 新建节点时给个合适的初始尺寸 (加载已有 workflow 时 onNodeCreated 不会再跑, 用户的尺寸保留)
  if (!node.__rrSized) {
    node.__rrSized = true;
    if (!node.size || node.size[1] <= 200) {
      node.setSize([440, Math.max(node.size?.[1] ?? 0, 320)]);
    }
  }

  // 卸载时补全那套挂在 textarea 上, 随 DOM 一起回收 (下拉会在失焦时自行清理)
}

// ---------------------------------------------------------------- 分辨率节点

/**
 * 预设下拉与宽高输入框联动:
 * - 选预设 -> 填进宽高
 * - 改宽高 -> 命中预设就切到那项, 没命中切到「自定义」
 * 加载 workflow 时不做初始同步, 保留用户存的组合。
 */
function setupResolutionNode(node) {
  if (node.__rrResSetup) return;
  node.__rrResSetup = true;

  const preset = node.widgets?.find((w) => w.name === "preset");
  const width = node.widgets?.find((w) => w.name === "width");
  const height = node.widgets?.find((w) => w.name === "height");
  if (!preset || !width || !height) return;

  preset.label = "Preset";
  width.label = "Width";
  height.label = "Height";

  let syncing = false;

  const applyPreset = () => {
    const match = /^(\d+)\s*[x×*]\s*(\d+)$/.exec(String(preset.value || ""));
    if (!match) return;
    syncing = true;
    width.value = Number(match[1]);
    height.value = Number(match[2]);
    syncing = false;
    node.setDirtyCanvas(true, true);
  };

  const matchPreset = () => {
    const key = `${width.value}x${height.value}`;
    const values = preset.options?.values || [];
    const hit = values.includes(key) ? key : "Custom";
    if (preset.value === hit) return;
    syncing = true;
    preset.value = hit;
    syncing = false;
    node.setDirtyCanvas(true, true);
  };

  const wrap = (widget, handler) => {
    const original = widget.callback;
    widget.callback = function (...args) {
      const result = original?.apply(this, args);
      if (!syncing) handler();
      return result;
    };
  };

  wrap(preset, applyPreset);
  wrap(width, matchPreset);
  wrap(height, matchPreset);

  if (!node.size || node.size[1] <= 120) {
    node.setSize([320, Math.max(node.size?.[1] ?? 0, 150)]);
  }
}

/** 执行完成后把后端最新的预设列表塞回下拉框 (手填的组合是刚被收录的)。 */
async function refreshResolutionPresets() {
  let data;
  try {
    data = await apiGet("/ricerabbit/resolutions");
  } catch {
    return;
  }
  const values = ["Custom", ...(data.presets || [])];
  for (const node of app.graph?._nodes || []) {
    if (node.type !== "RiceRabbitResolution" && node.comfyClass !== "RiceRabbitResolution") continue;
    const widget = node.widgets?.find((w) => w.name === "preset");
    if (!widget) continue;
    widget.options = widget.options || {};
    widget.options.values = values;
    if (!values.includes(widget.value)) widget.value = "Custom";
    node.setDirtyCanvas(true, true);
  }
}

// ---------------------------------------------------------------- 文本拼接节点

// 与后端 MAX_CONCAT_INPUTS 保持一致
const MAX_CONCAT_INPUTS = 20;

/**
 * 只显示"已连接的最后一个 + 1"个输入槽, 其余未连接的尾部槽直接移除。
 * 连上 text2 就冒出 text3, 连上 text3 就冒出 text4, 依此类推。
 */
function syncConcatInputs(node) {
  if (node.__rrSyncing) return;
  node.__rrSyncing = true;
  try {
    const inputs = node.inputs || [];
    let lastLinked = 1;
    for (const input of inputs) {
      const match = /^text(\d+)$/.exec(input?.name || "");
      if (match && input.link != null) lastLinked = Math.max(lastLinked, Number(match[1]));
    }
    const want = Math.min(Math.max(lastLinked + 1, 2), MAX_CONCAT_INPUTS);

    // 从尾往前删掉多余且没连线的槽 (有连线的槽绝不能动, 否则线会掉)
    for (let i = (node.inputs?.length || 0) - 1; i >= 0; i--) {
      const input = node.inputs[i];
      const match = /^text(\d+)$/.exec(input?.name || "");
      if (!match) continue;
      if (Number(match[1]) > want && input.link == null) {
        node.removeInput(i);
      }
    }

    // separator 只是个输入框, 不需要旁边的输入点
    for (let i = (node.inputs?.length || 0) - 1; i >= 0; i--) {
      const input = node.inputs[i];
      if (input?.name === "separator" && input.link == null) {
        node.removeInput(i);
      }
    }

    // 补齐缺的槽
    for (let n = 2; n <= want; n++) {
      const exists = (node.inputs || []).some((input) => input?.name === `text${n}`);
      if (!exists) node.addInput(`text${n}`, "STRING");
    }
    node.setDirtyCanvas(true, true);
  } catch (e) {
    console.warn("[RiceRabbit] Failed to sync concat inputs", e);
  } finally {
    node.__rrSyncing = false;
  }
}

function setupConcatNode(node) {
  if (node.__rrConcat) return;
  node.__rrConcat = true;

  const sep = node.widgets?.find((w) => w.name === "separator");
  if (sep) sep.label = "Separator";

  syncConcatInputs(node);

  const originChange = node.onConnectionsChange;
  node.onConnectionsChange = function (type, index, connected, linkInfo, ioSlot) {
    const result = originChange?.apply(this, arguments);
    // type === 1 是输入侧 (LiteGraph.INPUT)
    if (type === 1) {
      try {
        syncConcatInputs(this);
      } catch { /* 忽略 */ }
    }
    return result;
  };
}

// ---------------------------------------------------------------- 注册

app.registerExtension({
  name: EXT_NAME,

  async setup() {
    // 设置项逐项手动注册 (不依赖 settings 数组), 然后再补默认路径
    registerSettings();
    console.info("[RiceRabbit] Settings: " + SETTINGS.map((s) => s.id).join(" | "));
    setTimeout(() => {
      initDefaultPaths();
    }, 500);

    // 每次生成结束刷新一次分辨率预设 (新组合已经被后端收录)
    try {
      api.addEventListener("execution_success", () => {
        refreshResolutionPresets();
      });
    } catch (e) {
      console.warn("[RiceRabbit] Failed to hook execution_success", e);
    }
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name === "RiceRabbitConcat") {
      const onCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        const result = onCreated?.apply(this, arguments);
        try {
          setupConcatNode(this);
        } catch (e) {
          console.error("[RiceRabbit] Concat node init failed", e);
        }
        return result;
      };
      // 加载 workflow 时 inputs 会被 configure 覆盖回保存的数量, 这里再收一次
      const onConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function () {
        const result = onConfigure?.apply(this, arguments);
        try {
          syncConcatInputs(this);
        } catch { /* 忽略 */ }
        return result;
      };
      return;
    }

    if (nodeData?.name === "RiceRabbitResolution") {
      const onCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        const result = onCreated?.apply(this, arguments);
        try {
          setupResolutionNode(this);
        } catch (e) {
          console.error("[RiceRabbit] Resolution node init failed", e);
        }
        return result;
      };
      return;
    }

    if (nodeData?.name !== "RiceRabbitPrompt") return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      // onNodeCreated 时 widget 已经建好, 直接增强 (textarea 的 DOM 由 resolveTextarea 自己等)
      try {
        setupPromptNode(this);
      } catch (e) {
        console.error("[RiceRabbit] Node init failed", e);
      }
      return result;
    };
  },
});
