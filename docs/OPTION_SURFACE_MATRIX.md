# Option-surface matrix (§464) — directed design

**Status**: directed, unbuilt (design doc only, no CI wiring yet).
**Owner**: to assign.
**Motivated by**: firmware bug #3 (2026-08-03/04, three
holepartpalletize kills). The D14 pending-pose gate and mov*
arity D-rule (commits `60790e8` + `83f9472`) block the specific
signature that got past validation, but the matrix below is the
audit that would have caught that class of gap earlier — and
will catch the next class before it lands in production.

---

## What it is

A schema-introspected **step-type × editable-field × value**
matrix. For every step type authorable in the Program Editor,
enumerate every editable field, feed each field representative
values (valid, boundary, invalid), and run each combination
through the full pipeline:

```
program dict
  → validate (has_taught_poses, check_program_pending_poses,
    step-shape guards)
  → save (POST /api/programs, disk write, revs bump)
  → regenerate (codegen_lua_from_program)
  → lint (lint_lua_source against luaenginelib.json + D-rules)
  → byte-verify shape (varspoint arity, Lua CRLF, footer stamp)
```

Every combination is scored:
- **PASS** — the pipeline accepts and the emission is well-formed.
- **REJECT-AT-VALIDATE** — check_program_pending_poses or a
  guard fires. Expected for invalid values.
- **REJECT-AT-CODEGEN** — codegen refuses (AssertionError,
  raise). Expected for boundary shapes.
- **REJECT-AT-LINT** — one of the D-rules or per-verb matchers
  fires. Expected for malformed shapes.
- **CRASH** — codegen raised an unexpected exception, dashboard
  500, or the Lua contains a shape the lint gate lets through
  that a manual audit says is bad.
- **DEAD** — the field is authorable in the Editor but codegen
  drops it (no wire emission, no comment). Silent no-op.
- **UNGUARDED-COMBO** — two fields that are individually valid
  combine into a wire-crashing shape. Bug #3 was this class.

---

## Scope (v1, minimum viable matrix)

### Step-type registry

The frontend's authoritative registry is
`frontend/src/components/ProgramEditor.jsx:32-56` (search
`STEP_TYPES`). At v1 the matrix covers these action types:

| action              | fields (authorable)                              |
| ------------------- | ------------------------------------------------ |
| `move_home`         | (none — home reference)                          |
| `move_joint`        | `joints`, `speed_pct`                            |
| `move_linear`       | `position`, `offset_z_mm`, `speed_pct`, `derived_from` |
| `move_to_position`  | `point_name`                                     |
| `move_to_pallet`    | (config-driven; pallet layout in program.config) |
| `pick`              | `descend_mm`                                     |
| `place`             | (derived-from)                                   |
| `open_gripper`      | `width_mm`, `speed_pct`, `io_open`, `io_open_confirm` |
| `close_gripper`     | `force_pct`, `io_close`, `io_close_confirm`     |
| `set_io`            | `io_id`, `value`                                 |
| `wait`              | `duration_s`, `wait_condition`, `timeout_s`      |
| `loop`              | `goto`, `count`                                  |
| `detect`            | `target_part`                                    |
| `scan_workspace`    | (config-driven)                                  |

### Value classes per field

For each field, three value classes:

- **valid canonical** — an example the operator would author.
- **boundary** — the extreme of the allowed range (e.g. 0 mm,
  360 deg, 100%, 1 ms).
- **invalid** — deliberately out-of-range or wrong type.

Example (`wait.duration_s`):

| class     | value  | expected result             |
| --------- | ------ | --------------------------- |
| canonical | 1.0    | PASS → `wait(1000)`         |
| boundary  | 0.0    | REJECT-AT-CODEGEN (wait(0)) |
| boundary  | 3600   | PASS (upper limit)          |
| invalid   | -1     | REJECT-AT-VALIDATE          |
| invalid   | "abc"  | REJECT-AT-VALIDATE          |

---

## Introspection design

The matrix is **generated**, not written by hand. Three sources
of truth (already exist in the repo):

1. **Frontend step registry** — `ProgramEditor.jsx:STEP_TYPES`
   ships `{value, label, type, fields[]}` per step. Convert
   this to a Python-side dict at test time by parsing the JSX
   (a 20-line grep + regex extract; the shape is stable).
2. **Backend program schema** — the program dict shape lives in
   `src/programming_by_demonstration/programming_by_demonstration/schema.py`.
   Field-level validators (`_validate_step`, `_valid_joints`)
   are the authoritative allowed values.
3. **Codegen emission map** — `program_ops.codegen_lua_from_program`
   at `src/estun_driver/estun_driver/program_ops.py`. Every
   action-branch (~2900-4100) is the emit contract.

The generator walks (1) to enumerate steps × fields, walks (2)
for value classes, and feeds each combination through (3) plus
the dashboard endpoints. The output is a `matrix_report.json`
of `{step, field, value, expected, actual, passed}` rows.

---

## Test runner sketch

```python
# tests/matrix/option_surface_matrix.py — pseudocode

from estun_driver.program_ops import (
    codegen_lua_from_program,
    check_program_pending_poses,
    lint_lua_source,
)

STEP_TYPES = _parse_frontend_registry()   # jsx → dict
VALUE_CLASSES = _build_value_matrix()     # per-field classes

def one_row(step_type, field, value_class, value):
    program = _seed_program_with_step(step_type, {field: value})
    result = {'step': step_type, 'field': field,
              'class': value_class, 'value': value}
    # 1. validate
    pending = check_program_pending_poses(program)
    if pending:
        result['stage'] = 'validate'
        result['outcome'] = 'REJECT-AT-VALIDATE'
        return result
    # 2. save (uses a temp /opt/cobot/programs path)
    saved = _save_program_via_dashboard(program)
    if not saved.ok:
        result['stage'] = 'save'
        result['outcome'] = 'REJECT-AT-SAVE'
        return result
    # 3. regenerate
    try:
        lua, points, _pct = codegen_lua_from_program(saved.program)
    except AssertionError as e:
        result['stage'] = 'codegen'
        result['outcome'] = 'REJECT-AT-CODEGEN'
        result['reason'] = str(e)
        return result
    # 4. lint
    findings = lint_lua_source(lua)
    if findings:
        result['stage'] = 'lint'
        result['outcome'] = 'REJECT-AT-LINT'
        result['reason'] = findings[0]['reason']
        return result
    # 5. varspoint arity
    for name, entry in (points or {}).items():
        # (as codegen_lua_from_program's post-emit does)
        ...
    # 6. dead-option scan
    if value_class in ('invalid',) and value not in lua:
        # An invalid value that reached emit unchanged is DEAD.
        result['outcome'] = 'DEAD'
        return result
    result['outcome'] = 'PASS'
    return result

def run_matrix() -> list[dict]:
    rows = []
    for step, meta in STEP_TYPES.items():
        for field in meta['fields']:
            for cls, values in VALUE_CLASSES[field].items():
                for v in values:
                    rows.append(one_row(step, field, cls, v))
    return rows
```

Output triage buckets:

- `CRASH` and `UNGUARDED-COMBO` rows → open bug immediately.
- `DEAD` rows → either wire the option or hide it in the UI.
- Divergence between `class='canonical'` and PASS → likely a
  new regression in the gates.

---

## Not in v1

Deferred to a follow-up:

- **Multi-step programs** — v1 tests each step type in
  isolation. Multi-step interactions (adjacent movLs, pallet
  loops) are the next layer.
- **Config-driven state** — `pallet_place`, `motion_profile`,
  `gripper` config each have their own matrix; separate work.
- **Timing-dependent invariants** — jog deadman, WS reconnect,
  race conditions. Matrix is deterministic; race tests are a
  different tool (fault-injection).
- **CI wiring** — v1 runs by hand (`python3 -m
  cobot_dashboard.test.option_surface_matrix`) with a JSON
  report the developer eyeballs. CI integration (report ratchet
  to prevent regression, PR annotations) is a v2 story.

---

## Why "directed, unbuilt"

Building the full matrix is a multi-day effort and would
uncover more bugs than one session can triage. The right shape
is:

1. **Land this design doc** (this file) — commits an approach.
2. **Follow-up: build the generator** — one commit, no CI.
3. **Follow-up: triage the first run** — likely 5-20 findings.
   Each becomes its own bug commit.
4. **Follow-up: wire to CI** — after triage is stable, add a
   `pytest -m matrix` marker that runs the matrix on every PR
   touching `program_ops.py` / `ProgramEditor.jsx` /
   `dashboard_server.py`.

Land the design → prove the approach on 3-5 step types → then
wire it broadly. Skipping to full CI now means writing tests
against a moving target (bugs the matrix would find are STILL
in the code).

---

## Related work

- D14 pending-pose gate (`60790e8`) — the specific gap the
  matrix would have flagged as UNGUARDED-COMBO (untaught
  anchor + derived offset).
- Full-surface arg validators (this commit) — the per-verb
  matchers the matrix uses as its "lint" oracle.
- `PROGRAM_DOCTRINE.md` — the invariants the matrix's PASS
  bucket asserts against.
