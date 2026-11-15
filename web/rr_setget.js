import { app } from "../../scripts/app.js";

/**
 * 变量存取节点 (Set / Get)。
 *
 * 参照 ComfyUI-Easy-Use 的 easy setNode / easy getNode, 两点不同:
 * 1. 允许同一个变量名存在多个 Set (Easy-Use 会强制改掉重名);
 * 2. Get 的下拉列表把重名去重, 取值时跳过 Bypass / Never 状态的 Set,
 *    按图上顺序取第一个有效 Set 的上游 (bypass 掉的 set 不算数)。
 *
 * 两个节点都是纯前端虚拟节点 (isVirtualNode), 不进提交给后端的 prompt,
 * 数据通路在序列化时由 getInputLink 直接穿透到 Set 的上游, 所以执行顺序天然正确。
 *
 * 注意: 1.58 的 litegraph 只接受继承 LGraphNode 的类 (非继承类 createNode 会返回 null)。
 */

const SET_TYPE = "RiceRabbitSetNode";
const GET_TYPE = "RiceRabbitGetNode";
const LGNode = window.LiteGraph.LGraphNode;

function captureWidgetValue(node, widget) {
  // 拦下所有赋值: 只要写进过非空值就记住, 之后被人清空也能补回来
  let stored = widget.value;
  Object.defineProperty(widget, "value", {
    configurable: true,
    enumerable: true,
    get() {
      return stored;
    },
    set(next) {
      stored = next ?? "";
      if (stored) node.__rrSavedName = stored;
    },
  });
}


// litegraph 的节点 mode: 2 = Never, 4 = Bypass —— 这两种都不算有效
function isEffective(node) {
  return node?.mode !== 2 && node?.mode !== 4;
}

function findSetters(graph, name) {
  if (!graph || !name) return [];
  return (graph._nodes || []).filter(
    (n) => n.type === SET_TYPE && isEffective(n) && n.widgets?.[0]?.value === name,
  );
}

/**
 * 变量名看护。
 *
 * Set/Get 是纯前端虚拟节点, 名字只存在 widgets_values 里。实测 1.58 的加载流程:
 * 值先被填进 widget, 随后另一个扩展 (Easy-Use / rgthree 之类) 又把它清掉,
 * 节点标题跟着退回 "Set"/"Get"。而那时 configure 拿到的 info 已经没有
 * widgets_values 了, 事后补不回来。
 *
 * 所以这里做两件事, 高频扫一遍: 看到值就记到节点上 (__rrSavedName),
 * 看到空值且不是用户主动清空的, 就用记下来的值补回去。
 */
const WATCH_INTERVAL = 120;

function watchVariableNames() {
  for (const node of app.graph?._nodes || []) {
    if (node?.type !== SET_TYPE && node?.type !== GET_TYPE) continue;
    const widget = node.widgets?.[0];
    if (!widget) continue;
    if (widget.value) {
      node.__rrSavedName = widget.value;
      continue;
    }
    if (node.__userEdited) continue;
    const value = node.__rrSavedName || node.properties?.previousName;
    if (!value) continue;
    widget.value = value;
    node.onRename?.();
  }
}

setInterval(watchVariableNames, WATCH_INTERVAL);

app.registerExtension({
  name: "RiceRabbit.SetNode",
  registerCustomNodes() {
    class SetNode extends LGNode {
      static title = "Set";
      static category = "RiceRabbit";
      defaultVisibility = true;
      serialize_widgets = true;
      isVirtualNode = true;

      constructor() {
        super();
        if (!this.properties) {
          this.properties = { previousName: "" };
        }
        this.properties.showOutputText = true;
        const node = this;
        node.color = "#223349";

        const nameWidget = this.addWidget("text", "Variable name", "", () => {
          node.__userEdited = true;
          // 用户主动清空时把存档也清掉, 否则重新加载会被兜底逻辑复活
          if (!node.widgets?.[0]?.value) node.properties.previousName = "";
          node.onRename?.();
        }, {});
        captureWidgetValue(node, nameWidget);

        this.addInput("*", "*");

        // 连线时把类型记录到输入槽, 并同步给所有同名 Get
        // 反序列化时 litegraph 会先恢复连线再恢复 widgets_values, 那时 inputs 可能
        // 还没建好 —— 直接 this.inputs[0] 会抛错并中断 configure, 变量名就丢了
        this.onConnectionsChange = function (slotType, slot, isChangeConnect, linkInfo) {
          if (slotType !== 1) return;
          const input = this.inputs?.[0];
          if (!input) return;
          if (!isChangeConnect) {
            input.type = "*";
            input.name = "*";
          } else if (linkInfo && node.graph) {
            const fromNode = (node.graph._nodes || []).find((n) => n.id === linkInfo.origin_id);
            const type = fromNode?.outputs?.[linkInfo.origin_slot]?.type ?? "*";
            input.type = type;
            input.name = type;
          }
          this.onRename?.();
        };

        // litegraph 落到自定义节点上的 configure 不会恢复 widgets_values
        // (Set/Get 不是 ComfyNode, 走的是原生路径), 这里包一层, 直接用序列化
        // 数据里的原始值补回去
        const originConfigure = this.configure;
        this.configure = function (info) {
          const values = info?.widgets_values;
          const fallback = Array.isArray(values) ? values[0] : values?.["Variable name"] ?? values?.["变量名"];
          // 有的插件加载完还会再 configure 一次 (这次没有 widgets_values),
          // 把第一次读到的名字记在节点上, 后面就靠它兜住
          if (fallback) this.__rrSavedName = fallback;
          const result = originConfigure?.apply(this, arguments);
          const widget = this.widgets?.[0];
          if (widget && !widget.value) {
            const value = this.__rrSavedName || this.properties?.previousName;
            if (value) {
              widget.value = value;
              this.onRename?.();
            }
          }
          return result;
        };
      }

      onRename() {
        const name = this.widgets?.[0]?.value ?? "";
        // 反序列化中途 widgets_values 还没恢复, 这时读到的空值不能覆盖存档
        if (name) this.properties.previousName = name;
        this.title = name ? "Set_" + name : "Set";
        (this.findGetters(app.graph) || []).forEach((getter) => getter.syncOutputs?.());
      }

      findGetters(graph) {
        const name = this.widgets?.[0]?.value ?? "";
        if (!graph || !name) return [];
        return (graph._nodes || []).filter(
          (n) => n.type === GET_TYPE && n.widgets?.[0]?.value === name,
        );
      }

      // 兼容 Easy-Use 风格的 update() 调用
      update() {
        this.onRename?.();
      }
    }

    window.LiteGraph.registerNodeType(SET_TYPE, SetNode);
  },
});

app.registerExtension({
  name: "RiceRabbit.GetNode",
  registerCustomNodes() {
    class GetNode extends LGNode {
      static title = "Get";
      static category = "RiceRabbit";
      defaultVisibility = true;
      serialize_widgets = true;
      isVirtualNode = true;

      constructor() {
        super();
        if (!this.properties) this.properties = {};
        this.properties.showOutputText = true;
        const node = this;
        node.color = "#223349";

        const nameWidget = this.addWidget("combo", "Variable name", "", () => {
          node.__userEdited = true;
          if (!node.widgets?.[0]?.value) node.properties.previousName = "";
          node.onRename?.();
        }, {
          // 下拉选项 = 图里所有有效 Set 的变量名, 重名去重
          values: () => {
            const names = (node.graph?._nodes || [])
              .filter((n) => n.type === SET_TYPE && isEffective(n))
              .map((n) => n.widgets?.[0]?.value ?? "")
              .filter(Boolean);
            return [...new Set(names)].sort();
          },
        });
        captureWidgetValue(node, nameWidget);

        this.addOutput("*", "*");

        this.onConnectionsChange = function (slotType, slot, isChangeConnect, linkInfo) {
          node.validateLinks?.();
          node.onRename?.();
        };

        const originConfigure = this.configure;
        this.configure = function (info) {
          const values = info?.widgets_values;
          const fallback = Array.isArray(values) ? values[0] : values?.["Variable name"] ?? values?.["变量名"];
          // 有的插件加载完还会再 configure 一次 (这次没有 widgets_values),
          // 把第一次读到的名字记在节点上, 后面就靠它兜住
          if (fallback) this.__rrSavedName = fallback;
          const result = originConfigure?.apply(this, arguments);
          const widget = this.widgets?.[0];
          if (widget && !widget.value) {
            const value = this.__rrSavedName || this.properties?.previousName;
            if (value) {
              widget.value = value;
              this.onRename?.();
            }
          }
          return result;
        };
      }

      findSetters() {
        return findSetters(this.graph, this.widgets?.[0]?.value ?? "");
      }

      // 单输出槽: 类型跟随第一个有效 Set
      syncOutputs() {
        const setters = this.findSetters();
        const slot = this.outputs?.[0];
        if (!slot) return;
        const type = setters.length ? (setters[0].inputs?.[0]?.type || "*") : "*";
        if (slot.type !== type) {
          slot.type = type;
          slot.name = type;
          this.validateLinks();
        }
        this.setDirtyCanvas(true, true);
      }

      onRename() {
        const name = this.widgets?.[0]?.value ?? "";
        if (name) this.properties.previousName = name;
        this.title = name ? "Get_" + name : "Get";
        this.syncOutputs();
      }

      validateLinks() {
        const graph = this.graph;
        if (!graph?.links) return;
        for (const output of this.outputs || []) {
          if (output.type === "*" || !output.links) continue;
          for (const linkId of [...output.links]) {
            const link = graph.links[linkId];
            if (link && link.type !== output.type && link.type !== "*") {
              this.graph.removeLink(linkId);
            }
          }
        }
      }

      // 类型变化时重算输出槽 (兼容 Easy-Use 的 update/setType 调用方式)
      setType() {
        this.syncOutputs();
      }

      /**
       * 序列化时把输出穿透到第一个有效 Set 的上游。
       * Bypass / Never 的 Set 被跳过 —— 3 个同名 set bypass 掉 2 个时,
       * 这里拿到的就是剩下那一个的上游, 所以下游确实只会收到一个值。
       */
      getInputLink() {
        const setters = this.findSetters();
        if (!setters.length) return null;
        const setter = setters[0];
        const slotInfo = setter.inputs?.[0];
        if (!slotInfo || slotInfo.link == null) return null;
        return this.graph.links[slotInfo.link];
      }
    }

    window.LiteGraph.registerNodeType(GET_TYPE, GetNode);
  },
});
