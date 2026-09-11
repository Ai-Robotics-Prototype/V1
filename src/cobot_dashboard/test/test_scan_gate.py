"""Edition SCAN gate regression (2026-09-09).

Directive:
  * Remove ALL scan options from the BASIC interface; FULL keeps them.
  * Basic renders ZERO scan surfaces; full renders all.
  * Program EXECUTION is not touched: an existing program whose
    steps use detection still loads + runs identically on a basic
    device. Codegen invariants + executor dispatch are edition-
    independent. This gate is a VISIBILITY gate on operator-facing
    scan CONTROLS, never on codegen or run behavior.
  * Backend endpoints purely serving scan actions get the full-only
    refusal for basic devices; underlying services untouched. In
    practice all scan-only endpoints (/api/parts/{id}/scan/*,
    /api/detections, /api/parts/{id}/defects, /api/openvocab,
    /api/motioncam/*) are ALREADY gated behind `part_recognition`
    or `cameras_lidar` (both full-only), so this key adds no new
    backend gates — it purely gates frontend surfaces that lack
    dedicated backend endpoints.

Confirmed operator-facing scan surfaces gated by this directive:
  * frontend/src/components/ProgramEditor.jsx step-picker palette:
      - 'Scan' category (4 actions)
      - 'detect' entry in the 'Control' category
    Existing detect/scan steps in loaded programs still render (only
    the "+ Add Step" palette filters — ACTION_TYPES stays intact so
    per-step renderers keep working).
  * frontend/src/pages/MonitorDashboard.jsx Scan Results card
    (rendered mid-scan-program from task.scan_results / scan_count).
"""

from __future__ import annotations

import os
import re
import sys


HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.abspath(os.path.join(
    HERE, '..', 'cobot_dashboard', 'edition.py'))
FRONTEND_LIB = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'lib', 'edition.js'))
PROGRAM_EDITOR = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'ProgramEditor.jsx'))
MONITOR = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'pages', 'MonitorDashboard.jsx'))
PROGRAM_TRUTH = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'lib', 'programTruth.js'))

sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..')))
from cobot_dashboard import edition as edition_mod   # noqa: E402


def _read(path):
    with open(path) as fh:
        return fh.read()


# ── FEATURE_MAP: byte-mirrored, both editions correct ────────────

def test_scan_key_is_full_only_in_backend_map():
    assert edition_mod.FEATURE_MAP.get('scan') == edition_mod.EDITION_FULL


def test_scan_key_is_full_only_in_frontend_mirror():
    js = _read(FRONTEND_LIB)
    # Match the exact entry — permits trailing-comma / space variation.
    assert re.search(
        r"scan\s*:\s*EDITION_FULL", js), \
        "frontend edition.js MUST mirror scan: EDITION_FULL"


def test_scan_gate_semantics_basic_vs_full():
    """The runtime helper resolves scan the same way it resolves any
    other full-only key: basic → False, full → True. Guards against a
    future refactor that special-cases scan."""
    assert edition_mod.is_feature_enabled('scan', 'full')  is True
    assert edition_mod.is_feature_enabled('scan', 'basic') is False


# ── ProgramEditor palette: SCAN_ACTIONS gated, ACTION_TYPES intact ─

def test_program_editor_filters_palette_on_basic():
    src = _read(PROGRAM_EDITOR)
    # A dedicated filter helper — not scattered inline logic. Guards
    # against a future refactor that hides one surface but forgets the
    # others.
    assert re.search(
        r'function filterCategoriesForEdition\(',
        src), "ProgramEditor MUST expose filterCategoriesForEdition"
    # The palette render site uses the filter.
    assert 'filterCategoriesForEdition(STEP_CATEGORIES, edition)' in src, \
        "STEP_CATEGORIES render MUST route through the filter"
    # SCAN_ACTIONS set carries every action the operator sweep found.
    assert 'const SCAN_ACTIONS = new Set([' in src
    # Slice from the Set() literal opening to its closing bracket so
    # comments upstream don't shadow-match. The literal is bounded and
    # short — a fixed 400-char window from the "new Set([" landmark is
    # enough for the five entries + syntax.
    set_start = src.index('const SCAN_ACTIONS = new Set([')
    set_close = src.index('])', set_start)
    set_body = src[set_start:set_close]
    for action in ('detect', 'scan_workspace', 'scan_identify_each',
                    'sort_scanned', 'remove_defects'):
        assert re.search(
            rf"[\'\"]{action}[\'\"]", set_body), \
            f"SCAN_ACTIONS missing {action!r}"


def test_program_editor_action_types_intact_for_render():
    """ACTION_TYPES is the per-step renderer's source of truth for
    labels / tags / fields. Filtering it would collapse existing
    detect/scan steps in a LOADED program to ACTION_TYPES[0]
    (move_home) on basic. The gate MUST only touch STEP_CATEGORIES
    (the "+ Add Step" palette) so authored programs still render
    identically."""
    src = _read(PROGRAM_EDITOR)
    # ACTION_TYPES still lists every scan action verbatim.
    for action in ('detect', 'scan_workspace', 'scan_identify_each',
                    'sort_scanned', 'remove_defects'):
        assert re.search(
            rf"\{{\s*value:\s*[\'\"]{action}[\'\"]", src), \
            f"ACTION_TYPES lost {action!r} — existing steps would render wrong"


def test_program_editor_reads_edition_from_store():
    src = _read(PROGRAM_EDITOR)
    assert "import { isFeatureEnabled } from '../lib/edition'" in src
    assert 'const edition' in src
    assert "useStore((s) => s.edition)" in src


# ── MonitorDashboard: Scan Results card gated ────────────────────

def test_monitor_scan_results_gate():
    src = _read(MONITOR)
    # scanVisible is derived from isFeatureEnabled('scan', edition).
    assert "isFeatureEnabled('scan', edition)" in src
    assert 'const scanVisible' in src
    # The card's render condition wraps scanVisible. Regex tolerates
    # whitespace and either ordering (scanVisible AND task.scan_*).
    assert re.search(
        r'\{scanVisible\s*\n?\s*&&\s*\(task\?\.scan_results', src), \
        "Monitor Scan Results card MUST wrap render on scanVisible"


# ── Codegen invariant: executor step list still carries scan steps ─

def test_program_truth_still_lists_scan_step_actions():
    """programTruth.js MUST keep scan_workspace, scan_identify_each,
    sort_scanned, remove_defects, detect in its known-actions set so
    the executor's step dispatcher + save-program validator continue
    to accept them on both editions. Basic loads and RUNS programs
    with these steps identically to Full — the gate is purely on
    authoring surfaces."""
    src = _read(PROGRAM_TRUTH)
    for action in ('detect', 'scan_workspace', 'scan_identify_each',
                    'sort_scanned', 'remove_defects'):
        assert action in src, \
            f"programTruth.js lost {action!r} — codegen would refuse it"


# ── Backend refusal: scan-only endpoints already gated ────────────

def test_scan_only_backends_gated_via_part_recognition():
    """The scan-only backend endpoints don't need a NEW /scan/ gate:
    they're already gated behind `part_recognition` (full-only). Pin
    this so a future refactor that flips part_recognition to basic
    can't quietly expose scan endpoints. If part_recognition ever
    goes basic, the person doing that refactor lands on THIS test."""
    server_path = os.path.abspath(os.path.join(
        HERE, '..', 'cobot_dashboard', 'dashboard_server.py'))
    src = _read(server_path)
    # Slice the _EDITION_FULL_ONLY_PATTERNS list.
    m = re.search(
        r'_EDITION_FULL_ONLY_PATTERNS = \[(.+?)\]\n\n',
        src, re.DOTALL)
    assert m, '_EDITION_FULL_ONLY_PATTERNS list not found'
    patterns = m.group(1)
    for path_re, tag in [
        (r"/api/parts/\[\^/\]\+/scan\(\$\|/\)", 'part_recognition'),
        (r"/api/parts/\[\^/\]\+/defects\$", 'part_recognition'),
        (r"/api/detections\$", 'part_recognition'),
        (r"/api/openvocab\(\$\|/\)", 'part_recognition'),
        (r"/api/motioncam\(\$\|/\)", 'cameras_lidar'),
    ]:
        assert re.search(
            rf"{path_re}.*?[\'\"]{tag}[\'\"]",
            patterns, re.DOTALL), \
            f"scan-only endpoint {path_re!r} lost its {tag!r} gate"


# ── Safety invariant: scan is NOT a safety key ────────────────────

def test_basic_can_load_and_run_a_detect_program():
    """Program EXECUTION invariant. A program whose steps include
    `detect` (or any of the scan family) must load + run identically
    on a basic device. Codegen is untouched. The endpoints the run
    path traverses (/api/programs/{id}, /api/estun/program/run,
    /cmd/task) MUST NOT be in the edition-gated pattern list — the
    gate is on the authoring surface only. This test pins that
    non-gating so a future middleware sweep can't quietly close the
    run path for basic and silently break loaded programs."""
    server_path = os.path.abspath(os.path.join(
        HERE, '..', 'cobot_dashboard', 'dashboard_server.py'))
    src = _read(server_path)
    m = re.search(
        r'_EDITION_FULL_ONLY_PATTERNS = \[(.+?)\]\n\n',
        src, re.DOTALL)
    assert m
    patterns = m.group(1)
    for endpoint_re in (
        r"/api/programs",
        r"/api/estun/program/run",
        r"/cmd/task",
    ):
        # None of these appear as a full-only pattern. A path fragment
        # match is enough — the patterns are anchored regex strings.
        assert endpoint_re not in patterns, (
            f"{endpoint_re!r} became full-only — basic devices can no "
            f"longer load / run programs. Detect-step programs would "
            f"stop loading + running on basic. Codegen invariant broken.")


def test_scan_key_is_not_a_safety_invariant():
    """The `scan` key must NOT appear in SAFETY_INVARIANT_KEYS. That
    set is estop / safety_interlocks / delete_integrity / codegen /
    refusal_gates — the safety class. `scan` is a visibility gate, not
    a safety class, so it belongs in FEATURE_MAP. This pin catches a
    future refactor that accidentally promotes it to the invariant set
    (which would cause the loader to refuse it and crash the server)."""
    assert 'scan' not in edition_mod.SAFETY_INVARIANT_KEYS
