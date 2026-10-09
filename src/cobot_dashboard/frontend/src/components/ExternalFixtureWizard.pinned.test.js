// External Fixtures wizard — device-type picker declutter pin
// (2026-10-09 operator directive).
//
// The "What kind of device is this?" step shows one card per
// FIXTURE_TYPES entry. Pre-declutter, each card rendered a bold
// label + a short `desc` line + a long italic `why` paragraph that
// repeated behavioural detail already asked on later wizard steps
// (hold-on-loss defaults on AirActuationStep, "the robot tells it to
// go" on PowerForkStep, safety-guard caveat on AirActuationStep).
// The operator directive: card body = name + ONE short plain line.
// No italic paragraph on the picker.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const wizSrc  = fs.readFileSync(
  path.resolve(__dirname, 'ExternalFixtureWizard.jsx'), 'utf8')
const dataSrc = fs.readFileSync(
  path.resolve(__dirname, '../lib/fixturesData.js'), 'utf8')


// Shared util: the six expected FIXTURE_TYPES keys. Pin that the
// picker still enumerates ALL of them (no silent drop).
const KEYS = ['vice', 'indexer', 'feeder', 'blow_off', 'door', 'other']


test('FIXTURE_TYPES still enumerates the six expected device types', () => {
  for (const k of KEYS) {
    assert.match(dataSrc, new RegExp(`\\b${k}:\\s*\\{`),
      `FIXTURE_TYPES.${k} must still be defined`)
  }
})


test('DeviceTypeStep card does NOT render the italic why paragraph', () => {
  // Pre-fix the picker rendered a {t.why} <div> with
  // fontStyle:'italic' + a muted color — the long behavioural
  // paragraph. The declutter: no italic paragraph in the card body.
  const card = wizSrc.match(
    /function DeviceTypeStep[\s\S]{0,2500}?\n\}\n/)
  assert.ok(card, 'could not locate DeviceTypeStep')
  const body = card[0]
  assert.doesNotMatch(body, /\{t\.why\}/,
    'DeviceTypeStep card body must NOT render t.why — the behavioural '
    + 'detail belongs on the later wizard steps')
  assert.doesNotMatch(body, /fontStyle:\s*['"]italic['"]/,
    'no italic text in the DeviceTypeStep card — the long italic '
    + 'paragraph has been retired')
})


test('each device card desc is a short plain one-liner (≤8 words)', () => {
  // Pre-fix descriptions ran to 2+ sentences ("Spins to a new
  // position. Usually has its own controls."). The declutter: ONE
  // short plain line (≤8 words). Pulls the desc string literal
  // per key out of the FIXTURE_TYPES block and asserts the budget.
  for (const k of KEYS) {
    const entry = dataSrc.match(
      new RegExp(`${k}:\\s*\\{[\\s\\S]{0,500}?desc:\\s*'([^']+)'`))
    assert.ok(entry,
      `could not locate FIXTURE_TYPES.${k}.desc`)
    const desc = entry[1]
    const wordCount = desc.trim().split(/\s+/).length
    assert.ok(wordCount <= 8,
      `FIXTURE_TYPES.${k}.desc has ${wordCount} words `
      + `(budget: ≤8). desc=${JSON.stringify(desc)}`)
    // No multi-sentence paragraphs — the declutter directive forbids
    // a second sentence crammed into the same line.
    const sentenceEnds = (desc.match(/[.!?]/g) || []).length
    assert.ok(sentenceEnds <= 1,
      `FIXTURE_TYPES.${k}.desc contains ${sentenceEnds} sentence `
      + `terminators — must be a single plain line. `
      + `desc=${JSON.stringify(desc)}`)
  }
})


test('every device card renders consistently (same name+desc shape)', () => {
  // Pin that the card body only mounts the <div>{t.label}</div> +
  // <div>{t.desc}</div> pair — no sibling block, no per-type
  // branching. Scannability at a glance requires every card look
  // the same.
  const card = wizSrc.match(
    /function DeviceTypeStep[\s\S]{0,2500}?\n\}\n/)
  assert.ok(card, 'could not locate DeviceTypeStep')
  const body = card[0]
  // Only two text-rendering <div>{t.…}</div> sites inside the card.
  const tFieldHits = body.match(/\{t\.(label|desc|why)\}/g) || []
  const unique = Array.from(new Set(tFieldHits))
  assert.deepEqual(unique.sort(), ['{t.desc}', '{t.label}'],
    `DeviceTypeStep card may only render t.label + t.desc, got `
    + `${JSON.stringify(unique.sort())}`)
})


test('card minHeight pins consistent height across the grid', () => {
  // Scannability pin: the cards sit in an auto-fill grid, so a
  // narrow tablet width lets a label wrap onto two lines. A fixed
  // minHeight keeps every card the same vertical size — no
  // ragged-bottom grid.
  const card = wizSrc.match(
    /function DeviceTypeStep[\s\S]{0,2500}?\n\}\n/)
  assert.ok(card, 'could not locate DeviceTypeStep')
  assert.match(card[0], /minHeight:\s*\d+/,
    'DeviceTypeStep card must declare a minHeight so all six cards '
    + 'render at the same vertical size regardless of label wrap')
})


// ─────────────────────────────────────────────────────────────
// The removed behavioural guidance still lives on later steps.
// This is the "don't lose that guidance" half of the directive —
// pins that the hold-on-loss semantic + the own-controller semantic
// are present on PowerForkStep + AirActuationStep.
// ─────────────────────────────────────────────────────────────

test('PowerForkStep still carries the "robot tells it to go" semantic', () => {
  // The retired `why` text on indexer / feeder said: "the robot
  // tells it to go and waits for it to finish". The semantic lives
  // on the own-controller option of PowerForkStep.
  const step = wizSrc.match(
    /function PowerForkStep[\s\S]{0,2500}?\n\}\n/)
  assert.ok(step, 'could not locate PowerForkStep')
  assert.match(step[0], /its own controls/i,
    'PowerForkStep must still describe the own-controller option — '
    + 'the semantic retired from indexer/feeder why-paragraphs')
  assert.match(step[0], /start signal/i,
    'PowerForkStep own-controller description must still name the '
    + 'start-signal + wait-to-finish flow')
})


test('AirActuationStep still carries the hold-on-loss + safety-guard semantic', () => {
  // The retired `why` text on vice / door said: "keeps holding the
  // part if the robot stops" and "if this is a safety guard that
  // must open for a person to walk through, pick 'let go'". These
  // live on AirActuationStep's Yes / No cards.
  const step = wizSrc.match(
    /function AirActuationStep[\s\S]{0,3500}?\n\}\n/)
  assert.ok(step, 'could not locate AirActuationStep')
  assert.match(step[0], /holds whatever it is holding|keep holding/i,
    'AirActuationStep must still carry the hold-on-loss YES semantic')
  assert.match(step[0], /walk through|safety guard/i,
    'AirActuationStep must still carry the safety-guard "let go" '
    + 'semantic — the operator-visible home for the retired door `why`')
})
