"""提示词节点 + 分辨率节点 + 日期节点。"""

from __future__ import annotations

import os
from datetime import datetime

import ricerabbit_presets as presets
from ricerabbit_compare import (
    COMPARE_NODE_CLASS_MAPPINGS,
    COMPARE_NODE_DISPLAY_NAME_MAPPINGS,
)
from ricerabbit_text import (
    add_embedding_prefixes,
    format_prompt,
    join_prompt,
    replace_wildcards,
)

CATEGORY = "RiceRabbit"


def _embedding_names() -> set[str]:
    """embeddings 目录里实际可加载的文件名 (规范形式 = 去掉扩展名)。

    ComfyUI 的 load_embed 会自动尝试 .safetensors / .pt / .bin 扩展名,
    所以引用时写不带扩展名的名字即可; .metadata.json 之类的伴生文件不算。
    """
    try:
        import folder_paths

        names = folder_paths.get_filename_list("embeddings")
    except Exception:
        return set()
    out: set[str] = set()
    for name in names or []:
        stem = os.path.splitext(name)[0].strip()
        if stem:
            out.add(stem)
    return out


class RiceRabbitPrompt:
    """提示词: 上游 text + 节点内提示词 -> 拼接 / 格式化 / wildcard -> 文本 + conditioning。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "dynamicPrompts": False,
                        "tooltip": "Prompt text for this node. Tag autocomplete is available while typing; the button below opens the tag editor.",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xffffffffffffffff,
                        "tooltip": "Seed for <category:random> / <category:sequential> picks. Same seed reuses the same cards, so runs stay reproducible.",
                    },
                ),
                "format": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "Format",
                        "label_off": "Raw",
                        # advanced: 交给 ComfyUI 折叠 (与 KSampler (Advanced) 同一套机制,
                        # 节点底部会出现 "Show advanced inputs")
                        "advanced": True,
                        "tooltip": "Tidy up stray spaces and commas (same rules as Auto-NovelAI-Refactor)",
                    },
                ),
                "separator": (
                    "STRING",
                    {
                        "default": ",",
                        "multiline": False,
                        "advanced": True,
                        "tooltip": "Separator used when joining the upstream text with this node's prompt",
                    },
                ),
            },
            "optional": {
                "clip": (
                    "CLIP",
                    {
                        "tooltip": "Optional. Connect a CLIP to encode the prompt into CONDITIONING; without it only `text` is produced.",
                    },
                ),
                "text": (
                    "STRING",
                    {"forceInput": True, "tooltip": "Optional upstream text, joined before this node's own prompt"},
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",  # 执行时由 ComfyUI 注入, 终端打印用它区分节点
            },
        }

    RETURN_TYPES = ("STRING", "CONDITIONING")
    RETURN_NAMES = ("text", "conditioning")
    OUTPUT_TOOLTIPS = (
        "Final prompt used for encoding (joined, wildcards expanded, formatted)",
        "Encoded conditioning, ready for KSampler; empty when no CLIP is connected",
    )
    FUNCTION = "encode"
    CATEGORY = CATEGORY
    DESCRIPTION = "Prompt node: joins upstream text, expands <category:card> wildcards, formats the result, and encodes it to CONDITIONING when a CLIP is connected."

    @classmethod
    def IS_CHANGED(cls, text=None, prompt="", format=True, separator=",", clip=None, seed=0, **kwargs):
        # ComfyUI 0.44 起会把 hidden 输入(unique_id 等)也传给 IS_CHANGED,
        # 用 **kwargs 吸收, 否则抛 TypeError -> 每次排队刷 WARNING 且缓存指纹失效
        # 含 <分类:随机> / <分类:顺序> 时, 指纹带上 seed:
        # 种子不变 -> 指纹相同 -> ComfyUI 直接用上次的抽取结果 (同种子可复现);
        # 种子变化 -> 指纹变化 -> 重新抽取
        combined = f"{text or ''}{prompt or ''}"
        if "<" in combined and any(
            key in combined for key in ("random>", "sequential>", "随机>", "顺序>")
        ):
            return f"wildcard:{seed}:{combined}"
        return ""

    def encode(self, prompt, format=True, separator=",", clip=None, text=None, seed=0, unique_id=None):
        merged = join_prompt(text or "", prompt or "", separator)
        # 顺序与 ANR 一致: 先展开 wildcard, 再补 embedding 前缀, 再格式化
        # (卡片内容里嵌套的 wildcard 与 embedding 裸词也会被逐层处理)
        merged = replace_wildcards(merged, seed=int(seed or 0))
        merged = add_embedding_prefixes(merged, _embedding_names())
        merged = format_prompt(merged, separator, bool(format))
        # 终端打印最终输出, 方便对照生成结果 (节点被缓存跳过时不会重复打印);
        # 带节点序号, 多个提示词节点时能区分是谁打印的
        label = f"RiceRabbit Prompt #{unique_id}" if unique_id is not None else "RiceRabbit Prompt"
        print(f"\n[{label}]\n{'-' * 56}\n{merged}\n{'-' * 56}\n")

        if clip is None:
            # 没接 CLIP: 只做文本处理, conditioning 给空列表 (下游 KSampler 没条件可用时会自己报错)
            return (merged, [])

        tokens = clip.tokenize(merged)
        if hasattr(clip, "encode_from_tokens_scheduled"):
            conditioning = clip.encode_from_tokens_scheduled(tokens)
        else:  # 老版本 ComfyUI 的兜底路径
            cond, pooled = clip.encode_from_tokens(tokens, return_pooled=True)
            conditioning = [[cond, {"pooled_output": pooled}]]
        return (merged, conditioning)


class RiceRabbitResolution:
    """分辨率: 下拉选预设 / 手动填长宽 -> 输出 width, height。

    没有输入。每次执行时把手填的 (width, height) 收录进预设, 下次就能在下拉里选到。
    """

    @classmethod
    def INPUT_TYPES(cls):
        options = [presets.CUSTOM_LABEL] + presets.labels()
        default = options[1] if len(options) > 1 else presets.CUSTOM_LABEL
        return {
            "required": {
                "preset": (
                    options,
                    {
                        "default": default,
                        "tooltip": "Pick a preset to fill in width and height; editing them switches back to the matching preset, or Custom",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 512,
                        "min": 16,
                        "max": 16384,
                        "step": 8,
                        "tooltip": "Output width. Hand-typed combinations are saved as a preset after each run.",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 512,
                        "min": 16,
                        "max": 16384,
                        "step": 8,
                        "tooltip": "Output height",
                    },
                ),
            }
        }

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("width", "height")
    OUTPUT_TOOLTIPS = ("Width", "Height")
    FUNCTION = "run"
    CATEGORY = CATEGORY
    DESCRIPTION = "Resolution picker: preset dropdown plus manual width/height. Hand-typed combinations are added to the presets after running."

    def run(self, preset, width, height):
        w, h = presets.parsed(width, height)
        # 执行即收录: 手填的组合下次会出现在下拉框里
        presets.add_preset(w, h)
        return (w, h)


class RiceRabbitDate:
    """日期: 输出 YYYYMMDD 格式的当天日期。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("date",)
    OUTPUT_TOOLTIPS = ("Today's date as YYYYMMDD, e.g. 20261030",)
    FUNCTION = "run"
    CATEGORY = CATEGORY
    DESCRIPTION = "Outputs today's date (YYYYMMDD)."

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # 吸收 ComfyUI 0.44+ 注入的 hidden 参数(unique_id 等), 避免 TypeError
        # 跨天时必须重算, 否则 ComfyUI 的节点缓存会给回昨天的日期
        return f"{datetime.now():%Y%m%d}"

    def run(self):
        return (datetime.now().strftime("%Y%m%d"),)


class RiceRabbitIntToString:
    """整数转文本: 接一个 INT, 输出它的十进制字符串。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "value": (
                    "INT",
                    {
                        "default": 0,
                        "min": -2147483648,
                        "max": 2147483647,
                        "tooltip": "Connect an INT upstream, or type a number directly",
                    },
                ),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    OUTPUT_TOOLTIPS = ("The integer as a decimal string",)
    FUNCTION = "run"
    CATEGORY = CATEGORY
    DESCRIPTION = "Convert an INT to STRING, handy for filenames, paths and prompts."

    def run(self, value):
        return (str(int(value)),)


MAX_CONCAT_INPUTS = 20


class RiceRabbitConcat:
    """文本拼接: 按顺序接多个 STRING, 中间用分隔符连接。

    后端一次声明 20 个可选输入, 前端只显示"已连接的最后一个 + 1"个,
    所以默认看到 text1 / text2, 连上 text2 就冒出 text3, 依此类推。
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(2, MAX_CONCAT_INPUTS + 1):
            optional[f"text{i}"] = ("STRING", {"forceInput": True})
        return {
            "required": {
                "separator": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "Inserted between every two pieces; leave empty to concatenate directly",
                    },
                ),
                "text1": ("STRING", {"forceInput": True, "tooltip": "First piece of text (required)"}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    OUTPUT_TOOLTIPS = ("All pieces joined in text1, text2, ... order",)
    FUNCTION = "run"
    CATEGORY = CATEGORY
    DESCRIPTION = "Text concat: joins multiple STRING inputs in order. Connecting the next input reveals another slot."

    def run(self, separator="", **kwargs):
        parts = []
        for i in range(1, MAX_CONCAT_INPUTS + 1):
            value = kwargs.get(f"text{i}")
            if value is None:  # 没连的输入不会传进来
                continue
            parts.append(str(value))
        return (str(separator or "").join(parts),)


MAX_ANY_SWITCH_INPUTS = 20


def _is_blank(value) -> bool:
    """输入值算不算"空的"。

    None / 纯空白文本 / 空容器 都算空; 数字 0 与 False 算有内容 (它们是有效取值)。
    tensor 之类没有 len() 的对象一律当作有内容。
    """
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, tuple, dict, set, frozenset)):
        return len(value) == 0
    return False


class RiceRabbitAnySwitch:
    """任意类型选择: 接多个任意类型的输入, 只输出第一个非空的值。

    后端一次声明 20 个可选输入, 前端只显示"已连接的最后一个 + 1"个,
    所以默认看到 input1 / input2, 连上 input2 就冒出 input3, 依此类推。
    空输入 (None / 空文本 / 空列表) 会被跳过, 由下一个有内容的顶上。
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(1, MAX_ANY_SWITCH_INPUTS + 1):
            optional[f"input{i}"] = (
                "*",
                {
                    "forceInput": True,
                    "tooltip": "Any type. Empty values are skipped; the first non-empty input wins",
                },
            )
        return {"required": {}, "optional": optional}

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("value",)
    OUTPUT_TOOLTIPS = ("First non-empty input, passed through unchanged (type follows upstream)",)
    FUNCTION = "pick"
    CATEGORY = CATEGORY
    DESCRIPTION = "Any-type switch: outputs the first non-empty input. Connecting the second input reveals a third slot."

    def pick(self, **kwargs):
        for i in range(1, MAX_ANY_SWITCH_INPUTS + 1):
            value = kwargs.get(f"input{i}")
            if _is_blank(value):  # 没连的输入不会出现在 kwargs 里
                continue
            return (value,)
        print("[RiceRabbit] Any Switch: all inputs are empty, returning None")
        return (None,)


class RiceRabbitExistential:
    """存在性判断: 接任意类型, 有值输出 True, 没接或值为 None 输出 False。

    相当于 ModelSelector.py 里的 ExistentialJudgement, 只判断 None
    (0 / False / 空文本都算"存在", 与任何类型选择节点的"空值"口径不同)。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "any": (
                    "*",
                    {
                        "forceInput": True,
                        "tooltip": "Any type. Presence check only: unconnected or None means False",
                    },
                ),
            }
        }

    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("bool",)
    OUTPUT_TOOLTIPS = ("True when a value is present; False when unconnected or None",)
    FUNCTION = "exists"
    CATEGORY = CATEGORY
    DESCRIPTION = "Existential check: outputs True when the input has a value, False when unconnected or None."

    def exists(self, any=None):
        return (any is not None,)


class RiceRabbitFormatText:
    """格式化文本: 整理逗号与空格 (规则与 ModelSelector.py 的 Format_str 一致)。

    逐行处理: 逗号两侧的空白/连续逗号统一成 ", ", 连续空格压成一个,
    每行首尾去空白; 换行与空行原样保留。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": (
                    "STRING",
                    {"forceInput": True, "tooltip": "Prompt to clean up"},
                ),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    OUTPUT_TOOLTIPS = ("Cleaned-up text",)
    FUNCTION = "run"
    CATEGORY = CATEGORY
    DESCRIPTION = "Format text: removes redundant commas and spaces, keeps line breaks intact."

    def run(self, text):
        return (format_prompt(text or "", ",", True),)


class RiceRabbitSetNode:
    """变量写入 (Set) —— 真正的逻辑在 web/rr_setget.js, 是纯前端虚拟节点。

    这里只放一份"菜单占位"定义: 纯前端节点没有 nodeDef, 新版节点库只会把它
    丢进搜索/未分类, 有了这份定义就能出现在 RiceRabbit 分组里。
    前端 registerCustomNodes 在后端定义注册之后执行, 会用同名 type 覆盖成本地
    的虚拟节点 (isVirtualNode), 所以下面的 FUNCTION 实际不会被调用。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "value": (
                    "*",
                    {"tooltip": "Connect anything upstream; type the variable name in the field on the node"},
                ),
            },
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("value",)
    FUNCTION = "noop"
    CATEGORY = CATEGORY
    DESCRIPTION = "Variable writer (virtual node, not executed): stores the upstream value under a name that any matching Get node can read."

    def noop(self, value=None):
        return (value,)


class RiceRabbitGetNode:
    """变量读取 (Get) —— 真正的逻辑在 web/rr_setget.js, 是纯前端虚拟节点。

    同 RiceRabbitSetNode: 这份定义只负责让节点出现在 RiceRabbit 分组里。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "Variable name": (
                    "STRING",
                    {"default": "", "tooltip": "Variable to read (the dropdown lists every available Set)"},
                ),
            }
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("value",)
    FUNCTION = "noop"
    CATEGORY = CATEGORY
    DESCRIPTION = "Variable reader (virtual node, not executed): returns the value of the matching Set node."

    def noop(self, **kwargs):
        return (None,)


NODE_CLASS_MAPPINGS = {
    "RiceRabbitPrompt": RiceRabbitPrompt,
    "RiceRabbitResolution": RiceRabbitResolution,
    "RiceRabbitDate": RiceRabbitDate,
    "RiceRabbitIntToString": RiceRabbitIntToString,
    "RiceRabbitConcat": RiceRabbitConcat,
    "RiceRabbitAnySwitch": RiceRabbitAnySwitch,
    "RiceRabbitExistential": RiceRabbitExistential,
    "RiceRabbitSetNode": RiceRabbitSetNode,
    "RiceRabbitGetNode": RiceRabbitGetNode,
    "RiceRabbitFormatText": RiceRabbitFormatText,
    **COMPARE_NODE_CLASS_MAPPINGS,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "RiceRabbitPrompt": "🍚 Prompt (RiceRabbit)",
    "RiceRabbitResolution": "🍚 Resolution (RiceRabbit)",
    "RiceRabbitDate": "🍚 Date (RiceRabbit)",
    "RiceRabbitIntToString": "🍚 Int → Text (RiceRabbit)",
    "RiceRabbitConcat": "🍚 Text Concat (RiceRabbit)",
    "RiceRabbitAnySwitch": "🍚 Any Switch (RiceRabbit)",
    "RiceRabbitExistential": "🍚 Exists (RiceRabbit)",
    "RiceRabbitSetNode": "🍚 Set Variable (RiceRabbit)",
    "RiceRabbitGetNode": "🍚 Get Variable (RiceRabbit)",
    "RiceRabbitFormatText": "🍚 Format Text (RiceRabbit)",
    **COMPARE_NODE_DISPLAY_NAME_MAPPINGS,
}
