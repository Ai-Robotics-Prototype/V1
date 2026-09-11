#!/usr/bin/env python3
"""Run the motion analyzer against every program on disk and dump a
human-readable report. Used by the §5 validation ladder to show
what the analyzer would have flagged and adapted on the operator's
live programs.

Usage:
    python3 scripts/motion_check_report.py > docs/motion_check_findings.md
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent
                       / 'src' / 'estun_driver'))

from estun_driver.program_ops import analyze_program


PROGRAMS_DIR = Path('/opt/cobot/programs')
PARTS_INDEX_PATH = Path('/opt/cobot/parts/index.json')


def _load_json(p: Path):
    with open(p) as f:
        return json.load(f)


def _describe_step(program: dict, idx: int) -> str:
    steps = program.get('steps', [])
    if 0 <= idx < len(steps):
        s = steps[idx]
        return (f'{idx:>2} {s.get("action","?"):<15} '
                f'role={s.get("position_role","-"):<10} '
                f'label={s.get("label","")!r}')
    return f'{idx} <out of range>'


def _summarize(program_path: Path, part_index: dict | None):
    prog = _load_json(program_path)
    rep = analyze_program(prog, part_index=part_index)
    steps = prog.get('steps', [])
    lines: list[str] = []
    lines.append(f'## {program_path.name}')
    lines.append('')
    lines.append(f'- id: `{prog.get("id","")}`')
    lines.append(f'- steps: {len(steps)}')
    lines.append(f'- program speed_pct: {prog.get("config",{}).get("speed_pct","-")}')
    lines.append(f'- program motion_profile: '
                 f'{prog.get("config",{}).get("motion_profile","joint (default)")}')
    lines.append(f'- adaptations switch: '
                 f'{prog.get("config",{}).get("adaptations","on (default)")}')
    lines.append(f'- part_ids bound: '
                 f'{prog.get("config",{}).get("pbd_metadata",{}).get("part_ids", [])}')
    lines.append('')

    findings = rep['findings']
    adaptations = rep['adaptations']
    metrics = rep.get('metrics', {})

    if not findings and not adaptations:
        lines.append('**No findings, no adaptations** — program would '
                     'regenerate byte-identically under analyzer=on and '
                     'analyzer=off.')
        lines.append('')
        return '\n'.join(lines)

    lines.append(f'**{len(findings)} finding(s), '
                 f'{sum(1 for a in adaptations.values() if a.get("rules_applied"))} adaptation(s)**')
    lines.append('')

    if findings:
        lines.append('### Findings')
        lines.append('')
        for f in findings:
            sev = f['severity'].upper()
            lines.append(f'- **[{sev}] step {f["step_idx"]}** '
                         f'({f.get("step_label") or f.get("step_action") or "?"}) '
                         f'— `{f["rule"]}`  ')
            lines.append(f'  {f["message"]}  ')
            if f.get('suggested_action'):
                lines.append(f'  _Suggested action:_ {f["suggested_action"]}')
        lines.append('')

    if adaptations:
        lines.append('### Adaptations (parameter overrides applied at codegen)')
        lines.append('')
        for i in sorted(adaptations.keys()):
            a = adaptations[i]
            if not a.get('rules_applied'):
                continue
            lines.append(f'- step {i}: {_describe_step(prog, i)}')
            lines.append(f'  - rules: `{", ".join(a["rules_applied"])}`')
            if a.get('speed_pct_cap') is not None:
                lines.append(f'  - speed_pct_cap: {a["speed_pct_cap"]}')
            if a.get('blend_radius_mm_override') is not None:
                lines.append(f'  - blend_radius_override: {a["blend_radius_mm_override"]:g} mm')
            if a.get('descent_split'):
                lines.append(f'  - descent_split: {a["descent_split"]}')
            if a.get('coalesce_with_prev'):
                lines.append(f'  - coalesce_with_prev: True')
            if a.get('force_motion_profile'):
                lines.append(f'  - force_motion_profile: {a["force_motion_profile"]}')
            for r in a.get('reasons', []):
                lines.append(f'    - {r}')
        lines.append('')

    lines.append('### Segment metrics')
    lines.append('')
    lines.append('| step | action | seg len mm | wrist Δ° |')
    lines.append('|---:|---|---:|---:|')
    for i, s in enumerate(steps):
        L = metrics['segment_lengths_mm'][i] if i < len(metrics['segment_lengths_mm']) else None
        W = metrics['wrist_deltas_deg'][i]   if i < len(metrics['wrist_deltas_deg'])   else None
        L_s = f'{L:.1f}' if L is not None else '—'
        W_s = f'{W:.2f}' if W is not None else '—'
        lines.append(f'| {i} | `{s.get("action","?")}` ({s.get("label","")}) | {L_s} | {W_s} |')
    lines.append('')
    return '\n'.join(lines)


def main():
    part_index = None
    if PARTS_INDEX_PATH.is_file():
        try:
            part_index = _load_json(PARTS_INDEX_PATH)
        except Exception:
            part_index = None

    print('# Motion analyzer — findings across on-disk programs')
    print('')
    print('_Generated by `scripts/motion_check_report.py`._')
    print('')
    print(f'- programs dir: `{PROGRAMS_DIR}`')
    print(f'- parts index:  `{PARTS_INDEX_PATH}` '
          f'({"loaded" if part_index else "not loaded"})')
    print('')

    if not PROGRAMS_DIR.is_dir():
        print(f'_(programs dir not present on this host)_')
        return

    program_paths = sorted([p for p in PROGRAMS_DIR.iterdir()
                            if p.is_file() and p.suffix == '.json'
                            and not p.name.startswith('_')
                            and '.bak' not in p.name])
    for path in program_paths:
        print(_summarize(path, part_index))
        print('')


if __name__ == '__main__':
    main()
