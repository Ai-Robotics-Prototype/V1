#!/usr/bin/env node
// no-fork-truth — CI guard against the 2026-07-30 UI-truth incidents.
//
// Scans every source file under src/components/ and src/pages/ and
// FAILS the build when a file references any of the sentinel tokens
// listed in FORK_TOKENS *without* importing from lib/programTruth.js
// (the one canonical resolver).
//
// The tokens name the exact facts today's incidents forked on:
//
//   * taught_joints         — taught-state derivation
//   * point_name            — same
//   * 'move_linear'/'move_home'/'move_joint' — the step-verb triad
//     (chip labels, detail lines, ACTION_TYPES table)
//   * emittedLine           — legacy computeLineMap reference
//   * has_taught_poses      — server-computed flag; direct read is fine,
//                             deriving it locally is not — the sentinel
//                             catches the RE-derivation, not the read
//
// The guard is deliberately regex-based (not AST): a component that
// TOUCHES these tokens must go through the shared resolver, period.
// Whitelist file: FORK_ALLOWLIST — the resolver itself + the ACTION_TYPES
// definition file which is the ONE authoring-intent table.
//
// Exit codes:
//   0 — clean
//   1 — one or more offenders (specifics printed)
//
// Run manually: `node frontend/scripts/no-fork-truth.mjs`.
// CI wiring: add to `npm run lint`.

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const FRONTEND_ROOT = path.resolve(__dirname, '..')
const SRC_ROOT = path.join(FRONTEND_ROOT, 'src')

// Files/paths that are ALLOWED to reference the sentinel tokens
// without going through programTruth. Each entry is a suffix match
// against the file's path relative to FRONTEND_ROOT.
const FORK_ALLOWLIST = [
  'src/lib/programTruth.js',        // the resolver itself
  'src/lib/programTruth.test.js',   // its tests
  'src/lib/runState.js',            // sibling resolver (line map + status)
  'src/lib/runState.test.js',
  'src/components/ProgramEditor.jsx',   // ACTION_TYPES authoring table lives here
  'src/components/ProgramWizard.jsx',   // wizard emits authored step objects — allowed
  'src/components/ProgramFromDemonstration.jsx',  // PBD emits authored steps — allowed
  'src/components/ProgramErrorModal.jsx',   // error-text mentions verbs by name
  'src/pages/AdaptivePicking.jsx',      // teach_count/telemetry, unrelated meaning
  'src/store/useStore.js',              // hydrates authored programs; not a fact-source
  'src/lib/ioPortmap.js',
]

// Sentinel tokens. Regex fragments — each is matched with word
// boundaries where relevant.
const FORK_TOKENS = [
  { rx: /\btaught_joints\b/,           label: 'taught_joints (raw taught-state key)' },
  { rx: /\bpoint_name\b/,              label: 'point_name (raw taught-state ref)' },
  { rx: /'move_linear'|"move_linear"/, label: "'move_linear' string (step-verb literal)" },
  { rx: /'move_home'|"move_home"/,     label: "'move_home' string (step-verb literal)" },
  { rx: /'move_joint'|"move_joint"/,   label: "'move_joint' string (step-verb literal)" },
  { rx: /\bemittedLine\b/,             label: 'emittedLine (retired line-map field)' },
]

// A file "consumes" the shared resolver when it imports at least one
// symbol from ../lib/programTruth or the runState sibling.
const CONSUMER_IMPORT_RX = /from\s+['"](\.\.?\/)+lib\/programTruth(\.js)?['"]/

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

function isAllowed(relPath) {
  return FORK_ALLOWLIST.some((suf) => relPath.endsWith(suf))
}

function main() {
  const files = []
  walk(path.join(SRC_ROOT, 'components'), files)
  walk(path.join(SRC_ROOT, 'pages'), files)

  const offenders = []
  for (const f of files) {
    const rel = path.relative(FRONTEND_ROOT, f)
    if (isAllowed(rel)) continue

    const src = fs.readFileSync(f, 'utf8')
    const importsResolver = CONSUMER_IMPORT_RX.test(src)

    const hits = []
    for (const { rx, label } of FORK_TOKENS) {
      if (rx.test(src)) hits.push(label)
    }
    if (hits.length && !importsResolver) {
      offenders.push({ file: rel, hits })
    }
  }

  if (offenders.length === 0) {
    console.log('no-fork-truth: OK — no unshielded consumers of taught/verb tokens')
    process.exit(0)
  }

  console.error('\nno-fork-truth: FAILED — the following files reference')
  console.error('taught-state / step-verb tokens WITHOUT importing from')
  console.error('src/lib/programTruth.js. Either import the shared resolver')
  console.error('and use isStepTaught / verbForStep / hasFullTaughtPose,')
  console.error('or add the file to FORK_ALLOWLIST if it is authoritative.')
  console.error('')
  for (const o of offenders) {
    console.error(`  ${o.file}`)
    for (const h of o.hits) console.error(`    · ${h}`)
  }
  console.error('')
  process.exit(1)
}

main()
