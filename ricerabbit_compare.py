"""图片对比节点。

把任意数量的 IMAGE 输入落成临时 PNG, 让前端能:
1. 在节点里轮播输入的所有图片 (按输入顺序);
2. 打开对比窗口, 用分割线滑动比较任意两张。

节点本身没有输出 (OUTPUT_NODE), 图片只是给界面看的 —— 所以这里不做任何像素处理,
原样保存 (PNG 无损), 避免"对比窗口里看不出差别"这种自欺欺人的结果。
"""

from __future__ import annotations

import os
import re
import shutil

import numpy as np
from PIL import Image

CATEGORY = "RiceRabbit"

# 与前端 web/rr_compare.js 的 MAX_INPUTS 保持一致
MAX_COMPARE_INPUTS = 20

# 节点 id 要拼进目录名, 只留安全字符 (子图里的节点 id 可能是 "12:3" 这种)
_UNSAFE_ID = re.compile(r"[^0-9A-Za-z_-]+")


def _safe_id(unique_id) -> str:
    text = _UNSAFE_ID.sub("", str(unique_id if unique_id is not None else "0"))
    return text or "0"


def _temp_folder(unique_id):
    """本次执行的图片目录: temp/ricerabbit_compare/<节点id>/。

    每次执行都清空重建 —— 一次执行收集到的图才需要互相比较, 留历史只会撑大 temp;
    而且文件名固定, 不清掉的话浏览器可能拿旧缓存顶替新图。
    """
    try:
        import folder_paths

        root = folder_paths.get_temp_directory()
    except Exception:  # 极端情况下 (单元测试 / 环境不完整) 退到插件自己的 data 目录
        root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "temp")

    subfolder = f"ricerabbit_compare/{_safe_id(unique_id)}"
    folder = os.path.join(root, *subfolder.split("/"))
    shutil.rmtree(folder, ignore_errors=True)
    os.makedirs(folder, exist_ok=True)
    return folder, subfolder


def _to_pil(image) -> Image.Image:
    """ComfyUI 的 IMAGE ([B,H,W,C] float32 0~1) 单帧 -> PIL Image。"""
    array = image
    if hasattr(array, "detach"):
        array = array.detach().cpu().numpy()
    array = np.asarray(array, dtype=np.float32)
    if array.ndim == 4:  # 整个 batch 传进来: 只取第一帧 (batch 的拆解在 run 里做)
        array = array[0]
    if array.ndim == 2:  # [H,W] 灰度
        array = array[..., None]
    if array.shape[-1] == 1:  # 灰度补成 RGB, 免得前端 <img> 处理 L 模式色差
        array = np.repeat(array, 3, axis=-1)
    elif array.shape[-1] > 4:  # 理论上不会出现, 出现了就裁掉多余通道
        array = array[..., :4]
    return Image.fromarray(np.clip(array * 255.0, 0, 255).astype(np.uint8))


def _batch_size(value) -> int:
    shape = getattr(value, "shape", None)
    if shape is not None and len(shape) >= 3:
        try:
            return max(int(shape[0]), 1)
        except Exception:
            return 1
    return 1


class RiceRabbitImageCompare:
    """图片对比: 自动收集图里所有「图片类 Get」的图, 无输出, 只把图交给界面。"""

    @classmethod
    def INPUT_TYPES(cls):
        # 节点界面上没有输入点, 这些槽是前端在提交任务前临时注入的
        # (rr_compare.js 包装了 app.graphToPrompt, 把图里所有 IMAGE 类型的 Get 接进来)
        optional = {}
        for i in range(1, MAX_COMPARE_INPUTS + 1):
            optional[f"image{i}"] = (
                "IMAGE",
                {"tooltip": f"Auto-collected image {i} (injected by the frontend in Get order)"},
            )
        return {
            "required": {},
            "optional": optional,
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "run"
    CATEGORY = CATEGORY
    DESCRIPTION = (
        "Image viewer / compare: no wiring needed, it collects every IMAGE-typed Get variable "
        "(ordered by where the Get nodes sit on the canvas). Switch images inside the node, "
        "or open the compare window for a draggable split divider and wheel zoom."
    )

    def run(self, unique_id=None, **kwargs):
        pairs = []
        for i in range(1, MAX_COMPARE_INPUTS + 1):
            value = kwargs.get(f"image{i}")
            if value is not None:  # 没注入的槽不会进 kwargs
                pairs.append((f"image{i}", value))

        folder, subfolder = _temp_folder(unique_id)
        records = []
        summary = []

        for order, (slot, value) in enumerate(pairs, start=1):
            if value is None:
                continue
            batch = _batch_size(value)
            summary.append(f"{slot}×{batch}")
            for b in range(batch):
                frame = value[b] if batch > 1 else value
                try:
                    pil = _to_pil(frame)
                except Exception as exc:  # noqa: BLE001 - 单张坏掉不该拖垮整次执行
                    print(
                        f"[RiceRabbit] Image Compare: failed to convert {slot} image {b + 1} ({exc}), skipped"
                    )
                    continue

                filename = f"{order:02d}_{b:02d}.png"
                pil.save(os.path.join(folder, filename), format="PNG", compress_level=1)
                records.append(
                    {
                        "slot": slot,
                        "order": order,
                        "batch": b,
                        "filename": filename,
                        "subfolder": subfolder,
                        "type": "temp",
                        "width": pil.width,
                        "height": pil.height,
                    }
                )

        label = f"#{unique_id}" if unique_id is not None else ""
        print(
            f"[RiceRabbit] Image Compare {label}: collected {len(records)} image(s) ({', '.join(summary) or 'none'})"
        )

        # 前端 onExecuted 收到 message.rr_images; 顺序 = 输入顺序 + batch 内顺序
        return {"ui": {"rr_images": records}}


COMPARE_NODE_CLASS_MAPPINGS = {
    "RiceRabbitImageCompare": RiceRabbitImageCompare,
}

COMPARE_NODE_DISPLAY_NAME_MAPPINGS = {
    "RiceRabbitImageCompare": "🍚 Image Compare (RiceRabbit)",
}
