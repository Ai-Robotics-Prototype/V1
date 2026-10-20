"""Wizard simplification pinned regression (2026-09-08).

Directive:
  1. Retire the "which workspace/cell" page. Cell auto-assigns when
     exactly one commissioned cell exists; silent null otherwise.
     Cell-less programs load / push / run exactly as today —
     library filter's 'All cells' shows them.
  2. Retire the "Sort Parts" option from the operation page. Backend
     codegen paths for 'sort' stay live so existing sort programs
     on disk still load.
  3. Retire the "pick_method" page. Source defaults to
     'fixed_position' for pick_and_place + machine_tend from the
     operation page's onclick override. Palletize continues to set
     its own source via pallet_mode. `which_part` skip predicate
     already handles source !== 'camera_library' as True.
  4. Cycles slider → plain numeric input (min 1, no artificial max,
     validate integer at commit).
  5. All new/changed skip predicates go through the goNext override
     pattern so safeIdx self-heal tests stay green.
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
WZ = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'ProgramWizard.jsx'))
LIB = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'pages', 'ProgramLibrary.jsx'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def _strip_comments(src):
    s = re.sub(r'/\*.*?\*/',   '', src, flags=re.DOTALL)
    s = re.sub(r'\{/\*.*?\*/\}', '', s, flags=re.DOTALL)
    return '\n'.join(
        line for line in s.splitlines()
        if not line.lstrip().startswith('//'))


def test_cell_page_retired():
    """No PAGES entry with id: 'cell' and no CellPickerPage
    function remains. The cell auto-assign runs from a useEffect
    at ProgramWizard mount when exactly one commissioned cell
    exists."""
    code = _strip_comments(_read(WZ))
    # Page entry gone.
    assert "id: 'cell'," not in code, \
        'wizard must not carry a cell picker page any more'
    # Function body gone.
    assert 'function CellPickerPage' not in code, \
        'CellPickerPage function must be retired'
    # Auto-assign wired.
    assert 'commissioned.length === 1' in code, \
        'wizard must auto-assign cell_id when exactly one ' \
        'commissioned cell exists'


def test_sort_option_retired_from_operation_page():
    """The wizard's operation page no longer offers 'sort'.
    Codegen paths for existing sort programs stay live (this
    test only asserts the WIZARD chooser)."""
    code = _strip_comments(_read(WZ))
    # Operation-page choice-list must not include a sort entry.
    op_page_idx = code.find("id: 'operation'")
    assert op_page_idx != -1
    op_body = code[op_page_idx:op_page_idx + 3000]
    assert "value: 'sort'" not in op_body, \
        'sort option must be retired from operation page'
    # Three remaining options.
    for kept in ("value: 'pick_and_place'",
                 "value: 'machine_tend'",
                 "value: 'palletize'"):
        assert kept in op_body, f'{kept} must stay on operation page'


def test_pick_method_page_retired():
    """No PAGES entry with id: 'pick_method'. The operation page's
    onclick sets source='fixed_position' for non-palletize
    operations, passed through the goNext override so which_part
    (which skips on source !== 'camera_library') is correctly
    skipped without a stale-page render tick."""
    code = _strip_comments(_read(WZ))
    assert "id: 'pick_method'," not in code
    # The operation page's click handler seeds source alongside
    # operation through goNext override.
    assert "override.source = 'fixed_position'" in code
    assert 'goNext(override)' in code
    # which_part still exists with its original skip predicate.
    assert "id: 'which_part'," in code
    assert "answers.source !== 'camera_library'" in code


def test_cycles_uses_numeric_input_not_slider():
    """Repeat page: 'count' branch renders a plain <input type=
    "number" min={1}> instead of SliderQuestion. Integer
    validation on commit clamps to >=1."""
    code = _strip_comments(_read(WZ))
    # Locate the repeat page.
    rp_idx = code.find("id: 'repeat',")
    assert rp_idx != -1
    rp_body = code[rp_idx:rp_idx + 4000]
    # Numeric input hook present.
    assert 'data-testid="wizard-cycles-input"' in rp_body
    assert 'type="number"' in rp_body
    assert 'min={1}' in rp_body
    assert 'inputMode="numeric"' in rp_body
    # SliderQuestion no longer used for the count branch.
    assert 'SliderQuestion' not in rp_body
    # Plain <label> text carries the caption.
    assert 'Number of cycles' in rp_body
    # Integer validation on commit.
    assert 'parseInt(answers.repeat_count, 10)' in rp_body


def test_library_filter_shows_cell_less_programs_under_all():
    """Item 1 consumer check: the Program Library's 'all' filter
    surfaces programs with cell_id === null (cell-less). The
    filter code has been this way for weeks; this test locks it
    against a regression that would hide auto-assigned-null
    programs."""
    lib = _read(LIB)
    # 'all' returns everything; 'none' filters !cell_id; a specific
    # cell_id matches exactly. cell-less programs match under 'all'.
    assert "if (cellFilter === 'all')  return true" in lib
    assert "if (cellFilter === 'none') return !p.cell_id" in lib


def test_buildsteps_still_writes_cell_id_null_when_absent():
    """Item 1 wire consumer: handleSave writes `cell_id:
    answers.cell_id || null` to POST /api/programs. Cell-less
    programs are legitimate; no server refusal, no toast."""
    code = _strip_comments(_read(WZ))
    assert 'cell_id: answers.cell_id || null' in code


def test_which_part_still_skips_when_source_is_fixed():
    """Item 3 consumer check: `which_part` page's skip predicate
    already returns true for source !== 'camera_library'. With the
    default source='fixed_position', which_part is skipped without
    a stale-page tick — no orphan camera page reachable from the
    default pick_and_place flow."""
    code = _strip_comments(_read(WZ))
    wp_idx = code.find("id: 'which_part',")
    assert wp_idx != -1
    wp_body = code[wp_idx:wp_idx + 400]
    # Skip predicate present.
    assert 'skip:' in wp_body
    assert "answers.source !== 'camera_library'" in wp_body


def test_no_detect_step_when_source_is_fixed():
    """buildSteps emits the `detect` step only when
    `answers.source === 'camera_library'`. With the default
    'fixed_position', no detect step lands in a wizard-produced
    pick_and_place program. Prevents an orphan camera-detection
    step in a program that never chose a target part."""
    code = _strip_comments(_read(WZ))
    # The non-palletize gate.
    assert "if (answers.source === 'camera_library') {" in code
    # And no forced-emit in the non-palletize path (that would be
    # a bug — camera_library defaults to '|| camera_library' only
    # inside the palletize branch, which sets source explicitly).
    non_pallet_gate = re.search(
        r"if \(answers\.source === 'camera_library'\) \{[^}]*action: 'detect'",
        code, re.DOTALL)
    assert non_pallet_gate, \
        'non-palletize detect step must remain gated by source === camera_library'
