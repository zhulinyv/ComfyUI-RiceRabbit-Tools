"""卡片库 (wildcards) 与提示词库 (prompt_library) 的读写。

卡片库结构 (与 Auto-NovelAI-Refactor 完全一致):

    <wildcards 根>/<分类>/<卡片名>.txt        卡片内容 (一段提示词)
    <wildcards 根>/<分类>/<卡片名>.png|jpg…   可选封面

提示词库结构:

    [{"text": "标签", "category": "分类"}, ...]

所有路径都由 ricerabbit_paths 给出 (固定默认位置, 或手写的 data/library.json
allow-list), 并且每次拼路径都过 ricerabbit_fs.safe_child / contain: 先在
realpath 之后用 commonpath 确认仍在库根目录内, 再做读写/改名/移动/删除。

删卡片 / 删分类一律先移到插件 data/trash 下, 不做真正的删除。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
from pathlib import Path

from ricerabbit_fs import contain, safe_child
from ricerabbit_paths import anr_root, data_dir, prompt_library_file, wildcards_dir
from ricerabbit_text import KEY_RANDOM, KEY_SEQUENTIAL

_LOCK = threading.RLock()

COVER_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")
CARD_EXTS = (".txt",)

# 两个虚拟卡片: 不是文件, 只是 <category:random> / <category:sequential> 的入口
# (老的中文写法 <分类:随机> 仍然能被解析, 见 ricerabbit_text._LEGACY_KEYS)
VIRTUAL_CARDS = (KEY_RANDOM, KEY_SEQUENTIAL)

# 只读一次的提示词库缓存 (按 mtime 失效)
_PL_CACHE: dict = {"stamp": None, "items": []}

DEFAULT_CATEGORY = "Default"
PL_MAX_ITEMS = 2000


# ---------------------------------------------------------------- 通用小工具


def _safe_name(name: str) -> str:
    """挡住路径穿越: 分类名/卡片名不允许分隔符与 .."""
    text = (name or "").strip()
    if not text or text in (".", ".."):
        raise ValueError("Name must not be empty")
    if "/" in text or "\\" in text or ":" in text:
        raise ValueError(f"Invalid name: {name}")
    return text


def _join(base: Path, *parts: str) -> Path:
    """把 parts 拼到 base 下; 越界/非法名字直接抛 ValueError。"""
    path = safe_child(base, *parts)
    if path is None:
        raise ValueError("Invalid library path: " + "/".join(str(p) for p in parts))
    return path


def _atomic_write(base: Path, path: Path, text: str) -> None:
    """原子写: 先写临时文件再替换, 避免半截文件把用户的库写坏。"""
    path = contain(base, path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _trash_dir() -> Path:
    path = data_dir() / "trash"
    path.mkdir(parents=True, exist_ok=True)
    return path


# ---------------------------------------------------------------- 卡片库


def wildcard_root() -> Path:
    root = wildcards_dir()
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    return root


def list_types() -> list[str]:
    try:
        root = wildcard_root()
        types = []
        for entry in root.iterdir():
            if entry.name.startswith("."):
                continue
            # 符号链接/目录联接如果指向库外, safe_child 会返回 None, 不进列表
            folder = safe_child(root, entry.name)
            if folder is not None and folder.is_dir():
                types.append(entry.name)
        return sorted(types)
    except (OSError, ValueError):
        return []


def find_cover(category: str, name: str) -> Path | None:
    # 必须先清洗再碰文件系统: category 直接来自 URL / 卡片库请求,
    # 未清洗时 is_file() 会去探测任意路径 (Windows 上 \\host\share 还会触发 SMB 认证)
    folder = safe_child(wildcard_root(), category)
    if folder is None:
        return None
    for ext in COVER_EXTS:
        candidate = safe_child(folder, f"{name}{ext}")
        if candidate is not None and candidate.is_file():
            return candidate
    return None


def list_cards(category: str) -> list[dict]:
    """分类下的全部卡片 (按名字排序, 带封面与标签数)。"""
    folder = safe_child(wildcard_root(), category)
    if folder is None or not folder.is_dir():
        return []
    covers = {}
    cards = []
    try:
        entries = sorted(folder.iterdir(), key=lambda p: p.name.lower())
    except OSError:
        return []
    for entry in entries:
        resolved = safe_child(folder, entry.name)
        if resolved is None or not resolved.is_file():
            continue
        suffix = resolved.suffix.lower()
        if suffix in COVER_EXTS:
            covers.setdefault(resolved.stem, suffix)
        elif suffix in CARD_EXTS:
            cards.append(resolved)
    out = []
    for card in cards:
        cover = covers.get(card.stem)
        out.append(
            {
                "name": card.stem,
                "cover": bool(cover),
                # 加个查询串让浏览器在封面更新后重新拉图
                "cover_url": f"/ricerabbit/cover?type={_q(category)}&name={_q(card.stem)}&v={int(card.stat().st_mtime)}"
                if cover
                else "",
                "size": card.stat().st_size if card.exists() else 0,
            }
        )
    # 分类里有卡片时, 在最前面放两个虚拟入口: <分类:随机> / <分类:顺序>
    if out:
        out = [
            {"name": KEY_RANDOM, "cover": False, "cover_url": "", "size": 0, "special": "random"},
            {"name": KEY_SEQUENTIAL, "cover": False, "cover_url": "", "size": 0, "special": "sequential"},
        ] + out
    return out


def _q(text: str) -> str:
    from urllib.parse import quote

    return quote(text, safe="")


def get_card(category: str, name: str) -> str:
    if name in VIRTUAL_CARDS:
        raise ValueError(f"{name} is a virtual card and has no content to edit")
    path = _join(wildcard_root(), _safe_name(category), f"{_safe_name(name)}.txt")
    if not path.is_file():
        raise FileNotFoundError(f"Card not found: {category}:{name}")
    for encoding in ("utf-8-sig", "utf-8", "gbk"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    return ""


def save_card(category: str, name: str, content: str) -> None:
    if name in VIRTUAL_CARDS:
        raise ValueError(f"{name} is a reserved name and cannot be used as a card name")
    root = wildcard_root()
    folder = _join(root, _safe_name(category))
    folder.mkdir(parents=True, exist_ok=True)
    _atomic_write(root, _join(folder, f"{_safe_name(name)}.txt"), content or "")


def rename_card(category: str, name: str, new_name: str) -> str:
    """重命名卡片: .txt 与所有封面图一起改名。返回新卡片名。"""
    name = (name or "").strip()
    new_name = (new_name or "").strip()
    if not new_name:
        raise ValueError("New card name must not be empty")
    if name in VIRTUAL_CARDS or new_name in VIRTUAL_CARDS:
        raise ValueError(f"{new_name if new_name in VIRTUAL_CARDS else name} is a reserved name and cannot be used as a card name")
    if new_name == name:
        return name
    root = wildcard_root()
    folder = _join(root, _safe_name(category))
    src = _join(folder, f"{_safe_name(name)}.txt")
    if not src.is_file():
        raise FileNotFoundError(f"Card not found: {category}:{name}")
    dst = _join(folder, f"{_safe_name(new_name)}.txt")
    if dst.is_file():
        raise FileExistsError(f"A card with that name already exists: {new_name}")

    src_stem, dst_stem = _safe_name(name), _safe_name(new_name)
    # 先挪 .txt (失败直接抛错, 封面不动), 成功后再逐个挪封面
    os.replace(src, dst)
    moved = 0
    for ext in COVER_EXTS:
        cover_src = _join(folder, f"{src_stem}{ext}")
        if not cover_src.is_file():
            continue
        cover_dst = _join(folder, f"{dst_stem}{ext}")
        try:
            if cover_dst.is_file():
                cover_dst.unlink()
            os.replace(cover_src, cover_dst)
            moved += 1
        except OSError:
            pass
    if moved:
        print(f"[RiceRabbit] Moved {moved} cover file(s) with the rename: {name} -> {new_name}")
    return new_name


def delete_card(category: str, name: str) -> None:
    """删卡片 -> 移到 data/trash/<时间戳>/<分类>/ 。"""
    if name in VIRTUAL_CARDS:
        raise ValueError(f"{name} is a virtual card and cannot be deleted")
    folder = _join(wildcard_root(), _safe_name(category))
    stamp = time.strftime("%Y%m%d-%H%M%S")
    target = _join(_trash_dir(), stamp, _safe_name(category))
    target.mkdir(parents=True, exist_ok=True)
    stem = _safe_name(name)
    moved = False
    for path in [folder / f"{stem}.txt", *(folder / f"{stem}{ext}" for ext in COVER_EXTS)]:
        path = _join(folder, path.name)
        if path.is_file():
            shutil.move(str(path), str(_join(target, path.name)))
            moved = True
    if not moved:
        raise FileNotFoundError(f"Card not found: {category}:{name}")


def create_type(name: str) -> bool:
    folder = _join(wildcard_root(), _safe_name(name))
    if folder.is_dir():
        return False
    folder.mkdir(parents=True, exist_ok=True)
    return True


def delete_type(name: str) -> None:
    folder = _join(wildcard_root(), _safe_name(name))
    if not folder.is_dir():
        raise FileNotFoundError(f"Category not found: {name}")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    target = _join(_trash_dir(), stamp)
    target.mkdir(parents=True, exist_ok=True)
    shutil.move(str(folder), str(_join(target, folder.name)))


def save_cover(category: str, name: str, data: bytes, ext: str) -> Path:
    if name in VIRTUAL_CARDS:
        raise ValueError(f"{name} is a virtual card and cannot have a cover")
    folder = _join(wildcard_root(), _safe_name(category))
    # 分类必须已存在: 否则一个打错的分类名会悄悄在卡片库里建出空目录
    if not folder.is_dir():
        raise FileNotFoundError(f"Category not found: {category}")
    ext = ext if ext in COVER_EXTS else ".png"
    stem = _safe_name(name)
    for old in COVER_EXTS:  # 换扩展名时清掉旧封面
        if old != ext:
            old_path = _join(folder, f"{stem}{old}")
            if old_path.is_file():
                try:
                    old_path.unlink()
                except OSError:
                    pass
    target = _join(folder, f"{stem}{ext}")
    target.write_bytes(data)
    return target


def delete_cover(category: str, name: str) -> bool:
    """删掉卡片的所有同名封面图, 返回是否真的删到了。"""
    if name in VIRTUAL_CARDS:
        raise ValueError(f"{name} is a virtual card and has no cover")
    folder = _join(wildcard_root(), _safe_name(category))
    stem = _safe_name(name)
    removed = False
    for ext in COVER_EXTS:
        path = _join(folder, f"{stem}{ext}")
        if path.is_file():
            try:
                path.unlink()
                removed = True
            except OSError:
                pass
    return removed


# ---------------------------------------------------------------- 提示词库


def _pl_path() -> Path:
    # prompt_library_file() 已经做过 realpath + commonpath 的包含检查
    return prompt_library_file()


def _pl_stamp() -> tuple:
    path = _pl_path()
    try:
        st = path.stat()
        return (str(path), st.st_mtime_ns, st.st_size)
    except OSError:
        return (str(path), 0, 0)


def read_prompt_library() -> list[dict]:
    """读取提示词库 (兼容旧版纯字符串数组)。"""
    path = _pl_path()
    stamp = _pl_stamp()
    if _PL_CACHE["stamp"] == stamp:
        return _PL_CACHE["items"]
    items: list[dict] = []
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
        if isinstance(raw, list):
            for entry in raw:
                if isinstance(entry, dict):
                    text = str(entry.get("text") or "").strip()
                    if text:
                        items.append({"text": text, "category": str(entry.get("category") or DEFAULT_CATEGORY).strip() or DEFAULT_CATEGORY})
                elif isinstance(entry, str) and entry.strip():
                    items.append({"text": entry.strip(), "category": DEFAULT_CATEGORY})
    except FileNotFoundError:
        items = []
    except Exception:
        # 半截 JSON: 不要把用户的库当成空的显示, 直接退回上次读到的内容
        return _PL_CACHE["items"]
    _PL_CACHE.update({"stamp": stamp, "items": items})
    return items


def grouped_prompt_library() -> dict[str, list[str]]:
    """按分类分组 (分类顺序 = 库中首次出现的顺序)。"""
    groups: dict[str, list[str]] = {}
    for item in read_prompt_library():
        groups.setdefault(item["category"], []).append(item["text"])
    return groups


# ---------------------------------------------------------------- ANR 内置提示词库

# ANR 的内置提示词库是前端 JS (web/js/data/builtinPrompts.js), 不是标准 JSON:
#   export const builtinPromptGroups = [
#     { name: "画质画风", tags: [["best quality", "最佳质量"], ...] },
#     ...
#   ];
# 这里用正则抽 { name: "...", tags: [[en, zh], ...] }, 只读不改。
_BUILTIN_GROUP_RE = re.compile(r'\{\s*name:\s*"([^"]+)"\s*,\s*tags:\s*\[(.*?)\]\s*,?\s*\}', re.S)
_BUILTIN_TAG_RE = re.compile(r'\[\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\]')

_BUILTIN_CACHE: dict = {"stamp": None, "groups": {}}


def builtin_prompt_groups() -> dict[str, list[list[str]]]:
    """ANR 内置提示词库 (只读), 返回 {分组名: [[英文, 中文], ...]}。

    ANR 路径没配 / 文件不存在时返回空 dict (不影响自定义库)。
    """
    root = anr_root()
    if root is None:
        return {}
    try:
        path = contain(root, root / "web" / "js" / "data" / "builtinPrompts.js")
    except ValueError:
        return {}
    try:
        st = path.stat()
        stamp = (str(path), st.st_mtime_ns, st.st_size)
    except OSError:
        return {}
    if _BUILTIN_CACHE["stamp"] == stamp:
        return _BUILTIN_CACHE["groups"]
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return {}
    # 文件末尾还有 LEGACY_CATEGORY_NAMES, 只取 builtinPromptGroups 定义段
    start = text.find("builtinPromptGroups")
    end = text.find("LEGACY_CATEGORY_NAMES")
    body = text[start:end] if start >= 0 and end > start else text
    groups: dict[str, list[list[str]]] = {}
    for match in _BUILTIN_GROUP_RE.finditer(body):
        name = match.group(1).strip()
        tags = [
            [en.strip(), zh.strip()]
            for en, zh in _BUILTIN_TAG_RE.findall(match.group(2))
            if en.strip()
        ]
        if name and tags:
            groups[name] = tags
    _BUILTIN_CACHE.update({"stamp": stamp, "groups": groups})
    return groups


def add_prompt(text: str, category: str = DEFAULT_CATEGORY) -> list[dict]:
    text = (text or "").strip()
    if not text:
        raise ValueError("Content must not be empty")
    category = (category or DEFAULT_CATEGORY).strip() or DEFAULT_CATEGORY
    with _LOCK:
        items = [x for x in read_prompt_library() if x["text"] != text]
        items.insert(0, {"text": text, "category": category})
        items = items[:PL_MAX_ITEMS]
        _write_prompt_library(items)
    return items


def delete_prompt(text: str) -> list[dict]:
    with _LOCK:
        items = [x for x in read_prompt_library() if x["text"] != (text or "").strip()]
        _write_prompt_library(items)
    return items


def _write_prompt_library(items: list[dict]) -> None:
    path = _pl_path()
    _atomic_write(path.parent, path, json.dumps(items, ensure_ascii=False, indent=2))
    _PL_CACHE.update({"stamp": _pl_stamp(), "items": items})


def invalidate_prompt_cache() -> None:
    """丢掉提示词库缓存 (改完 data/library.json 指向别的库时调用)。"""
    _PL_CACHE.update({"stamp": None, "items": []})


def library_info() -> dict:
    path = _pl_path()
    root = wildcard_root()
    return {
        "wildcards_dir": str(root),
        "prompt_library": str(path),
        "prompt_library_exists": path.is_file(),
        "cards": sum(len(list_cards(t)) for t in list_types()),
        "prompts": len(read_prompt_library()),
    }
