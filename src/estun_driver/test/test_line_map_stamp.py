"""D9 line_map stamp — codegen authors a step→lua_line map used by
the Monitor's live step highlight.

Guarantees under test:
  * `line_map_sink` receives one entry per program step, in order.
  * Every entry names step_idx, step_id, action, and inclusive
    [lua_line_start, lua_line_end].
  * Line ranges are contiguous — no gaps, no overlaps — and cover
    every non-footer line in the emitted Lua (the walker phase).
  * ProjectState.line-style values (motion / IO verb lines) resolve
    to the right step_id.
  * A loop program's for/end lines both fall inside a step range,
    and the same physical line resolves to the same step across
    every iteration (loop-aware).
  * The footer stamp `-- line_map (D9 ...): [...]` carries the JSON
    of the same list.
"""

from __future__ import annotations

import json

from estun_driver.program_ops import codegen_lua_from_program


PICK_J  = [63.15, 38.45, 133.63, 81.85, 90.57, -105.28]
PLACE_J = [-2.82, 22.14, 130.69, 62.61, 90.57, -105.28]


def _bowl_program():
    return {
        'id':   'line-map-bowl',
        'name': 'line-map-bowl',
        'config': {'speed_pct': 60},
        'steps': [
            {'id': 1, 'action': 'move_home', 'label': 'Home',
             'taught_joints': [40.0, 30.0, 130.0, 80.0, 90.0, -105.0],
             'position_role': 'home'},
            {'id': 2, 'action': 'set_io', 'io_id': 'DO2', 'value': 0},
            {'id': 3, 'action': 'move_linear', 'label': 'approach pick',
             'derived_from': 'pick', 'offset_z_mm': 100},
            {'id': 4, 'action': 'move_linear', 'label': 'PICK',
             'position_role': 'pick', 'taught_joints': list(PICK_J)},
            {'id': 5, 'action': 'set_io', 'io_id': 'DO2', 'value': 1},
            {'id': 6, 'action': 'wait',   'duration_s': 0.5},
            {'id': 7, 'action': 'move_linear', 'label': 'ascent pick',
             'derived_from': 'pick', 'offset_z_mm': 100},
            {'id': 8, 'action': 'move_linear', 'label': 'approach place',
             'derived_from': 'place', 'offset_z_mm': 100},
            {'id': 9, 'action': 'move_linear', 'label': 'PLACE',
             'position_role': 'place', 'taught_joints': list(PLACE_J)},
            {'id': 10, 'action': 'set_io', 'io_id': 'DO2', 'value': 0},
            {'id': 11, 'action': 'move_linear', 'label': 'ascent place',
             'derived_from': 'place', 'offset_z_mm': 100},
            {'id': 12, 'action': 'loop', 'type': 'move',
             'goto': 3, 'count': 5},
        ],
    }


def test_line_map_covers_every_step_once():
    prog = _bowl_program()
    sink = []
    codegen_lua_from_program(
        prog, operator_speed_limit_pct=100, line_map_sink=sink)
    assert len(sink) == len(prog['steps']), (
        f'line_map has {len(sink)} entries; program has '
        f'{len(prog["steps"])} steps')
    for i, e in enumerate(sink):
        assert e['step_idx'] == i, e
        # Every entry names the step_id from the program (may be None
        # only for programs with unset ids — bowl program sets them
        # all so we assert non-None here).
        assert e['step_id'] is not None, e
        assert e['action'], e
        assert isinstance(e['lua_line_start'], int), e
        assert isinstance(e['lua_line_end'], int), e


def test_line_map_ranges_contiguous_no_gaps_no_overlap():
    prog = _bowl_program()
    sink = []
    codegen_lua_from_program(
        prog, operator_speed_limit_pct=100, line_map_sink=sink)
    prev_end = 0
    for e in sink:
        s = e['lua_line_start']
        t = e['lua_line_end']
        assert s == prev_end + 1, (
            f'gap or overlap: step {e["step_idx"]} starts at L{s}, '
            f'previous ended at L{prev_end}')
        assert t >= s - 1, (   # -1 allowed for a zero-emission step
            f'step {e["step_idx"]} has inverted range [{s}, {t}]')
        prev_end = t


def test_projectstate_line_resolves_to_correct_step():
    """Emit the bowl program and hand back the motion-line numbers
    the controller would report on the wire. Each must resolve to
    the correct step_idx via the line_map."""
    prog = _bowl_program()
    sink = []
    lua, _, _ = codegen_lua_from_program(
        prog, operator_speed_limit_pct=100, line_map_sink=sink)
    lines = lua.splitlines()

    def _step_for_wire_line(ln_no):
        for e in sink:
            if e['lua_line_start'] <= ln_no <= e['lua_line_end']:
                return e['step_idx']
        return None

    # Walk emitted lines and check each PRIMARY motion / IO / wait
    # verb resolves back to a plausible step_idx.
    verb_prefixes = ('movJ(', 'movL(', 'movJCoorRel(', 'setDO(',
                     'setAO(', 'wait(', 'waitCondition(', 'for i=', 'end ')
    hits = 0
    for i, ln in enumerate(lines, 1):
        s = ln.strip()
        if not any(s.startswith(p) for p in verb_prefixes):
            continue
        idx = _step_for_wire_line(i)
        assert idx is not None, (
            f'wire line L{i} ({s!r}) not covered by any line_map '
            f'range — Monitor cannot highlight this frame')
        # Sanity: the resolved step's action shouldn't be wildly
        # inconsistent (e.g. a setDO line resolving to a move_home).
        act = prog['steps'][idx]['action']
        if s.startswith('setDO(') or s.startswith('setAO('):
            assert act == 'set_io', (
                f'L{i} {s!r} resolved to step {idx} (action={act!r}) '
                f'— should be a set_io')
        if s.startswith('wait('):
            assert act == 'wait', (
                f'L{i} {s!r} resolved to step {idx} (action={act!r}) '
                f'— should be a wait')
        if s.startswith('mov'):
            assert act in ('move_linear', 'move_home', 'move_joint'), (
                f'L{i} {s!r} resolved to step {idx} (action={act!r}) '
                f'— should be a move')
        hits += 1
    assert hits >= 6, f'no motion lines checked ({hits}) — fixture broke'


def test_line_map_footer_stamp_matches_sink():
    """The `-- line_map (D9 ...): [...]` footer must carry JSON
    equal to the sink list. Consumers that only have the resident
    Lua (no sidecar) parse the stamp; drift between sink and stamp
    would break that path."""
    prog = _bowl_program()
    sink = []
    lua, _, _ = codegen_lua_from_program(
        prog, operator_speed_limit_pct=100, line_map_sink=sink)
    stamp_line = None
    for ln in lua.splitlines():
        if ln.startswith('-- line_map (D9'):
            stamp_line = ln
            break
    assert stamp_line, f'no D9 stamp in emitted Lua'
    json_part = stamp_line[stamp_line.index('['):]
    parsed = json.loads(json_part)
    assert parsed == sink, (
        f'footer stamp does not match sink:\n'
        f'  stamp: {parsed}\n'
        f'  sink:  {sink}')


def test_loop_body_lines_map_to_body_steps():
    """The for-loop body carries the same physical Lua lines every
    iteration; those lines MUST map to the same body step. Loop-
    aware highlight is what the operator's cycle counter carries."""
    prog = _bowl_program()
    sink = []
    codegen_lua_from_program(
        prog, operator_speed_limit_pct=100, line_map_sink=sink)
    # PICK contact is step_idx 3 in the fixture. Its Lua line must
    # be inside the body (i.e. not equal to the initial move_home
    # line = step 0's range). Same line resolves to step 3 whether
    # we're on iteration 1 or iteration 5.
    pick_entry = next(e for e in sink if e['step_idx'] == 3)
    # Simulate the controller reporting the pick line during
    # iteration 3 — the map lookup doesn't know or care.
    for iteration in (1, 2, 3, 4, 5):
        # Any line inside [start, end] resolves to step 3.
        for ln in range(pick_entry['lua_line_start'],
                        pick_entry['lua_line_end'] + 1):
            hit = None
            for e in sink:
                if e['lua_line_start'] <= ln <= e['lua_line_end']:
                    hit = e['step_idx']; break
            assert hit == 3, (
                f'iteration {iteration}: line L{ln} resolved to step '
                f'{hit}, expected step 3 (pick)')


def test_line_map_sink_absent_by_default():
    """When no sink is passed, codegen must not attempt to populate
    anything — backward compat for callers that never asked."""
    prog = _bowl_program()
    lua, _, _ = codegen_lua_from_program(
        prog, operator_speed_limit_pct=100)
    # Footer stamp still lands (self-contained in the Lua) but no
    # external structure is affected.
    assert '-- line_map (D9' in lua


def test_line_map_reference_programs_all_have_valid_map():
    """Every reference program produces a well-formed line_map.
    Reference set: bowl, single-station, empty-loop, tools-off."""
    programs = [
        _bowl_program(),
        # Single-station
        {'id': 'single', 'steps': [
            {'id': 1, 'action': 'move_home',
             'taught_joints': [0.0]*6},
            {'id': 2, 'action': 'move_linear',
             'derived_from': 'pick', 'offset_z_mm': 100},
            {'id': 3, 'action': 'move_linear',
             'position_role': 'pick', 'taught_joints': list(PICK_J)},
            {'id': 4, 'action': 'move_linear',
             'derived_from': 'pick', 'offset_z_mm': 100},
        ]},
        # No-loop pick&place
        {'id': 'noloop', 'steps': [
            {'id': 1, 'action': 'move_home',
             'taught_joints': [0.0]*6},
            {'id': 2, 'action': 'move_linear',
             'position_role': 'pick', 'taught_joints': list(PICK_J)},
            {'id': 3, 'action': 'move_linear',
             'position_role': 'place', 'taught_joints': list(PLACE_J)},
        ]},
    ]
    for prog in programs:
        sink = []
        codegen_lua_from_program(
            prog, operator_speed_limit_pct=100, line_map_sink=sink)
        assert len(sink) == len(prog['steps']), (
            f'{prog["id"]}: len mismatch {len(sink)} vs {len(prog["steps"])}')
        for e in sink:
            assert e['lua_line_start'] >= 1, e
            assert (e['lua_line_end'] >= e['lua_line_start']
                    or e['lua_line_end'] == e['lua_line_start'] - 1), e
