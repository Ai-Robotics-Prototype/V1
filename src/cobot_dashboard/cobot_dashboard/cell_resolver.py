"""cell_resolver.py — single source of truth for cell_id → raw-port resolution.

Audit anti-recurrence piece (e749ccb, 2026-10-09): tool / fixture
bind-by-id resolution used to live in several copies — program_ops's
inline lookup, pbd/program_composer's hardcoded placeholders, and the
frontend's cellActions.js (which stays authoritative on the FE but
mirrors this shape). This module is the ONE Python-side resolver
everything backend goes through. If a new codegen or compose path
needs ports from a cell id, it imports from here.

Three families covered:

  * `resolve_eoat(cell, eoat_id)` →
        { name, valve_do, inputs: [{raw, synapse, role}], outputs: [...] }
      or None (operator-actionable missing/incomplete marker; the
      caller decides whether that's a hard refuse or soft fallback).

  * `resolve_fixture(cell, fixture_id)` →
        { name, valve_do, out_do, in_done_di }
      or None.

  * `_synapse_to_raw(s)` — Vxx→DOx / OUTxx→DOx / INxx→DIx — mirrors the
    frontend's `_rawFromPortmap` fallback so backend emissions stay
    byte-identical to frontend-authored programs when the operator
    hasn't audited the Synapse portmap yet.

Convention source: HARDWARE.md + the 2026-10-01 Synapse Addressing
Doctrine. The seeded portmap at /opt/cobot/synapse_portmap.json rows
through this translation at operator-audit time; the raw convention
below is the default used when the portmap can't be loaded (unit
tests, cold-boot codegen).

NEVER inline-import this module's logic into another file. If
something needs a resolver, add a `from .cell_resolver import …`
line. The grep pin `test_cell_resolver_is_single_source` enforces
no competing resolver — if a search for the inline cell-lookup regex
turns up anything outside this file + program_ops's import, the
pin fires.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any, Optional


_DEFAULT_CELL_PATH = '/opt/cobot/cell.json'


def load_cell(path: Optional[str] = None) -> dict:
    """Read the cell JSON. Returns an empty cell shape on any failure
    so callers can treat "no cell file" the same as "no bound id".
    """
    cell_path = path or os.environ.get('COBOT_CELL', _DEFAULT_CELL_PATH)
    try:
        with open(cell_path) as fh:
            cell = json.load(fh)
            if isinstance(cell, dict):
                return cell
    except (OSError, json.JSONDecodeError):
        pass
    return {'eoats': [], 'fixtures': []}


# ─────────────────────────────────────────────────────────────
# Synapse → raw translation (Vxx→DOx / OUTxx→DOx / INxx→DIx)
# ─────────────────────────────────────────────────────────────

_V_RE   = re.compile(r'^V(\d+)$',   re.IGNORECASE)
_OUT_RE = re.compile(r'^OUT(\d+)$', re.IGNORECASE)
_IN_RE  = re.compile(r'^IN(\d+)$',  re.IGNORECASE)
_DO_RE  = re.compile(r'^DO(\d+)$',  re.IGNORECASE)
_DI_RE  = re.compile(r'^DI(\d+)$',  re.IGNORECASE)


def synapse_to_raw(sid: Any) -> Optional[str]:
    """Translate a Synapse-named port ('V05', 'OUT03', 'IN02') to its
    raw-controller form ('DO5', 'DO3', 'DI2'). Pass-through for
    already-raw ids ('DO<n>', 'DI<n>'). Returns None on anything else.
    """
    if not isinstance(sid, str):
        return None
    s = sid.strip()
    for rx, prefix in ((_V_RE, 'DO'), (_OUT_RE, 'DO'), (_IN_RE, 'DI')):
        m = rx.match(s)
        if m:
            return f'{prefix}{int(m.group(1))}'
    for rx in (_DO_RE, _DI_RE):
        m = rx.match(s)
        if m:
            return s.upper()
    return None


# ─────────────────────────────────────────────────────────────
# EOAT resolution
# ─────────────────────────────────────────────────────────────

def resolve_eoat(cell: dict, eoat_id: Optional[str]) -> Optional[dict]:
    """Resolve an EOAT by id. Returns a flat dict with the ports the
    code generators actually emit against, or None when the id is
    missing / unknown / has no actuator valve.

    Shape:
        {
            'id':         <str>,
            'name':       <str>,
            'valve_do':   <'DO<n>'>,
            'inputs':     [{'raw':'DI<n>', 'synapse':'IN<n>', 'label':…}],
            'outputs':    [{'raw':'DO<n>', 'synapse':…,          'label':…}],
        }

    `valve_do` resolution order:
        1. actuators[0].valve synapse → raw
        2. legacy top-level `valve` field
    When no valve resolves, returns None — the caller surfaces the
    plain-copy "has no valve assigned" refusal.
    """
    if not isinstance(cell, dict) or not eoat_id:
        return None
    for e in (cell.get('eoats') or []):
        if not isinstance(e, dict) or e.get('id') != eoat_id:
            continue
        valve = None
        for a in (e.get('actuators') or []):
            if isinstance(a, dict) and a.get('valve'):
                valve = a['valve']
                break
        if not valve:
            valve = e.get('valve')
        valve_do = synapse_to_raw(valve) if valve else None
        if not valve_do:
            return None
        inputs = []
        for inp in (e.get('inputs') or []):
            if isinstance(inp, dict):
                sid = inp.get('port') or inp.get('synapse') or inp.get('id')
                raw = synapse_to_raw(sid)
                if raw and raw.startswith('DI'):
                    inputs.append({
                        'raw': raw,
                        'synapse': sid,
                        'label': inp.get('label') or inp.get('role'),
                    })
            elif isinstance(inp, str):
                raw = synapse_to_raw(inp)
                if raw and raw.startswith('DI'):
                    inputs.append({
                        'raw': raw, 'synapse': inp, 'label': None})
        outputs = []
        for out in (e.get('outputs') or []):
            if isinstance(out, dict):
                sid = out.get('port') or out.get('synapse') or out.get('id')
                raw = synapse_to_raw(sid)
                if raw and raw.startswith('DO'):
                    outputs.append({
                        'raw': raw, 'synapse': sid,
                        'label': out.get('label') or out.get('role'),
                    })
            elif isinstance(out, str):
                raw = synapse_to_raw(out)
                if raw and raw.startswith('DO'):
                    outputs.append({
                        'raw': raw, 'synapse': out, 'label': None})
        return {
            'id': e.get('id'),
            'name': e.get('name') or 'tool',
            'valve_do': valve_do,
            'inputs': inputs,
            'outputs': outputs,
        }
    return None


# ─────────────────────────────────────────────────────────────
# Fixture resolution
# ─────────────────────────────────────────────────────────────

def resolve_fixture(cell: dict, fixture_id: Optional[str]) -> Optional[dict]:
    """Resolve a fixture by id. Returns:
        {
            'id':          <str>,
            'name':        <str>,
            'valve_do':    <'DO<n>'> or None (air mode),
            'out_do':      <'DO<n>'> or None (own-controller mode),
            'in_done_di':  <'DI<n>'> or None (optional done signal),
            'power_mode':  <'air' | 'own_controller' | 'manual'>,
        }
    or None when the id isn't in the cell.

    A fixture is considered RESOLVABLE when it carries at least one
    actuation output for its declared power mode:
        * power_mode='air'            → valve_do required
        * power_mode='own_controller' → out_do required
        * power_mode='manual'         → neither required (operator wait)
    When the required field is missing, returns None so the caller
    refuses the save/run with a named-fixture reason.
    """
    if not isinstance(cell, dict) or not fixture_id:
        return None
    for f in (cell.get('fixtures') or []):
        if not isinstance(f, dict) or f.get('id') != fixture_id:
            continue
        power_mode = str(f.get('power_mode') or '').lower() or None
        valve_do = synapse_to_raw(f.get('valve'))
        out_do   = synapse_to_raw(f.get('out'))
        in_done_di = synapse_to_raw(f.get('in_done'))
        name = f.get('name') or 'fixture'
        if power_mode == 'air' and not valve_do:
            return None
        if power_mode == 'own_controller' and not out_do:
            return None
        return {
            'id': f.get('id'),
            'name': name,
            'valve_do': valve_do,
            'out_do': out_do,
            'in_done_di': in_done_di,
            'power_mode': power_mode,
        }
    return None


# ─────────────────────────────────────────────────────────────
# Save-validation helpers (reused by /api/cell/eoat + /api/cell/fixture)
# ─────────────────────────────────────────────────────────────

def eoat_body_has_valve(body: dict) -> bool:
    """True when the POST body for /api/cell/eoat carries at least one
    actuator with a non-empty valve (either in `actuators[]` or on the
    legacy top-level `valve` field). Keeps the save endpoint and this
    resolver on the same definition of "valve assigned".
    """
    if not isinstance(body, dict):
        return False
    for a in (body.get('actuators') or []):
        if isinstance(a, dict) and a.get('valve'):
            return True
    return bool(body.get('valve'))


def fixture_body_has_actuation(body: dict) -> bool:
    """True when the POST body for /api/cell/fixture carries the
    actuation port its declared power_mode requires. 'manual' fixtures
    pass regardless (operator-wait only).
    """
    if not isinstance(body, dict):
        return False
    power_mode = str(body.get('power_mode') or '').lower() or None
    if power_mode == 'manual':
        return True
    if power_mode == 'air':
        return bool(body.get('valve'))
    if power_mode == 'own_controller':
        return bool(body.get('out'))
    # Unknown / missing power_mode → fail-closed; the save endpoint
    # routes the operator back to re-pick a power mode.
    return False
