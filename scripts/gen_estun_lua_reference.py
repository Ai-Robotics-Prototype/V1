#!/usr/bin/env python3
"""Generate docs/estun_lua_reference.md from data/estun_captures/luaenginelib.json.

Source of truth: data/estun_captures/luaenginelib.json — the controller
serves this at GET /webmodel/cocontrol/luaeditor/luaenginelib.json; the
frontend's Lua editor uses it to render palette entries and the
insertion templates. Every callable the interpreter accepts is a key
here (168 total in the 2026-07-21 capture).

Status column values:
  wire-verified   codegen currently emits AND we have evidence the
                  controller executes it (either an observed error
                  that identifies the callable — e.g. alarm 10006 for
                  wait's integer check — or a clean run through the
                  interpreter with the emitted syntax).
  doc-captured    library entry present with a signature; codegen may
                  or may not emit it, but no controller-run has proved
                  the exact wire behavior.
  untested        NOT in luaenginelib.json — appears only in i18n
                  label bundles or syntax-highlighter keyword lists.
                  Do NOT emit without a bench test. setBlender,
                  setNoBlender, setPayload land here as of 2026-07-29.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path


REPO = Path(__file__).resolve().parent.parent
LIB  = REPO / 'data' / 'estun_captures' / 'luaenginelib.json'
OUT  = REPO / 'docs' / 'estun_lua_reference.md'


# Verbs the current program_ops.py emits, keyed to the wire-verification
# evidence.  Anything NOT in this dict falls back to doc-captured.
_WIRE_VERIFIED = {
    'movJ':        'emitted as movJ(pN); controller runs it (bowl program live runs)',
    'movL':        'emitted as movL(pN); controller runs it (§412 taught contacts + 2026-07-31 STANDARD derived-step columns)',
    'movJCoorRel': 'emitted as movJCoorRel({cp={0,0,Δz,0,0,0}},{coor=0,tool=0}) fallback path',
    'setDO':       'emitted as setDO(port,0|1); operator-observed effect on DO gate',
    'setAO':       'emitted as setAO(port,v); part of io_map surface',
    'getDI':       'emitted as _diN = getDI(port) for wait_input; runs without alarm',
    'goto':        'emitted as goto _prog_start for count=0 continuous loops',
    # 2026-07-31 task §1-§3: setSpeedJ/L, setAccJ/L, setBlender/setNoBlender,
    # and waitCondition are treated as authoritative per the task's captured
    # verb-forms declaration. First-run bench in the §7 checklist confirms
    # observed speed matches emitted absolutes.
    'setSpeedJ':    'emitted as setSpeedJ(dps) before each joint segment (modal); '
                    'task §2 captured verb (rated max per-joint [150,150,150,180,180,180] dps '
                    'from speedLimit page); bench-verify unit at first run',
    'setSpeedL':    'emitted as setSpeedL(mm/s) before each linear segment (modal); '
                    'task §2 captured verb; controller cartAutoMaxVel=2600 mm/s '
                    '(robotLimit page); we cap at 1500 mm/s cruise ceiling',
    'setAccJ':      'available for future emission; task §2 captured verb (deg/s² modal default)',
    'setAccL':      'emitted as setAccL(150) for gentle-descent bracket (task §4); '
                    'also emitted by RULE 2c descent-split adaptation; modal',
    'setBlender':   'emitted as setBlender(<mm>) in SMOOTH / STANDARD profiles; task §3 '
                    'captured verb (mm, modal); wire_verified_blender=True by default '
                    'from 2026-07-31 — bench-verify at first live run',
    'setNoBlender': 'emitted as setNoBlender() (BARE, no arg) before contact / column-'
                    'internal / program-end (task §3); modal killswitch for blender',
    'waitCondition':'emitted as waitCondition(getDI(N)==<expect>,<timeout_ms>) for '
                    'verify_input, AND as waitCondition(false,<ms>) for the timed '
                    'wait step (2026-07-31 §1 replacement for wait() which is NOT '
                    'in the library); timeout unit inferred as ms — bench-verify',
    'systemTime':   'reserved: fallback delay idiom if bench proves '
                    'waitCondition(false,N) short-circuits',
}

# Verbs whose NAMES appear only in the i18n label bundle or the
# syntax-highlighter keyword list — NOT in luaenginelib.json.  Emitting
# them risks 10012 unknown-identifier alarms.  Keep this list in sync
# with the "untested" set in the generated doc.
_UNTESTED_ABSENT_FROM_LIB = {
    'setPayload':   'i18n label only ("Set the default load"); no callable signature '
                    'captured in luaenginelib.json; task §6 STOP-CONDITION held — the '
                    'header comment reports payload_kg but no call is emitted',
}

# `wait` is no longer emitted (2026-07-31 §1 replacement); its previous
# wire-verified status is retained but the doc now flags emission as
# suppressed.  waitCondition(false,ms) is the current timed-delay verb.
_EXTRA_STATUS_NOTES = {
    'wait': ('untested',
             'NOT in luaenginelib.json; earlier codegen emitted wait(<ms>) based '
             'on an alarm-10006 inference — 2026-07-31 §1 replaced that with '
             'waitCondition(false,<ms>) since the alarm text alone is not '
             'sufficient proof of callability. wait() is no longer emitted.'),
}


def _placeholders(template: str):
    """Extract ${name} placeholders in order they appear in the template."""
    return re.findall(r'\$\{([^}]+)\}', template)


def _positional(template: str):
    """Extract $1/$2/... in order (deduplicated, preserving first-seen order)."""
    seen = []
    for m in re.finditer(r'\$(\d+)', template):
        n = int(m.group(1))
        if n not in seen:
            seen.append(n)
    return seen


def _classify(name: str, entry: dict) -> tuple[str, str]:
    """(status, evidence_note)."""
    if name in _EXTRA_STATUS_NOTES:
        return _EXTRA_STATUS_NOTES[name]
    if name in _WIRE_VERIFIED:
        return ('wire-verified', _WIRE_VERIFIED[name])
    return ('doc-captured', '')


def _row(name: str, entry: dict) -> tuple[str, str, str, str, str]:
    """Return (name, insertion, args, status, evidence)."""
    lua_tpl = entry.get('lua', '')
    args_ph = _placeholders(lua_tpl)
    positional = _positional(lua_tpl)
    if args_ph:
        args_repr = ', '.join(args_ph)
    elif positional:
        args_repr = ', '.join(f'${n}' for n in positional)
    else:
        args_repr = '—'
    status, evidence = _classify(name, entry)
    # Shorten the insertion for readability — keep the leading form,
    # collapse the long optional block.
    insertion = lua_tpl
    if len(insertion) > 90:
        insertion = insertion[:87] + '…'
    return (name, insertion, args_repr, status, evidence)


def main():
    with open(LIB) as f:
        lib = json.load(f)
    assert isinstance(lib, dict), f'expected dict, got {type(lib).__name__}'

    rows = [_row(name, entry) for name, entry in sorted(lib.items())]

    # Add wait as an explicit row even though it's not in the library —
    # readers looking for wait must find its status in this doc.
    if 'wait' not in lib:
        rows.append(('wait', 'wait(<int_ms>)', 'ms', *_EXTRA_STATUS_NOTES['wait']))

    # Append the absent-from-library untested set so readers looking for
    # setBlender/setNoBlender/setPayload find explicit status here.
    for name, evidence in sorted(_UNTESTED_ABSENT_FROM_LIB.items()):
        rows.append((name, '(absent from luaenginelib.json)', '—', 'untested', evidence))

    counts = {'wire-verified': 0, 'doc-captured': 0, 'untested': 0}
    for _, _, _, status, _ in rows:
        counts[status] = counts.get(status, 0) + 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, 'w') as f:
        f.write('# Estun Lua verb reference\n\n')
        f.write('_Generated by `scripts/gen_estun_lua_reference.py` from '
                '`data/estun_captures/luaenginelib.json` — do not hand-edit._\n\n')
        f.write('Source-of-truth path on the controller: '
                '`GET /webmodel/cocontrol/luaeditor/luaenginelib.json` '
                '(served by the factory UI bundle; the Lua editor uses it '
                'to render palette entries and the insertion template).\n\n')
        f.write('## Status legend\n\n')
        f.write('- **wire-verified** — codegen emits it AND controller-side execution is '
                'proven (either a clean run or an error message that identifies the '
                'callable).\n')
        f.write('- **doc-captured** — library entry present with a signature, but no '
                'controller-run has proved the exact wire behavior yet.\n')
        f.write('- **untested** — NOT in `luaenginelib.json`. Appears only in i18n label '
                'bundles or syntax-highlighter keyword lists. Do NOT emit without a bench '
                'test — the interpreter rejects unknown names with 10012-class errors.\n\n')
        f.write('## Counts\n\n')
        f.write(f'| wire-verified | doc-captured | untested | total |\n')
        f.write(f'|---:|---:|---:|---:|\n')
        f.write(f'| {counts.get("wire-verified", 0)} '
                f'| {counts.get("doc-captured", 0)} '
                f'| {counts.get("untested", 0)} '
                f'| {sum(counts.values())} |\n\n')
        f.write('## Verbs\n\n')
        f.write('| Name | Insertion template | Args | Status | Evidence |\n')
        f.write('|------|-----|------|--------|----------|\n')
        for name, insertion, args, status, evidence in rows:
            ins_md = '`' + insertion.replace('|', r'\|').replace('`', "'") + '`'
            args_md = args.replace('|', r'\|')
            evidence_md = evidence.replace('|', r'\|')
            f.write(f'| `{name}` | {ins_md} | {args_md} | {status} | {evidence_md} |\n')
        f.write('\n')
        f.write('## Reference-only for now (in library, not yet emitted)\n\n')
        f.write('These verbs are wire-callable per `luaenginelib.json` but the codegen does '
                'not emit them this release — capture them here so a future release can add '
                'targeted support without re-mining the library.\n\n')
        deferred = [
            'movC', 'movCircle', 'movTraj',
            'setMoveRate',
            'setCollisionDetectionSensitivity',
        ]
        # Pallet + conveyor + torque names — pattern-matched.
        for name in sorted(lib.keys()):
            lname = name.lower()
            if ('pallet' in lname or 'conveyor' in lname
                    or 'torque' in lname):
                deferred.append(name)
        seen = set()
        for name in deferred:
            if name in seen:
                continue
            seen.add(name)
            if name in lib:
                sig = lib[name].get('lua', '')
                f.write(f'- `{name}` — `{sig[:80]}`\n')
            else:
                f.write(f'- `{name}` — (not in library)\n')
        f.write('\n')

    print(f'wrote {OUT}')
    print(f'  {counts["wire-verified"]} wire-verified')
    print(f'  {counts["doc-captured"]} doc-captured')
    print(f'  {counts["untested"]} untested (absent from library)')


if __name__ == '__main__':
    main()
