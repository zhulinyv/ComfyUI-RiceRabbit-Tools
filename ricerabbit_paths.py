"""库路径解析: 卡片库与提示词库的位置。

默认固定位置 (路径不再从 ComfyUI 设置读取):

    <插件目录>/wildcards
    <插件目录>/prompts/prompt_library.json

需要复用 ANR 或把库放到别的盘时, 手写 <插件目录>/data/library.json:

    {
      "anr_root": "D:\\GitClone\\Auto-NovelAI-Refactor",
      "wildcards_dir": "D:\\cards",
      "prompt_library_dir": "D:\\prompts"
    }

三个键都是"允许使用的目录" (allow-list), 不是任意路径 —— 插件没有任何 HTTP
接口会写这个文件, 所以能访问服务的客户端改不了它:
- 必须是绝对路径, 且不能是网络共享 (\\\\host\\share): 检查发生在任何
  is_dir()/stat()/realpath() 之前, 免得在 Windows 上触发 SMB 认证;
- ANR 目录必须已存在; 卡片库与提示词库目录会在第一次写入时创建;
- 指向插件 data/ (运行时状态) 或插件目录上层的路径会被拒绝。
所有文件操作都在 ricerabbit_fs.contain() 里用 realpath + commonpath 确认
目标仍位于解析后的库根目录内。
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from ricerabbit_fs import contain, is_network_path, real_path

NODE_DIR = Path(__file__).resolve().parent
DATA_DIR = NODE_DIR / "data"

# 手写的库位置文件: 不在 ComfyUI 设置里, 也没有任何路由写它。
CONFIG_FILE = DATA_DIR / "library.json"

DEFAULT_WILDCARDS_DIR = NODE_DIR / "wildcards"
DEFAULT_PROMPT_LIB_DIR = NODE_DIR / "prompts"
PROMPT_LIB_NAME = "prompt_library.json"
DEFAULT_PROMPT_LIB = DEFAULT_PROMPT_LIB_DIR / PROMPT_LIB_NAME

_CFG_LOCK = threading.RLock()
_CFG_CACHE: dict = {"stamp": None, "data": {}}
_WARNED: set[str] = set()


def _warn(message: str) -> None:
    """同一条提示只打印一次, 免得每次 /ricerabbit/config 都刷屏。"""
    if message in _WARNED:
        return
    _WARNED.add(message)
    print(f"[RiceRabbit] {message}")


def _config() -> dict:
    """读取 data/library.json (按 mtime+size 失效)。缺失/损坏时返回空设置。"""
    try:
        st = CONFIG_FILE.stat()
        stamp = (st.st_mtime_ns, st.st_size)
    except OSError:
        return {}
    with _CFG_LOCK:
        if _CFG_CACHE["stamp"] == stamp:
            return _CFG_CACHE["data"]
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                data = {}
        except Exception:
            # 用户正在编辑 (半截 JSON) 时保留上一份, 不要把库切回默认
            return _CFG_CACHE["data"] or {}
        _CFG_CACHE.update({"stamp": stamp, "data": data})
        return data


def _expand(value, label: str) -> Path | None:
    """配置值 -> 绝对本地路径。所有形式检查都在碰文件系统之前完成。"""
    text = str(value if value is not None else "").strip()
    if not text or "\x00" in text:
        return None
    try:
        text = os.path.expanduser(os.path.expandvars(text))
    except Exception:
        return None
    path = Path(text)
    if not path.is_absolute():
        _warn(f"Ignoring {label} {text!r}: it must be an absolute path")
        return None
    if is_network_path(path):
        _warn(f"Ignoring {label} {text!r}: network shares are not supported")
        return None
    return path


def _inside_data(path: Path) -> bool:
    data = real_path(DATA_DIR)
    target = real_path(path)
    return target == data or data in target.parents


def _contains_plugin(path: Path) -> bool:
    """库根目录不能是插件目录本身或它的上级 (删分类时可能把插件文件搬走)。"""
    plugin = real_path(NODE_DIR)
    target = real_path(path)
    return target == plugin or target in plugin.parents


def _validated_dir(value, label: str, must_exist: bool) -> Path | None:
    path = _expand(value, label)
    if path is None:
        return None
    root = real_path(path)
    if is_network_path(root):
        _warn(f"Ignoring {label} {str(path)!r}: network shares are not supported")
        return None
    if _inside_data(root):
        _warn(f"Ignoring {label} {str(path)!r}: the plugin data folder is reserved")
        return None
    if _contains_plugin(root):
        _warn(f"Ignoring {label} {str(path)!r}: it contains the plugin folder")
        return None
    if must_exist and not root.is_dir():
        _warn(f"Ignoring {label} {str(path)!r}: folder not found")
        return None
    return root


def anr_root() -> Path | None:
    """配置的 ANR 目录 (未配置/无效时返回 None)。"""
    return _validated_dir(_config().get("anr_root"), "ANR folder", must_exist=True)


def wildcards_dir() -> Path:
    """卡片库根目录 (一定返回一个 Path; 目录可能还没建出来)。"""
    root = anr_root()
    if root is not None:
        for candidate in (root / "data" / "state" / "wildcards", root / "wildcards"):
            try:
                candidate = contain(root, candidate)
            except ValueError:
                continue
            if candidate.is_dir():
                return candidate
    custom = _validated_dir(_config().get("wildcards_dir"), "card library folder", must_exist=False)
    if custom is not None:
        return custom
    return DEFAULT_WILDCARDS_DIR


def prompt_library_dir() -> Path:
    """提示词库所在目录 (文件固定叫 prompt_library.json)。"""
    root = anr_root()
    if root is not None:
        try:
            candidate = contain(root, root / "data" / "state" / PROMPT_LIB_NAME)
        except ValueError:
            candidate = None
        if candidate is not None and candidate.is_file():
            return candidate.parent
    custom = _validated_dir(_config().get("prompt_library_dir"), "prompt library folder", must_exist=False)
    if custom is not None:
        return custom
    return DEFAULT_PROMPT_LIB_DIR


def prompt_library_file() -> Path:
    """提示词库 json 文件 (一定返回一个 Path)。"""
    folder = prompt_library_dir()
    try:
        return contain(folder, folder / PROMPT_LIB_NAME)
    except ValueError:
        _warn(f"Ignoring prompt library folder {str(folder)!r}: it resolves outside the folder")
        return DEFAULT_PROMPT_LIB


def data_dir() -> Path:
    """插件自己的运行时数据目录 (顺序指针、翻译缓存、回收站)。"""
    path = DATA_DIR
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
        try:
            out.append(contain(root, root / "assets" / "danbooru_tags_full_zh.csv"))
        except ValueError:
            pass
    out.append(NODE_DIR / "assets" / "danbooru_tags_full_zh.csv")
    return out
