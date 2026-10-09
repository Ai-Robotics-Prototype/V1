#!/usr/bin/env node
// no-fork-truth — CI guard against the 2026-07-30 UI-truth incidents.
//
// A file under src/components/ or src/pages/ that references any
// sentinel token below MUST also import from the corresponding
// shared resolver module. New code physically can't fork the
// truth again.
//
// Each guard has:
//   * name        — reported in the failure output
//   * tokens      — regex fragments that flag "this file has an
//                   opinion about the shared truth"
//   * resolver    — regex that matches the import that shields it
//   * allowlist   — path suffixes exempt from the check (the
//                   resolver itself + authoritative tables)
//
// Adding a new fork-class:
//   1. Extract the truth into a shared lib/xxx.js module.
//   2. Add a new guard entry below with the sentinel tokens.
//   3. Everything else works automatically.

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname     = path.dirname(url.fileURLToPath(import.meta.url))
const FRONTEND_ROOT = path.resolve(__dirname, '..')
const SRC_ROOT      = path.join(FRONTEND_ROOT, 'src')


const GUARDS = [
  // ── Guard A: taught-state / step-verb ─────────────────────────
  // Motivating incidents (all 2026-07-30 audit):
  //   #P1-1 computeLineMap (retired)
  //   #P1-2 taught-count forked three ways (Editor / RunModal / Monitor)
  //   #P1-3 hasPositionData accepted partial arrays
  //   #P2-1 TypeChip label from step.action, not emitted verb
  {
    name:      'programTruth',
    resolver:  /from\s+['"](\.\.?\/)+lib\/programTruth(\.js)?['"]/,
    tokens: [
      { rx: /\btaught_joints\b/,           label: 'taught_joints (raw taught-state key)' },
      { rx: /\bpoint_name\b/,              label: 'point_name (raw taught-state ref)' },
      { rx: /'move_linear'|"move_linear"/, label: "'move_linear' string (step-verb literal)" },
      { rx: /'move_home'|"move_home"/,     label: "'move_home' string (step-verb literal)" },
      { rx: /'move_joint'|"move_joint"/,   label: "'move_joint' string (step-verb literal)" },
      { rx: /\bemittedLine\b/,             label: 'emittedLine (retired line-map field)' },
    ],
    allowlist: [
      'src/lib/programTruth.js',        // the resolver itself
      'src/lib/programTruth.test.js',
      'src/lib/runState.js',            // sibling resolver (line map + status)
      'src/lib/runState.test.js',
      'src/components/ProgramEditor.jsx',   // ACTION_TYPES authoring table lives here
      'src/components/ProgramWizard.jsx',   // wizard emits authored step objects — allowed
      'src/components/ProgramFromDemonstration.jsx',  // PBD emits authored steps — allowed
      'src/components/ProgramErrorModal.jsx',   // error-text mentions verbs by name
      'src/pages/AdaptivePicking.jsx',      // teach_count/telemetry, unrelated meaning
      'src/store/useStore.js',              // hydrates authored programs; not a fact-source
      'src/lib/ioPortmap.js',
    ],
  },

  // ── Guard B: effector vocabulary (audit instance #4) ─────────
  // Wizard used hardcoded "Grip part" / "Release part" labels on a
  // vacuum program because it had its own step-naming path that
  // bypassed the PBD composer's effector-aware emitters. This guard
  // forbids hardcoded gripper/vacuum/magnet vocabulary tokens in
  // any component that doesn't import lib/effectorVocab.
  {
    name:     'effectorVocab',
    resolver: /from\s+['"](\.\.?\/)+lib\/effectorVocab(\.js)?['"]/,
    tokens: [
      { rx: /'Grip part'|"Grip part"/,       label: "'Grip part' hardcoded label" },
      { rx: /'Release part'|"Release part"/, label: "'Release part' hardcoded label" },
      { rx: /'Open gripper'|"Open gripper"|'Open Gripper'|"Open Gripper"/,
        label: "'Open Gripper' hardcoded label" },
      { rx: /'Close gripper'|"Close gripper"|'Close Gripper'|"Close Gripper"/,
        label: "'Close Gripper' hardcoded label" },
      { rx: /'Engage vacuum'|"Engage vacuum"/,       label: "'Engage vacuum' hardcoded label" },
      { rx: /'Disengage vacuum'|"Disengage vacuum"/, label: "'Disengage vacuum' hardcoded label" },
      { rx: /'Blow off'|"Blow off"/,                 label: "'Blow off' hardcoded label" },
      { rx: /'Vacuum on'|"Vacuum on"|'Vacuum off'|"Vacuum off"/,
        label: "'Vacuum on'/'Vacuum off' hardcoded label" },
      { rx: /'Engage magnet'|"Engage magnet"|'Disengage magnet'|"Disengage magnet"/,
        label: "'Engage magnet'/'Disengage magnet' hardcoded label" },
    ],
    allowlist: [
      'src/lib/effectorVocab.js',      // the resolver itself
      'src/lib/effectorVocab.test.js',
      // ControlStrip is a direct-actuation UI (toolbar toggle
      // buttons for manual gripper control); its tooltips name
      // the raw actuator action, not program-composed steps. If a
      // future release adds effector-aware direct actuation, it
      // should import effectorVocab and be removed from here.
      'src/components/ControlStrip.jsx',
      // Comment prose only — documents the whitebowl "'vacuum'
      // answered, 'Grip part' saved" bug in an audit note. The
      // PBD composer that this file drives ALREADY routes through
      // the backend effector-aware emitter.
      'src/components/ProgramFromDemonstration.jsx',
    ],
  },
]


function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      if (name === 'node_modules') continue
      walk(full, out)
    } else if (/\.(jsx?|mjs)$/.test(name) && !name.endsWith('.test.js')) {
      out.push(full)
    }
  }
}


function isAllowed(guard, relPath) {
  return guard.allowlist.some((suf) => relPath.endsWith(suf))
}


function main() {
  const files = []
  walk(path.join(SRC_ROOT, 'components'), files)
  walk(path.join(SRC_ROOT, 'pages'), files)

  let totalOffenses = 0

  for (const guard of GUARDS) {
    const offenders = []
    for (const f of files) {
      const rel = path.relative(FRONTEND_ROOT, f)
      if (isAllowed(guard, rel)) continue

      const src = fs.readFileSync(f, 'utf8')
      const importsResolver = guard.resolver.test(src)

      const hits = []
      for (const { rx, label } of guard.tokens) {
        if (rx.test(src)) hits.push(label)
      }
      if (hits.length && !importsResolver) {
        offenders.push({ file: rel, hits })
      }
    }

    if (offenders.length === 0) {
      console.log(`no-fork-truth [${guard.name}]: OK`)
      continue
    }

    console.error(`\nno-fork-truth [${guard.name}]: FAILED`)
    console.error('  The following files reference tokens managed by')
    console.error(`  src/lib/${guard.name}.js WITHOUT importing from it.`)
    console.error(`  Either import the resolver and use its exports, or`)
    console.error(`  add the file to the guard's allowlist if it is`)
    console.error(`  authoritative.\n`)
    for (const o of offenders) {
      console.error(`    ${o.file}`)
      for (const h of o.hits) console.error(`      · ${h}`)
    }
    totalOffenses += offenders.length
  }

  if (totalOffenses > 0) {
    console.error('')
    process.exit(1)
  }
  console.log('no-fork-truth: all guards clean')
  process.exit(0)
}

main()
