#!/usr/bin/env python3
"""Generate the bowl program under each of the four motion profiles
(joint / straight / smooth / standard, per 2026-07-31 §3) and dump the
outputs side by side. Used by the §7 validation ladder report to show
what the profiles produce for the same program.

Usage:
    python3 scripts/gen_bowl_three_profiles.py > docs/bowl_four_profiles.txt

Reads:  /opt/cobot/programs/whitebowlpickplace.json
Writes: four concatenated Lua sections + short numeric summaries.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent
                       / 'src' / 'estun_driver'))

from estun_driver.program_ops import codegen_lua_from_program


def _sanitize_trailer(lua: str) -> str:
    """Strip the '--Lua version 5.3 time:YYYY-MM-DD HH:MM:SS' trailer +
    the -- codegen timestamp so diffs across runs stay reproducible."""
    out = []
    for ln in lua.splitlines():
        if ln.startswith('--Lua version'):
            out.append('--Lua version 5.3 time:<stripped>')
            continue
        if ln.startswith('-- codegen:'):
            # Keep the format skeleton but strip mtime/boot times.
            out.append('-- codegen: <stripped for reproducible diff>')
            continue
        out.append(ln)
    return '\n'.join(out)


def _stats(lua: str) -> dict:
    lines = lua.splitlines()
    return {
        'total_lines':   len(lines),
        'movJ':          sum(1 for ln in lines if ln.startswith('movJ(')),
        'movL':          sum(1 for ln in lines if ln.startswith('movL(')),
        'movJCoorRel':   sum(1 for ln in lines if ln.startswith('movJCoorRel(')),
        'setSpeedJ':     sum(1 for ln in lines if ln.startswith('setSpeedJ(')),
        'setSpeedL':     sum(1 for ln in lines if ln.startswith('setSpeedL(')),
        'setAccL':       sum(1 for ln in lines if ln.startswith('setAccL(')),
        'setBlender':    sum(1 for ln in lines if ln.startswith('setBlender(')),
        'setNoBlender':  sum(1 for ln in lines if ln.startswith('setNoBlender(')),
        'wait':          sum(1 for ln in lines if ln.startswith('wait(')),
    }


def main():
    with open('/opt/cobot/programs/whitebowlpickplace.json') as f:
        program = json.load(f)

    print('# Bowl program — three-profile side-by-side comparison')
    print(f'# Source: /opt/cobot/programs/whitebowlpickplace.json (rev={program.get("rev")})')
    print(f'# Steps:  {len(program.get("steps", []))}')
    print(f'# Program speed_pct: {program.get("config",{}).get("speed_pct")}')
    print()

    for profile in ('joint', 'straight', 'smooth', 'standard'):
        prog = dict(program)
        cfg = dict(prog.get('config') or {})
        cfg['motion_profile'] = profile
        prog['config'] = cfg
        lua, points, eff = codegen_lua_from_program(
            prog, operator_speed_limit_pct=100)
        s = _stats(lua)
        print(f'\n{"=" * 68}')
        print(f'=== profile={profile}  '
              f'(wire_verified_blender=DEFAULT=True from 2026-07-31 §3)  '
              f'effective_pct={eff}')
        print(f'{"=" * 68}')
        print(f'# counts: {json.dumps(s)}')
        print()
        print(_sanitize_trailer(lua))


if __name__ == '__main__':
    main()
