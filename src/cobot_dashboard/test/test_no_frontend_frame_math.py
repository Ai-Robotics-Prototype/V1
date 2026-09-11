"""No frontend pallet-frame geometry (§465 fork-1 lint, 2026-08-04).

Enforces the post-2026-08-04 architecture: pallet-frame geometry
runs ONLY on the backend via `POST /api/pallet/validate_frame`
→ `pallet_geometry.compute_frame / validate_frame`. Any frontend
code that computes row/col vectors, plane normals, tilt from
raw corner_*_tcp coordinates is a fork and this test refuses it.

Why: `frontend/src/lib/palletTeachSequence.js::validatePalletFrame`
was such a fork through 2026-08-04. It skipped the v1→v2 migration
(so v1-shape programs silently passed), computed tilt from raw
Z instead of the Gram-Schmidt plane normal, and fired as a
passive banner mid-re-teach against half-updated state — the
report class that motivated §465 fork-1.

If this test fails: move the math to `pallet_geometry` and call
the shared endpoint from the frontend via
`palletFrameValidator.js`. The one allowed frontend touch on
corner poses is passing them through to the endpoint verbatim.
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
FRONTEND_SRC = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src'))

# Files exempt from the ban — the async client (which passes
# corner_*_tcp through to the endpoint but does NO math) and this
# test file itself when it lands anywhere frontend-adjacent.
_EXEMPT_BASENAMES = frozenset({
    'palletFrameValidator.js',
    'palletFrameValidator.test.js',
})

# Legal touches on corner_*_tcp fields — pass-through only:
#   place.corner1_tcp | corner_1_tcp | corner1_tcp: [x, y, z...]  in setters
#   fields[k] = [...tcp]                       in ProgramEditor's write
# Any math with these coordinates is banned.


def _is_exempt(path: str) -> bool:
    return os.path.basename(path) in _EXEMPT_BASENAMES


def _iter_frontend_js():
    for root, _dirs, files in os.walk(FRONTEND_SRC):
        for name in files:
            if not (name.endswith('.js') or name.endswith('.jsx')):
                continue
            path = os.path.join(root, name)
            if '/node_modules/' in path or '/dist/' in path:
                continue
            yield path


def test_no_validatePalletFrame_export_or_use():
    """The retired local function must not reappear. Test files
    are exempt because they may reference the retired name in
    NEGATIVE assertions (a regex string in a pinned test that
    verifies the fork is gone)."""
    hits = []
    for path in _iter_frontend_js():
        if _is_exempt(path):
            continue
        # Test files may cite the retired name inside a regex
        # inside an assert to prove it's absent from production.
        if path.endswith('.test.js') or path.endswith('.pinned.test.js'):
            continue
        with open(path) as fh:
            src = fh.read()
        if re.search(r'\bvalidatePalletFrame\s*\(', src):
            hits.append(path)
    assert not hits, (
        f'validatePalletFrame() call reintroduced in {hits} — that '
        f'function was retired in the §465 fork-1 kill. Use '
        f'palletFrameValidator.validatePalletFrameServer instead.')


def test_no_frontend_cross_product_on_pallet_corners():
    """Cross product on corner_*_tcp coordinates is plane-normal
    computation — plane normal is a backend responsibility (see
    pallet_geometry.compute_frame). If frontend code calls cross()
    or its inline equivalent NEAR a corner_*_tcp reference, that's
    the fork returning."""
    # Very loose pattern — any use of `corner1_tcp` / `corner2_tcp` /
    # `corner3_tcp` / `corner_a_tcp` / `point_b_tcp` / `point_c_tcp` /
    # `part_tcp` within 400 chars of a math operation on axis
    # indices (`[0]-`, `[1]-`, `[2]-`) is banned.
    hits = []
    for path in _iter_frontend_js():
        if _is_exempt(path):
            continue
        with open(path) as fh:
            src = fh.read()
        # Find corner references, then look for axis-index math nearby.
        for m in re.finditer(
                r'(corner[123]_tcp|corner_a_tcp|point_[bc]_tcp|part_tcp)',
                src):
            window = src[max(0, m.start() - 400): m.end() + 400]
            # Bail if the surrounding context is clearly a config
            # write (a[0] destructure, or `= [...tcp]` spread copy).
            if re.search(r'\[\.\.\.[a-zA-Z_]+\]', window):
                continue
            # Axis arithmetic near a corner ref → likely frame math.
            if re.search(r'\[\s*0\s*\]\s*[\-\+\*]\s*[a-zA-Z_(]', window) \
                    and re.search(r'\[\s*1\s*\]\s*[\-\+\*]\s*[a-zA-Z_(]', window):
                hits.append((path, window[:80].replace('\n', ' ')))
                break
    assert not hits, (
        f'Axis arithmetic on pallet corner coordinates in {hits} — '
        f'frame math must run on the backend. Post the corners to '
        f'POST /api/pallet/validate_frame instead.')


def test_no_gram_schmidt_or_plane_normal_in_frontend():
    """The specific patterns the backend implements — Gram-Schmidt
    row/col orthogonalization and plane_normal — must NOT appear
    in the frontend NEAR pallet corner references. Files that
    don't touch pallet corner fields at all are exempt: this
    lint targets the fork specifically, not general geometry
    (orient.js / IKGizmo.jsx do wrist / IK math with acos+dot
    that has nothing to do with pallet frames)."""
    banned = [
        r'plane_normal',
        # Row-col angle via acos(dot(...)) is the exact fork we killed.
        r'Math\.acos\s*\(.*dot',
        # Explicit "tilt" math on raw Z (the fork's tilt check).
        r'Math\.abs\s*\(\s*row\s*\[\s*2\s*\]\s*\)\s*/\s*rowLen',
        r'Math\.abs\s*\(\s*col\s*\[\s*2\s*\]\s*\)\s*/\s*colLen',
    ]
    # Pallet-context sentinel: file must reference any of the
    # corner_*_tcp fields for its geometry patterns to be
    # considered part of the fork surface.
    pallet_context = re.compile(
        r'corner[123]_tcp|corner_a_tcp|point_[bc]_tcp|part_tcp')
    hits = []
    for path in _iter_frontend_js():
        if _is_exempt(path):
            continue
        # Test files can cite banned patterns in a regex string
        # inside a negative assertion.
        if path.endswith('.test.js') or path.endswith('.pinned.test.js'):
            continue
        with open(path) as fh:
            src = fh.read()
        # Strip block + line comments so a doc string mentioning
        # "Gram-Schmidt" doesn't false-positive.
        src_no_comments = re.sub(r'/\*.*?\*/', '', src, flags=re.DOTALL)
        src_no_comments = re.sub(r'//[^\n]*', '', src_no_comments)
        if not pallet_context.search(src_no_comments):
            continue   # not a pallet-frame file
        for pattern in banned:
            if re.search(pattern, src_no_comments, re.IGNORECASE):
                hits.append((path, pattern))
                break
    assert not hits, (
        f'Frontend contains banned frame-geometry pattern(s) NEAR '
        f'pallet corner references in {hits} — move the math to '
        f'pallet_geometry and read through POST '
        f'/api/pallet/validate_frame.')


def test_no_passive_frame_warning_banner():
    """The `pallet-frame-warning` data-testid marked the passive
    banner that fired mid-re-teach. It must be gone; findings
    now surface as toasts at Record + teach-complete only."""
    hits = []
    for path in _iter_frontend_js():
        if _is_exempt(path):
            continue
        # Test files may still reference the retired testid in a
        # negative assertion — skip them.
        if path.endswith('.test.js'):
            continue
        with open(path) as fh:
            src = fh.read()
        if 'data-testid="pallet-frame-warning"' in src:
            hits.append(path)
    assert not hits, (
        f'Passive pallet-frame-warning banner still rendered in '
        f'{hits} — findings must surface only via toasts at Record '
        f'and at teach-complete, never as a passive overlay.')
