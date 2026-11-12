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

        this.addWidget("text", "变量名", "", () => {
          node.onRename?.();
        }, {});

        this.addInput("*", "*");

        // 连线时把类型记录到输入槽, 并同步给所有同名 Get
        this.onConnectionsChange = function (slotType, slot, isChangeConnect, linkInfo) {
          if (slotType !== 1) return;
          if (!isChangeConnect) {
            this.inputs[0].type = "*";
            this.inputs[0].name = "*";
          } else if (linkInfo && node.graph) {
            const fromNode = (node.graph._nodes || []).find((n) => n.id === linkInfo.origin_id);
            const type = fromNode?.outputs?.[linkInfo.origin_slot]?.type ?? "*";
            this.inputs[0].type = type;
            this.inputs[0].name = type;
          }
          this.onRename?.();
        };
      }

      onRename() {
        const name = this.widgets?.[0]?.value ?? "";
        this.properties.previousName = name;
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

        this.addWidget("combo", "变量名", "", () => {
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

        this.addOutput("*", "*");

        this.onConnectionsChange = function (slotType, slot, isChangeConnect, linkInfo) {
          node.validateLinks?.();
          node.onRename?.();
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
        const setters = this.findSetters();
        this.title = setters.length ? "Get_" + this.widgets[0].value : "Get";
        this.syncOutputs();
      }

      validateLinks() {
        for (const output of this.outputs || []) {
          if (output.type === "*" || !output.links) continue;
          for (const linkId of [...output.links]) {
            const link = this.graph.links[linkId];
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
