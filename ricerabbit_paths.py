"""路径与 ComfyUI 设置的读取。

设置项 (保存在 ComfyUI 自己的 user/default/comfy.settings.json 里):

    RiceRabbit.ANRPath            Auto-NovelAI-Refactor 目录 (默认空)
    RiceRabbit.WildcardsDir       wildcards 卡片库目录
    RiceRabbit.PromptLibraryPath  提示词库文件 (json)

三个值都为空时, 卡片库与提示词库落到本插件目录下的 wildcards/ 与 prompts/。
ANR 目录有效时优先读 ANR 的库 (data/state/wildcards 与 data/state/prompt_library.json),
这样两边的库始终是同一份, 不会各改各的。
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

NODE_DIR = Path(__file__).resolve().parent

# 设置键名 (前端 web/ricerabbit_settings.js 必须用同样的字符串)
KEY_ANR_PATH = "RiceRabbit.ANRPath"
KEY_WILDCARDS_DIR = "RiceRabbit.WildcardsDir"
KEY_PROMPT_LIB = "RiceRabbit.PromptLibraryPath"

DEFAULT_WILDCARDS_DIR = NODE_DIR / "wildcards"
DEFAULT_PROMPT_LIB = NODE_DIR / "prompts" / "prompt_library.json"

_lock = threading.RLock()
_cache: dict = {"mtime": None, "size": None, "data": {}}


def _settings_file() -> Path:
    """ComfyUI 的用户设置文件。导入 folder_paths 失败时退化成空设置。"""
    try:
        import folder_paths  # 只有跑在 ComfyUI 进程里才存在

        base = Path(folder_paths.get_user_directory())
    except Exception:
        base = NODE_DIR / "_no_user_dir"
    return base / "default" / "comfy.settings.json"


def read_all() -> dict:
    """读取并缓存 comfy.settings.json (按 mtime+size 失效, 改完设置立刻生效)。"""
    path = _settings_file()
    try:
        st = path.stat()
        stamp = (st.st_mtime_ns, st.st_size)
    except OSError:
        return {}
    with _lock:
        if _cache["mtime"] == stamp:
            return _cache["data"]
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                data = {}
        except Exception:
            # 文件正在被写入 (半截 JSON) 时保留上一份, 不要把手头的设置清空
            return _cache["data"] or {}
        _cache.update({"mtime": stamp, "size": st.st_size, "data": data})
        return data


def get_str(key: str, default: str = "") -> str:
    value = read_all().get(key, default)
    if value is None:
        return default
    text = str(value).strip()
    # 用户从资源管理器复制路径时常带引号
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        text = text[1:-1].strip()
    return text or default


def _as_dir(value: str) -> Path | None:
    if not value:
        return None
    try:
        path = Path(os.path.expandvars(value)).expanduser()
    except Exception:
        return None
    return path if path.is_dir() else None


def anr_root() -> Path | None:
    """配置的 ANR 目录 (不存在/未配置时返回 None)。"""
    return _as_dir(get_str(KEY_ANR_PATH))


def wildcards_dir() -> Path:
    """卡片库根目录 (一定返回一个 Path; 目录可能还没建出来)。"""
    root = anr_root()
    if root is not None:
        for candidate in (root / "data" / "state" / "wildcards", root / "wildcards"):
            if candidate.is_dir():
                return candidate
    configured = get_str(KEY_WILDCARDS_DIR)
    if configured:
        try:
            return Path(os.path.expandvars(configured)).expanduser()
        except Exception:
            pass
    return DEFAULT_WILDCARDS_DIR


def prompt_library_file() -> Path:
    """提示词库 json 文件 (一定返回一个 Path)。"""
    root = anr_root()
    if root is not None:
        candidate = root / "data" / "state" / "prompt_library.json"
        if candidate.is_file():
            return candidate
    configured = get_str(KEY_PROMPT_LIB)
    if configured:
        try:
            return Path(os.path.expandvars(configured)).expanduser()
        except Exception:
            pass
    return DEFAULT_PROMPT_LIB


def data_dir() -> Path:
    """插件自己的运行时数据目录 (顺序指针、翻译缓存)。"""
    path = NODE_DIR / "data"
    path.mkdir(parents=True, exist_ok=True)
    return path


def tag_dict_candidates() -> list[Path]:
    """自动补全/翻译词典的候选路径, 按优先级排列。

    ANR 目录里的词典是权威来源 (用户会跟着项目更新), 插件自带的那份只是
    给没有 ANR 的用户兜底。
    """
    out: list[Path] = []
    root = anr_root()
    if root is not None:
        out.append(root / "assets" / "danbooru_tags_full_zh.csv")
    out.append(NODE_DIR / "assets" / "danbooru_tags_full_zh.csv")
    return out
