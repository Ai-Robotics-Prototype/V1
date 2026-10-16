#!/usr/bin/env python3
"""Offline verdict sweep: every resident program through the full
hardened pipeline (syntax → whitelist lint → semantic round-trip).

No arm touched. No writes. GET-only against :9198.

Classify each program:
  PASS         — all three gates clean
  CAUGHT(gate) — first gate that refused + first finding detail
  UNVERIFIABLE — could not fetch Lua/varspoint from :9198, or
                 pre-D9 legacy program with no reachability findings
"""
import json, sys, urllib.request

sys.path.insert(0, "/home/teddy/cobot_ws/src/estun_driver")
from estun_driver.lua_syntax_gate import check_syntax, LuaSyntaxError
from estun_driver.program_ops import lint_lua_source
from estun_driver.lua_semantic_roundtrip import check_consistency

HOST = "192.168.2.136"; PORT = 9198


def _get_json(path, timeout=4.0):
    url = f"http://{HOST}:{PORT}{path}"
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def fetch_programs():
    d = _get_json("/api/robotjson/projectlua/select/projectlist/")
    if d.get("code") != 909:
        raise SystemExit(f"projectlist code={d.get('code')}")
    return json.loads(d["data"][0]["content"])


def fetch_lua(pid, tid="main"):
    try:
        d = _get_json(f"/api/robotcode/projectlua_{pid}_lua/select/{tid}/")
    except Exception as e:
        return None, f"HTTP: {e}"
    if d.get("code") != 909:
        return None, f"code={d.get('code')}"
    data = d.get("data") or []
    if not data:
        return None, "empty data"
    c = data[0].get("content")
    return c if isinstance(c, str) else None, "no content" if c is None else ""


def fetch_varspoint(pid):
    try:
        d = _get_json(f"/api/robotjson/projectlua_{pid}/select/varspoint/")
    except Exception as e:
        return None, f"HTTP: {e}"
    if d.get("code") != 909:
        return {}, ""
    data = d.get("data") or []
    if not data:
        return {}, ""
    try:
        obj = json.loads(data[0]["content"])
        return obj if isinstance(obj, dict) else {}, ""
    except Exception as e:
        return None, f"parse: {e}"


def fetch_task_id(pid):
    """Task id is (usually) 'main' but check the registry to be sure."""
    try:
        d = _get_json(f"/api/robotjson/projectlua_{pid}/select/project/")
        if d.get("code") == 909 and d.get("data"):
            obj = json.loads(d["data"][0]["content"])
            keys = list(obj.keys())
            return keys[0] if keys else "main"
    except Exception:
        pass
    return "main"


def verdict(lua, varspoint):
    """Return (status, gate, detail)."""
    # 1) syntax
    try:
        check_syntax(lua, source_name="sweep")
    except LuaSyntaxError as e:
        return "CAUGHT", "syntax", f"line {e.line}: {e}"
    # 2) whitelist + semantic lint
    findings = lint_lua_source(lua)
    if findings:
        f0 = findings[0]
        return "CAUGHT", "lint", f"line {f0['line']} verb={f0['verb']!r}: {f0['reason'][:180]}"
    # 3) semantic round-trip
    r = check_consistency(lua, varspoint or {})
    if r.legacy_no_line_map and not r.findings:
        # G1: pre-D9 legacy program with no reachability issues.
        # Not verifiable via RT, but also no wire hazard from
        # reachability. Sweep classifies as UNVERIFIABLE.
        return ("UNVERIFIABLE", "semantic_rt",
                "pre-D9 legacy: no line_map trailer (reachability clean)")
    if not r.ok:
        f0 = r.findings[0]
        if r.legacy_no_line_map:
            return "CAUGHT", "reachability", str(f0)[:220]
        return "CAUGHT", "semantic_rt", str(f0)[:220]
    return "PASS", "-", "-"


def main():
    programs = fetch_programs()
    print(f"=== Sweep: {len(programs)} resident programs ===\n")
    rows = []
    for pid in sorted(programs.keys()):
        display = programs[pid].get("nm", "?")
        tid = fetch_task_id(pid)
        lua, lua_err = fetch_lua(pid, tid)
        if not lua:
            rows.append((pid, display, "UNVERIFIABLE", "fetch_lua",
                         lua_err or "empty"))
            continue
        vp, vp_err = fetch_varspoint(pid)
        if vp is None:
            rows.append((pid, display, "UNVERIFIABLE", "fetch_varspoint", vp_err))
            continue
        status, gate, detail = verdict(lua, vp)
        rows.append((pid, display, status, gate, detail))

    # Print table
    widths = [26, 32, 14, 14]
    hdr = f"{'pid':<{widths[0]}} {'display':<{widths[1]}} {'verdict':<{widths[2]}} {'gate':<{widths[3]}} detail"
    print(hdr)
    print("-" * (sum(widths) + 40))
    for pid, display, status, gate, detail in rows:
        print(f"{pid:<{widths[0]}} {display[:31]:<{widths[1]}} {status:<{widths[2]}} {gate:<{widths[3]}} {detail}")

    # Summary
    from collections import Counter
    c = Counter(r[2] for r in rows)
    print(f"\nSummary: {dict(c)}")

    # Detail for CAUGHT
    caught = [r for r in rows if r[2] == "CAUGHT"]
    if caught:
        print(f"\n=== CAUGHT ({len(caught)}) — full detail ===")
        for pid, display, status, gate, detail in caught:
            print(f"\n{pid} ({display}) → {gate}")
            print(f"  {detail}")


if __name__ == "__main__":
    main()
