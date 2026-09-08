"""Peripheral hookup guide pinned regression (2026-09-08).

Directive:
  1. New wizard page immediately after gripper-type selection —
     'Connect your hardware' — with a Skip ('already connected').
     Editor Tool & Payload strip carries a "View hookup" button
     that reopens the same guide read-only.
  2. Data-driven from /opt/cobot/hookup/hookup_map.json:
     coordinate table for the M8 grid (4×5 rows/cols, IN1–IN10
     top two rows, OUT1–OUT10 bottom two rows) + labeled air
     stations + per-gripper connection lists.
     Placeholder connections carry needs_operator_confirmation:
     true — the wizard renders WHATEVER the file says.
  3. Panel artwork lives in frontend/src/assets/hookup/ — SVG
     placeholders now; PNG replacements drop in without any
     coordinate churn (highlights are computed from x_pct/y_pct
     fractions of whatever image is loaded).
  4. Display-only: no IO / motion published. Only writes
     hookup_confirmed + hookup_skipped onto answers (which land
     in the saved program config).
  5. safeIdx self-heal preserved — page skip predicate honours
     hookup_skipped so navigating back doesn't get stuck; every
     setAnswer that gates a skip goes through goNext(override).
"""

from __future__ import annotations

import json
import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(
    HERE, '..', 'cobot_dashboard', 'dashboard_server.py'))
WZ = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'ProgramWizard.jsx'))
EDITOR = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'ProgramEditor.jsx'))
GUIDE = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'HookupGuide.jsx'))
HOOKUP_MAP = '/opt/cobot/hookup/hookup_map.json'
ASSETS = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'assets', 'hookup'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def test_hookup_map_data_file_exists_and_conforms_to_operator_convention():
    """The map file is present at /opt/cobot/hookup/hookup_map.json,
    the M8 coordinate table has all 20 ids (IN1..IN10, OUT1..OUT10)
    with rows 0-1 = INs, rows 2-3 = OUTs, left→right per row,
    and the air-station labels match the operator's list."""
    assert os.path.isfile(HOOKUP_MAP), \
        f'{HOOKUP_MAP} must exist (operator-configurable data file)'
    with open(HOOKUP_MAP) as fh:
        data = json.load(fh)
    m8 = data['coordinates']['m8']
    for i in range(1, 11):
        assert f'IN{i}' in m8, f'M8 map missing IN{i}'
        assert f'OUT{i}' in m8, f'M8 map missing OUT{i}'
    # Row assignment: IN1..IN5 row=0, IN6..IN10 row=1,
    # OUT1..OUT5 row=2, OUT6..OUT10 row=3.
    for i, ex_row, ex_col in [
        ('IN1', 0, 0), ('IN5', 0, 4),
        ('IN6', 1, 0), ('IN10', 1, 4),
        ('OUT1', 2, 0), ('OUT5', 2, 4),
        ('OUT6', 3, 0), ('OUT10', 3, 4),
    ]:
        assert m8[i]['row'] == ex_row, i
        assert m8[i]['col'] == ex_col, i
    # Air-station labels present.
    stations = data['coordinates']['air_stations']
    expected = {
        '5/2 SS #1', '5/2 SS #2',
        'HIFLO 3/2 N/C #1', 'HIFLO 3/2 N/C #2',
        '5/3', 'HIFLO 3/2 NO', 'HIFLO 3/2 NC', '5/2 DS',
        'SPARE 1', 'SPARE 2',
    }
    missing = expected - set(stations.keys())
    assert not missing, f'air-station labels missing: {sorted(missing)}'


def test_placeholder_connections_flagged_for_operator_confirmation():
    """Every default gripper→port assignment carries
    needs_operator_confirmation: true. The operator will replace
    with true mappings; the wizard renders WHATEVER the file
    says."""
    with open(HOOKUP_MAP) as fh:
        data = json.load(fh)
    for gtype in ('vacuum', 'finger'):
        hookups = data['gripper_hookups'].get(gtype, [])
        assert hookups, f'{gtype} must ship with at least one hookup'
        for h in hookups:
            assert h.get('needs_operator_confirmation') is True, \
                (f'{gtype} hookup {h["id"]} must be flagged '
                 f'needs_operator_confirmation until operator confirms')


def test_backend_endpoint_wired():
    src = _read(SERVER)
    assert '@app.get("/api/hookup_map")' in src
    assert '_HOOKUP_MAP_PATH' in src
    assert "'/opt/cobot/hookup/hookup_map.json'" in src
    # 404 when the file is missing so the frontend can name the
    # exact cause (no silent empty payload).
    assert "'hookup_map_missing'" in src


def test_wizard_page_inserted_after_gripper_type():
    """New PAGES entry id='hookup' lands immediately after
    id='gripper_type' and before id='gripper_settings' — the
    natural post-selection slot per operator directive."""
    src = _read(WZ)
    i_type = src.find("id: 'gripper_type',")
    i_hook = src.find("id: 'hookup',")
    i_set  = src.find("id: 'gripper_settings',")
    assert i_type != -1 and i_hook != -1 and i_set != -1
    assert i_type < i_hook < i_set, \
        (f'hookup must sit between gripper_type ({i_type}) and '
         f'gripper_settings ({i_set}); got hookup at {i_hook}')


def test_wizard_skip_honours_desync_class_fix():
    """Skip button seeds BOTH hookup_skipped:true and
    hookup_confirmed:false and goes through the goNext(override)
    pattern so the skip predicate sees the fresh values on the
    same tick. Same for the confirm button (hookup_skipped:false
    + hookup_confirmed:true)."""
    src = _read(WZ)
    # Skip predicate keys off hookup_skipped or hookup_confirmed.
    assert 'skip: (answers) => !!answers.hookup_skipped' in src
    assert 'answers.hookup_confirmed === true' in src
    # Override discipline.
    assert 'goNext({ hookup_skipped: true, hookup_confirmed: false })' in src
    assert 'goNext({ hookup_skipped: false, hookup_confirmed: true })' in src


def test_hookup_guide_component_shape():
    """HookupGuide reads /api/hookup_map, renders one card per
    hookup with the panel image + SVG highlight overlay. Mode
    'editor' disables the checkboxes and hides Skip/Confirm."""
    src = _read(GUIDE)
    assert "fetch('/api/hookup_map')" in src
    # Test hooks the headless verifier / edition-matrix relies on.
    for hook in (
        'data-testid="hookup-guide"',
        'data-testid="hookup-card"',
        'data-testid="hookup-card-check"',
        'data-testid="hookup-guide-skip"',
        'data-testid="hookup-guide-confirm"',
        'data-testid="hookup-guide-close"',
    ):
        assert hook in src, f'missing hook {hook}'
    # SVG overlay is percentage-anchored so remapping requires no
    # new artwork.
    assert 'viewBox="0 0 100 100"' in src
    assert 'preserveAspectRatio="none"' in src


def test_editor_view_hookup_button_wired():
    """Program editor's Tool & Payload strip carries the View
    hookup button; opening it renders <HookupGuide mode='editor'>
    inside a portal modal."""
    src = _read(EDITOR)
    assert "import HookupGuide from './HookupGuide'" in src
    assert 'data-testid="view-hookup-button"' in src
    # Modal renders in editor mode.
    assert 'mode="editor"' in src
    # Gripper type is resolved from program.config.gripper_type
    # (or gripper.type as fallback).
    assert 'config.gripper_type || program.config.gripper?.type' in src


def test_panel_svg_placeholders_exist():
    """Placeholder SVGs land in the assets dir; real PNGs will
    replace them without any coordinate churn."""
    for fn in ('panel_m8_placeholder.svg', 'panel_air_placeholder.svg'):
        assert os.path.isfile(os.path.join(ASSETS, fn)), \
            f'{fn} must exist in frontend/src/assets/hookup/'


def test_guide_never_publishes_io_or_motion():
    """Display-only invariant: the guide component must not fetch
    IO write endpoints or publish motion verbs. Only the map read
    is permitted."""
    src = _read(GUIDE)
    # Sole /api/ endpoint referenced anywhere in the file is the
    # map read. Multiple occurrences (fetch + docstring) all
    # point at the same endpoint.
    api_calls = set(re.findall(r"/api/[a-z0-9_/{}?=]+", src))
    assert api_calls == {'/api/hookup_map'}, \
        f'unexpected API endpoint(s) in HookupGuide: {sorted(api_calls)}'
    # No IO/motion strings.
    for forbidden in ('/api/io/set', '/api/io/force',
                      '/api/estun/program/run', 'setDO', 'movJ', 'movL'):
        assert forbidden not in src, \
            f'HookupGuide must not touch {forbidden}'
