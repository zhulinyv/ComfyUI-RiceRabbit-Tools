// 任意类型选择节点: 输入槽按连接情况动态增减
// 默认两个 (input1 / input2), 连上第 2 个就冒出第 3 个, 依此类推
import { app } from "../../scripts/app.js";

// 与后端 MAX_ANY_SWITCH_INPUTS 保持一致
const MAX_ANY_INPUTS = 20;
const MIN_ANY_INPUTS = 2;

function slotIndex(slot) {
  const match = /^input(\d+)$/.exec(slot?.name || "");
  return match ? Number(match[1]) : 0;
}

/**
 * 只保留"已连接的最后一个 + 1"个输入槽 (至少 2 个)。
 * 尾部没连线的槽直接删掉; 中间断开的空槽保留 —— 删掉会让后面的连线错位。
 */
function syncAnyInputs(node) {
  if (node.__rrSyncing) return;
  node.__rrSyncing = true;
  try {
    let lastLinked = 0;
    for (const slot of node.inputs || []) {
      if (slot?.link != null) lastLinked = Math.max(lastLinked, slotIndex(slot));
    }
    const want = Math.min(Math.max(lastLinked + 1, MIN_ANY_INPUTS), MAX_ANY_INPUTS);

    // 从尾往前删, 只动没连线的槽 (有连线的槽删了线会掉)
    for (let i = (node.inputs?.length || 0) - 1; i >= 0; i--) {
      const index = slotIndex(node.inputs[i]);
      if (index > want && node.inputs[i].link == null) node.removeInput(i);
    }

    // 补齐缺的槽
    for (let n = 1; n <= want; n++) {
      const exists = (node.inputs || []).some((slot) => slotIndex(slot) === n);
      if (!exists) node.addInput(`input${n}`, "*");
    }
    node.setDirtyCanvas(true, true);
  } catch (e) {
    console.warn("[RiceRabbit] Failed to sync any-type inputs", e);
  } finally {
    node.__rrSyncing = false;
  }
}

function setupAnyNode(node) {
  if (node.__rrAnySwitch) return;
  node.__rrAnySwitch = true;

  syncAnyInputs(node);

  const originChange = node.onConnectionsChange;
  node.onConnectionsChange = function (type, index, connected) {
    const result = originChange?.apply(this, arguments);
    // type === 1 是输入侧 (LiteGraph.INPUT)
    if (type === 1) {
      try {
        if (!connected) {
          // 断开后把槽恢复成通配, 否则会被上游类型锁死, 改接别的类型会被拒
          const slot = this.inputs?.[index];
          if (slot && slot.type !== "*") slot.type = "*";
        }
        syncAnyInputs(this);
      } catch {
        /* 忽略 */
      }
    }
    return result;
  };
}

app.registerExtension({
  name: "RiceRabbit.AnySwitch",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "RiceRabbitAnySwitch") return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onCreated?.apply(this, arguments);
      try {
        setupAnyNode(this);
      } catch (e) {
        console.error("[RiceRabbit] Any Switch init failed", e);
      }
      return result;
    };

    // 加载工作流时 inputs 会被 configure 覆盖回保存的数量, 这里再收一次
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = onConfigure?.apply(this, arguments);
      try {
        syncAnyInputs(this);
      } catch {
        /* 忽略 */
      }
      return result;
    };
  },
});
