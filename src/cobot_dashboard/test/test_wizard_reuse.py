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


def test_wizard_reader_falls_back_to_geometry_store_for_pallet_corners():
    """VALIDATOR FIX PIN — 2026-09-15.

    The Sep 15 field report: operator taught pallet corners via the
    editor's palletTeachRecord overlay, saved, and the app claimed
    pallet positions were "not taught". On disk teest.json had
    config.pallet.corner*_tcp populated (geometry authority the
    codegen uses) but config.taught_pallet_corner* absent (wizard-
    marker key the Review card checked). This validator/reader
    divergence let the UI claim "not fully taught" for a program
    whose geometry was fully present.

    Fix: readTaughtWithConfig(answers, config, key) falls back to
    config.pallet.corner*_tcp / part_tcp when the wizard-marker key
    is absent. Named PALLET_TAUGHT_KEY_TO_GEOMETRY_FIELD map pins
    the key → field routing.
    """
    src = _read(WZ)
    assert 'function readTaughtWithConfig' in src, (
        'widened validator missing — the reader must accept a config '
        'argument and fall back to config.pallet.corner*_tcp')
    assert 'PALLET_TAUGHT_KEY_TO_GEOMETRY_FIELD' in src, (
        'the wizard-marker → geometry-field mapping must be named so '
        'a future reshuffling surfaces here rather than silently '
        'reintroducing the divergence')
    # All four wizard-marker keys must route to their geometry field.
    # Allow any whitespace between the key and the value string.
    for k, f in (('taught_pallet_corner1', 'corner1_tcp'),
                 ('taught_pallet_corner2', 'corner2_tcp'),
                 ('taught_pallet_corner3', 'corner3_tcp'),
                 ('taught_pallet_part',    'part_tcp')):
        assert re.search(rf"\b{k}:\s+'{f}'", src), (
            f'{k} must fall back to {f} in the geometry store')
    # Review card call sites must use the widened reader.
    review_uses = src.count('readTaughtWithConfig(answers, _cfg, ')
    assert review_uses >= 4, (
        f'Review card must consult readTaughtWithConfig for all four '
        f'pallet keys; found {review_uses} call sites')


def test_editor_palletTeachRecord_mirrors_wizard_marker():
    """MIRROR-WRITE PIN — 2026-09-15.

    palletTeachRecord in ProgramEditor.jsx must write BOTH stores in
    one setCurrentProgram commit: (a) the geometry key
    (pallet_place[field] + pallet[field]) and (b) the wizard-marker
    key (taught_pallet_corner{1..3} / taught_pallet_part). Prior
    code wrote only (a), leaving the two stores divergent — see the
    Sep 15 field report on teest.json.

    Pins: the wizard-marker key map is present with all four roles,
    and the setCurrentProgram commit for both the corner (line ~5217)
    and the part-datum (line ~5246) paths spreads the mirror patch.
    """
    ED = os.path.join(REPO, 'src/cobot_dashboard/frontend/src/components/ProgramEditor.jsx')
    src = _read(ED)
    assert '_wizardMarkerKey' in src, 'mirror-write variable missing'
    for role_key in (
        "pallet_c1:   'taught_pallet_corner1'",
        "pallet_c2:   'taught_pallet_corner2'",
        "pallet_c3:   'taught_pallet_corner3'",
        "pallet_part: 'taught_pallet_part'",
    ):
        assert role_key in src, (
            f'{role_key.strip()} missing from the editor role→wizard-'
            f'marker map — mirror-write cannot fire for this role')
    # Both setCurrentProgram commits must spread the mirror patch.
    assert src.count('..._wizardMarkerPatch') >= 3, (
        'the mirror patch must be spread in every commit path '
        '(corner-record, part-record, and the merged advance object)')


def test_teest_json_reads_as_pallet_fully_taught():
    """REGRESSION PIN on the Sep 15 field program — verifies that a
    saved program with geometry authority in config.pallet.corner*_tcp
    is read as fully taught by the pallet-frame status check.

    Uses the exact shape teest.json holds on disk: config.pallet_place
    has all four corner_tcp fields populated with 6-elem arrays. The
    frontend's palletFrameStatus consumes config.pallet_place; a
    regression that renames the field or drops the v2 canonical read
    path surfaces here.
    """
    ED_TRUTH = os.path.join(REPO, 'src/cobot_dashboard/frontend/src/lib/programTruth.js')
    src = _read(ED_TRUTH)
    # The function must consult pallet_place.corner*_tcp (v2 canonical).
    assert 'place.corner1_tcp' in src
    assert 'place.corner2_tcp' in src
    assert 'place.corner3_tcp' in src
    assert 'place.part_tcp'    in src
    # allTaught boolean is what the editor's taughtCount collapses to
    # for the 4/4 banner.
    assert 'allTaught:' in src


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
