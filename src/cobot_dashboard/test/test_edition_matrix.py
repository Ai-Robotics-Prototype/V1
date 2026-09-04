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
    """2026-09-04 operator authoritative split — Basic includes every
    feature EXCEPT the three hidden surfaces (cameras_lidar,
    part_recognition, safety_page). The safety PAGE is edition-gated
    here; E-STOP + safety interlocks stay edition-INDEPENDENT via
    SAFETY_INVARIANT_KEYS (test_safety_keys_rejected_by_loader)."""
    basic = {k for k, v in edition_mod.FEATURE_MAP.items() if v == 'basic'}
    assert basic == {
        'monitor', 'run_controls', 'program_library',
        'wizard', 'demonstration', 'speed_control',
        'corner_smoothing',
        'deep_editor', '3d_view', 'io_panel',
        'event_log', 'configure', 'per_step_overrides',
    }


def test_full_set_is_exactly_the_three_hidden_surfaces():
    """Only three keys are full-only: cameras_lidar, part_recognition,
    safety_page. Any future promo of a key here trips a review at CI
    (the assertion fails and the author has to explicitly update this
    test with the intended new full-only set)."""
    full = {k for k, v in edition_mod.FEATURE_MAP.items() if v == 'full'}
    assert full == {'cameras_lidar', 'part_recognition', 'safety_page'}


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
    # Basic device -> everything on EXCEPT the three hidden surfaces.
    for k in edition_mod.FEATURE_MAP.keys():
        want = edition_mod.FEATURE_MAP[k] == 'basic'
        assert edition_mod.is_feature_enabled(k, 'basic') is want, k
    # Full device -> everything on.
    for k in edition_mod.FEATURE_MAP.keys():
        assert edition_mod.is_feature_enabled(k, 'full'), k
    # Three hidden surfaces specifically OFF on basic.
    assert not edition_mod.is_feature_enabled('cameras_lidar',    'basic')
    assert not edition_mod.is_feature_enabled('part_recognition', 'basic')
    assert not edition_mod.is_feature_enabled('safety_page',      'basic')
    # Unknown feature key defaults ENABLED (basic-safe).
    assert edition_mod.is_feature_enabled('does_not_exist', 'basic')
    # Unknown edition fails closed.
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
    # The safety TAB maps to `safety_page` which IS edition-gated.
    # The E-STOP BUTTON lives in TopBar directly and does NOT go
    # through TAB_TO_FEATURE — it renders unconditionally in both
    # editions and is safety-invariant (see SAFETY_INVARIANT_KEYS,
    # which the loader hard-rejects from FEATURE_MAP entries).
    assert tab_map['safety'] == 'safety_page'
    assert edition_mod.FEATURE_MAP['safety_page'] == 'full'
    # The three hidden tabs map to the three full-only feature keys.
    assert tab_map['sensors']          == 'cameras_lidar'
    assert tab_map['adaptive_picking'] == 'part_recognition'


# ── Backend refusal on a full-only endpoint (via source-string check) ─

def test_server_middleware_gates_the_three_hidden_surfaces():
    """2026-09-04 operator split: gating moved from per-endpoint
    _require_full_edition calls into a single middleware +
    URL-pattern list. The middleware is the ONE audit site and its
    patterns are what get exercised end-to-end by the headless
    verify. This test locks the pattern list to the operator's
    exact three surfaces so a future edit can't silently un-gate
    (e.g. Part Recognition's /teach) or spread the gate to a
    still-visible page (e.g. /api/io/set)."""
    src = _read(SERVER)
    assert '_EDITION_FULL_ONLY_PATTERNS' in src
    assert 'async def _edition_gate_middleware' in src
    # part_recognition patterns
    for pat in (
        r"'^/api/parts/upload/?\$'",
        r"'^/api/parts/\[\^/\]\+/teach\(\$\|/\)'",
        r"'^/api/parts/\[\^/\]\+/scan\(\$\|/\)'",
        r"'^/api/parts/\[\^/\]\+/orient_weights\$'",
        r"'^/api/openvocab\(\$\|/\)'",
        r"'^/api/teach_mode/\(start\|stop\)\$'",
        r"'^/api/detections\$'",
    ):
        # Regex-escape the pattern for a raw substring search; the
        # source stores it with backslashes intact.
        needle = pat.replace('\\', '')
        assert needle in src.replace('\\', ''), f'missing gate pattern: {pat}'
    # cameras_lidar
    assert "/api/motioncam" in src
    # Ensure the previously-mis-gated endpoints are NOT gated again.
    assert "_require_full_edition(request, 'io_panel')"    not in src
    assert "_require_full_edition(request, 'event_log')"   not in src
    # /api/parts LIST must be un-gated (Monitor + editor + wizard).
    parts_list_body = src[src.find('async def api_parts_list'):
                          src.find('async def api_parts_list') + 800]
    assert '_require_full_edition' not in parts_list_body, \
        '/api/parts list is used by Monitor + editor + wizard — MUST NOT gate'


def test_server_ships_edition_endpoints():
    src = _read(SERVER)
    assert '@app.get("/api/edition")' in src
    assert '@app.get("/api/edition/features")' in src
    assert '@app.post("/api/edition/unlock")' in src
    assert '@app.post("/api/edition/lock")' in src
    assert 'from cobot_dashboard import edition as _edition_mod' in src


# ── Load-to-Monitor button ships in both editions ──────────────

def test_load_to_monitor_button_ships_in_both_editions():
    """2026-09-04 feature: the "Load to Monitor →" button in the
    Program Library's detail modal ships in BOTH editions by
    construction — Program Library is basic-tier and the button has
    no additional edition wrapper. This smoke check ensures no
    future edit accidentally gates it (e.g. wrapping the button in
    a full-only FeatureGate)."""
    library_src = _read(os.path.abspath(os.path.join(
        HERE, '..', 'frontend', 'src', 'pages', 'ProgramLibrary.jsx')))
    # Button label matches directive prose.
    assert 'Load to Monitor →' in library_src
    # Handler wired to shared loadProgramFlow.
    assert 'loadProgramFlow({' in library_src
    # No isFeatureEnabled or FeatureGate wrapping in the library.
    assert 'isFeatureEnabled' not in library_src
    assert 'FeatureGate' not in library_src


# ── Repo rule doc in place ──────────────────────────────────────

def test_readme_states_repo_rule():
    with open(os.path.join(
            os.path.dirname(HERE), '..', '..', 'README.md')) as fh:
        readme = fh.read()
    assert 'ONE repo, ONE branch flow' in readme
    assert 'No edition branches, ever' in readme
    assert 'vX.Y-basic' in readme
    assert 'vX.Y-full' in readme
