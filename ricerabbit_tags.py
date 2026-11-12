"""标签词典: 自动补全建议 + 本地中文翻译。

数据格式沿用 Auto-NovelAI-Refactor 的 assets/danbooru_tags_full_zh.csv:

    tag,category,count,"aliases,逗号分隔",中文翻译

category 与 Danbooru 一致: 0=general 1=artist 3=copyright 4=character 5=meta。

词典优先读 ANR 目录里的那份 (见 ricerabbit_paths.tag_dict_candidates);
一份都没有时退化成"卡片名 + 提示词库"的小索引, 保证补全至少能用。
"""

from __future__ import annotations

import csv
import os
import re
import threading
import time
from pathlib import Path

from ricerabbit_paths import tag_dict_candidates, wildcards_dir

_LOCK = threading.RLock()
_CACHE: dict | None = None
_ZH: dict | None = None

# 每层独立上限 + 返回条数 (与 ANR 一致, 保证手感相同)
LIMIT = 20
LAYER_CAP = 40
SCAN_MAX_ROWS = 150_000
SCAN_MAX_MS = 100.0


def _fingerprint(paths: list[Path]) -> tuple:
    out = []
    for p in paths:
        try:
            st = p.stat()
            out.append((str(p), st.st_mtime_ns, st.st_size))
        except OSError:
            out.append((str(p), 0, 0))
    return tuple(out)


def _dict_path() -> Path | None:
    for p in tag_dict_candidates():
        if p.is_file():
            return p
    return None


def _load_rows(path: Path) -> list[tuple]:
    rows: list[tuple] = []
    try:
        with open(path, "r", encoding="utf-8-sig", newline="") as f:
            for row in csv.reader(f):
                if not row or not row[0].strip():
                    continue
                tag = row[0].strip()
                cat = int(row[1]) if len(row) >= 2 and row[1].strip().isdigit() else 0
                count = int(row[2]) if len(row) >= 3 and row[2].strip().isdigit() else 0
                aliases = [a.strip().lower() for a in row[3].split(",") if a.strip()] if len(row) >= 4 else []
                zh = row[4].strip() if len(row) >= 5 else ""
                if zh == tag:  # 表情/符号类标签译文与原文相同, 当没有译文
                    zh = ""
                rows.append((tag.lower(), tag, cat, count, aliases, zh))
    except OSError:
        return []
    rows.sort(key=lambda x: x[3], reverse=True)
    return rows


def _load_fallback_rows() -> list[tuple]:
    """没有词典时, 用卡片名与提示词库拼一个最小可用词表。"""
    rows: list[tuple] = []
    seen: set[str] = set()
    root = wildcards_dir()
    try:
        for category in sorted(os.listdir(root)) if root.is_dir() else []:
            sub = root / category
            if not sub.is_dir():
                continue
            for f in sorted(os.listdir(sub)):
                if not f.lower().endswith(".txt"):
                    continue
                name = os.path.splitext(f)[0]
                key = name.lower()
                if key and key not in seen:
                    seen.add(key)
                    rows.append((key, name, 0, 0, [], ""))
    except OSError:
        pass
    return rows


def _build() -> dict:
    path = _dict_path()
    if path is not None:
        rows = _load_rows(path)
    else:
        rows = _load_fallback_rows()
    exact2: dict[str, list[int]] = {}
    alias2: dict[str, list[int]] = {}
    for idx, row in enumerate(rows):
        tag_l, aliases = row[0], row[4]
        if len(tag_l) >= 2:
            exact2.setdefault(tag_l[:2], []).append(idx)
        for a in aliases:
            if len(a) >= 2:
                alias2.setdefault(a[:2], []).append(idx)
    return {
        "rows": rows,
        "exact2": exact2,
        "alias2": alias2,
        "fp": _fingerprint(tag_dict_candidates()),
        "source": str(path) if path else "",
    }


def get_cache() -> dict:
    """懒加载词典索引 (词典文件变了自动重建)。"""
    global _CACHE, _ZH
    cache = _CACHE
    fp = _fingerprint(tag_dict_candidates())
    if cache is not None and cache["fp"] == fp:
        return cache
    with _LOCK:
        if _CACHE is None or _CACHE["fp"] != fp:
            _CACHE = _build()
            _ZH = None
        return _CACHE


def zh_map() -> dict:
    """标签/别名 -> 中文 (小写键)。第一次用到时才建表。"""
    global _ZH
    if _ZH is not None:
        return _ZH
    with _LOCK:
        if _ZH is None:
            table: dict[str, str] = {}
            for tag_l, _tag, _cat, _count, aliases, zh in get_cache()["rows"]:
                if not zh:
                    continue
                table[tag_l] = zh
                for a in aliases:
                    table.setdefault(a, zh)
            _ZH = table
        return _ZH


def reset() -> None:
    global _CACHE, _ZH
    with _LOCK:
        _CACHE = None
        _ZH = None


def lookup_zh(text: str) -> str:
    """单个标签的本地译文 (查不到返回空串)。"""
    key = (text or "").strip().lower()
    if not key:
        return ""
    table = zh_map()
    return table.get(key) or table.get(key.replace(" ", "_")) or ""


def suggest(keyword: str, limit: int = LIMIT) -> list[dict]:
    """补全建议: 标签前缀 > 别名前缀 > 标签包含 > 别名包含 > 中文包含。"""
    kw = (keyword or "").strip().lower()
    if not kw:
        return []
    cache = get_cache()
    rows = cache["rows"]
    if not rows:
        return []
    kw_tag = kw.replace(" ", "_")

    exact: list[tuple] = []
    contains: list[tuple] = []
    alias_sub: list[tuple] = []
    zh_hit: list[tuple] = []
    used: set[int] = set()

    if len(kw_tag) >= 2:
        bucket = sorted(set(cache["exact2"].get(kw_tag[:2], ())) | set(cache["alias2"].get(kw_tag[:2], ())))
        for idx in bucket:
            if len(exact) >= LAYER_CAP:
                break
            tag_l, tag, cat, count, aliases, zh = rows[idx]
            if tag_l.startswith(kw_tag):
                exact.append((tag, cat, count, "", zh))
                used.add(idx)
            else:
                hit = next((a for a in aliases if a.startswith(kw_tag)), None)
                if hit is not None:
                    exact.append((tag, cat, count, hit, zh))
                    used.add(idx)

    sealed = len(kw_tag) >= 2
    if len(exact) < limit:
        deadline = time.monotonic() + SCAN_MAX_MS / 1000.0
        for idx, (tag_l, tag, cat, count, aliases, zh) in enumerate(rows):
            if idx >= SCAN_MAX_ROWS or (idx % 512 == 0 and time.monotonic() > deadline):
                break
            if idx in used:
                continue
            if tag_l.startswith(kw_tag):
                if len(exact) < LAYER_CAP:
                    exact.append((tag, cat, count, "", zh))
                continue
            hit = next((a for a in aliases if a.startswith(kw_tag)), None)
            if hit is not None:
                if len(exact) < LAYER_CAP:
                    exact.append((tag, cat, count, hit, zh))
                continue
            if kw_tag in tag_l:
                if len(contains) < LAYER_CAP:
                    contains.append((tag, cat, count, "", zh))
            else:
                hit2 = next((a for a in aliases if kw_tag in a), None)
                if hit2 is not None:
                    if len(alias_sub) < LAYER_CAP:
                        alias_sub.append((tag, cat, count, hit2, zh))
                elif zh and kw in zh:
                    if len(zh_hit) < LAYER_CAP:
                        zh_hit.append((tag, cat, count, "", zh))
            if len(exact) >= limit:
                break
            if sealed and len(exact) + len(contains) >= limit:
                break

    items = (exact + contains + alias_sub + zh_hit)[:limit]
    return [
        {"tag": t, "category": c, "count": n, "alias": a, "zh": z}
        for t, c, n, a, z in items
    ]


def stats() -> dict:
    cache = get_cache()
    return {"source": cache["source"], "count": len(cache["rows"])}


# 供测试脚本直接调用
if __name__ == "__main__":  # pragma: no cover
    import sys

    word = sys.argv[1] if len(sys.argv) > 1 else "1girl"
    print(stats())
    for it in suggest(word):
        print(it)
