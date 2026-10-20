// DOCTRINE — Palletize wizard embeds the taught HOME pose onto the
// FIRST move_home step (2026-10-20 operator field report).
//
// Pre-fix: the wizard captured `answers.taught_home` and stashed it on
// `config.taught_home` (via buildPalletConfig / the save path) but
// `buildPalletizeSteps` and `buildSteps` both emitted a BARE
// `{action:'move_home', label:'Move to home position'}` step with NO
// `taught_joints`, NO `taught` flag, NO `position_role`. Every reader
// that resolves teaching per-step (editor's isTeachable, pending-pose
// gate `program_ops.check_program_pending_poses`, codegen) landed on
// the empty step and the saved program showed HOME untaught — even
// though the operator had taught it correctly in the wizard. Pick's
// emission at ProgramWizard.jsx is the pattern this pin mirrors:
// readTaught(answers, 'taught_pick') + joints/TCP/taught/position_role
// embedded on the step. The matching helper is _homeStepFromAnswers.
//
// Pins:
//   * ProgramWizard.jsx defines `_homeStepFromAnswers(answers, label)`
//     that reads `taught_home` and emits taught_joints / taught_tcp /
//     joints / position / taught=true / position_role='home' when a
//     pose exists; the bare {action, label} shape stays when no pose
//     (so a skip-home flow keeps emitting the empty step).
//   * The FIRST move_home in `buildPalletizeSteps` goes through the
//     helper (not a bare literal).
//   * The FIRST move_home in `buildSteps` goes through the helper too.
//   * The sibling "Return to home" at program end can stay bare — the
//     backend pending-pose gate's sibling-scan (program_ops.py:1545-
//     1570) and the frontend's isTeachable mirror both rescue the
//     trailing move_home against the first.
//
// Failure format: DOCTRINE WIZARD_HOME_TAUGHT VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

const progWizSrc = readSrc('components/ProgramWizard.jsx')

function v(msg) { return `DOCTRINE WIZARD_HOME_TAUGHT VIOLATED: ${msg}` }

test('_homeStepFromAnswers helper exists and reads taught_home', () => {
  assert.match(
    progWizSrc,
    /function\s+_homeStepFromAnswers\s*\(\s*answers\s*,\s*label\s*\)/,
    v('`_homeStepFromAnswers(answers, label)` helper not defined.'))
  // The helper must read the operator's taught home pose from answers.
  // readTaught is the shared reader used by pick/place; keep home on
  // the same path.
  const bodyMatch = progWizSrc.match(
    /function\s+_homeStepFromAnswers[\s\S]+?\n\}/)
  assert.ok(bodyMatch,
    v('Could not locate the body of _homeStepFromAnswers.'))
  const body = bodyMatch[0]
  assert.match(body, /readTaught\s*\(\s*answers\s*,\s*['"]taught_home['"]\s*\)/,
    v("Helper does not read answers via readTaught(answers, 'taught_home')."))
  // When a pose exists, the helper must stamp taught_joints + taught
  // + position_role='home' onto the step. These are the exact fields
  // every per-step reader (editor, pending-pose gate, codegen) looks at.
  assert.match(body, /taught_joints/,
    v('Helper does not emit taught_joints onto the step.'))
  assert.match(body, /taught\s*=\s*true/,
    v('Helper does not stamp taught=true onto the step.'))
  assert.match(body, /position_role\s*=\s*['"]home['"]/,
    v("Helper does not set position_role='home' on the step."))
  assert.match(body, /taught_tcp/,
    v('Helper does not emit taught_tcp onto the step.'))
})

test('buildPalletizeSteps uses the helper for the FIRST move_home', () => {
  const palletFn = progWizSrc.match(
    /function\s+buildPalletizeSteps[\s\S]+?\nfunction\s/)
  assert.ok(palletFn,
    v('Could not locate buildPalletizeSteps.'))
  const src = palletFn[0]
  // The first move_home must come from the helper, NOT the bare literal.
  // Match "Move to home position" via the helper call.
  assert.match(
    src,
    /_homeStepFromAnswers\s*\(\s*answers\s*,\s*['"]Move to home position['"]\s*\)/,
    v('buildPalletizeSteps still emits the start-of-program move_home '
      + 'as a bare literal. Replace with '
      + "_homeStepFromAnswers(answers, 'Move to home position') so the "
      + 'operator-taught home lands on steps[0].taught_joints.'))
  // Guard against future reversion: NO bare "Move to home position"
  // literal survives inside the palletize builder.
  assert.doesNotMatch(
    src,
    /\{\s*action:\s*['"]move_home['"]\s*,\s*label:\s*['"]Move to home position['"]\s*\}/,
    v('A bare {action:"move_home", label:"Move to home position"} '
      + 'literal is still present in buildPalletizeSteps. Route the '
      + 'start-of-program home through _homeStepFromAnswers.'))
})

test('buildSteps uses the helper for the FIRST move_home', () => {
  // buildSteps is immediately followed by `export default function
  // ProgramWizard(...)` — anchor the capture against that boundary
  // rather than the generic `function\s` so the match terminates.
  const buildFn = progWizSrc.match(
    /function\s+buildSteps[\s\S]+?\nexport\s+default\s+function\s/)
  assert.ok(buildFn,
    v('Could not locate buildSteps.'))
  const src = buildFn[0]
  assert.match(
    src,
    /_homeStepFromAnswers\s*\(\s*answers\s*,\s*['"]Move to home position['"]\s*\)/,
    v('buildSteps still emits the start-of-program move_home as a '
      + 'bare literal. Replace with '
      + "_homeStepFromAnswers(answers, 'Move to home position')."))
  assert.doesNotMatch(
    src,
    /\{\s*action:\s*['"]move_home['"]\s*,\s*label:\s*['"]Move to home position['"]\s*\}/,
    v('A bare {action:"move_home", label:"Move to home position"} '
      + 'literal is still present in buildSteps.'))
})

test('simulated palletize answers → first move_home carries the taught pose', async () => {
  // Direct behavioural pin: load the wizard module, call
  // buildPalletizeSteps with a taught_home, and assert the step's
  // taught_joints / taught / position_role lands correctly.
  //
  // The ES module graph of ProgramWizard.jsx pulls in React / Zustand
  // / zustand-selectors / three.js — none of which runs under node's
  // test runner. Instead, extract the two functions we actually need
  // (_homeStepFromAnswers + readTaught) into a tiny vm context and
  // run the logic directly. Keeps the behavioural assertion while
  // avoiding the whole-component import cost.
  const vm = await import('node:vm')
  const readTaughtSrc = progWizSrc.match(
    /function\s+readTaught[\s\S]+?\n\}/)[0]
  const helperSrc = progWizSrc.match(
    /function\s+_homeStepFromAnswers[\s\S]+?\n\}/)[0]
  // Field-captured palletize2 home pose — the operator's actual
  // taught values from /opt/cobot/programs/palletize2.json's
  // config.taught_home.
  const answers = {
    taught_home: {
      joints: [25.02, 39.88, 91.15, 40.48, 89.77, 56.95],
      tcp:    [0.832952, 0.617063, 0.218411,
               3.133005633669981, -0.005777039824101231,
               -2.1281148635417257],
      taught_at: '2026-10-20T15:25:11.616Z',
      skipped: false,
      source: 'live',
    },
  }
  const ctx = vm.createContext({ answers })
  vm.runInContext(`${readTaughtSrc}\n${helperSrc}`, ctx)
  const got = vm.runInContext(
    "_homeStepFromAnswers(answers, 'Move to home position')", ctx)

  assert.equal(got.action, 'move_home',
    v('Emitted step action is not move_home.'))
  assert.equal(got.label, 'Move to home position',
    v('Emitted step label was not passed through.'))
  assert.equal(got.taught, true,
    v('Emitted step is not marked taught=true.'))
  assert.deepEqual(got.taught_joints, answers.taught_home.joints,
    v('Emitted step.taught_joints does not match answers.taught_home.joints.'))
  assert.deepEqual(got.joints, answers.taught_home.joints,
    v('Emitted step.joints does not match answers.taught_home.joints.'))
  assert.deepEqual(got.taught_tcp, answers.taught_home.tcp,
    v('Emitted step.taught_tcp does not match answers.taught_home.tcp.'))
  assert.equal(got.position_role, 'home',
    v("Emitted step.position_role is not 'home'."))

  // Guard: when the operator skips home teaching, the helper still
  // emits the bare step shape so the SKIP path keeps working.
  const skipCtx = vm.createContext({ answers: { taught_home: null } })
  vm.runInContext(`${readTaughtSrc}\n${helperSrc}`, skipCtx)
  const skipStep = vm.runInContext(
    "_homeStepFromAnswers(answers, 'Move to home position')", skipCtx)
  assert.equal(skipStep.action, 'move_home',
    v('Skip-home case: action is not move_home.'))
  assert.equal(skipStep.label, 'Move to home position',
    v('Skip-home case: label was dropped.'))
  assert.equal(skipStep.taught, undefined,
    v('Skip-home case: taught flag leaked when no pose exists.'))
  assert.equal(skipStep.taught_joints, undefined,
    v('Skip-home case: taught_joints leaked when no pose exists.'))
})
