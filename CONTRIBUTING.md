# Contributing

Two hard process rules apply to every change that touches program
generation, teaching, or step rendering.

## 1. Program Doctrine gate

The operator's standing requirements live in `docs/PROGRAM_DOCTRINE.md`
as numbered rules (D1–D10, plus operator-approved additions). The
doctrine test suite in
`src/cobot_dashboard/frontend/tests/doctrine/D<N>_*.test.js` is the
working definition of "consistent with the operator's requirements".

Before deploying any change that touches:

- program generation (`estun_driver/program_ops.py`, PBD composer,
  wizard emit paths),
- teaching (row Teach buttons, teach overlays, itinerary builders,
  the `programTruth` / `palletTeachSequence` / `teachingDebt`
  resolvers),
- step rendering (`ProgramEditor.jsx`, `PalletFrameDiagram.jsx`,
  `SelfCollisionWarnBanner.jsx`, badges, chips, banners),

run:

```
bash scripts/run_doctrine_suite.sh
```

`scripts/deploy.sh` invokes the same script as its first gate — no
manual bypass. A doctrine failure names its rule number in the
output (`DOCTRINE Dx VIOLATED: <detail>`); either fix the underlying
code or amend the rule (rule changes require operator approval — the
doctrine is HIS).

## 2. Anti-fork gate

`scripts/no-fork-truth.mjs` is a lint gate: any component under
`src/cobot_dashboard/frontend/src/components/` or `.../pages/` that
references shared-truth tokens (`taught_joints`, `move_linear`,
`emittedLine`, etc.) MUST import from the shared resolver
(`lib/programTruth.js`) or a designated sibling (`lib/effectorVocab.js`,
`lib/machineVocab.test.js` fixtures, etc.).

Running:

```
node src/cobot_dashboard/frontend/scripts/no-fork-truth.mjs
```

Called by `npm run lint` and thus by the deploy gate.

## What "touches teaching" means in practice

If your change adds/removes:

- an action verb (e.g. a new `pallet_c1`-style role or a new
  `scan_*` verb),
- a resolver export (`isTeachable`, `computeTeachingDebt`,
  `verbForStep`, `palletFrameStatus`, …),
- a step-row element (badge, Teach button, verb label, chip),
- a codegen emission (footer stamps, adaptation reasons, modal
  verbs like `setBlender` / `setNoBlender`),

… then it touches teaching. Run the doctrine suite. The runner
takes ~2 seconds; the operator's trust is worth much more.

## Amending the doctrine

The doctrine is the operator's model of the program. When a rule
needs to change:

1. Update `docs/PROGRAM_DOCTRINE.md` — describe the new/amended rule
   in the same voice as the existing D1–D10.
2. Update the corresponding `tests/doctrine/D<N>_*.test.js` file.
3. Include the operator's approval in the commit message
   (`amend-D<N>: <reason>` prefix keeps it grep-able).

Never amend a rule to make a test pass. The suite failing means the
CODE is wrong; the doctrine is the anchor.
