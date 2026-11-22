"""HTTP 接口: 卡片库 / 提示词库 / 自动补全 / 翻译 / 封面图。

ComfyUI 的服务端是 aiohttp (不是 FastAPI), 所以路由写成
``async def handler(request)`` 并返回 ``web.json_response`` / ``web.FileResponse``。
所有磁盘 IO 都丢进 ``asyncio.to_thread``, 不阻塞事件循环。
"""

from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path

import ricerabbit_compare as compare
import ricerabbit_library as lib
import ricerabbit_presets as presets
import ricerabbit_tags as tags
import ricerabbit_translate as tr
from ricerabbit_fs import contain
from ricerabbit_paths import (
    CONFIG_FILE,
    DEFAULT_PROMPT_LIB,
    DEFAULT_WILDCARDS_DIR,
    anr_root,
)
from ricerabbit_text import replace_wildcards

PREFIX = "/ricerabbit"

# 封面上限: 前端用 data URL 传, 太大容易把请求撑爆
MAX_COVER_BYTES = 8 * 1024 * 1024


def _json(data, status: int = 200):
    from aiohttp import web

    # 不转义中文: 前端拿到的就是可读文本, 体积也更小
    return web.json_response(data, status=status, dumps=lambda o: json.dumps(o, ensure_ascii=False))


def _error(message: str, status: int = 400):
    return _json({"detail": str(message)}, status)


async def _payload(request) -> dict:
    try:
        data = await request.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


# ---------------------------------------------------------------- 同步实现 (跑在线程池)


def _config_payload() -> dict:
    root = anr_root()
    info = lib.library_info()
    info.update(
        {
            "anr_path": str(root) if root else "",
            # 库位置只来自插件目录下这个手写文件, 没有任何路由会写它
            "config_file": str(CONFIG_FILE),
            "config_file_exists": CONFIG_FILE.is_file(),
            "default_wildcards": str(DEFAULT_WILDCARDS_DIR),
            "default_prompt_lib": str(DEFAULT_PROMPT_LIB),
            "tag_dict": tags.stats(),
        }
    )
    return info


def _refresh_payload() -> dict:
    # 词典按文件指纹自动失效, 这里只清提示词库缓存就够了 (重建 32 万行词典要 1 秒, 没必要)
    lib.invalidate_prompt_cache()
    return {"ok": True, **lib.library_info()}


def _prompts_payload() -> dict:
    return {
        "groups": lib.grouped_prompt_library(),
        # ANR 内置提示词库 (只读): {分组: [[英文, 中文], ...]}
        "builtin_groups": lib.builtin_prompt_groups(),
        "items": lib.read_prompt_library(),
    }


def _save_card(payload: dict) -> dict:
    category = payload.get("type", "")
    lib.save_card(category, payload.get("name", ""), payload.get("content", ""))
    return {"ok": True, "cards": lib.list_cards(category)}


def _rename_card(payload: dict) -> dict:
    category = payload.get("type", "")
    new_name = lib.rename_card(category, payload.get("name", ""), payload.get("new_name", ""))
    return {"ok": True, "new_name": new_name, "cards": lib.list_cards(category)}


def _delete_card(payload: dict) -> dict:
    category = payload.get("type", "")
    lib.delete_card(category, payload.get("name", ""))
    return {"ok": True, "cards": lib.list_cards(category)}


def _create_type(payload: dict) -> dict:
    created = lib.create_type(payload.get("name", ""))
    return {"ok": True, "created": created, "types": lib.list_types()}


def _delete_type(payload: dict) -> dict:
    lib.delete_type(payload.get("name", ""))
    return {"ok": True, "types": lib.list_types()}


def _save_cover(payload: dict) -> dict:
    """接收前端 FileReader 读出的 data URL, 存成 <分类>/<卡片名>.<ext>。"""
    category = payload.get("type", "")
    name = payload.get("name", "")
    data_url = str(payload.get("data") or "")
    if not data_url:
        raise ValueError("No image data received")

    ext = ".png"
    if data_url.startswith("data:"):
        header, _, b64 = data_url.partition(",")
        if "image/jpeg" in header or "image/jpg" in header:
            ext = ".jpg"
        elif "image/webp" in header:
            ext = ".webp"
        elif "image/gif" in header:
            ext = ".gif"
        data_url = b64
    else:
        ext = str(payload.get("ext") or ".png").lower()

    try:
        raw = base64.b64decode(data_url, validate=False)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Could not parse image data: {exc}") from exc
    if not raw:
        raise ValueError("Image data is empty")
    if len(raw) > MAX_COVER_BYTES:
        raise ValueError(f"Image too large ({len(raw) // 1024 // 1024} MB), please keep it under 8 MB")

    lib.save_cover(category, name, raw, ext)
    return {"ok": True, "cards": lib.list_cards(category)}


def _delete_cover(payload: dict) -> dict:
    category = payload.get("type", "")
    name = payload.get("name", "")
    removed = lib.delete_cover(category, name)
    return {"ok": True, "removed": removed, "cards": lib.list_cards(category)}


def _cover_path(category: str, name: str) -> Path | None:
    path = lib.find_cover(category, name)
    if path is None or not path.is_file():
        return None
    try:
        # 只允许读卡片库里的文件: realpath + commonpath, 挡住 ../ 与符号链接
        return contain(lib.wildcard_root(), path)
    except ValueError:
        return None


# ---------------------------------------------------------------- 路由


def _register(routes) -> None:
    from aiohttp import web

    # ---- 配置 / 库信息

    @routes.get(f"{PREFIX}/config")
    async def rr_config(request):
        try:
            return _json(await asyncio.to_thread(_config_payload))
        except Exception as exc:  # noqa: BLE001
            return _error(f"Failed to read config: {exc}", 500)

    @routes.post(f"{PREFIX}/refresh")
    async def rr_refresh(request):
        try:
            return _json(await asyncio.to_thread(_refresh_payload))
        except Exception as exc:  # noqa: BLE001
            return _error(f"Refresh failed: {exc}", 500)

    # ---- 卡片库

    @routes.get(f"{PREFIX}/wildcards")
    async def rr_types(request):
        try:
            types = await asyncio.to_thread(lib.list_types)
            return _json({"types": types, "root": str(lib.wildcard_root())})
        except Exception as exc:  # noqa: BLE001
            return _error(f"Failed to read card library: {exc}", 500)

    @routes.get(f"{PREFIX}/wildcards/{{category}}")
    async def rr_cards(request):
        category = request.match_info["category"]
        try:
            cards = await asyncio.to_thread(lib.list_cards, category)
            return _json({"type": category, "cards": cards})
        except Exception as exc:  # noqa: BLE001
            return _error(f"Failed to read card: {exc}", 500)

    @routes.get(f"{PREFIX}/wildcards/{{category}}/{{name}}")
    async def rr_card(request):
        category = request.match_info["category"]
        name = request.match_info["name"]
        try:
            content = await asyncio.to_thread(lib.get_card, category, name)
            return _json({"type": category, "name": name, "content": content})
        except FileNotFoundError as exc:
            return _error(exc, 404)
        except ValueError as exc:
            return _error(exc, 400)
        except Exception as exc:  # noqa: BLE001
            return _error(f"Failed to read card: {exc}", 500)

    @routes.post(f"{PREFIX}/wildcards/save")
    async def rr_save_card(request):
        payload = await _payload(request)
        try:
            return _json(await asyncio.to_thread(_save_card, payload))
        except (ValueError, OSError) as exc:
            return _error(exc, 400)

    @routes.post(f"{PREFIX}/wildcards/rename")
    async def rr_rename_card(request):
        payload = await _payload(request)
        try:
            return _json(await asyncio.to_thread(_rename_card, payload))
        except (ValueError, FileExistsError, FileNotFoundError, OSError) as exc:
            return _error(exc, 400)

    @routes.post(f"{PREFIX}/wildcards/delete")
    async def rr_delete_card(request):
        payload = await _payload(request)
        try:
            return _json(await asyncio.to_thread(_delete_card, payload))
        except (ValueError, FileNotFoundError, OSError) as exc:
            return _error(exc, 400)

    @routes.post(f"{PREFIX}/wildcards/cover")
    async def rr_save_cover(request):
        payload = await _payload(request)
        try:
            return _json(await asyncio.to_thread(_save_cover, payload))
        except (ValueError, OSError) as exc:
            return _error(exc, 400)

    @routes.post(f"{PREFIX}/wildcards/cover/delete")
    async def rr_delete_cover(request):
        payload = await _payload(request)
        try:
            return _json(await asyncio.to_thread(_delete_cover, payload))
        except (ValueError, OSError) as exc:
            return _error(exc, 400)

    @routes.post(f"{PREFIX}/wildcards/create-type")
    async def rr_create_type(request):
        payload = await _payload(request)
        try:
            return _json(await asyncio.to_thread(_create_type, payload))
        except (ValueError, OSError) as exc:
            return _error(exc, 400)

    @routes.post(f"{PREFIX}/wildcards/delete-type")
    async def rr_delete_type(request):
        payload = await _payload(request)
        try:
            return _json(await asyncio.to_thread(_delete_type, payload))
        except (ValueError, FileNotFoundError, OSError) as exc:
            return _error(exc, 400)

    @routes.get(f"{PREFIX}/cover")
    async def rr_cover(request):
        category = request.query.get("type", "")
        name = request.query.get("name", "")
        try:
            path = await asyncio.to_thread(_cover_path, category, name)
        except ValueError:
            path = None
        if path is None:
            return _error("Cover not found", 404)
        return web.FileResponse(path)

    # ---- 提示词库

    @routes.get(f"{PREFIX}/prompts")
    async def rr_prompts(request):
        try:
            return _json(await asyncio.to_thread(_prompts_payload))
        except Exception as exc:  # noqa: BLE001
            return _error(f"Failed to read prompt library: {exc}", 500)

    @routes.post(f"{PREFIX}/prompts/add")
    async def rr_prompt_add(request):
        payload = await _payload(request)
        try:
            items = await asyncio.to_thread(
                lib.add_prompt,
                payload.get("text", ""),
                payload.get("category", lib.DEFAULT_CATEGORY),
            )
            return _json({"ok": True, "items": items})
        except ValueError as exc:
            return _error(exc, 400)
        except OSError as exc:
            return _error(f"Save failed: {exc}", 500)

    @routes.post(f"{PREFIX}/prompts/delete")
    async def rr_prompt_delete(request):
        payload = await _payload(request)
        try:
            items = await asyncio.to_thread(lib.delete_prompt, payload.get("text", ""))
            return _json({"ok": True, "items": items})
        except OSError as exc:
            return _error(f"Delete failed: {exc}", 500)

    # ---- 补全 / 翻译

    @routes.get(f"{PREFIX}/suggest")
    async def rr_suggest(request):
        keyword = request.query.get("keyword", "")
        try:
            limit = int(request.query.get("limit", tags.LIMIT))
        except ValueError:
            limit = tags.LIMIT
        limit = max(1, min(limit, 50))
        try:
            items = await asyncio.to_thread(tags.suggest, keyword, limit)
            return _json({"keyword": keyword, "items": items})
        except Exception as exc:  # noqa: BLE001
            return _error(f"Autocomplete failed: {exc}", 500)

    @routes.post(f"{PREFIX}/translate")
    async def rr_translate(request):
        payload = await _payload(request)
        items = payload.get("tags") or []
        if not isinstance(items, list):
            return _error("`tags` must be an array", 400)
        cleaned = [str(t) for t in items if str(t).strip()][:200]
        if not cleaned:
            return _json({"translations": {}})
        try:
            return _json({"translations": await asyncio.to_thread(tr.translate_many, cleaned)})
        except Exception as exc:  # noqa: BLE001
            return _error(f"Translation failed: {exc}", 500)

    @routes.post(f"{PREFIX}/compare/save")
    async def rr_compare_save(request):
        try:
            payload = await _payload(request)
            result = await asyncio.to_thread(
                compare.save_cached,
                payload.get("node_id"),
                payload.get("picks"),
                payload.get("names"),
            )
            return _json(result)
        except (ValueError, FileNotFoundError) as exc:
            return _error(str(exc), 400)
        except Exception as exc:  # noqa: BLE001
            return _error(f"Save failed: {exc}", 500)

    @routes.post(f"{PREFIX}/expand")
    async def rr_expand(request):
        payload = await _payload(request)
        text = str(payload.get("text") or "")
        return _json({"text": await asyncio.to_thread(replace_wildcards, text)})

    # ---- 分辨率预设

    @routes.get(f"{PREFIX}/resolutions")
    async def rr_resolutions(request):
        try:
            items = await asyncio.to_thread(presets.labels)
            return _json({"presets": items, "custom": presets.CUSTOM_LABEL})
        except Exception as exc:  # noqa: BLE001
            return _error(f"Failed to read resolution presets: {exc}", 500)


def register() -> bool:
    """把路由挂到 ComfyUI 的 server 上 (失败时返回 False, 不影响节点本身可用)。"""
    try:
        from server import PromptServer

        instance = getattr(PromptServer, "instance", None)
        if instance is None:
            print("[RiceRabbit] PromptServer not ready, api registration skipped")
            return False
        _register(instance.routes)
        return True
    except Exception as exc:  # pragma: no cover - 只在异常环境触发
        print(f"[RiceRabbit] api registration failed: {exc}")
        return False
