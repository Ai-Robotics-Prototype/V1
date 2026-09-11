// DOCTRINE D10 — extension for the 2026-07-31 operator directive:
// warnings OFF, jog gate OFF during teaching. The capsule model
// over-approximates by ~30 mm and was blocking legitimate jogs.
//
// Failure format:
//   DOCTRINE D10 VIOLATED: <detail>
//
// Coverage:
//  (a) Driver's command-time jog gate applies ONLY inside the stop
//      zone. No cap, no block, no throttle in the warn band.
//  (b) Global stop threshold is 15 mm (shrunk to honest).
//  (c) Per-pair link3↔link5 override matches the global: warn 40,
//      stop 15.
//  (d) Stop-zone modal exposes an operator override affordance
//      (held press + logged).
//  (e) Store default: selfCollisionBannerEnabled starts false.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'


function d10(msg) { return `DOCTRINE D10 VIOLATED: ${msg}` }


const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')
const driverSrc = fs.readFileSync(
  path.join(REPO_ROOT, 'src', 'estun_driver', 'estun_driver',
            'estun_driver_node.py'), 'utf8')
const capsulesYaml = fs.readFileSync(
  path.join(REPO_ROOT, 'config', 'self_collision_capsules.yaml'), 'utf8')
const modalSrc = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'components',
               'ObstacleEscapeModal.jsx'), 'utf8')
const storeSrc = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'store', 'useStore.js'),
  'utf8')


test('D10(a): driver jog gate applies ONLY when cur_min <= stop_thr', () => {
  // The command-time gate must branch on cur_min <= stop_thr, NOT
  // cur_min <= warn_thr. The 2026-07-31 audit found the OPENING
  // branch capping speed at 6% whenever cur_min was inside warn,
  // which threw the operator's teach jogs into slow-motion at
  // 45-50 mm clearances that were physically fine.
  assert.ok(
    /if cur_min <= stop_thr:\s*\n\s+#[\s\S]{0,200}?Project the commanded direction/
      .test(driverSrc),
    d10('_on_jog_command must gate on `cur_min <= stop_thr` — not '
     + 'warn_thr — so the warn band passes through with zero '
     + 'interference. See the "OPERATOR DIRECTIVE" comment block '
     + 'above the branch.'))
  // Anti-regression: the old `if cur_min <= warn_thr:` pattern
  // must be gone.
  assert.equal(/if cur_min <= warn_thr:/.test(driverSrc), false,
    d10('the old `if cur_min <= warn_thr:` gate is retired — that '
     + 'was the block that throttled legitimate jogs. It must not '
     + 'come back without an operator directive amending this rule.'))
})


test('D10(b): global stop threshold is 15 mm', () => {
  assert.ok(
    /declare_parameter\('collision_stop_distance_mm',\s*15\.0\)/.test(driverSrc),
    d10('collision_stop_distance_mm must be 15.0 — shrunk to honest '
     + 'to reflect the capsule model\'s ~30 mm over-approximation'))
})


test('D10(c): link3↔link5 per-pair override matches (warn 40, stop 15)', () => {
  // Loose YAML parse — find the pair_thresholds block for
  // link3_forearm/link5_wrist2 and verify the two numbers.
  const block = capsulesYaml.match(
    /pair:\s*\[link3_forearm,\s*link5_wrist2\][\s\S]{0,400}?stop:\s*([\d.]+)/)
  assert.ok(block, 'link3_forearm/link5_wrist2 override must exist')
  assert.equal(parseFloat(block[1]), 15.0,
    d10(`link3↔link5 stop override must be 15.0 (found ${block[1]})`))
  const warnBlock = capsulesYaml.match(
    /pair:\s*\[link3_forearm,\s*link5_wrist2\][\s\S]{0,200}?warn:\s*([\d.]+)/)
  assert.ok(warnBlock)
  assert.equal(parseFloat(warnBlock[1]), 40.0,
    d10(`link3↔link5 warn override must be 40.0 (found ${warnBlock[1]})`))
})


test('D10(d): stop-zone modal exposes a held-press override', () => {
  assert.ok(modalSrc.includes('data-testid="collision-override-affordance"'),
    d10('ObstacleEscapeModal must render the operator override '
     + 'affordance with a stable testid'))
  assert.ok(modalSrc.includes('data-testid="collision-override-hold"'),
    d10('override button must be testable — the held-press affordance '
     + 'is the operator\'s escape hatch when the model is wrong'))
  // Held-press duration must be non-trivial (≥1s) so a stray
  // touch on the tablet doesn't dismiss the safety modal.
  assert.ok(/OVERRIDE_HOLD_MS\s*=\s*(1[0-9]{3}|2[0-9]{3})/.test(modalSrc),
    d10('override hold duration must be ≥1000 ms to prevent accidental '
     + 'stray-touch dismissal of the stop-zone modal'))
  // Log-write is required — the operator's decision goes on the
  // audit trail.
  assert.ok(/_collisionOverrideLog/.test(modalSrc),
    d10('override must record to a session log so the audit trail '
     + '("who dismissed the modal when") is queryable'))
})


test('D10(e): warn banner defaults OFF', () => {
  // The hydration returns false when no localStorage value is set.
  assert.ok(
    /raw === null \? false : raw === '1'/.test(storeSrc),
    d10('selfCollisionBannerEnabled default MUST be false — the '
     + 'operator directive turned warnings off until the mesh-hull '
     + 'upgrade lands'))
})


test('D10(f): §396 mesh-hull upgrade is documented as the real fix', () => {
  // The temporary shrinks (warn OFF, stop=15 mm) are cover, not
  // doctrine. The follow-up must be documented so it doesn't get
  // forgotten.
  const doc = path.join(REPO_ROOT, 'docs', '396_mesh_hull_upgrade.md')
  assert.ok(fs.existsSync(doc),
    d10('docs/396_mesh_hull_upgrade.md must exist — the real fix '
     + 'behind today\'s temporary guard shrinks needs to be a queued, '
     + 'named follow-up, not tribal knowledge'))
  const body = fs.readFileSync(doc, 'utf8')
  assert.ok(/convex hull/i.test(body),
    d10('follow-up doc must describe the convex-hull replacement '
     + 'for the current capsule model'))
  assert.ok(/2026-07-31/.test(body),
    d10('follow-up doc must date the directive so its temporary '
     + 'nature is visible'))
})
