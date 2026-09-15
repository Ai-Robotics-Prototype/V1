"""REUSE-UX PINS — 2026-09-15.

Pin the operator's directive on taught-position reuse:
  (a) reuse offered only-when-exists — never blind, never auto-applied
  (b) reuse copies the exact stored pose (no rounding / re-fetch)
  (c) teach-now overwrites (default action stays 'Teach now')
  (d) reused entries in the Review summary carry a timestamp / origin
  (e) global home (from /opt/cobot/home.json via GET /api/robot/home)
      is offered as a reuse source when no local taught_home exists.

These are text-scan pins over ProgramWizard.jsx + dashboard_server.py
so they run without a browser. If any rendering path drifts the copy
or removes the reuse-choice screen, the pin catches it.
"""

import os
import re


REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
WZ   = os.path.join(REPO, 'src/cobot_dashboard/frontend/src/components/ProgramWizard.jsx')
DASH = os.path.join(REPO, 'src/cobot_dashboard/cobot_dashboard/dashboard_server.py')


def _read(path):
    with open(path, 'r') as f:
        return f.read()


def test_reuse_choice_screen_present():
    """The reuse-choice screen exists and is gated on
    `alreadyRecordedHere && !forceTeach[posIdx]` — i.e. only offered
    when a stored value for THIS key exists.
    """
    src = _read(WZ)
    assert 'showChoiceScreen' in src, 'reuse-choice gate variable missing'
    assert 'alreadyRecordedHere && !forceTeach' in src, (
        'reuse-choice must gate on both an existing value AND the '
        'operator not having chosen Re-teach for this step')
    assert 'Reuse This Position' in src, 'reuse button copy missing'
    assert 'Re-teach' in src, 're-teach button copy missing'


def test_reuse_copies_pose_without_mutation():
    """`reuseCurrent()` must NOT rewrite the answer — it just marks the
    step reused and advances. Pose stays byte-identical to what was
    already stored under the shared key.
    """
    src = _read(WZ)
    idx = src.find('function reuseCurrent()')
    assert idx != -1, 'reuseCurrent function missing'
    body = src[idx:src.find('function ', idx + 30)]
    assert 'advanceOrComplete()' in body, 'reuseCurrent must advance'
    assert 'setAnswer(' not in body, (
        'reuseCurrent must not call setAnswer — reuse copies the exact '
        'stored pose by NOT rewriting it')


def test_review_summary_marks_reused_with_origin():
    """The Positions Taught card labels reused entries with either
    the earlier step that taught the shared key OR the taught_at date
    (or 'saved home position' for globally-seeded home). Bare 'reused'
    is only used when no origin is derivable.
    """
    src = _read(WZ)
    assert 'reused from' in src or 'saved home position' in src, (
        'reused entries must be labelled with an origin (date or '
        'source) per operator directive')
    assert '↻' in src, 'reused symbol (↻) missing from review card'


def test_reuse_choice_screen_shows_taught_at():
    """Reuse-choice screen must show when the position was taught (or
    that it came from the saved global home) so the operator can make
    an informed choice — never blind.
    """
    src = _read(WZ)
    # The choice screen block computes a `when` label from
    # existingForCurrent.taught_at and renders one of these copies.
    assert 'From your saved home position' in src, (
        'reuse-choice screen must name the global-home origin')
    assert 'Taught earlier in this setup' in src, (
        'reuse-choice screen must show the local-taught origin')
    assert 'toLocaleString' in src, (
        'reuse-choice screen must render taught_at as human-readable date')


def test_global_home_seeded_only_when_local_absent():
    """The TeachSequence mount-effect that fetches /api/robot/home
    must skip the seed when a local taught_home already exists — never
    overwrite operator work.
    """
    src = _read(WZ)
    m = re.search(
        r"const th = answers\?\.taught_home[\s\S]*?"
        r"const alreadyTaughtLocally[\s\S]*?"
        r"if \(alreadyTaughtLocally\) return",
        src)
    assert m, (
        'global-home mount-effect must gate on !alreadyTaughtLocally '
        'so it never overwrites a local teach')
    # The seed must mark source='global' so the review + reuse-choice
    # can render the correct origin copy.
    assert "source:    'global'" in src, (
        "global-home seed must set source='global' so the reuse UI "
        "renders 'From your saved home position' instead of a date")


def test_backend_home_get_endpoint_present():
    """GET /api/robot/home returns the stored home pose or
    {present:false}. Fed to the wizard's reuse-seeding effect.
    """
    src = _read(DASH)
    assert '@app.get("/api/robot/home")' in src, (
        'GET /api/robot/home endpoint missing — wizard reuse offer '
        'cannot fetch the program-independent global home')
    assert 'def api_robot_home_get' in src, (
        'GET handler function name drifted')
    # The response payload must carry joints + tcp + taught_at + source
    # so the wizard can seed answers.taught_home in the same shape it
    # would use for a local teach.
    assert '"joints"' in src and '"tcp"' in src
    assert '"taught_at"' in src
    assert '"source"' in src
