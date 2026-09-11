"""Peripheral hookup guide pinned regression.

2026-09-10 restructure: HookupGuide is no longer a New Program
Wizard page. It's hosted by the standalone HardwareSetupWizard
launched from the Program Library header; confirmation persists
PER-TOOL (via /api/tool_hookup) rather than per-program. The
wizard's gripper-type page still records the tool AND renders
an inline thread line reporting the tool's hookup-confirmation
status — informational only, never blocks program creation.
The editor's "View hookup" button opens the Hardware Setup
wizard read-only for the program's tool.

What stays untouched: the map file schema, coordinate overlays,
io_role coverage test, needs_operator_confirmation placeholders,
no-sensor codegen invariant. See test_hookup_coverage.py for the
class-fence walker that keeps codegen and hookup_map in sync.
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
HW_SETUP = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'HardwareSetupWizard.jsx'))
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


def test_program_wizard_has_no_hookup_page():
    """2026-09-10 restructure: the New Program Wizard no longer
    hosts the hookup guide. The 'hookup' PAGES entry is gone;
    HookupGuide is not imported by ProgramWizard.jsx; the wizard
    persists no hookup_confirmed / hookup_skipped answers.

    Skip-pattern doctrine still applies for OTHER pages (see
    test_wizard_simplification.py) — this test just enforces the
    absence of the retired page. desync suite stays green because
    the page count only drops by one and no new skip predicate
    was introduced."""
    src = _read(WZ)
    assert "id: 'hookup'," not in src, \
        'hookup PAGES entry must be retired from the program wizard'
    assert "import HookupGuide" not in src, \
        'HookupGuide import must be gone from ProgramWizard'
    # The retired-in-wizard machinery (hookup_skipped / setAnswer
    # for hookup_confirmed) should not persist in the wizard.
    assert 'setAnswer(\'hookup_skipped\'' not in src
    assert 'setAnswer(\'hookup_confirmed\'' not in src


def test_program_wizard_shows_thread_line_after_gripper_type():
    """Item 3: after gripper selection, the wizard renders a
    quiet inline line reporting per-tool hookup-confirmation
    status. Reads /api/tool_hookup/<key> via toolsApi's
    getToolHookup(). Informational only — never blocks."""
    src = _read(WZ)
    assert 'function HookupThreadLine' in src, \
        'inline thread-line component must exist'
    assert 'data-testid="wizard-hookup-thread"' in src
    # Consumes the per-tool API (not per-program state).
    assert 'getToolHookup' in src, \
        'thread line must fetch tool-hookup record from /api/tool_hookup'
    assert 'toolHookupKey' in src
    # Rendered inside the gripper_type page body.
    gt_idx = src.find("id: 'gripper_type',")
    assert gt_idx != -1
    tail = src[gt_idx:gt_idx + 2000]
    assert '<HookupThreadLine' in tail, \
        'HookupThreadLine must render on the gripper_type page'


def test_program_wizard_snapshots_tool_hookup_at_save():
    """Item 5: hookup machinery carries over untouched. At save
    time the wizard reads the tool's confirmation record and
    snapshots no_sensor + optional-answers into program.config
    so downstream codegen consumers (effectorVocab withBlowOff,
    hookup_no_sensor invariant) behave identically to the
    pre-restructure per-program wizard."""
    src = _read(WZ)
    assert 'const rec = await getToolHookup(key)' in src
    assert 'config.hookup_no_sensor = { ...rec.no_sensor }' in src
    # optional-toggle keys spread onto config as top-level keys
    # (matches the retired wizard's `for k of optionalMap` spread
    # so answers.blow_off_enabled etc. still land on config).
    assert 'config[k] = rec.optional[k]' in src


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
    the map now lands on the PER-TOOL record (via
    /api/tool_hookup/<key>) — HardwareSetupWizard is the host.

    Program-side plumbing carries over: wizard's handleSave
    snapshots the tool record's no_sensor into
    program.config.hookup_no_sensor so effectorVocab keeps
    behaving as before."""
    src = _read(GUIDE)
    # Filter drops hidden cards (multi-branch filter now — handles
    # noSensor + optional toggles).
    assert 'if (noSensor[h.id]) return false' in src
    # Summary rendered for hidden entries.
    assert 'data-testid="hookup-no-sensor-note"' in src
    assert 'Re-add sensor' in src
    # Standalone Hardware Setup wizard hosts the guide and hands
    # the map back via confirmToolHookup() POST — the per-tool
    # persistence path.
    hs = _read(HW_SETUP)
    assert 'confirmToolHookup' in hs
    assert 'noSensor: noSensorMap' in hs
    # Wizard-side snapshot lands on program.config.
    wz = _read(os.path.abspath(os.path.join(
        HERE, '..', 'frontend', 'src', 'components', 'ProgramWizard.jsx')))
    assert 'config.hookup_no_sensor = { ...rec.no_sensor }' in wz
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
    hookup button; opening it now renders the HardwareSetupWizard
    read-only (mount pre-scoped to the program's tool via
    initialToolKey). Same behavior, new home per the 2026-09-10
    restructure."""
    src = _read(EDITOR)
    # View hookup button still exists in the Tool & Payload strip.
    assert 'data-testid="view-hookup-button"' in src
    # The read-only jump-in mounts HardwareSetupWizard (not
    # HookupGuide directly any more).
    assert "import HardwareSetupWizard from './HardwareSetupWizard'" in src
    assert '<HardwareSetupWizard' in src
    assert 'readOnly' in src
    # Gripper type is resolved from program.config.gripper_type
    # (or gripper.type as fallback).
    assert 'config.gripper_type || program.config.gripper?.type' in src
    # And the editor no longer imports HookupGuide directly.
    assert "import HookupGuide from './HookupGuide'" not in src, \
        'HookupGuide import must be replaced by HardwareSetupWizard'


def test_program_library_header_has_hardware_setup_launcher():
    """Item 2: the Hardware Setup wizard launches from the Program
    Library header, beside 'New Program Wizard'."""
    src = _read(EDITOR)
    assert 'data-testid="hardware-setup-launcher"' in src
    # Modal render entry present.
    assert 'setShowHardwareSetup(true)' in src
    assert '{showHardwareSetup && (' in src


def test_hardware_setup_wizard_component_shape():
    """The standalone wizard exposes the tool-picker → guide flow
    with a Close control; jumps straight to a tool when
    initialToolKey is passed; renders the per-tool confirmation
    status line; and POSTs the record via confirmToolHookup."""
    src = _read(HW_SETUP)
    for hook in (
        'data-testid="hardware-setup-wizard"',
        'data-testid="hardware-setup-close"',
        'data-testid="hardware-setup-picker"',
        'data-testid="hardware-setup-tool-choice"',
        'data-testid="hardware-setup-body"',
        'data-testid="hardware-setup-status"',
    ):
        assert hook in src, f'missing hook {hook}'
    # Uses HookupGuide underneath — no fork of the guide component.
    assert "import HookupGuide from './HookupGuide'" in src
    # POST persistence.
    assert 'confirmToolHookup' in src
    # Read on open + refresh after confirm.
    assert 'getToolHookup' in src


def test_backend_tool_hookup_endpoints_wired():
    """Item 2: per-tool confirmation state lives at
    /api/tool_hookup/<tool_key>. GET returns the record (or null),
    POST persists with a confirmed_at timestamp."""
    src = _read(SERVER)
    assert '@app.get("/api/tool_hookup")' in src
    assert '@app.get("/api/tool_hookup/{tool_key:path}")' in src
    assert '@app.post("/api/tool_hookup/{tool_key:path}")' in src
    assert '_TOOL_HOOKUP_PATH' in src
    # Tool-key validator enforces vacuum/finger/custom:<hex>.
    assert "_validate_tool_key" in src
    # Timestamped record.
    assert "'confirmed_at'" in src


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
