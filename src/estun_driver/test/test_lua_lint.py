"""Lint-pass tests for the Lua emitter.

The linter's contract is to catch every verb that either (a) isn't in
luaenginelib.json's 168-entry authoritative catalogue or (b) has the
wrong positional-argument count against the library template. See
program_ops.lint_lua_source for the parser.

These tests pin the "no unverified verb reaches the wire" invariant.
"""
from estun_driver.program_ops import (
    codegen_lua_from_program,
    lint_lua_source,
    LuaLintError,
    _parse_lib_arity,
    _load_luaenginelib,
)


# ── library-signature parser ──────────────────────────────────────

def test_parse_arity_simple_positional():
    assert _parse_lib_arity({'lua': 'setDO($1,$2)'}) == (2, 2)
    assert _parse_lib_arity({'lua': 'setSpeedJ(${vvd})'}) == (1, 1)
    assert _parse_lib_arity({'lua': '$1 = systemTime()'}) == (0, 0)


def test_parse_arity_movJ_options_table_is_optional():
    # movJ($1, {v=${optional.vv}, a=${optional.av}, ...}) — the trailing
    # table is entirely optional-scoped placeholders, so it's optional.
    t = ('movJ($1,{v=${optional.vv},a=${optional.av},b=${optional.b},'
         'rb=${optional.rb},coor=${optional.coor},tool=${optional.tool},'
         'search=${optional.search},onpercent=${optional.onpercent}})')
    assert _parse_lib_arity({'lua': t}) == (1, 2)


def test_parse_arity_waitCondition_two_required():
    t = '${var} = waitCondition(${condition},${timeout})'
    # Neither placeholder is optional-prefixed → both required.
    assert _parse_lib_arity({'lua': t}) == (2, 2)


# ── lint_lua_source basic behavior ────────────────────────────────

def test_lint_clean_program():
    prog = {
        'id': 'lintclean',
        'config': {'speed_pct': 100, 'motion_profile': 'joint'},
        'steps': [
            {'id': 1, 'action': 'move_home', 'taught': True,
             'taught_joints': [0, 0, 90, 0, 90, 0]},
            {'id': 2, 'action': 'set_io', 'io_id': 'DO1', 'value': 1},
            {'id': 3, 'action': 'wait', 'duration_s': 0.25},
            {'id': 4, 'action': 'set_io', 'io_id': 'DO1', 'value': 0},
        ],
    }
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    findings = lint_lua_source(lua)
    assert findings == [], f'expected clean lint, got: {findings}'


def test_lint_catches_unknown_verb():
    # `noSuchVerb` is neither in luaenginelib.json nor in
    # _WIRE_PROVEN_UNDOCUMENTED — must be refused.
    #
    # Note (2026-09-02): this test previously used setBlender as the
    # canary "unknown verb"; setBlender has since been documented as
    # wire-proven-undocumented per docs/lua_contract.md §7 (manual
    # §C.2 p.76). setBlender is now a KNOWN verb; noSuchVerb is a
    # regression-safe substitute for the "true unknown" case.
    src = 'setDO(1,0)\nnoSuchVerb(15)\nmovJ(p1)\r\n'
    findings = lint_lua_source(src)
    verbs = [f['verb'] for f in findings]
    assert 'noSuchVerb' in verbs, findings
    # Only noSuchVerb should have been flagged — setDO and movJ are in the library.
    assert all(f['verb'] == 'noSuchVerb' for f in findings), findings


def test_lint_catches_arity_mismatch():
    # setDO expects 2 args; giving it 3 should be flagged.
    src = 'setDO(1, 0, 999)\r\n'
    findings = lint_lua_source(src)
    assert len(findings) == 1, findings
    assert findings[0]['verb'] == 'setDO'
    assert findings[0]['args'] == 3
    assert 'arity' in findings[0]['reason']


def test_lint_recognizes_optional_options_table_on_movJ():
    # Both forms should pass — bare and with options table.
    assert lint_lua_source('movJ(p1)\r\n') == []
    assert lint_lua_source('movJ(p1, {coor=0, tool=0})\r\n') == []


def test_lint_ignores_control_flow():
    # `while`, `if`, `for`, `local`, `return` are not calls.
    src = (
        'local _t0 = systemTime()\r\n'
        'while (systemTime() - _t0) < 500 do end\r\n'
        'if x == 1 then setDO(1,1) end\r\n'
        'for i=1,5 do setDO(1,0) end\r\n'
    )
    assert lint_lua_source(src) == []


def test_lint_walks_into_nested_calls():
    # waitCondition(getDI(1)==1, 500) — both waitCondition and the
    # nested getDI must validate.
    src = 'waitCondition(getDI(1)==1, 500)\r\n'
    assert lint_lua_source(src) == []
    # A bogus nested verb should be caught.
    src2 = 'waitCondition(fakeVerb(1)==1, 500)\r\n'
    findings = lint_lua_source(src2)
    verbs = [f['verb'] for f in findings]
    assert 'fakeVerb' in verbs, findings


def test_lint_ignores_string_literals_and_comments():
    # setBlender appears only inside a string / comment — must not fire.
    src = (
        'setDO(1, 0)  -- setBlender(3) here is a comment, not a call\r\n'
        'print("setBlender(3) is a string literal")\r\n'
    )
    findings = lint_lua_source(src)
    # print is in the library — no arity concern here.
    assert all(f['verb'] != 'setBlender' for f in findings), findings


def test_lint_full_bowl_program_is_clean():
    """The whitebowlpickplace3-shaped program (Balanced/joint profile,
    5 pick-place cycles, 5 vacuum-seal waits) must lint clean under
    the new wait emission. This is the smoke-test that a real
    production program passes end-to-end."""
    prog = {
        'id': 'bowlsmoke',
        'config': {'speed_pct': 25, 'motion_profile': 'joint'},
        'steps': [
            {'id': 1, 'action': 'move_home', 'taught': True,
             'taught_joints': [0, 27, 128, 65, 89, -182]},
            {'id': 2, 'action': 'set_io', 'io_id': 'DO2', 'value': 0},
            {'id': 3, 'action': 'move_linear', 'derived_from': 'pick',
             'offset_z_mm': 100},
            {'id': 4, 'action': 'move_linear', 'position_role': 'pick',
             'taught': True,
             'taught_joints': [4.6, 30.3, 129.2, 69.1, 89, -182]},
            {'id': 5, 'action': 'set_io', 'io_id': 'DO2', 'value': 1},
            {'id': 6, 'action': 'wait', 'duration_s': 0.5},
            {'id': 7, 'action': 'move_linear', 'derived_from': 'pick',
             'offset_z_mm': 100},
            {'id': 8, 'action': 'move_home'},
        ],
    }
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=25)
    findings = lint_lua_source(lua)
    assert findings == [], (
        f'bowl-shaped program must lint clean, got {len(findings)} '
        f'finding(s): {findings[:3]}')
    # Also confirm the header lint stamp landed.
    assert 'lint: OK' in lua, 'header lint stamp missing'


# ── LuaLintError sugar ────────────────────────────────────────────

def test_lint_whitelists_wait_wire_proven():
    """`wait` is absent from luaenginelib.json but wire-proven — the
    linter's WIRE_PROVEN_UNDOCUMENTED whitelist admits it. Arity
    outside the observed range (1..1) still fails."""
    assert lint_lua_source('wait(500)\r\n') == []
    assert lint_lua_source('wait(1)\r\n') == []
    # arity 0 and arity 2 must fail — the observed evidence is one arg.
    for src in ('wait()\r\n', 'wait(500, 1)\r\n'):
        findings = lint_lua_source(src)
        assert len(findings) == 1, (src, findings)
        assert findings[0]['verb'] == 'wait'
        assert 'outside observed range' in findings[0]['reason']


def test_lint_catches_waitCondition_bare_false_literal():
    """Signature-vs-runtime gap: waitCondition(false, N) passes arity
    (2 args) but firmware v2.3 rejected it with alarm 10006 on
    2026-07-30 08:40 (bowl-run bench). The linter's known-bad
    pattern list now catches this shape at codegen time. bare `true`
    and `nil` are also flagged for symmetry — same class of trap."""
    for lit in ('false', 'true', 'nil'):
        src = f'waitCondition({lit}, 500)\r\n'
        findings = lint_lua_source(src)
        assert len(findings) == 1, (lit, findings)
        f = findings[0]
        assert f['verb'] == 'waitCondition'
        assert 'REJECTED by firmware' in f['reason']
        assert lit in f['reason']

    # A legal waitCondition (runtime-evaluable condition) must pass.
    assert lint_lua_source('waitCondition(getDI(1)==1, 500)\r\n') == []


def test_LuaLintError_carries_findings():
    finds = [{'line': 2, 'verb': 'setBlender', 'args': 1,
              'reason': 'not in library'}]
    try:
        raise LuaLintError(finds)
    except LuaLintError as e:
        assert e.findings == finds
        assert 'setBlender' in str(e)
