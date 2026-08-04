"""Full-surface argument validation (2026-08-04, post-D14).

Firmware bug #3 (three holepartpalletize kills) proved that
malformed Lua args kill C2Control silently. The D14 mov* arity
D-rule covered the 9 mov* verbs. This test module pins the
extended per-verb type/range matchers that cover every OTHER
verb codegen emits:

    wait, setDO, setAO, setSpeedJ, setSpeedL, setAccL,
    setBlender (D15 zero-length-blend, firmware bug #1).

The post-emit AssertionError in codegen_lua_from_program is
extended to raise on ANY of these matchers, not just D14, so
programmatic callers that skip the dashboard flow can't reach
the wire with a bad emission either.
"""

from __future__ import annotations

from estun_driver.program_ops import lint_lua_source


def _findings_from(src: str, verb_prefix: str) -> list:
    """Filter lint findings for a given verb's matcher prefix.
    Each matcher's reason string starts with the verb name (or
    the D-rule tag for the arity + zero-blend gates)."""
    return [
        f for f in lint_lua_source(src)
        if isinstance(f.get('reason'), str)
        and f['reason'].startswith(verb_prefix)
    ]


# ── wait(ms) ──────────────────────────────────────────────────────

def test_wait_accepts_positive_integer_ms():
    """The canonical case codegen emits — wait(500) after every
    setDO for gripper-settle timing."""
    findings = _findings_from('wait(500)', 'wait(')
    assert findings == [], (
        f'wait(500) triggered a matcher — the wait gate is too '
        f'strict; findings={findings!r}')


def test_wait_refuses_zero_or_negative_ms():
    """wait(0) is a codegen bug — either the caller wanted no
    wait (should have dropped the step) or wanted a minimum
    tick (should have emitted wait(1))."""
    for src in ('wait(0)', 'wait(-1)', 'wait(-100)'):
        findings = _findings_from(src, 'wait(')
        assert len(findings) == 1, (
            f'{src} should refuse; got findings={findings!r}')
        assert 'must be > 0' in findings[0]['reason']


def test_wait_refuses_bare_boolean_or_nil():
    """A bare literal like `wait(false)` is the same shape as
    the waitCondition-bare-literal firmware gap — different
    verb, same class of programmer error. Refuse defensively.

    Note: string literals (`wait('now')`) can't be detected at
    lint time because _strip_lua_strings_and_comment removes
    them before arg parsing. That gap is upstream; codegen
    never emits a string arg to wait so the practical exposure
    is nil."""
    for src, hint in [
        ("wait(false)", 'false'),
        ("wait(true)",  'true'),
        ("wait(nil)",   'nil'),
    ]:
        findings = _findings_from(src, 'wait(')
        assert len(findings) == 1, (
            f'{src} should refuse; got findings={findings!r}')
        assert hint in findings[0]['reason'], (
            f'expected reason to name the bad literal {hint!r}; '
            f'got {findings[0]["reason"]!r}')


def test_wait_refuses_sub_millisecond_float():
    """wait(0.5) is a codegen bug — v2.3 has no sub-ms
    precision. Codegen rounds before emit; a float that
    reaches lint is a regression."""
    findings = _findings_from('wait(0.5)', 'wait(')
    assert len(findings) == 1
    assert 'INTEGER' in findings[0]['reason']


# ── setDO(port, level) ────────────────────────────────────────────

def test_setDO_accepts_canonical_shape():
    """setDO(2,1) — vacuum on, canonical codegen emission."""
    findings = _findings_from('setDO(2,1)', 'setDO(')
    assert findings == []


def test_setDO_refuses_out_of_range_port():
    """v2.3 IOManager rejects ports outside 1..24."""
    for src in ('setDO(0,1)', 'setDO(25,1)', 'setDO(100,0)'):
        findings = _findings_from(src, 'setDO(')
        assert len(findings) == 1
        assert 'outside wire-proven range' in findings[0]['reason']


def test_setDO_refuses_non_binary_level():
    """DO writes are 0 or 1. Analog goes through setAO."""
    for src in ('setDO(2,2)', 'setDO(2,-1)', 'setDO(2,255)'):
        findings = _findings_from(src, 'setDO(')
        assert len(findings) == 1
        assert 'must be 0 or 1' in findings[0]['reason']


# ── setAO(port, value) ────────────────────────────────────────────

def test_setAO_refuses_negative_or_huge():
    for src in ('setAO(1,-1)', 'setAO(1,99999)'):
        findings = _findings_from(src, 'setAO(')
        assert len(findings) == 1


def test_setAO_refuses_port_out_of_range():
    findings = _findings_from('setAO(9,50)', 'setAO(')
    assert len(findings) == 1
    assert 'outside wire-proven range' in findings[0]['reason']


# ── setSpeedJ / setSpeedL / setAccL ─────────────────────────────

def test_setSpeedJ_refuses_zero_or_over_ceiling():
    """Zero-speed movJ hangs the interpreter; over-ceiling
    values get silently clamped by firmware, masking a codegen
    scaling bug."""
    findings = _findings_from('setSpeedJ(0)', 'setSpeedJ(')
    assert len(findings) == 1 and 'must be > 0' in findings[0]['reason']
    findings = _findings_from('setSpeedJ(-5)', 'setSpeedJ(')
    assert len(findings) == 1
    findings = _findings_from('setSpeedJ(250)', 'setSpeedJ(')
    assert len(findings) == 1 and 'exceeds wire-proven' in findings[0]['reason']


def test_setSpeedJ_accepts_canonical_range():
    """Codegen emits 37.5, 90, etc. inside the operator cap."""
    for src in ('setSpeedJ(37.5)', 'setSpeedJ(90)', 'setSpeedJ(150)'):
        findings = _findings_from(src, 'setSpeedJ(')
        assert findings == [], f'{src} rejected: {findings!r}'


def test_setSpeedL_refuses_zero_or_over_ceiling():
    findings = _findings_from('setSpeedL(0)', 'setSpeedL(')
    assert len(findings) == 1
    findings = _findings_from('setSpeedL(5000)', 'setSpeedL(')
    assert len(findings) == 1
    # Canonical still passes
    assert _findings_from('setSpeedL(1500)', 'setSpeedL(') == []


def test_setAccL_refuses_zero():
    findings = _findings_from('setAccL(0)', 'setAccL(')
    assert len(findings) == 1
    assert _findings_from('setAccL(3000)', 'setAccL(') == []


# ── D15 zero-length-blend (firmware bug #1) ─────────────────────

def test_d15_zero_length_blend_refuses_setBlender_zero():
    """Firmware bug #1 (Part C, 2026-07-22): a zero-radius
    blend or zero-length movL crashes the blend planner on
    real hardware. Codegen guards zero-length movL upstream;
    this D-rule refuses the setBlender(0) shape as the last-
    mile catch."""
    findings = _findings_from('setBlender(0)', 'D15')
    assert len(findings) == 1
    assert 'firmware bug' in findings[0]['reason'].lower()
    assert 'setNoBlender' in findings[0]['reason']


def test_d15_refuses_negative_blend():
    findings = _findings_from('setBlender(-3)', 'setBlender(')
    assert len(findings) == 1


def test_d15_accepts_positive_blend():
    for r in ('setBlender(12)', 'setBlender(3.5)', 'setBlender(30)'):
        findings = [f for f in lint_lua_source(r)
                    if 'D15' in f.get('reason', '')]
        assert findings == [], (
            f'{r} triggered D15 falsely: {findings!r}')


# ── Codegen post-emit AssertionError extended coverage ──────────

def test_codegen_post_emit_covers_all_verbs():
    """Regression pin: the post-emit assertion inside
    codegen_lua_from_program must key on the same set of
    reason-prefixes as the lint gate — otherwise a caller
    that skips the dashboard flow can produce bad Lua that
    the lint would refuse."""
    from estun_driver import program_ops
    import inspect
    src = inspect.getsource(program_ops.codegen_lua_from_program)
    # Every matcher's prefix must be name-checked in the
    # post-emit assertion filter. If a new matcher is added
    # without adding its prefix here, the post-emit
    # AssertionError will silently miss it.
    for prefix in ('D14 arity', 'D15 zero-length-blend',
                   'arity mismatch',
                   'wait(', 'setDO(', 'setAO(',
                   'setSpeedJ(', 'setSpeedL(', 'setAccL(',
                   'setBlender('):
        assert repr(prefix) in src or f"'{prefix}'" in src, (
            f'codegen_lua_from_program post-emit assertion does '
            f'not key on prefix {prefix!r} — new matcher not '
            f'wired to the assertion filter')


# ── Positive list: unknown verb refusal is intact ────────────────

def test_unknown_verb_still_refused():
    """The pre-existing "unknown verb" branch in lint_lua_source
    (positive-list defense) must survive the matcher additions.
    A hypothetical `crashRobot(1)` should still be refused with
    the "not in luaenginelib.json" reason."""
    findings = lint_lua_source('crashRobot(1)')
    assert len(findings) == 1
    r = findings[0]['reason']
    assert 'not in luaenginelib.json' in r.lower() or \
           'not in the wire-proven-undocumented whitelist' in r.lower()
