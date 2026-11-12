"""分辨率预设。

预设存在插件自己的 data/resolutions.json 里 (不动 ComfyUI 的设置文件)。
节点每次执行时调用 ``add_preset`` —— 手填的长宽如果不在预设里就收录进去,
下次这个组合就会出现在下拉框里。

文件格式: [[1024, 1024], [832, 1216], ...]  (宽在前)
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

from ricerabbit_paths import data_dir

# 首次使用时写入的默认预设 (覆盖常见 SD / SDXL / 宽屏比例)
DEFAULT_PRESETS: list[tuple[int, int]] = [
    (512, 512),
    (512, 768),
    (768, 512),
    (640, 640),
    (768, 768),
    (832, 1216),
    (1216, 832),
    (1024, 1024),
    (1024, 1536),
    (1536, 1024),
    (1344, 768),
    (768, 1344),
    (1920, 1080),
    (1080, 1920),
]

CUSTOM_LABEL = "自定义"

_lock = threading.RLock()
_cache: dict = {"stamp": None, "presets": []}


def _file() -> Path:
    return data_dir() / "resolutions.json"


def _stamp() -> tuple:
    path = _file()
    try:
        st = path.stat()
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return (0, 0)


def _normalize(items) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    seen: set[tuple[int, int]] = set()
    for item in items:
        try:
            if isinstance(item, dict):
                w, h = int(item.get("width")), int(item.get("height"))
            elif isinstance(item, (list, tuple)) and len(item) >= 2:
                w, h = int(item[0]), int(item[1])
            elif isinstance(item, str) and "x" in item.lower():
                left, _, right = item.lower().partition("x")
                w, h = int(left), int(right)
            else:
                continue
        except (TypeError, ValueError):
            continue
        if w <= 0 or h <= 0:
            continue
        key = (w, h)
        if key not in seen:
            seen.add(key)
            out.append(key)
    return out


def load_presets() -> list[tuple[int, int]]:
    """读取预设 (文件变化自动重读; 文件不存在时写入默认值)。"""
    path = _file()
    stamp = _stamp()
    with _lock:
        if _cache["stamp"] == stamp and _cache["presets"]:
            return _cache["presets"]
        if not path.is_file():
            presets = list(DEFAULT_PRESETS)
            _write(presets)
            _cache.update({"stamp": _stamp(), "presets": presets})
            return presets
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            presets = _normalize(raw if isinstance(raw, list) else [])
        except Exception:
            presets = []
        if not presets:
            presets = list(DEFAULT_PRESETS)
        _cache.update({"stamp": _stamp(), "presets": presets})
        return presets


def _write(presets: list[tuple[int, int]]) -> None:
    path = _file()
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps([[w, h] for w, h in presets], ensure_ascii=False, indent=1), encoding="utf-8")
    import os

    os.replace(tmp, path)


def add_preset(width: int, height: int) -> bool:
    """把 (w, h) 收录进预设; 已存在返回 False。"""
    try:
        width, height = int(width), int(height)
    except (TypeError, ValueError):
        return False
    if width <= 0 or height <= 0:
        return False
    with _lock:
        presets = list(load_presets())
        if (width, height) in presets:
            return False
        presets.append((width, height))
        try:
            _write(presets)
        except OSError:
            return False
        _cache.update({"stamp": _stamp(), "presets": presets})
        return True


def labels() -> list[str]:
    """下拉框用的标签列表 (不含"自定义")。"""
    return [f"{w}x{h}" for w, h in load_presets()]


def parsed(width: int, height: int) -> tuple[int, int]:
    """把任意输入折成正整数 (节点输出用)。"""
    def clamp(value) -> int:
        try:
            return max(16, min(int(value), 16384))
        except (TypeError, ValueError):
            return 512

    return clamp(width), clamp(height)


__all__ = ["CUSTOM_LABEL", "DEFAULT_PRESETS", "add_preset", "labels", "load_presets", "parsed"]
