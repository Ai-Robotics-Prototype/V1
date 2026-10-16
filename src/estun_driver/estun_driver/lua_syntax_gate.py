"""Lua 5.3 syntax gate for codegen output.

Uses libgen liblua5.3 (`luaL_loadstring`) via ctypes so no `luac`
subprocess or extra apt package is required. This is stage 3 of
the codegen pipeline in `docs/lua_contract.md` §9:

    contract lookup → emit → SYNTAX GATE → lint → HTTP POST → verify

Fail-closed: any parse error refuses the save. Bypass requires
`ESTUN_BYPASS_LUA_CONTRACT=1` (telemetry-flagged, off by default).
"""
from __future__ import annotations

import ctypes
import ctypes.util
import os
import re
import threading

__all__ = ["LuaSyntaxError", "LuaGateUnavailable", "check_syntax"]


class LuaSyntaxError(Exception):
    """Raised when generated Lua fails `luaL_loadstring`."""

    def __init__(self, message: str, *, line: int | None, col: int | None,
                 source_name: str, raw: str):
        super().__init__(message)
        self.line = line
        self.col = col
        self.source_name = source_name
        self.raw = raw


class LuaGateUnavailable(RuntimeError):
    """Raised when liblua5.3 cannot be loaded. Fail loud rather
    than silently skip the gate — a codegen path with no syntax
    check is not a shipping configuration."""


_ERR_RE = re.compile(r'^\[string "[^"]*"\]:(\d+)(?::(\d+))?:\s*(.*)$')

_lib_lock = threading.Lock()
_lib = None


def _load_lib() -> ctypes.CDLL:
    global _lib
    if _lib is not None:
        return _lib
    with _lib_lock:
        if _lib is not None:
            return _lib
        # ctypes.util.find_library returns something like 'liblua5.3.so.0'.
        name = ctypes.util.find_library("lua5.3")
        candidates = [name] if name else []
        candidates += ["liblua5.3.so.0", "liblua5.3.so"]
        last_err: Exception | None = None
        for cand in candidates:
            if not cand:
                continue
            try:
                lib = ctypes.CDLL(cand)
                break
            except OSError as e:
                last_err = e
        else:
            raise LuaGateUnavailable(
                f"liblua5.3 not loadable (tried {candidates!r}): {last_err}"
            )
        lib.luaL_newstate.restype = ctypes.c_void_p
        lib.luaL_loadstring.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        lib.luaL_loadstring.restype = ctypes.c_int
        lib.lua_close.argtypes = [ctypes.c_void_p]
        lib.lua_tolstring.argtypes = [
            ctypes.c_void_p, ctypes.c_int,
            ctypes.POINTER(ctypes.c_size_t),
        ]
        lib.lua_tolstring.restype = ctypes.c_char_p
        _lib = lib
        return _lib


def check_syntax(src: str, *, source_name: str = "codegen") -> None:
    """Parse `src` under Lua 5.3. Raises LuaSyntaxError on any parse
    error. Successful load-without-execute confirms the whole file
    is syntactically valid.

    `source_name` appears in error messages; keep it stable across a
    program's regeneration so operator-facing refusals are diffable.
    """
    if os.environ.get("ESTUN_BYPASS_LUA_CONTRACT") == "1":
        # Off-by-default operator override; refuse to silently skip.
        # The caller records a telemetry event on activation.
        return
    lib = _load_lib()
    L = lib.luaL_newstate()
    if not L:
        raise LuaGateUnavailable("luaL_newstate returned NULL")
    try:
        rc = lib.luaL_loadstring(L, src.encode("utf-8"))
        if rc == 0:
            return
        sz = ctypes.c_size_t(0)
        raw = lib.lua_tolstring(L, -1, ctypes.byref(sz)) or b""
        text = raw.decode("utf-8", errors="replace")
    finally:
        lib.lua_close(L)
    m = _ERR_RE.match(text)
    if m:
        line = int(m.group(1))
        col = int(m.group(2)) if m.group(2) else None
        msg = m.group(3).strip()
    else:
        line, col, msg = None, None, text
    raise LuaSyntaxError(
        msg,
        line=line, col=col,
        source_name=source_name, raw=text,
    )
