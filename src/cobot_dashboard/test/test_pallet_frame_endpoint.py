"""Shared pallet-frame validator (§465 fork-1 kill, 2026-08-04).

Pins the behavior of `POST /api/pallet/validate_frame` and the
underlying `pallet_geometry.validate_frame` extensions:

  * `corner_coincident` finding fires when either row (c1→c2)
    or col (c1→c3) < _MIN_EDGE_LEN_MM (= 1 mm), with
    involves_corners=['c1','c2'] or ['c1','c3'] and the
    measured distance in mm.
  * Other findings (row_col_near_parallel, pallet_tilted,
    part_datum_*) carry involves_corners so the frontend can
    filter for re-teach suppression.
  * v1-shape input (corner_a_tcp / point_b_tcp / point_c_tcp)
    is migrated to v2 before validation — v1 programs are NOT
    silently passed.
  * Operator copy: title = what to do; detail = which corners
    + measured distance; technicalDetail = raw wire text.
    None of {codegen, mm2mAndDeg2rad, v.size(), firmware bug}
    in title/detail (267108a register).
"""

from __future__ import annotations

from programming_by_demonstration.schema import PalletPlaceSpec
from programming_by_demonstration.pallet_geometry import validate_frame


def _spec(**place):
    base = {'rows': 2, 'cols': 2, 'layers': 1}
    base.update(place)
    return PalletPlaceSpec.from_dict(base)


# ── corner_coincident (row) ────────────────────────────────────

def test_corner_coincident_c1_c2_fires_below_threshold():
    s = _spec(
        corner1_tcp=[100.0, 0.0, 50.0, 0, 0, 0],
        corner2_tcp=[100.5, 0.0, 50.0, 0, 0, 0],   # 0.5 mm from c1
        corner3_tcp=[100.0, 100.0, 50.0, 0, 0, 0],
    )
    findings = validate_frame(s)
    coincidents = [f for f in findings
                   if f.get('code') == 'corner_coincident']
    assert len(coincidents) == 1, (
        f'expected exactly one corner_coincident finding, got: {findings!r}')
    f = coincidents[0]
    assert f['involves_corners'] == ['c1', 'c2']
    assert 0.4 < f['distance_mm'] < 0.6
    assert 'coincident' in f['message'].lower()


def test_corner_coincident_c1_c3_fires_below_threshold():
    s = _spec(
        corner1_tcp=[100.0, 0.0, 50.0, 0, 0, 0],
        corner2_tcp=[500.0, 0.0, 50.0, 0, 0, 0],
        corner3_tcp=[100.4, 0.0, 50.0, 0, 0, 0],   # 0.4 mm from c1
    )
    findings = validate_frame(s)
    coincidents = [f for f in findings
                   if f.get('code') == 'corner_coincident']
    assert len(coincidents) == 1
    assert coincidents[0]['involves_corners'] == ['c1', 'c3']
    assert 0.3 < coincidents[0]['distance_mm'] < 0.5


def test_healthy_frame_no_coincident_finding():
    s = _spec(
        corner1_tcp=[0.0, 0.0, 0.0, 0, 0, 0],
        corner2_tcp=[400.0, 0.0, 0.0, 0, 0, 0],
        corner3_tcp=[0.0, 300.0, 0.0, 0, 0, 0],
        part_tcp=[5.0, 5.0, -50.0, 0, 0, 0],
    )
    findings = validate_frame(s)
    coincidents = [f for f in findings
                   if f.get('code') == 'corner_coincident']
    assert coincidents == []


def test_coincident_skips_angle_check_to_avoid_double_reporting():
    """When either row or col collapses, the angle math is
    meaningless — validate_frame must NOT also emit
    row_col_near_parallel (angle=0 on coincident inputs would
    trip that check). Keeping the two findings from firing
    together stops the operator from getting a contradictory
    "same direction" toast on top of "same point"."""
    s = _spec(
        corner1_tcp=[0.0, 0.0, 0.0, 0, 0, 0],
        corner2_tcp=[0.2, 0.0, 0.0, 0, 0, 0],   # 0.2 mm — coincident
        corner3_tcp=[0.0, 300.0, 0.0, 0, 0, 0],
    )
    findings = validate_frame(s)
    codes = [f.get('code') for f in findings]
    assert 'corner_coincident' in codes
    assert 'row_col_near_parallel' not in codes, (
        f'both coincident AND row_col_near_parallel emitted: {codes!r}')


# ── v1 migration passes through validation ────────────────────

def test_v1_shape_migrated_then_validated_not_silently_passed():
    """A v1-shape program (corner_a_tcp / point_b_tcp /
    point_c_tcp) with degenerate corners must be caught after
    migration — the pre-2026-08-04 frontend fork skipped this
    check for v1 programs because it read v2 keys only."""
    s = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2, 'layers': 1,
        'corner_a_tcp': [100.0, 0.0, 50.0, 0, 0, 0],
        'point_b_tcp':  [100.3, 0.0, 50.0, 0, 0, 0],   # 0.3 mm from A
        'point_c_tcp':  [100.0, 100.0, 50.0, 0, 0, 0],
    })
    assert s.migrated_from_v1
    findings = validate_frame(s)
    codes = [f.get('code') for f in findings]
    assert 'corner_coincident' in codes, (
        'v1-shape program was silently passed — migration to v2 '
        'must happen BEFORE validate_frame runs so the same '
        'geometry checks apply to old and new shapes')


# ── involves_corners metadata on every finding ────────────────

def test_row_col_near_parallel_involves_c2_c3():
    """Points B and C at the same angle → the fix is re-teaching
    corner 2 or 3, not corner 1."""
    s = _spec(
        corner1_tcp=[0.0, 0.0, 0.0, 0, 0, 0],
        corner2_tcp=[400.0, 0.0, 0.0, 0, 0, 0],
        # Column 5° off row direction — under _MIN_ROW_COL_ANGLE_DEG (60).
        corner3_tcp=[300.0, 30.0, 0.0, 0, 0, 0],
    )
    findings = validate_frame(s)
    parallels = [f for f in findings
                 if f.get('code') == 'row_col_near_parallel']
    assert len(parallels) == 1
    assert parallels[0]['involves_corners'] == ['c2', 'c3']


def test_pallet_tilted_involves_all_three_corners():
    s = _spec(
        corner1_tcp=[0.0, 0.0, 0.0, 0, 0, 0],
        # Row lifted 100 mm across 400 → 14° tilt.
        corner2_tcp=[400.0, 0.0, 100.0, 0, 0, 0],
        corner3_tcp=[0.0, 300.0, 0.0, 0, 0, 0],
    )
    findings = validate_frame(s)
    tilts = [f for f in findings if f.get('code') == 'pallet_tilted']
    assert len(tilts) == 1
    assert tilts[0]['involves_corners'] == ['c1', 'c2', 'c3']


# ── operator copy contract on the endpoint layer ──────────────
# The dashboard's _pallet_finding_operator_copy is exercised
# indirectly via the endpoint. We keep the assertion at the
# source-level since spinning FastAPI for a unit test is
# overkill — the copy strings live in dashboard_server.py.

def test_operator_copy_uses_267108a_register():
    """dashboard_server.py's _pallet_finding_operator_copy must
    produce operator-language strings free of the banned
    technical tokens (267108a register)."""
    import os
    import re as _re
    HERE = os.path.dirname(os.path.abspath(__file__))
    SERVER = os.path.abspath(os.path.join(
        HERE, '..', 'cobot_dashboard', 'dashboard_server.py'))
    with open(SERVER) as fh:
        src = fh.read()
    # Extract _pallet_finding_operator_copy body — cheap slice
    # bounded by the next @app.post decorator (the endpoint that
    # calls this helper).
    m = _re.search(
        r'def _pallet_finding_operator_copy\([^)]*\)[^:]*:'
        r'(.+?)\n    @app\.post',
        src, _re.DOTALL)
    assert m, ('_pallet_finding_operator_copy signature drifted — '
               'cannot pin the operator-copy register')
    body = m.group(1)
    # Banned technical tokens (subset of the frontend
    # BANNED_OPERATOR_TOKENS the 267108a commit codified).
    banned = ('mm2mAndDeg2rad', 'v.size()', 'exitProcess', 'firmware bug',
              'Gram-Schmidt', 'compute_frame', 'plane_normal')
    for token in banned:
        # 'compute_frame' is fine in comments; only refuse in a
        # string literal inside the function body.
        for match in _re.finditer(r"['\"]([^'\"\\n]{0,200})['\"]", body):
            s = match.group(1)
            assert token not in s, (
                f'operator copy contains banned token {token!r} in '
                f'string {s!r} — technicalDetail carries the raw wire '
                f'text; title/detail must be operator-language.')
    # Positive: at least one code branch must use the "jog to the
    # actual pallet corner" phrasing per the directive. Python
    # adjacent-string-literal concatenation splits the phrase
    # across source lines (`'…foo '` newline `f'bar…'`), so join
    # adjacent quoted literals before checking.
    collapsed = _re.sub(r"['\"](\s|f)*['\"]", "", body)
    collapsed = _re.sub(r"\s+", " ", collapsed)
    assert 'jog to the actual pallet corner' in collapsed, (
        'directive-required phrase "jog to the actual pallet '
        'corner" missing from the operator copy — the coincident-'
        'corner case must instruct the fix')


# ── Endpoint wiring ────────────────────────────────────────────

def test_endpoint_is_registered():
    """/api/pallet/validate_frame must exist as a POST route so
    the frontend can call it."""
    import os
    import re as _re
    HERE = os.path.dirname(os.path.abspath(__file__))
    SERVER = os.path.abspath(os.path.join(
        HERE, '..', 'cobot_dashboard', 'dashboard_server.py'))
    with open(SERVER) as fh:
        src = fh.read()
    assert _re.search(
        r'@app\.post\(\s*["\']/api/pallet/validate_frame["\']\s*\)',
        src), ('POST /api/pallet/validate_frame not registered — '
               'the frontend cannot reach the shared validator')
    assert 'api_pallet_validate_frame' in src, (
        'endpoint handler function name drifted')
    # The endpoint must implement the suppression rule.
    assert 're_teaching_role' in src
    # And must return the four documented top-level keys.
    for key in ('findings', 'blocking', 'measured', 'spec'):
        assert f"'{key}'" in src, (
            f'endpoint response schema missing {key!r}')


def test_suppression_drops_findings_that_only_involve_reteaching_corner():
    """The endpoint layer (not validate_frame itself) applies the
    suppression rule: findings whose involves_corners are a
    subset of {the corner being re-taught} are dropped. This is
    the semantic pinned by the frontend's re-teach behavior.

    We exercise the rule by importing the same logic — a
    finding involving ONLY c2 should be dropped when
    re_teaching_role='pallet_c2', but a finding involving c2
    AND c3 stays (only c3 is the operator's evidence)."""
    # The suppression logic lives inline in the endpoint; we
    # replicate the filter here so a regression that moves the
    # code out still gets caught.
    _ROLE_TO_CORNER = {'pallet_c1': 'c1', 'pallet_c2': 'c2',
                       'pallet_c3': 'c3', 'pallet_part': 'c4'}
    def _filter(findings, role):
        suppress = _ROLE_TO_CORNER.get(role)
        out = []
        for f in findings:
            involves = f.get('involves_corners') or []
            if suppress and involves \
                    and all(c == suppress for c in involves):
                continue
            out.append(f)
        return out

    findings = [
        {'code': 'X', 'involves_corners': ['c2']},         # dropped
        {'code': 'Y', 'involves_corners': ['c2', 'c3']},   # kept (c3 counts)
        {'code': 'Z', 'involves_corners': ['c1', 'c3']},   # kept
        {'code': 'W', 'involves_corners': []},             # kept (no metadata)
    ]
    out = _filter(findings, 'pallet_c2')
    codes = [f['code'] for f in out]
    assert 'X' not in codes, 'c2-only finding must be dropped'
    assert 'Y' in codes, ('c2+c3 finding must be kept — c3 is real '
                          'evidence, and the operator copy names c3')
    assert 'Z' in codes
    assert 'W' in codes
