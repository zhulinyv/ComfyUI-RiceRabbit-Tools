"""标签在线翻译 (无 API Key 的多源免费接口), 带本地词典与磁盘缓存。

翻译策略与 Auto-NovelAI-Refactor 的 utils/translate.py 一致:
先查本地 Danbooru 词典的中文列, 查不到再依次尝试 Google / MyMemory / Bing / 百度,
单源失败立即换下一个, 失败的源冷却 60 秒。结果落盘到 data/translate_cache.json。

连接方式: 先按环境/系统代理请求 (requests 默认读 HTTP(S)_PROXY), 失败再直连 ——
挂梯子的用户与纯直连的用户都能用。
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import ricerabbit_tags
from ricerabbit_paths import data_dir

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

_TIMEOUT_FAST = (2.5, 5)
_TIMEOUT_SLOW = (4, 10)
_COOLDOWN = 60.0
_FAIL_UNTIL: dict[str, float] = {}
_CACHE_LOCK = threading.RLock()
_MEM_CACHE: dict[str, str] = {}
_DISK_LOADED = False
_MAX_WORKERS = 4


# ---------------------------------------------------------------- 缓存


def _cache_file():
    return data_dir() / "translate_cache.json"


def _load_disk_cache() -> None:
    global _DISK_LOADED
    if _DISK_LOADED:
        return
    with _CACHE_LOCK:
        if _DISK_LOADED:
            return
        try:
            data = json.loads(_cache_file().read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for key, value in data.items():
                    if isinstance(key, str) and isinstance(value, str):
                        _MEM_CACHE[key] = value
        except Exception:
            pass
        _DISK_LOADED = True


def _save_disk_cache() -> None:
    with _CACHE_LOCK:
        try:
            _cache_file().write_text(json.dumps(_MEM_CACHE, ensure_ascii=False, indent=0), encoding="utf-8")
        except OSError:
            pass


def _key(text: str) -> str:
    return (text or "").strip().lower().replace(" ", "_")


# ---------------------------------------------------------------- 单源实现


def _request(method: str, url: str, **kw):
    import requests

    last: Exception | None = None
    for idx, trust_env in enumerate((True, False)):
        timeout = _TIMEOUT_FAST if idx == 0 else _TIMEOUT_SLOW
        try:
            sess = requests.Session()
            sess.trust_env = trust_env
            sess.headers.update(_HEADERS)
            resp = sess.request(method, url, timeout=timeout, **kw)
            resp.raise_for_status()
            return resp, sess
        except Exception as exc:  # noqa: BLE001 - 换连接方式重试
            last = exc
    raise last if last is not None else RuntimeError("翻译请求失败")


def _google(text: str) -> str:
    resp, _ = _request(
        "GET",
        "https://translate.googleapis.com/translate_a/single",
        params={"client": "gtx", "sl": "en", "tl": "zh-CN", "dt": "t", "q": text},
    )
    data = resp.json()
    parts = [seg[0] for seg in (data[0] or []) if seg and seg[0]]
    out = "".join(parts).strip()
    if not out:
        raise RuntimeError("Google 返回空结果")
    return out


def _mymemory(text: str) -> str:
    resp, _ = _request(
        "GET",
        "https://api.mymemory.translated.net/get",
        params={"q": text, "langpair": "en|zh-CN"},
    )
    out = str(resp.json().get("responseData", {}).get("translatedText") or "").strip()
    if not out or "MYMEMORY WARNING" in out.upper() or "EXCEEDED" in out.upper():
        raise RuntimeError("MyMemory 未返回有效译文")
    return out


def _bing(text: str) -> str:
    resp, sess = _request("GET", "https://cn.bing.com/translator")
    match = re.search(r'IG:"([0-9A-Fa-f]{8,})"', resp.text)
    if not match:
        raise RuntimeError("Bing 页面未找到 IG token")
    url = f"https://cn.bing.com/ttranslatev3?isVertical=1&&IG={match.group(1)}&IID=translator.5028"
    payload = {"fromLang": "en", "text": text, "to": "zh-Hans", "token": "", "key": ""}
    resp2 = sess.post(url, data=payload, timeout=_TIMEOUT_SLOW)
    resp2.raise_for_status()
    data = resp2.json()
    if isinstance(data, list) and data and data[0].get("translations"):
        out = str(data[0]["translations"][0].get("text") or "").strip()
        if out:
            return out
    raise RuntimeError("Bing 返回异常")


def _baidu(text: str) -> str:
    resp, sess = _request("GET", "https://fanyi.baidu.com/", headers={"Referer": "https://fanyi.baidu.com/"})
    resp2 = sess.post(
        "https://fanyi.baidu.com/transapi",
        data={"from": "en", "to": "zh", "query": text},
        timeout=_TIMEOUT_SLOW,
    )
    resp2.raise_for_status()
    data = resp2.json()
    if data.get("errno") in (0, None) and data.get("data"):
        out = str(data["data"][0].get("dst") or "").strip()
        if out:
            return out
    raise RuntimeError("百度返回异常")


_PROVIDERS = [
    ("google", _google),
    ("bing", _bing),
    ("baidu", _baidu),
    ("mymemory", _mymemory),
]


def _cooling(name: str) -> bool:
    until = _FAIL_UNTIL.get(name, 0.0)
    if until <= time.monotonic():
        _FAIL_UNTIL.pop(name, None)
        return False
    return True


def _same_word(a: str, b: str) -> bool:
    """译文和原文是同一个词 (免费接口遇到不认识的词会原样回显)。"""

    def norm(s: str) -> str:
        return re.sub(r"[\s_]+", "", s).lower()

    return norm(a) == norm(b)


def _translate_one(text: str) -> str:
    """按优先级找第一个能用的源。"""
    for name, fn in _PROVIDERS:
        if _cooling(name):
            continue
        try:
            out = fn(text)
            if out and not _same_word(out, text):
                _FAIL_UNTIL.pop(name, None)
                return out
        except Exception:
            _FAIL_UNTIL[name] = time.monotonic() + _COOLDOWN
    return ""


# ---------------------------------------------------------------- 对外接口


class _Failed:
    pass


def translate_many(tags: list[str]) -> dict[str, str]:
    """批量翻译 (本地词典 -> 磁盘缓存 -> 在线)。返回 {原文: 译文}。"""
    _load_disk_cache()
    result: dict[str, str] = {}
    pending: list[str] = []

    for raw in tags:
        tag = (raw or "").strip()
        if not tag:
            continue
        local = ricerabbit_tags.lookup_zh(tag)
        if local:
            result[tag] = local
            continue
        cached = _MEM_CACHE.get(_key(tag))
        if cached:
            result[tag] = cached
            continue
        pending.append(tag)

    if not pending:
        return result

    lock = threading.Lock()

    def work(tag: str) -> None:
        out = _translate_one(tag)
        if not out:
            return
        with lock:
            _MEM_CACHE[_key(tag)] = out
            result[tag] = out

    # 同一个源最多 2 个并发, 这里用 4 个工人分摊不同源; 失败源有冷却, 不会互相拖死
    with ThreadPoolExecutor(max_workers=min(_MAX_WORKERS, len(pending))) as pool:
        list(pool.map(work, pending))

    if result:
        _save_disk_cache()
    return result


def stats() -> dict:
    _load_disk_cache()
    return {"cached": len(_MEM_CACHE), "file": str(_cache_file())}


if __name__ == "__main__":  # pragma: no cover
    import sys

    words = sys.argv[1:] or ["1girl", "long_hair"]
    print(translate_many(words))
