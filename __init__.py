"""ComfyUI-RiceRabbit-Tools

提示词节点: 上游 text + 节点内提示词 -> 拼接 / wildcard 展开 / 格式化 -> 文本 + conditioning。
图片对比节点: 多路 IMAGE 输入 -> 临时 PNG -> 节点内轮播 + 滑动分割线对比窗口。
卡片库与提示词库直接复用 Auto-NovelAI-Refactor 的目录 (在 data/library.json 里指定其路径)。
"""

from __future__ import annotations

import os
import sys
import threading

NODE_DIR = os.path.dirname(os.path.abspath(__file__))
# ComfyUI 以目录名作为模块名加载本插件 (名字带 "-", 不能当包名), 所以子模块走
# 普通绝对导入; 模块名统一带上 ricerabbit_ 前缀, 不会和其它插件撞名。
if NODE_DIR not in sys.path:
    sys.path.insert(0, NODE_DIR)

from ricerabbit_nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS  # noqa: E402
import ricerabbit_routes  # noqa: E402

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

_API_READY = ricerabbit_routes.register()


def _warmup_tag_dict() -> None:
    """后台把标签词典与中文映射表建好。

    词典是 32 万行的 CSV, 第一次查补全/翻译时要 1~2 秒; 放到启动后台预热,
    用户第一次打开标签窗口时就是毫秒级响应。
    """
    try:
        import ricerabbit_tags

        ricerabbit_tags.get_cache()
        ricerabbit_tags.zh_map()
    except Exception as exc:  # noqa: BLE001 - 预热失败不影响节点
        print(f"[RiceRabbit] tag dict warmup skipped: {exc}")


threading.Thread(target=_warmup_tag_dict, name="RiceRabbitWarmup", daemon=True).start()

print(f"[RiceRabbit] {len(NODE_CLASS_MAPPINGS)} nodes loaded (api={'ok' if _API_READY else 'skipped'}) from {NODE_DIR}")
