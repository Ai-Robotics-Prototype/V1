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
    # Air-station labels present + v2 schema: two ports per station
    # (port_a + port_b with x_pct/y_pct fractions on the front render).
    stations = data['coordinates']['air_stations']
    expected = {
        '5/2 SS #1', '5/2 SS #2',
        'HIFLO 3/2 N/C #1', 'HIFLO 3/2 N/C #2',
        '5/3', 'HIFLO 3/2 NO', 'HIFLO 3/2 NC', '5/2 DS',
        'SPARE 1', 'SPARE 2',
    }
    missing = expected - set(stations.keys())
    assert not missing, f'air-station labels missing: {sorted(missing)}'
    for label, entry in stations.items():
        assert 'port_a' in entry and 'port_b' in entry, \
            f'{label} must expose both port_a AND port_b'
        for k in ('port_a', 'port_b'):
            p = entry[k]
            assert 'x_pct' in p and 'y_pct' in p, \
                f'{label}.{k} missing x_pct/y_pct'


def test_hookups_reference_station_plus_port():
    """v2 schema: air_station hookups reference {station, port}
    (not the legacy air_station_label field). The wizard resolves
    the pair to port_a/port_b coordinates on the front render."""
    with open(HOOKUP_MAP) as fh:
        data = json.load(fh)
    for gtype in ('vacuum', 'finger'):
        for h in data['gripper_hookups'].get(gtype, []):
            if h['target'] != 'air_station':
                continue
            assert 'station' in h and 'port' in h, \
                f'{gtype}/{h["id"]} must carry station+port (v2 schema)'
            assert h['port'] in ('A', 'B'), \
                f'{gtype}/{h["id"]} port must be A or B'


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
            # Every INPUT (sensor) connection carries a
            # no_sensor_recommendation string — the wizard renders
            # it as the non-nagging note when the operator picks
            # "No sensor" AND on the sensor card itself.
            if h['direction'] == 'input':
                assert 'no_sensor_recommendation' in h and \
                       h['no_sensor_recommendation'], \
                    (f'{gtype} sensor {h["id"]} needs a '
                     f'no_sensor_recommendation string')


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
    # Override discipline. Skip path passes plain flags; Confirm
    # path also passes hookup_no_sensor per the 2026-09-08
    # refinement.
    assert 'goNext({ hookup_skipped: true, hookup_confirmed: false })' in src
    # Confirm's goNext contains hookup_skipped:false + hookup_confirmed
    # :true + hookup_no_sensor: <map>. Match on the multi-line form.
    assert 'hookup_skipped:   false' in src
    assert 'hookup_confirmed: true' in src
    assert 'hookup_no_sensor: noSensorMap || {}' in src


def test_hookup_guide_component_shape():
    """HookupGuide reads /api/hookup_map, renders one card per
    hookup with the panel image + SVG glow overlay. Mode
    'editor' disables the checkboxes and hides Skip/Confirm.
    2026-09-08 refinement: no-sensor toggle + reduced-motion +
    dim mask + halo + ring stroke all present."""
    src = _read(GUIDE)
    assert "fetch('/api/hookup_map')" in src
    for hook in (
        'data-testid="hookup-guide"',
        'data-testid="hookup-card"',
        'data-testid="hookup-card-check"',
        'data-testid="hookup-guide-skip"',
        'data-testid="hookup-guide-confirm"',
        'data-testid="hookup-guide-close"',
        # 2026-09-08 refinement additions:
        'data-testid="hookup-no-sensor-btn"',
        'data-testid="hookup-no-sensor-note"',
        'data-testid="hookup-glow-overlay"',
    ):
        assert hook in src, f'missing hook {hook}'
    # SVG overlay is percentage-anchored.
    assert 'viewBox="0 0 100 100"' in src
    assert 'preserveAspectRatio="none"' in src
    # Commercial glow: dim mask + halo gradient + ring stroke +
    # pulse animation.
    assert 'mask=' in src, 'dim mask overlay required for glow treatment'
    assert 'radialGradient' in src, 'halo gradient required'
    assert '@keyframes hookup-glow-pulse' in src, \
        'pulse animation required (1.5-2s cadence)'
    # Reduced-motion: honored via matchMedia and conditional class.
    assert "prefers-reduced-motion: reduce" in src
    assert 'reducedMotion' in src


def test_no_sensor_toggle_hides_sensor_card_and_persists():
    """Clicking the 'No sensor' button on a sensor card sets the
    id in `noSensor` state, hides the card, and shows a hidden-
    cards summary line with the recommendation text. On confirm,
    the map lands in `answers.hookup_no_sensor` (persisted on
    program.config via handleSave's spread)."""
    src = _read(GUIDE)
    # Filter drops hidden cards (multi-branch filter now — handles
    # noSensor + optional toggles).
    assert 'if (noSensor[h.id]) return false' in src
    # Summary rendered for hidden entries.
    assert 'data-testid="hookup-no-sensor-note"' in src
    assert 'Re-add sensor' in src
    # Wizard hands the map back on confirm.
    wz = _read(os.path.abspath(os.path.join(
        HERE, '..', 'frontend', 'src', 'components', 'ProgramWizard.jsx')))
    assert 'hookup_no_sensor' in wz
    assert 'noSensor={answers.hookup_no_sensor || {}}' in wz
    assert 'goNext({' in wz  # override discipline preserved
    # effectorEngage documents the invariant.
    voc = _read(os.path.abspath(os.path.join(
        HERE, '..', 'frontend', 'src', 'lib', 'effectorVocab.js')))
    assert 'no-sensor invariant' in voc
    assert "hookup_no_sensor['vacuum-seal-sensor']" in voc


def test_vacuum_engage_still_timed_dwell_only():
    """Regression fence: the current vacuum-engage emission stays
    a timed dwell (action:'wait', duration_s:0.5). No wait-for-
    input step is emitted. If a future edit adds an input wait,
    it MUST gate on cfg.hookup_no_sensor per the invariant
    comment — retire this test alongside that change."""
    voc = _read(os.path.abspath(os.path.join(
        HERE, '..', 'frontend', 'src', 'lib', 'effectorVocab.js')))
    # Locate effectorEngage specifically, then its vacuum branch
    # (effectorReady also has a `e === 'vacuum'` block that would
    # false-match a plain search).
    engage_idx = voc.find('export function effectorEngage(')
    assert engage_idx != -1
    engage_body = voc[engage_idx:engage_idx + 1500]
    vac_idx = engage_body.find("if (e === 'vacuum') return [")
    assert vac_idx != -1, 'vacuum branch missing from effectorEngage'
    slice_ = engage_body[vac_idx:vac_idx + 500]
    assert "action: 'set_io'" in slice_
    assert "action: 'wait'" in slice_
    assert "duration_s: 0.5" in slice_
    # No wait_for_input / waitCondition emitted in the current
    # vacuum branch.
    for forbidden in ('wait_for_input', 'waitCondition', 'io_seal_confirm'):
        assert forbidden not in slice_, \
            f'vacuum engage must not emit {forbidden} without a hookup_no_sensor gate'


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


def test_panel_asset_files_present_with_operator_naming():
    """2026-09-08 refinement: assets renamed to match operator's
    filenames: hookup_panel_front.svg (front render, hosts the
    overlays) + hookup_panel_iso.svg (context view). Real PNGs
    drop in as .png; only the JSON asset field extension changes."""
    for fn in ('hookup_panel_front.svg', 'hookup_panel_iso.svg'):
        assert os.path.isfile(os.path.join(ASSETS, fn)), \
            f'{fn} must exist in frontend/src/assets/hookup/'
    # And the retired placeholder names are gone.
    for gone in ('panel_m8_placeholder.svg', 'panel_air_placeholder.svg'):
        assert not os.path.exists(os.path.join(ASSETS, gone)), \
            f'stale placeholder {gone} must be removed'


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
