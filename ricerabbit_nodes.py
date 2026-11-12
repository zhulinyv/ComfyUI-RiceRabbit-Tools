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
                        "tooltip": "节点自己的提示词。输入时会给出标签自动补全, 右下角按钮可打开标签化编辑窗口",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xffffffffffffffff,
                        "tooltip": "随机/顺序的抽取种子: 可接 KSampler 的 seed。种子不变时不会重新抽取 (保证同种子可复现)",
                    },
                ),
                "format": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "格式化",
                        "label_off": "原始",
                        # advanced: 交给 ComfyUI 折叠 (与 KSampler (Advanced) 同一套机制,
                        # 节点底部会出现 "Show advanced inputs")
                        "advanced": True,
                        "tooltip": "整理多余的空格与逗号 (规则同 Auto-NovelAI-Refactor)",
                    },
                ),
                "separator": (
                    "STRING",
                    {
                        "default": ",",
                        "multiline": False,
                        "advanced": True,
                        "tooltip": "拼接上游 text 与节点提示词时用的分隔符",
                    },
                ),
            },
            "optional": {
                "clip": (
                    "CLIP",
                    {
                        "tooltip": "可选。接上就把提示词编码成 conditioning; 不接则只用 text 输出（conditioning 为空）",
                    },
                ),
                "text": (
                    "STRING",
                    {"forceInput": True, "tooltip": "可选的上游文本, 会用分隔符拼在节点提示词前面"},
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",  # 执行时由 ComfyUI 注入, 终端打印用它区分节点
            },
        }

    RETURN_TYPES = ("STRING", "CONDITIONING")
    RETURN_NAMES = ("text", "conditioning")
    OUTPUT_TOOLTIPS = (
        "最终用于编码的提示词 (已拼接 / 展开 wildcard / 格式化)",
        "编码后的条件, 可直接接入 KSampler; 没接 CLIP 时为空",
    )
    FUNCTION = "encode"
    CATEGORY = CATEGORY
    DESCRIPTION = "提示词节点: 拼接上游文本, 展开 <分类:卡片> wildcard, 格式化后输出文本; 接了 CLIP 还可以编码成 conditioning。"

    @classmethod
    def IS_CHANGED(cls, text=None, prompt="", format=True, separator=",", clip=None, seed=0, **kwargs):
        # ComfyUI 0.44 起会把 hidden 输入(unique_id 等)也传给 IS_CHANGED,
        # 用 **kwargs 吸收, 否则抛 TypeError -> 每次排队刷 WARNING 且缓存指纹失效
        # 含 <分类:随机> / <分类:顺序> 时, 指纹带上 seed:
        # 种子不变 -> 指纹相同 -> ComfyUI 直接用上次的抽取结果 (同种子可复现);
        # 种子变化 -> 指纹变化 -> 重新抽取
        combined = f"{text or ''}{prompt or ''}"
        if "<" in combined and ("随机>" in combined or "顺序>" in combined):
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
        label = f"RiceRabbit 提示词 #{unique_id}" if unique_id is not None else "RiceRabbit 提示词"
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
                        "tooltip": "选一个预设会自动填到下面的宽高; 手动改宽高会切成对应的预设或「自定义」",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 512,
                        "min": 16,
                        "max": 16384,
                        "step": 8,
                        "tooltip": "实际输出的宽度; 手填的组合在生成后会存进预设",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 512,
                        "min": 16,
                        "max": 16384,
                        "step": 8,
                        "tooltip": "实际输出的高度",
                    },
                ),
            }
        }

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("width", "height")
    OUTPUT_TOOLTIPS = ("宽度", "高度")
    FUNCTION = "run"
    CATEGORY = CATEGORY
    DESCRIPTION = "分辨率选择: 预设下拉 + 手动宽高。手填的组合会在执行后自动加入预设。"

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
    OUTPUT_TOOLTIPS = ("YYYYMMDD 格式的日期, 例如 20261030",)
    FUNCTION = "run"
    CATEGORY = CATEGORY
    DESCRIPTION = "输出当天日期 (YYYYMMDD)。"

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
                        "tooltip": "可以连上游的 INT 输出, 也可以直接填数字",
                    },
                ),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    OUTPUT_TOOLTIPS = ("整数转成的十进制文本",)
    FUNCTION = "run"
    CATEGORY = CATEGORY
    DESCRIPTION = "把 INT 转成 STRING, 方便拼进文件名 / 路径 / 提示词。"

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
                        "tooltip": "拼接时插入在每两段之间的字符串, 留空则直接相连",
                    },
                ),
                "text1": ("STRING", {"forceInput": True, "tooltip": "第一段文本 (必填)"}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    OUTPUT_TOOLTIPS = ("按 text1, text2, ... 顺序拼接后的文本",)
    FUNCTION = "run"
    CATEGORY = CATEGORY
    DESCRIPTION = "文本拼接: 多个 STRING 按顺序用分隔符连起来, 接上下一个输入框会自动出现。"

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
                    "tooltip": "任意类型。空值会被跳过, 只输出第一个有内容的输入",
                },
            )
        return {"required": {}, "optional": optional}

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("value",)
    OUTPUT_TOOLTIPS = ("第一个有内容的输入, 原样输出 (类型跟随上游)",)
    FUNCTION = "pick"
    CATEGORY = CATEGORY
    DESCRIPTION = "任意类型选择: 接多个输入, 只输出第一个非空的那个; 接上第二个输入后会自动出现第三个输入槽。"

    def pick(self, **kwargs):
        for i in range(1, MAX_ANY_SWITCH_INPUTS + 1):
            value = kwargs.get(f"input{i}")
            if _is_blank(value):  # 没连的输入不会出现在 kwargs 里
                continue
            return (value,)
        print("[RiceRabbit] 任意类型选择: 所有输入都是空的, 输出 None")
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
                        "tooltip": "任意类型。只判断有没有值: 没接线或上游给 None 就是 False",
                    },
                ),
            }
        }

    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("bool",)
    OUTPUT_TOOLTIPS = ("有值 True; 没接或值为 None 时 False",)
    FUNCTION = "exists"
    CATEGORY = CATEGORY
    DESCRIPTION = "存在性判断: 任意类型输入有值输出 True, 没接或值为 None 输出 False。"

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
                    {"forceInput": True, "tooltip": "要格式化的提示词"},
                ),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    OUTPUT_TOOLTIPS = ("格式化后的文本",)
    FUNCTION = "run"
    CATEGORY = CATEGORY
    DESCRIPTION = "格式化文本: 清理多余的逗号与空格, 换行结构保持不变。"

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
                    {"tooltip": "接任意上游; 变量名填在节点上的输入框里"},
                ),
            },
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("value",)
    FUNCTION = "noop"
    CATEGORY = CATEGORY
    DESCRIPTION = "变量写入 (虚拟节点, 不参与执行): 把上游存成变量, 同名 Get 节点随处取用。"

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
                "变量名": (
                    "STRING",
                    {"default": "", "tooltip": "要读取的变量名 (下拉里是所有可用的 Set)"},
                ),
            }
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("value",)
    FUNCTION = "noop"
    CATEGORY = CATEGORY
    DESCRIPTION = "变量读取 (虚拟节点, 不参与执行): 从同名的 Set 节点取上游的值。"

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
    "RiceRabbitPrompt": "🍚 提示词 (RiceRabbit)",
    "RiceRabbitResolution": "🍚 分辨率 (RiceRabbit)",
    "RiceRabbitDate": "🍚 日期 (RiceRabbit)",
    "RiceRabbitIntToString": "🍚 整数→文本 (RiceRabbit)",
    "RiceRabbitConcat": "🍚 文本拼接 (RiceRabbit)",
    "RiceRabbitAnySwitch": "🍚 任意类型选择 (RiceRabbit)",
    "RiceRabbitExistential": "🍚 存在性判断 (RiceRabbit)",
    "RiceRabbitSetNode": "🍚 变量写入 Set (RiceRabbit)",
    "RiceRabbitGetNode": "🍚 变量读取 Get (RiceRabbit)",
    "RiceRabbitFormatText": "🍚 格式化文本 (RiceRabbit)",
    **COMPARE_NODE_DISPLAY_NAME_MAPPINGS,
}
