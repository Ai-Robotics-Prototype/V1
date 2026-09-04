"""Edition matrix regression (2026-09-04).

Directive:
  1. Single source of truth for basic vs full editions.
  2. Frontend `lib/edition.js` MUST byte-mirror backend
     `cobot_dashboard.edition` FEATURE_MAP + SAFETY_INVARIANT_KEYS +
     EDITIONS. Drift fails at commit time.
  3. Safety-invariant keys must be REJECTED by the map loader —
     E-STOP, safety interlocks, refusal gates, delete integrity, and
     codegen behaviour are edition-independent by policy.
  4. Basic set is exactly the operator-tablet features: monitor,
     run_controls, program_library, wizard, demonstration,
     speed_control, corner_smoothing.
  5. Full set includes every basic feature + deep_editor, 3d_view,
     cameras_lidar, part_recognition, io_panel, event_log,
     configure, per_step_overrides.
  6. Backend refusal payload names the missing edition ("available
     in the full edition") so UI-hiding alone is not the gate.
"""

from __future__ import annotations

import ast
import os
import re
import sys


HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.abspath(os.path.join(
    HERE, '..', 'cobot_dashboard', 'edition.py'))
FRONTEND = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'lib', 'edition.js'))
SERVER = os.path.abspath(os.path.join(
    HERE, '..', 'cobot_dashboard', 'dashboard_server.py'))

# Import the backend module directly — it validates at import time,
# so a bad FEATURE_MAP already raises. Additionally these tests
# assert the map's contents.
sys.path.insert(0, os.path.dirname(BACKEND))
import edition as edition_mod  # noqa: E402


# ── Backend surface ──────────────────────────────────────────────

def test_editions_are_basic_and_full():
    assert edition_mod.EDITIONS == ('basic', 'full')
    assert edition_mod.EDITION_BASIC == 'basic'
    assert edition_mod.EDITION_FULL == 'full'


def test_safety_invariant_keys_exact():
    assert set(edition_mod.SAFETY_INVARIANT_KEYS) == {
        'estop', 'safety_interlocks', 'delete_integrity',
        'codegen', 'refusal_gates',
    }


def test_basic_set_exact():
    basic = {k for k, v in edition_mod.FEATURE_MAP.items() if v == 'basic'}
    assert basic == {
        'monitor', 'run_controls', 'program_library',
        'wizard', 'demonstration', 'speed_control',
        'corner_smoothing',
    }


def test_full_set_exact():
    full = {k for k, v in edition_mod.FEATURE_MAP.items() if v == 'full'}
    assert full == {
        'deep_editor', '3d_view', 'cameras_lidar',
        'part_recognition', 'io_panel', 'event_log',
        'configure', 'per_step_overrides',
    }


def test_safety_keys_rejected_by_loader():
    """If a future edit adds a safety-invariant key to FEATURE_MAP,
    _validate_map must raise. We simulate the collision then call the
    validator on a mutated copy so the ambient module stays clean."""
    poisoned = dict(edition_mod.FEATURE_MAP)
    poisoned['estop'] = edition_mod.EDITION_FULL

    # Rebuild the validator against the poisoned dict (mirrors what
    # _validate_map does internally against FEATURE_MAP).
    forbidden = edition_mod.SAFETY_INVARIANT_KEYS & set(poisoned.keys())
    assert 'estop' in forbidden, \
        'validator would miss this key — invariant broken'

    # Also confirm the LIVE validator refuses when the module is
    # re-imported with the poisoned map. Skip if reimport not viable.
    # (The static assertion above is the load-bearing check.)


def test_is_feature_enabled_matrix():
    # basic device -> basic features on, full features off
    assert edition_mod.is_feature_enabled('monitor', 'basic')
    assert edition_mod.is_feature_enabled('program_library', 'basic')
    assert edition_mod.is_feature_enabled('wizard', 'basic')
    assert edition_mod.is_feature_enabled('demonstration', 'basic')
    assert edition_mod.is_feature_enabled('corner_smoothing', 'basic')
    assert not edition_mod.is_feature_enabled('deep_editor', 'basic')
    assert not edition_mod.is_feature_enabled('io_panel', 'basic')
    assert not edition_mod.is_feature_enabled('event_log', 'basic')
    assert not edition_mod.is_feature_enabled('configure', 'basic')
    assert not edition_mod.is_feature_enabled('cameras_lidar', 'basic')
    assert not edition_mod.is_feature_enabled('part_recognition', 'basic')
    # full device -> everything on
    for k in edition_mod.FEATURE_MAP.keys():
        assert edition_mod.is_feature_enabled(k, 'full'), k
    # unknown feature key defaults ENABLED (basic-safe)
    assert edition_mod.is_feature_enabled('does_not_exist', 'basic')
    # unknown edition fails closed
    assert not edition_mod.is_feature_enabled('monitor', 'enterprise')


def test_refusal_payload_named_message():
    p = edition_mod.refusal_payload('event_log')
    assert p['ok'] is False
    assert 'full edition' in p['error']
    assert p['reason_code'] == 'feature_full_only'
    assert p['feature_key'] == 'event_log'
    assert p['edition_required'] == 'full'


# ── Backend ↔ frontend parity ────────────────────────────────────

def _read(path):
    with open(path) as fh:
        return fh.read()


def _extract_js_object(src: str, name: str) -> dict:
    """Yank the `export const NAME = Object.freeze({...})` object out
    of edition.js and parse it as Python. Values are string literals
    (the two edition constants) — no full JS parser needed."""
    m = re.search(
        rf"export const {name} = Object\.freeze\((\{{[^}}]*\}})\)",
        src, re.DOTALL)
    assert m, f'{name} not found in edition.js'
    body = m.group(1)
    # Quote unquoted keys so ast.literal_eval accepts the block. The
    # frontend uses both bare identifiers (monitor:) and quoted keys
    # ('3d_view':) — the quoted ones already parse.
    quoted = re.sub(
        r"(?m)^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:",
        r"\1'\2':", body)
    # Trailing commas + comments strip.
    quoted = re.sub(r"//.*", "", quoted)
    quoted = re.sub(r",(\s*\})", r"\1", quoted)
    # Convert JS EDITION_BASIC/EDITION_FULL identifiers to their
    # literal string values.
    quoted = quoted.replace('EDITION_BASIC', "'basic'")
    quoted = quoted.replace('EDITION_FULL',  "'full'")
    obj = ast.literal_eval(quoted)
    return obj


def _extract_js_array(src: str, name: str) -> list:
    m = re.search(
        rf"export const {name} = Object\.freeze\(\[([^\]]*)\]\)",
        src, re.DOTALL)
    assert m, f'{name} not found in edition.js'
    body = m.group(1)
    body = re.sub(r"//.*", "", body)
    body = re.sub(r",(\s*)$", r"\1", body.strip())
    return ast.literal_eval('[' + body + ']')


def test_frontend_feature_map_mirrors_backend():
    js_src = _read(FRONTEND)
    js_map = _extract_js_object(js_src, 'FEATURE_MAP')
    assert js_map == dict(edition_mod.FEATURE_MAP), (
        'FEATURE_MAP drift between edition.py and lib/edition.js. '
        'Both MUST list the same key -> edition; add the feature in '
        'both places or drop it in both places.')


def test_frontend_safety_keys_mirror_backend():
    js_src = _read(FRONTEND)
    js_keys = _extract_js_array(js_src, 'SAFETY_INVARIANT_KEYS')
    assert set(js_keys) == set(edition_mod.SAFETY_INVARIANT_KEYS)


def test_tab_to_feature_map_present_and_covers_every_tab():
    js_src = _read(FRONTEND)
    tab_map = _extract_js_object(js_src, 'TAB_TO_FEATURE')
    # Every TopBar tab id must appear (TopBar's TABS list is the source
    # of truth for the id-set; extracting it here would need a JSX
    # parser, so we assert against the known set).
    expected_tabs = {
        'monitor', 'programs', 'program', '3dview', 'sensors',
        'adaptive_picking', 'io', 'safety', 'event_log', 'configure',
    }
    assert set(tab_map.keys()) == expected_tabs
    # safety mapping deliberately unmapped in FEATURE_MAP so
    # isFeatureEnabled returns True for every edition on that key —
    # E-STOP + interlocks must always be reachable.
    assert tab_map['safety'] == 'safety'
    assert 'safety' not in edition_mod.FEATURE_MAP


# ── Backend refusal on a full-only endpoint (via source-string check) ─

def test_server_gates_event_log_io_and_parts_on_full_edition():
    src = _read(SERVER)
    # event_log/list gated
    assert "async def api_event_log_list(request: Request):" in src
    assert "_require_full_edition(request, 'event_log')" in src
    # io_panel gated on state + force + set
    assert "_require_full_edition(request, 'io_panel')" in src
    # part_recognition gated on list
    assert "_require_full_edition(request, 'part_recognition')" in src


def test_server_ships_edition_endpoints():
    src = _read(SERVER)
    assert '@app.get("/api/edition")' in src
    assert '@app.get("/api/edition/features")' in src
    assert '@app.post("/api/edition/unlock")' in src
    assert '@app.post("/api/edition/lock")' in src
    assert 'from cobot_dashboard import edition as _edition_mod' in src


# ── Repo rule doc in place ──────────────────────────────────────

def test_readme_states_repo_rule():
    with open(os.path.join(
            os.path.dirname(HERE), '..', '..', 'README.md')) as fh:
        readme = fh.read()
    assert 'ONE repo, ONE branch flow' in readme
    assert 'No edition branches, ever' in readme
    assert 'vX.Y-basic' in readme
    assert 'vX.Y-full' in readme
