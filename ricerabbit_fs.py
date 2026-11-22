"""Filesystem containment helpers shared by the plugin.

Card names and categories come from wildcard markers (workflow text or
``POST /ricerabbit/expand``), and the library folders come from the local
``data/library.json`` file. Either way, nothing is allowed to step outside the
folder that was explicitly configured:

* ``is_network_path`` rejects UNC / device forms *before* any filesystem call,
  because on Windows a single ``stat()`` on ``\\\\host\\share`` opens an SMB
  connection with the account's credentials;
* ``contain`` resolves both paths with ``os.path.realpath`` and compares them
  with ``os.path.commonpath`` (case-insensitive on Windows), so ``..``,
  symlinks and junctions cannot escape the base folder;
* ``safe_child`` is the variant used for name parts: it rejects separators,
  colons and NUL, then applies ``contain``.
"""

from __future__ import annotations

import os
from pathlib import Path

__all__ = ["is_network_path", "real_path", "contain", "safe_child"]

# \\host\share and //host/share (POSIX spelling)
_NETWORK_PREFIXES = ("\\\\", "//")


def is_network_path(path) -> bool:
    """True for network-share / device paths, checked without touching disk.

    On Windows, even a single stat on a UNC path makes the process connect to
    that host and authenticate with the Windows account's credentials, so this
    check only looks at the string form. Callers must run it before
    ``is_dir`` / ``stat`` / ``realpath``.
    """
    text = os.fspath(path)
    if not text:
        return False
    if text.startswith(_NETWORK_PREFIXES):
        return True
    drive, _ = os.path.splitdrive(text)
    return bool(drive) and drive.startswith(_NETWORK_PREFIXES)


def real_path(path) -> Path:
    """``Path.resolve()`` without requiring the target to exist."""
    return Path(os.path.realpath(os.fspath(path)))


def contain(base, target) -> Path:
    """Resolve *target* and require it to stay inside *base*.

    Raises ``ValueError`` when the target is a network path, when it resolves
    outside the base folder, or when it resolves to the base folder itself.
    Returns the resolved target.
    """
    base_text = os.fspath(base)
    target_text = os.fspath(target)
    if is_network_path(base_text) or is_network_path(target_text):
        raise ValueError(f"Network paths are not supported: {target_text}")

    base_real = Path(os.path.realpath(base_text))
    target_real = Path(os.path.realpath(target_text))
    if is_network_path(base_real) or is_network_path(target_real):
        raise ValueError(f"Network paths are not supported: {target_text}")

    try:
        common = os.path.commonpath([str(base_real), str(target_real)])
    except ValueError:
        raise ValueError(f"Path is outside the library folder: {target_text}") from None
    if common != str(base_real) or target_real == base_real:
        raise ValueError(f"Path is outside the library folder: {target_text}")
    return target_real


def _safe_part(value: str) -> str | None:
    """One path segment of a card/category name, or None when it is unsafe."""
    name = (value or "").strip()
    if not name or name in (".", ".."):
        return None
    if any(ch in name for ch in ("/", "\\", ":", "\x00")):
        return None
    return name


def safe_child(root, *parts: str) -> Path | None:
    """Join *parts* under *root*, returning None when the result would escape.

    Wildcard markers are user input, so both the category and the card name
    are treated as hostile: separators, ``..`` and drive/UNC prefixes are
    rejected first, then the resolved path is checked with ``contain``.
    """
    if not parts:
        return None
    cleaned = []
    for part in parts:
        value = _safe_part(part)
        if value is None:
            return None
        cleaned.append(value)
    try:
        base = os.fspath(root)
        if is_network_path(base):
            return None
        return contain(base, Path(base).joinpath(*cleaned))
    except (OSError, ValueError):
        return None
