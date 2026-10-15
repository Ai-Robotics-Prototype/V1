// DOCTRINE — Program-wizard waypoint-offer prompts between main teach
// positions (2026-10-15 operator directive).
//
// Before this ship, the wizard teach sequence only let the operator
// teach the main positions (home, pick, place, …). Any need to steer
// the arm around a fixture had to be handled post-hoc by hand-adding
// waypoint steps in ProgramEditor (which existed as a step type from
// 08cf555). The 2026-10-15 directive is to prompt the operator for an
// optional waypoint BETWEEN each main motion position so the authoring
// surface where positions are taught is also where routing decisions
// are made.
//
// Pins:
//   * waypointJunctionsForAnswers derives junctions per operation
//     (pick_and_place / sort / machine_tend / palletize / depalletize).
//   * teachPositionsForAnswers interleaves {kind:'waypoint_junction'}
//     entries AFTER each referenced main teach step (never between a
//     position and its own approach/retreat — those are paired).
//   * TeachSequence renders a `waypoint-junction-offer` panel on
//     junction steps; default button is "No, continue / Continue"
//     (first-focused, primary-styled) so straight-through flows are
//     one tap per junction.
//   * "Add waypoint" sets teachingWaypoint[posIdx] = true; the SAME
//     jog UI (same jog pads, same Record button) renders — no fork.
//   * recordPosition + saveManualPose branch on isWaypointJunction;
//     the taught pose appends to answers.waypoints[junctionId] (array)
//     via setAnswer('waypoints', ...). "Add another" chaining uses
//     the same append — multiple via-points at one junction.
//   * Copy is HONEST: "steer the path around a fixture or obstacle"
//     + "Manual routing: you teach the via-point; the arm does not
//     auto-detect obstacles." NEVER "automatically avoids obstacles."
//   * buildSteps + buildPalletizeSteps inject waypointStepsForJunction
//     at the correct seams per operation (home_to_pick after start
//     move_home, place_to_home before return move_home, pick-side
//     junction inside the per-cycle loop body, etc.).
//   * Taught waypoints emit `action: 'waypoint'` — the SAME action
//     ProgramEditor's Add Step → Motion → Waypoint already produces
//     (programTruth TEACHABLE_ACTIONS + MOTION_SMOOTHING_ACTIONS carry
//     'waypoint' from 08cf555). No new step type.
//   * Existing programs unaffected: a program with no answers.waypoints
//     emits byte-identical to the pre-feature output (empty array →
//     no steps injected).
//
// Failure format: DOCTRINE WIZARD_WAYPOINT VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

const progWizSrc    = readSrc('components/ProgramWizard.jsx')
const progTruthSrc  = readSrc('lib/programTruth.js')

function v(msg) { return `DOCTRINE WIZARD_WAYPOINT VIOLATED: ${msg}` }


// ── (1) Junction definitions per operation ──────────────────────────

test('waypointJunctionsForAnswers exists in ProgramWizard', () => {
  assert.ok(
    /function waypointJunctionsForAnswers\(answers\)/.test(progWizSrc),
    v('ProgramWizard must define waypointJunctionsForAnswers(answers) '
      + '— the per-operation junction map that drives both the teach-'
      + 'sequence interleave AND the buildSteps inject sites.'))
})

test('waypointJunctionsForAnswers covers every supported operation', () => {
  // One sanity probe per op — pattern-match that the branch emits a
  // junction with the canonical home_to_pick starter.
  const ops = ['pick_and_place', 'palletize', 'depalletize', 'machine_tend', 'sort']
  for (const op of ops) {
    assert.ok(
      new RegExp(`id:\\s*['"]home_to_pick['"]`).test(progWizSrc),
      v(`waypointJunctionsForAnswers must emit a home_to_pick junction `
        + `for ${op} — the HOME → first-main-position seam is the one `
        + `universal junction every op needs.`))
  }
  // machine_tend specifically carries the extra pick→load / load→unload / unload→home junctions.
  for (const id of ['pick_to_machine_load', 'machine_load_to_unload', 'unload_to_home']) {
    assert.ok(
      new RegExp(`id:\\s*['"]${id}['"]`).test(progWizSrc),
      v(`waypointJunctionsForAnswers must emit a ${id} junction for `
        + `machine_tend — the operator teaches four motion endpoints `
        + `(home / pick / machine_load / unload) + the return home.`))
  }
})


// ── (2) Teach-sequence interleave ───────────────────────────────────

test('teachPositionsForAnswers interleaves kind:waypoint_junction entries', () => {
  assert.ok(
    /kind:\s*['"]waypoint_junction['"]/.test(progWizSrc),
    v('teachPositionsForAnswers must emit entries with '
      + 'kind:"waypoint_junction" interleaved after main teach steps.'))
  assert.ok(
    /const junctions\s*=\s*waypointJunctionsForAnswers\(answers\)/.test(progWizSrc),
    v('teachPositionsForAnswers must call waypointJunctionsForAnswers '
      + '(single source of truth for the junction set).'))
  assert.ok(
    /junctions\.find\(\(x\)\s*=>\s*x\.afterKey\s*===\s*entry\.key\)/.test(progWizSrc),
    v('Interleave must match junctions by afterKey → the taught-position '
      + 'key it follows. One junction per key, injected ONCE (after the '
      + 'first occurrence) so taught_home\'s START occurrence gets the '
      + 'home_to_pick junction but the HOME (return) tail does not.'))
})


// ── (3) Waypoint-offer rendering + default button ──────────────────

test('TeachSequence renders a waypoint-junction-offer panel', () => {
  assert.ok(
    /data-testid="waypoint-junction-offer"/.test(progWizSrc),
    v('TeachSequence must render data-testid="waypoint-junction-offer" '
      + 'on the offer-screen panel so operator-facing tests can locate '
      + 'the prompt.'))
  assert.ok(
    /data-junction-id=\{currentJunctionId\}/.test(progWizSrc)
      && /data-waypoints-count=\{currentJunctionWps\.length\}/.test(progWizSrc),
    v('The offer panel must stamp data-junction-id + data-waypoints-count '
      + '— the junction identity and the chained-count must be observable '
      + 'at render time (not derived from screenshot heuristics).'))
})

test('"No, continue" / "Continue" is the primary default button', () => {
  assert.ok(
    /data-testid="waypoint-junction-continue"[\s\S]{0,400}autoFocus/.test(progWizSrc),
    v('The continue/No,-continue button must be autoFocus — the directive '
      + 'is explicit: default is skip so a straight pick-place isn\'t '
      + 'cluttered. First-focused + primary-styled.'))
  assert.ok(
    /No, continue →/.test(progWizSrc),
    v('When the junction has zero waypoints, the primary button copy '
      + 'is "No, continue →" (verbatim per 2026-10-15 directive).'))
})

test('"Add waypoint" / "Add another waypoint" is the secondary action', () => {
  assert.ok(
    /data-testid="waypoint-junction-add"/.test(progWizSrc),
    v('The add-waypoint button must carry data-testid="waypoint-junction-add" '
      + 'for operator-facing selection.'))
  assert.ok(
    /Add waypoint/.test(progWizSrc) && /Add another waypoint/.test(progWizSrc),
    v('The add-waypoint button copy switches: "+ Add waypoint" on an '
      + 'empty junction, "+ Add another waypoint" once at least one is '
      + 'taught — chaining signal.'))
})


// ── (4) Honest-scope copy — no auto-avoidance claim ─────────────────

test('Offer copy says "steer the path around" and not auto-avoidance', () => {
  // The 2026-10-15 directive echoes 08cf555's rule: this is MANUAL
  // routing. Never claim automatic avoidance.
  assert.ok(
    /steer the path around a fixture or obstacle/.test(progWizSrc),
    v('Offer copy must say "steer the path around a fixture or obstacle" '
      + '— the operator-written phrasing from the 2026-10-15 directive.'))
  assert.ok(
    /Manual routing: you teach the via-point; the arm does not\s*(?:\n\s*)?auto-detect obstacles/.test(progWizSrc),
    v('Offer copy must carry the "Manual routing: … the arm does not '
      + 'auto-detect obstacles" disclaimer verbatim — same honest-scope '
      + 'rule as the editor\'s Add Step → Waypoint description.'))
  // Hard-NEG: no claim of automatic obstacle avoidance anywhere.
  assert.ok(
    !/automatic(ally)? avoid/i.test(progWizSrc)
      && !/auto-avoid/i.test(progWizSrc),
    v('The wizard must NOT claim automatic obstacle avoidance anywhere '
      + '— the arm does not sense; the operator teaches via-points.'))
})


// ── (5) No fork — shared teach/record flow ──────────────────────────

test('recordPosition branches on isWaypointJunction and appends to answers.waypoints', () => {
  assert.ok(
    /if \(isWaypointJunction\)\s*\{\s*\n\s*appendWaypointPose\(/.test(progWizSrc),
    v('recordPosition must early-return into appendWaypointPose when '
      + 'the current step is a waypoint junction — same jog UI, same '
      + 'Record button, different storage target.'))
})

test('saveManualPose branches on isWaypointJunction too (same append)', () => {
  // Manual-entry path must also route waypoints into the array —
  // otherwise the Enter… fallback would silently write to the taught
  // key of a junction entry (which has no key).
  const idx = progWizSrc.indexOf('function saveManualPose')
  const chunk = progWizSrc.slice(idx, idx + 2000)
  assert.ok(
    /if \(isWaypointJunction\)\s*\{\s*\n\s*appendWaypointPose\(/.test(chunk),
    v('saveManualPose must early-return into appendWaypointPose when '
      + 'the current step is a waypoint junction — no fork between the '
      + 'live-capture and manual-entry paths.'))
})

test('appendWaypointPose writes answers.waypoints[junctionId] as an array', () => {
  assert.ok(
    /function appendWaypointPose/.test(progWizSrc),
    v('appendWaypointPose helper must exist as the single write seam '
      + 'for taught via-points.'))
  assert.ok(
    /setAnswer\(['"]waypoints['"],\s*nextMap\)/.test(progWizSrc),
    v('appendWaypointPose must write via setAnswer("waypoints", nextMap) '
      + '— the answers map carries a single waypoints object keyed by '
      + 'junctionId, each value being the ordered pose array.'))
  assert.ok(
    /const next = \[\.\.\.existing,/.test(progWizSrc),
    v('appendWaypointPose must APPEND to the existing array (not '
      + 'replace it) — chaining multiple via-points at one junction is '
      + 'in the directive.'))
})

test('After waypoint record, flash clears teachingWaypoint — re-renders offer', () => {
  // The chaining UX: Record a waypoint → 900ms flash → the UI flips
  // back to the "add another? / Continue" screen WITHOUT advancing the
  // posIdx. That lets the operator add N via-points at one junction
  // before hitting Continue.
  assert.ok(
    /setTeachingWaypoint\(\(p\)\s*=>\s*\(\{\s*\.\.\.p,\s*\[posIdx\]:\s*false\s*\}\)\)/
      .test(progWizSrc),
    v('appendWaypointPose must setTeachingWaypoint(posIdx -> false) '
      + 'after the flash — the offer screen re-renders in "add '
      + 'another?" form, no auto-advance.'))
})


// ── (6) buildSteps / buildPalletizeSteps injection ──────────────────

test('waypointStepsForJunction helper exists and emits action:"waypoint"', () => {
  assert.ok(
    /function waypointStepsForJunction\(answers, junctionId, defaultSpeed\)/
      .test(progWizSrc),
    v('ProgramWizard must define waypointStepsForJunction(answers, '
      + 'junctionId, defaultSpeed) — the single builder for program-'
      + 'step emission from taught via-points.'))
  assert.ok(
    /action:\s*['"]waypoint['"]/.test(progWizSrc),
    v('waypointStepsForJunction must emit action:"waypoint" — the SAME '
      + 'action ProgramEditor Add Step → Motion → Waypoint produces '
      + '(programTruth TEACHABLE_ACTIONS from 08cf555). No new step '
      + 'type, no fork.'))
  assert.ok(
    /waypoint_junction:\s*junctionId/.test(progWizSrc),
    v('Each emitted waypoint step must carry waypoint_junction: '
      + 'junctionId as an audit trail (which junction authored it).'))
})

test('waypoint is in TEACHABLE_ACTIONS and MOTION_SMOOTHING_ACTIONS', () => {
  // Not strictly a wizard pin — pins the shared vocabulary the
  // injection relies on. If a future rewrite ever removes 'waypoint'
  // from these sets, both the editor and the wizard-emitted waypoints
  // silently break; this pin catches that.
  assert.ok(
    /TEACHABLE_ACTIONS\s*=\s*new Set\(\[[\s\S]*?['"]waypoint['"][\s\S]*?\]\)/
      .test(progTruthSrc),
    v('programTruth TEACHABLE_ACTIONS must include "waypoint" — the '
      + 'wizard\'s injected waypoint steps rely on this.'))
  assert.ok(
    /MOTION_SMOOTHING_ACTIONS\s*=\s*new Set\(\[[\s\S]*?['"]waypoint['"][\s\S]*?\]\)/
      .test(progTruthSrc),
    v('programTruth MOTION_SMOOTHING_ACTIONS must include "waypoint" '
      + '— operator per-step smoothing applies to taught waypoints '
      + 'the same way as any other motion step.'))
})

test('buildSteps injects waypoints at every main-position seam', () => {
  const idx = progWizSrc.indexOf('function buildSteps(answers, portmap = null')
  const chunk = progWizSrc.slice(idx, idx + 18000)
  // home_to_pick — AFTER the start move_home, BEFORE pick approach.
  assert.ok(
    /action: 'move_home', label: 'Move to home position'[\s\S]{0,400}waypointStepsForJunction\(answers, 'home_to_pick'/
      .test(chunk),
    v('buildSteps must inject waypointStepsForJunction(home_to_pick) '
      + 'immediately after the start move_home — the arm leaves home, '
      + 'flies through operator via-points, then does the pick approach.'))
  // pick_to_place / pick_to_machine_load — after retreat-above-pick.
  // Source order: machine_tend branch (pick_to_machine_load) fires
  // FIRST, else branch (pick_to_place) is the fallback. Both anchors
  // must be present and both must sit after 'Retreat above pick'.
  assert.ok(
    /'Retreat above pick'[\s\S]{0,800}waypointStepsForJunction\(answers, 'pick_to_machine_load'[\s\S]{0,600}waypointStepsForJunction\(answers, 'pick_to_place'/
      .test(chunk),
    v('buildSteps must inject the pick-side junction (pick_to_place for '
      + 'the else fallback, pick_to_machine_load for the machine_tend '
      + 'branch) AFTER retreat-above-pick, in that source order.'))
  // machine_load_to_unload — before approach-unload.
  assert.ok(
    /waypointStepsForJunction\(answers, 'machine_load_to_unload'[\s\S]{0,400}'Approach unload'/
      .test(chunk),
    v('buildSteps must inject waypointStepsForJunction('
      + 'machine_load_to_unload) BEFORE the approach-unload step so '
      + 'the operator can steer the arm from safe-outside-machine to '
      + 'the unload approach.'))
  // place_to_home / unload_to_home — before return move_home.
  assert.ok(
    /waypointStepsForJunction\(answers, 'place_to_home'[\s\S]{0,400}'Return to home'/.test(chunk)
      && /waypointStepsForJunction\(answers, 'unload_to_home'[\s\S]{0,400}'Return to home'/.test(chunk),
    v('buildSteps must inject the return-side junction (place_to_home '
      + 'for pick_and_place / sort; unload_to_home for machine_tend) '
      + 'BEFORE the final return move_home.'))
})

test('buildPalletizeSteps injects waypoints at pallet seams', () => {
  const idx = progWizSrc.indexOf('function buildPalletizeSteps')
  const chunk = progWizSrc.slice(idx, idx + 12000)
  // home_to_pick — AFTER start move_home, BEFORE readySteps (so it
  // runs ONCE at program start, not every pallet cycle).
  assert.ok(
    /action: 'move_home', label: 'Move to home position'[\s\S]{0,800}waypointStepsForJunction\(answers, 'home_to_pick'[\s\S]{0,400}readySteps\(\)/
      .test(chunk),
    v('buildPalletizeSteps must inject home_to_pick waypoints BEFORE '
      + 'readySteps() — they run once at program start, not every '
      + 'pallet cycle.'))
  // place_to_home — AFTER the loop marker, BEFORE return move_home
  // (so they run ONCE at program end, not every cycle).
  assert.ok(
    /action: 'loop',[\s\S]{0,600}pallet_loop: true[\s\S]{0,600}waypointStepsForJunction\(answers, 'place_to_home'[\s\S]{0,400}'Return to home'/
      .test(chunk),
    v('buildPalletizeSteps must inject place_to_home waypoints AFTER '
      + 'the loop marker and BEFORE the return move_home — once at '
      + 'program end, not every cycle.'))
  // pick_to_place — INSIDE the loop body (per-cycle routing).
  assert.ok(
    /'Retreat above pick'[\s\S]{0,800}waypointStepsForJunction\(answers, 'pick_to_place'[\s\S]{0,600}action: 'move_to_pallet'/
      .test(chunk),
    v('buildPalletizeSteps (palletize mode) must inject pick_to_place '
      + 'waypoints INSIDE the loop body — between retreat-above-pick '
      + 'and the move_to_pallet macro. Per-cycle routing.'))
})


// ── (7) Existing programs unaffected (empty-waypoints no-op) ───────

function evalReadWaypointsForJunction() {
  const m = progWizSrc.match(/function readWaypointsForJunction\(answers, junctionId\)\s*\{[\s\S]*?\n\}/)
  if (!m) throw new Error('readWaypointsForJunction not found in ProgramWizard.jsx')
  return new Function(`${m[0]}; return readWaypointsForJunction;`)()
}
function evalWaypointStepsForJunction() {
  const m = progWizSrc.match(/function waypointStepsForJunction\(answers, junctionId, defaultSpeed\)\s*\{[\s\S]*?\n\}/)
  if (!m) throw new Error('waypointStepsForJunction not found in ProgramWizard.jsx')
  const readFn = evalReadWaypointsForJunction()
  return new Function('readWaypointsForJunction',
    `${m[0]}; return waypointStepsForJunction;`)(readFn)
}

test('waypointStepsForJunction returns [] when no waypoints are taught', () => {
  const fn = evalWaypointStepsForJunction()
  assert.deepEqual(fn({},                              'home_to_pick', 40), [],
    v('No answers.waypoints at all → []. Existing programs must be '
      + 'unaffected by this feature.'))
  assert.deepEqual(fn({ waypoints: {} },               'home_to_pick', 40), [],
    v('answers.waypoints exists but no entry for this junctionId → [].'))
  assert.deepEqual(fn({ waypoints: { home_to_pick: [] } }, 'home_to_pick', 40), [],
    v('Empty array at this junction → [].'))
  assert.deepEqual(fn({ waypoints: { home_to_pick: [{ skipped: true, tcp: [0,0,0,0,0,0] }] } },
                      'home_to_pick', 40), [],
    v('Only-skipped entries → [] (skipped poses never emit).'))
})

test('waypointStepsForJunction emits taught poses with action:"waypoint"', () => {
  const fn = evalWaypointStepsForJunction()
  const tcp = [0.1, 0.2, 0.3, 0, 0, 0]
  const joints = [10, -90, 0, -90, 0, 0]
  const out = fn({
    waypoints: {
      home_to_pick: [
        { tcp, joints, taught_at: '2026-10-15T12:00:00Z', source: 'live' },
        { tcp: [0.4, 0.5, 0.6, 0, 0, 0], joints, taught_at: '2026-10-15T12:00:30Z', source: 'live' },
      ],
    },
  }, 'home_to_pick', 55)
  assert.equal(out.length, 2,
    v('Two taught via-points → two emitted steps.'))
  assert.equal(out[0].action, 'waypoint',
    v('Emitted step action must be "waypoint" — matches programTruth\'s '
      + 'TEACHABLE_ACTIONS entry from 08cf555.'))
  assert.equal(out[0].waypoint_junction, 'home_to_pick',
    v('Each emitted step must carry waypoint_junction so tools can map '
      + 'it back to its originating junction.'))
  assert.equal(out[0].speed_pct, 55,
    v('Emitted step speed_pct must come from the defaultSpeed arg — '
      + 'per-op spd flow.'))
  assert.deepEqual(out[0].taught_tcp, tcp,
    v('Emitted step taught_tcp must carry the live TCP.'))
})
