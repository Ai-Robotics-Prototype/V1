"""Delete-integrity pinned regression (2026-09-04).

Directive:
  1. Deleting a program in the UI must delete it EVERYWHERE — main
     .json + every sidecar (currently just <id>.line_map.json). No
     visible-list-only removal.
  2. Deleted programs move to /opt/cobot/programs/.deleted/<id>.<ts>.
     <suffix> before unlinking — taught poses are hours of operator
     labor and one wrong tap must not vaporise them permanently.
  3. .deleted is capped at 20 most-recent entries; pruning is grouped
     by <id>.<ts> so sidecars share the fate of their main.
  4. If the deleted id is the CONTROLLER-RESIDENT program, the
     dashboard's mirror is cleared and a named refusal
     (outcome.kind='resident_deleted', 410 Gone) fires on any
     subsequent /api/estun/program/run against that id — no ghost run.
  5. Frontend confirm dialog names the program and states the disk
     removal + resident-on-controller case.
  6. Every /api/programs listdir sweep skips .deleted (dotfolder is
     already filtered by endswith('.json'); the dot-prefix guard is
     defence-in-depth for future dotfolders).

These tests are source-string checks (matching test_load_pushes_to_
controller.py's pattern) because dashboard_server hardcodes
_PROG_DIR inside create_app, and rebuilding the app hermetically
would need surgery outside the scope of this fix. The behavioural
proof is the headless curl verification against the live dashboard,
reported separately.
"""

from __future__ import annotations

import os


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(
    HERE, '..', 'cobot_dashboard', 'dashboard_server.py'))
LIBRARY = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'pages', 'ProgramLibrary.jsx'))


def _read(path: str) -> str:
    with open(path) as fh:
        return fh.read()


def test_trash_dir_and_cap_declared():
    """The safeguard folder + cap constants exist so the delete path
    has a single source of truth for both."""
    src = _read(SERVER)
    assert "_PROG_TRASH_DIR = os.path.join(_PROG_DIR, '.deleted')" in src
    assert '_PROG_TRASH_CAP = 20' in src


def test_trash_helper_moves_main_and_sidecars():
    """`_trash_program` handles the main .json AND every entry in
    `_prog_sidecar_paths`. Rename (not copy+unlink) so the delete is
    atomic on same-filesystem moves; the original is consumed."""
    src = _read(SERVER)
    assert 'def _prog_sidecar_paths(prog_id: str) -> list:' in src
    assert "f'{prog_id}.line_map.json'" in src
    assert 'def _trash_program(prog_id: str) -> dict:' in src
    # Rename (not copy + unlink) so the move is atomic on same-fs.
    assert 'os.rename(main, trash_main)' in src
    assert 'os.rename(sc, dest)' in src


def test_trash_pruning_caps_at_20_and_culls_sidecar_prefix():
    """`_prune_prog_trash` keeps the 20 most-recent MAIN entries;
    every file that shares the pruned main's `<id>.<ts>.` prefix is
    culled with it so no orphan sidecars accumulate in .deleted."""
    src = _read(SERVER)
    assert 'def _prune_prog_trash():' in src
    assert 'entries.sort(reverse=True)' in src
    assert 'entries[_PROG_TRASH_CAP:]' in src
    assert "prefix = fn[:-len('.json')] + '.'" in src


def test_delete_endpoint_uses_trash_and_clears_resident_mirror():
    """The DELETE route routes through `_trash_program` (no direct
    os.remove) and, when the deleted id is the controller-resident
    one, clears `resident_program_id` + records `deleted_resident_id`
    under the state lock."""
    src = _read(SERVER)
    # Locate the DELETE handler and slice its body.
    marker = '@app.delete("/api/programs/{prog_id}")'
    i = src.find(marker)
    assert i >= 0, 'delete endpoint moved'
    # Slice enough of the handler to cover the response block (the
    # `was_resident` line lands past the 2500-char mark once the
    # trash-summary lines are in).
    body = src[i:i + 4000]
    assert 'trash = _trash_program(prog_id)' in body
    # No direct os.remove of the main .json in the delete handler.
    assert 'os.remove(path)' not in body, \
        'delete must route through _trash_program, not os.remove'
    assert 'was_resident = (pg.get("resident_program_id") == prog_id)' in body
    assert 'pg["deleted_resident_id"] = prog_id' in body
    assert 'pg["resident_program_id"] = None' in body
    # Response surfaces the trash summary + resident flag for the UI.
    assert '"was_resident": was_resident' in body


def test_run_gate_named_refusal_for_deleted_resident():
    """`POST /api/estun/program/run` refuses with the NAMED outcome
    'resident_deleted' (410 Gone) when the requested prog_id was
    just deleted-and-was-resident. Generic 404 is reserved for
    'never existed' — the delete case is meaningfully different."""
    src = _read(SERVER)
    assert '"kind":        "resident_deleted"' in src
    assert '"reason_code": "resident_program_deleted"' in src
    assert 'status_code=410' in src
    # The gate keys off the same STATE mirror the delete handler set.
    assert 'deleted_resident_id = pg.get("deleted_resident_id")' in src


def test_listdir_sweeps_skip_dotfolders():
    """Every listdir(_PROG_DIR) sweep skips both underscore- and
    dot-prefixed entries so .deleted (and any future dotfolder) is
    invisible to program listing, folder unassign, cell counts, and
    cell-programs list."""
    src = _read(SERVER)
    # Four sweeps; all four now guard startswith(('_', '.')).
    hits = src.count("startswith(('_', '.'))")
    assert hits >= 4, f'expected >=4 dot-guarded sweeps, found {hits}'


def test_frontend_confirm_names_program_and_disk_removal():
    """The library's Delete confirm dialog must name the program AND
    state the disk removal + .deleted safeguard. Resident-on-
    controller case must add the controller-keeps-its-copy line so
    the operator is not surprised."""
    src = _read(LIBRARY)
    # Row lookup so we can name the program.
    assert "const row = (programs || []).find((p) => p.id === progId)" in src
    # Resident mirror wired from the store.
    assert "residentProgramId = useStore" in src
    # Two branches with the load-bearing phrases.
    assert '.deleted safeguard' in src
    assert 'controller keeps its resident' in src


def test_frontend_clears_current_program_when_deleting_itself():
    """If the deleted id equals the editor's currentProgram.id, the
    frontend resets currentProgram — otherwise the editor tab keeps
    showing a ghost that Save/Push would either re-create or 404
    against."""
    src = _read(LIBRARY)
    assert "if (currentProgramId && currentProgramId === progId)" in src
    assert "setCurrentProgram({" in src
    assert "id: null, name: 'Untitled Program'" in src
