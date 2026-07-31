# Program Doctrine

The operator's standing requirements for programs, teaching, and step
rendering — captured as numbered rules. Every future directive that
touches program generation, teaching, or step rendering runs the
doctrine test suite before deploy. The suite (`tests/doctrine/`) is
the working definition of "consistent with the operator's
requirements".

**Status:** draft — operator reviews and amends. These are HIS rules.

**Enforcement:** `scripts/deploy.sh` runs `node --test tests/doctrine/`
before the build gate. A doctrine failure blocks deploy and names its
rule number in the message: `DOCTRINE Dx VIOLATED: <detail>`.

---

## Rules

**D1. Derived steps stay derived — teach the source, never the shadow.**
Contacts are taught. Approaches, retreats, descends, and lifts are
DERIVED from a taught source + Z offset. Derived steps never appear
in a Teach itinerary and never render a taught-badge on their row.
Overriding a derived step (`overridden: true`) promotes it to a
first-class teachable pose and its badge follows the source-of-truth
rules for pose-bearing steps.

**D2. Station columns emit movL, every profile.**
The approach→contact→retreat trio at a station emits linear motion
(`movL`) across every motion profile (Conservative, Balanced,
Aggressive, custom). Transits between stations emit `movJ` unless
explicitly overridden. Any deviation must be logged as an analyzer
adaptation with the reason printed alongside the affected step.

**D3. Shown verb == emitted verb, or the divergence is displayed.**
The verb shown on a step row (`verbForStep`) must match the verb the
codegen actually emitted. When they diverge — approach forced to
`movJ` under wrist lock, an analyzer swap, a wire-verified
substitution — the row surfaces both plus the reason in
operator-facing copy. A shown verb that doesn't match the emitted
verb without explanation is a lie.

**D4. Teachability is a positive list, shared.**
`isTeachable(step, program)` is the single predicate for "does this
step take a taught pose?" Every consumer — Teach All itinerary,
debt banner, row badges, Teach buttons, position-source collection
— routes through it. Adding a new step verb means adding it to
`TEACHABLE_ACTIONS` (or leaving it out) in `lib/programTruth.js`
once, not touching six components.

**D5. One vocabulary, one resolver, one teach surface.**
Effector + machine verbs live in `lib/effectorVocab.js` and
`lib/machineVocab.js`. Taught-state truth lives in
`lib/programTruth.js`. Each teachable capability has ONE teach
surface (the row's Teach button + the diagram-guided pallet flow —
not "a modal that also teaches"). Duplicate vocabularies or forked
resolvers get caught by `scripts/no-fork-truth.mjs` at build time.

**D6. Loop bodies have two predecessors.**
The first step inside a loop body has two immediate predecessors:
the setup step BEFORE the loop, and the loop's own back-edge (from
the LAST body step). Every previous-step rule the analyzer or
codegen evaluates — modal-state inheritance, blend continuity,
speed carryover — must consider BOTH predecessors, not just the
lexical one.

**D7. Modal state is set before use and cleared at exact-stop.**
Blend (`setBlender`/`setNoBlender`), speed (`setSpeedL`,
`setSpeedJ`), and acceleration modes are set at the top of any
sequence that uses them and cleared at exact-stop contexts (every
CONTACT step, every station arrival, program end). Modal state is
never inherited across an exact-stop boundary — the operator's
model is "each contact is a fresh sequence".

**D8. Taught wrists must agree; disagreement flagged at teach time.**
Within a single program, taught wrist orientations at semantically
equivalent poses (all picks, all places, the two homes) should
agree. Disagreement is surfaced during teaching via the Match
dial-to-green targets (Joint mode's target overlay), not discovered
at runtime as a joint-limit alarm. The Match feature is the
promise; runtime failure is the promise broken.

**D9. Every generated program carries its stamps.**
Codegen output ends with a footer block naming (a) the codegen
module SHA (`codegen_sha: <12hex>`), (b) the linter result
(`lint: OK` or `lint: <violation>`), and (c) every analyzer
adaptation with its rule ID and reason. A program without its
stamps is not shippable — the header is the audit trail.

**D10. The screen never asserts state it can't read.**
Live status must be observable to render as fact. When we can't
read the true value — controller preset unreadable, drag-mode
observability pending bench verification, the operator's cabinet
key position — the copy names the limitation
("controller preset not readable — verify at Factory UI") rather
than inventing an assertion the app can't back with a wire read.

---

## Proposed additions (operator review)

Sweep of `docs/`, `CLAUDE.md`, `PROJECT.md`, `PART_2C_ARCHITECTURE.md`,
and `lib/programTruth.js` surfaced these candidate rules. Operator to
accept, merge into D1–D10, or reject.

**D11 (candidate). Wire-verified verbs only.**
Codegen never emits a verb that hasn't been observed on the wire.
Verbs classed SOURCE-ONLY (mined from factory UI capture but
unproven) are blocked by the pre-emit linter until lifted to
VALIDATED. Motivation: `setPayload("")` argument format —
present in the factory UI, not yet wire-verified, so no emission.
_(Source: `program_ops.py` linter, `docs/oem_takeover_roadmap.md`.)_
_(Possibly folds into D9's "lint: OK" contract.)_

**D12 (candidate). `waitCondition` requires a runtime expression.**
The condition slot in `waitCondition(<expr>, N)` must be a
runtime-evaluable expression (e.g. `getDI(port)==expect`), never a
bare literal `false` / `true` / `nil`. Firmware v2.3 rejects the
literal form with alarm 10006 despite the factory UI documentation
claiming otherwise. Discovered live; now caught pre-emit.
_(Source: `docs/estun_lua_reference.md`, program_ops linter.)_

**D13 (candidate). Error dedup by (code, unix_ts).**
`publish/Error` fires at 3 Hz keepalive. Only the first
`(code, unix_ts)` tuple is a new event; identical reflood is
noise. UI + status pipeline must dedup so the operator sees one
alarm, not 100. _(Source: `PART_2C_ARCHITECTURE.md` §4.)_
_(May belong in a separate "Telemetry Doctrine" — flagged for
scope check.)_

**D14 (candidate). Named-point library is the codegen pose source.**
Taught_joints on a step is display/debug only. Codegen resolves
motion to controller-side `varspoint` named entries (p1, p2, …).
Any codegen path that emits raw joint arrays instead of a named
point is a bug. _(Source: `PART_2C_ARCHITECTURE.md` §2.3.)_
_(Possibly folds into D5's "one resolver" — depends on how the
operator wants the surface enforced.)_

**D15 (candidate). Station-column cardinality.**
An approach→contact→retreat column has strict cardinality: exactly
one arrival, one in-contact, one departure. When the analyzer's
awkward-wrist adaptation forces a `movJ` on the departure, the row
must carry an `ADAPTED` tag with the reason. _(Source:
`ui_truth_audit.md` #P2-1, `program_ops.py` column-arrival logic.)_
_(Refinement of D2. Merge or keep separate is the operator's
call.)_

**D16 (meta). Build-time anti-fork gate.**
`scripts/no-fork-truth.mjs` is a hard gate: any component under
`src/components/` or `src/pages/` that references shared-truth
tokens (`taught_joints`, `move_linear`, etc.) MUST import from the
shared resolver. New guards added when a new resolver appears; the
suite catches drift at build. _(Meta-rule about how D4/D5 are
enforced. Include or move to an "Enforcement" section.)_

---

## Suite coverage

One test file per rule under `tests/doctrine/`. Naming:
`D<N>_<slug>.test.js`. Every failing assertion prefixes the rule
number:

```
DOCTRINE D1 VIOLATED: derived step 'Retreat above pick' in teach itinerary for reference program 'palletize'
```

| Rule | Test file | Coverage |
|---|---|---|
| D1 | D1_derived_never_taught.test.js | Compose reference templates (P&P, pallet, tending, PBD); assert no derived step appears in `computeTeachingDebt.stepIds` or `untaughtStepIds`; source-level: row's taught-badge visibility gates on `isTeachable(step, program)`. |
| D2 | D2_station_movL.test.js | Assert `verbForStep` reports `movL` for approach + contact + retreat rows across the four profile fixtures. Codegen snapshot compare when reference Lua is available. |
| D3 | D3_shown_equals_emitted.test.js | `verbForStep` returns `{ verb, expected }`. When `expected: false` (emitted-verbs table present), the shown verb equals the emitted verb. When `expected: true`, the row surfaces the "expected only" caveat. |
| D4 | D4_teachable_positive_list.test.js | Every consumer (row, itinerary, debt, badge) imports `isTeachable` from `lib/programTruth`. No local `TEACHABLE_ACTIONS` list survives. |
| D5 | D5_single_vocab_and_resolver.test.js | `scripts/no-fork-truth.mjs` clean. Each resolver module has ≤1 export per capability name. No duplicate `effectorVocab` labels. |
| D6 | D6_loop_two_predecessors.test.js | For a synthesized loop program: rules that read "previous step" enumerate BOTH lexical prev AND loop back-edge. (Phase 1: pin the classification table; deeper analyzer coverage in phase 2.) |
| D7 | D7_modal_cleared_at_exact_stop.test.js | Read reference generated Lua; assert `setNoBlender` (or profile-equivalent) precedes every contact and appears at program end. |
| D8 | D8_wrist_agreement.test.js | For a program with two "pick" contacts, taught wrists must be within ε on each joint. Failure prints the joint deltas. (Phase 1: pin the resolver + Match UI presence; live check phase 2.) |
| D9 | D9_program_stamps.test.js | Generated Lua footer contains `codegen_sha`, `lint:`, and adaptation-reason lines. Regex-check against reference outputs. |
| D10 | D10_no_unread_state_asserted.test.js | Sweep source for language patterns that imply sync/read where none exists (`syncs to`, `auto-updates`, "controller preset: X kg" without a wire-read). |

Rules D8 and D6 lean on live data; phase 1 coverage is source-level.
Phase 2 adds live composition + Lua compare (see `TODO` markers in
each file).

## Process

`CONTRIBUTING.md` records the rule: any change touching program
generation, teaching, or step rendering runs `bash
scripts/run_doctrine_suite.sh` before deploy. `scripts/deploy.sh`
invokes the same script — no manual bypass.

Doctrine failures are named by rule number so the fix path is
unambiguous.
