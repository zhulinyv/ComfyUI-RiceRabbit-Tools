"""提示词文本处理: 格式化、拼接、wildcard 展开。

格式化规则照搬 Auto-NovelAI-Refactor 的 ``utils/helpers.py::format_str``:

    - 逐行处理 (换行原样保留, 空行保留)
    - 逗号两侧的空白/连续逗号统一成单个 ", "
    - 连续空格压成一个
    - 每行首尾空白去掉

自定义分隔符 (不是逗号) 时只做空白清理, 不动逗号 —— 否则用户拿 "|" 或换行当
分隔符时, 正文里的逗号会被无条件改写。
"""

from __future__ import annotations

import json
import os
import random
import re
import threading
from pathlib import Path

# wildcard 标记: 只认 <分类:卡片>。分类与卡片名都不允许出现 < > 与换行。
# 冒号两侧只容忍空格/制表符, 免得把跨行、正文带冒号的结构化提示词整段吃掉。
_WILDCARD_TOKEN = re.compile(r"<[ \t]*([^:<>\r\n]+?)[ \t]*:[ \t]*([^<>\r\n]+?)[ \t]*>")

# 替换轮数上限: 卡片内容可以再引用别的卡片, 正常几轮就收敛; 自引用时必须有退出路径
_MAX_ROUNDS = 50

# 特殊卡片名 (分类级操作, 不是真实文件名)
_KEY_RANDOM = "随机"
_KEY_SEQUENTIAL = "顺序"

_TXT_EXTS = (".txt",)

_seq_lock = threading.Lock()


# ---------------------------------------------------------------- 格式化


def _clean_line(line: str, normalize_comma: bool) -> str:
    if normalize_comma:
        line = re.sub(r"[,\s]*,[,\s]*", ", ", line)
    line = re.sub(r" +", " ", line)
    return line.strip()


# embedding 裸词识别: 词 = 连续的"非分隔符"字符。分隔符是提示词里的结构性符号
# (空白/逗号/括号/冒号/方括号/尖括号/竖线) —— 中文冒号也算。点号和连字符、
# 中日文字符都在词内 (比如 embedding 文件名 "2.5d-游戏风" 是一个完整的词)。
_EMB_WORD_RE = re.compile(r"[^\s,()\[\]<>:|：]+")

_EMB_PREFIX = "embedding:"


def add_embedding_prefixes(text: str, embedding_names: set[str]) -> str:
    """把与 embedding 文件名匹配的裸词自动加上 ``embedding:`` 前缀。

    - 名字大小写不敏感匹配, 替换时用目录里的规范名 (不带扩展名)
    - 已带 ``embedding:`` 前缀的词不重复处理
    - ``<分类:卡片>`` wildcard 标记内部不处理 (那里是卡片名, 不是 embedding)
    """
    if not text or not embedding_names:
        return text
    lowered: dict[str, str] = {}
    for name in embedding_names:
        name = name.strip()
        if name:
            lowered[name.lower()] = name

    out: list[str] = []
    for part in re.split(r"(<[^<>]*>)", text):
        if not part:
            continue
        if part.startswith("<") and part.endswith(">"):
            out.append(part)  # wildcard 标记内部不动
            continue

        def repl_word(match: re.Match, part: str = part) -> str:
            word = match.group(0)
            start = match.start()
            prev = part[max(0, start - len(_EMB_PREFIX)) : start].lower()
            if prev.endswith(_EMB_PREFIX):
                return word  # 已带前缀 (embedding:EasyNegative 里的 EasyNegative)
            canonical = lowered.get(word.lower())
            return f"{_EMB_PREFIX}{canonical}" if canonical else word

        out.append(_EMB_WORD_RE.sub(repl_word, part))
    return "".join(out)


def format_prompt(text: str, separator: str = ",", enabled: bool = True) -> str:
    """格式化提示词 (逐行, 保留换行结构)。"""
    if not text or not enabled:
        return text or ""
    normalize_comma = _is_comma(separator)
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    for line in lines:
        if line.endswith("\n"):
            content = line[:-1]
            out.append(_clean_line(content, normalize_comma) + "\n" if content else "\n")
        else:
            out.append(_clean_line(line, normalize_comma))
    return "".join(out)


def _is_comma(separator: str) -> bool:
    """分隔符是不是逗号 (允许前后带空白, 也认全角逗号)。"""
    return (separator or "").strip() in ("", ",", "，")


def join_prompt(text_input: str, prompt: str, separator: str = ",") -> str:
    """把上游 text 与节点自身的提示词按分隔符拼起来 (两边都空时返回空串)。

    任一侧为空时不留分隔符 —— 否则结果会以 ", " 开头或以逗号结尾。
    """
    left = (text_input or "").strip()
    right = (prompt or "").strip()
    if not left:
        return right
    if not right:
        return left
    sep = separator if separator is not None else ","
    if not sep:
        return left + right
    # 分隔符是换行时, 避免出现三连空行
    if "\n" in sep:
        return f"{left}{sep}{right}"
    return f"{left}{sep}{right}" if sep.endswith(" ") else f"{left}{sep} {right}"


# ---------------------------------------------------------------- wildcard


def _list_cards(root: Path, category: str) -> list[str]:
    """分类下的卡片名 (不含扩展名), 按文件名排序。"""
    path = root / category
    if not path.is_dir():
        return []
    try:
        names = [f for f in os.listdir(path) if f.lower().endswith(_TXT_EXTS)]
    except OSError:
        return []
    return sorted(os.path.splitext(f)[0] for f in names)


def _read_card(root: Path, category: str, name: str) -> str:
    path = root / category / f"{name}.txt"
    # 编码容错: 老卡片可能是 GBK, 读不出来也不该让整次生成失败
    for encoding in ("utf-8-sig", "utf-8", "gbk"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
        except OSError:
            break
    return ""


def _seq_file() -> Path:
    from ricerabbit_paths import data_dir

    return data_dir() / "wildcard_seq.json"


def _next_sequential(root: Path, category: str) -> str:
    """顺序取卡: 按分类维护一个游标, 到末尾后回到第一张。"""
    names = _list_cards(root, category)
    if not names:
        return ""
    with _seq_lock:
        path = _seq_file()
        try:
            data = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
            if not isinstance(data, dict):
                data = {}
        except Exception:
            data = {}
        # 分类名带上卡片库路径做 key: 换库/换机器时不会串台
        key = f"{root.as_posix()}::{category}"
        index = data.get(key, -1)
        try:
            index = int(index) + 1
        except Exception:
            index = 0
        if index >= len(names):
            index = 0
        data[key] = index
        try:
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass
    return names[index]


def replace_wildcards(
    text: str,
    root: Path | None = None,
    max_rounds: int = _MAX_ROUNDS,
    seed: int | None = None,
) -> str:
    """把 <分类:卡片> 换成卡片内容, 支持 <分类:随机> / <分类:顺序>。

    - 每个出现位置**独立抽取**: 同一段文本里写两个 <画质:随机> 会各抽各的,
      两个 <画质:顺序> 会各取下一张 (游标各推进一格) —— 不能用 str.replace
      一次全替换, 那会让所有相同标记变成同一张卡
    - 传了 seed 时随机抽取用种子派生的 RNG: 同 seed + 同文本 -> 同样的抽取结果
      (可复现); seed 为 None 时用全局随机
    - **替换点末尾补逗号**: 替换后如果后面还有内容 (紧接词 / 空格接词 / 换行接词),
      且替换内容不以逗号结尾, 就在替换内容末尾补一个逗号, 避免卡片内容与后面的
      提示词直接粘连; 后面紧跟逗号或已到文本末尾时不补
    - 解析不了的标记原样保留 (不抛错): 一张卡片缺失不该让整张图没法生成
    - 卡片内容里嵌套的 <分类:卡片> 会被下一轮继续替换 (上限 max_rounds 轮)
    """
    if not text or "<" not in text:
        return text or ""
    if root is None:
        from ricerabbit_paths import wildcards_dir

        root = wildcards_dir()

    token_seq = 0  # 出现顺序计数 (跨轮累计, 用于派生确定性的随机源)
    for _ in range(max_rounds):
        cache: dict[str, str] = {}
        replaced = 0
        pieces: list[str] = []
        last_end = 0

        # 手动遍历而不是 re.sub: 需要拿到每个替换点后面的原文, 来判断要不要补逗号
        for match in _WILDCARD_TOKEN.finditer(text):
            pieces.append(text[last_end : match.start()])
            idx = token_seq
            token_seq += 1
            token, category, name = match.group(0), match.group(1), match.group(2)
            after = text[match.end() :].lstrip()
            needs_comma = bool(after) and after[0] not in (",", "，")
            try:
                if name == _KEY_RANDOM:
                    names = _list_cards(root, category)
                    if not names:
                        raise FileNotFoundError(category)
                    if seed is None:
                        card = random.choice(names)
                    else:
                        card = random.Random(f"{seed}:{category}:r:{idx}").choice(names)
                elif name == _KEY_SEQUENTIAL:
                    card = _next_sequential(root, category)
                    if not card:
                        raise FileNotFoundError(category)
                else:
                    card = name
                key = f"{category}/{card}"
                if key not in cache:
                    cache[key] = _read_card(root, category, card).strip()
                content = cache[key]
                if not content:
                    raise FileNotFoundError(key)
            except Exception:
                pieces.append(token)  # 解析失败: 原样保留 (不补逗号, 不动结构)
                last_end = match.end()
                continue
            replaced += 1
            if needs_comma and not content.rstrip().endswith((",", "，")):
                content = content.rstrip() + ","
            pieces.append(content)
            last_end = match.end()

        pieces.append(text[last_end:])
        text = "".join(pieces)
        if not replaced:
            break
    return text


def expand(text: str, root: Path | None = None) -> str:
    """便捷入口: 只做 wildcard 展开。"""
    return replace_wildcards(text, root)


__all__ = ["add_embedding_prefixes", "expand", "format_prompt", "join_prompt", "replace_wildcards"]
