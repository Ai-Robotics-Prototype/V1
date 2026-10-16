// DOCTRINE — External Fixture wizard tells the operator which Synapse
// ports to wire everything to (2026-10-16 operator order).
//
// Pre-fix: the fixture Summary step emitted a flat text block with
// "Wire air line to: V05" / "Wire done sensor to: IN03" rows mixed in
// with other summary fields ("Kind:", "How it works:"), using generic
// signal names regardless of device type. The glowing map was below
// but no explicit imperative "Connect X to Y" + per-port tick-off
// surface existed. Operators had to parse the summary to work out
// which signal was which.
//
// Fix: a dedicated WiringChecklist panel sits above the glowing map
// in SummaryStep. It:
//   * Reads the ports the shared allocator (allocateFixturePorts)
//     assigned to this record (record.valve / record.out /
//     record.in_done) — the operator never picks a DO/DI number.
//   * Names each signal in the device's own terms via wiringLabelsFor
//     (vice.valve → "clamp air line", door.in_done → "door position
//     sensor", etc.) — new per-type data in FIXTURE_TYPES.
//   * Shows profile-aware port names via portDisplayName (Synapse mode
//     "Valve 05" / "IN 03", OEM mode "DO5" / "DI3").
//   * Carries a per-port tick-off checkbox for the operator's working
//     memory while they physically wire. Local state only — not
//     persisted on the record (same pattern as the EOAT hookup
//     guidance's tick-off).
//   * Keeps the glowing map (GuidanceBlock, SHARED import from
//     EOATSetupWizard) immediately below so the operator sees the
//     physical location of each assigned port.
//
// Pins:
//   * wiringLabelsFor is exported from lib/fixturesData + each shipped
//     device type carries its per-type wiring_labels sub-object.
//   * Vice valve label is "clamp air line"; vice in_done is "clamp
//     sensor". Door valve is "door air line"; door in_done is "door
//     position sensor". Blow-off valve is "blow-off air line".
//   * fixturePortMap callouts use the per-type labels (not the
//     generic "air line" / "DONE sensor" literals).
//   * SummaryStep mounts a WiringChecklist that reads the record's
//     allocated ports + the per-type labels + profile-aware
//     portDisplayName. The panel renders ALL ports the record has
//     (valve + out + in_done, in that order).
//   * Per-port tick-off checkbox lives in local component state.
//   * The glowing map (GuidanceBlock) is still rendered below the
//     checklist — one shared surface, no fork of the map.
//
// Failure format: DOCTRINE FIXTURE_WIRING VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  FIXTURE_TYPES, wiringLabelsFor, fixturePortMap,
} from '../../src/lib/fixturesData.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

const wizSrc = readSrc('components/ExternalFixtureWizard.jsx')

function v(msg) { return `DOCTRINE FIXTURE_WIRING VIOLATED: ${msg}` }


// ── (1) Per-type wiring labels + resolver ───────────────────────────

test('wiringLabelsFor is exported + returns a well-formed shape', () => {
  assert.ok(typeof wiringLabelsFor === 'function',
    v('lib/fixturesData must export wiringLabelsFor — the single '
      + 'resolver the WiringChecklist consults for signal names.'))
  const generic = wiringLabelsFor('does-not-exist')
  for (const field of ['valve', 'out', 'in_done']) {
    assert.ok(typeof generic[field] === 'string' && generic[field].length > 0,
      v(`wiringLabelsFor fallback must carry a non-empty ${field} label `
        + `so an unknown type still renders working copy.`))
  }
})

test('Vice wiring labels: "clamp air line" + "clamp sensor"', () => {
  const vice = wiringLabelsFor('vice')
  assert.equal(vice.valve,   'clamp air line',
    v('Vice valve label must be "clamp air line" — the operator-order '
      + 'phrasing from the 2026-10-16 directive.'))
  assert.equal(vice.in_done, 'clamp sensor',
    v('Vice in_done label must be "clamp sensor" — matches the '
      + 'completion-step "A clamp sensor tells it" copy.'))
})

test('Door wiring labels: "door air line" + "door position sensor"', () => {
  const door = wiringLabelsFor('door')
  assert.equal(door.valve,   'door air line')
  assert.equal(door.in_done, 'door position sensor')
})

test('Blow-off wiring label: "blow-off air line"', () => {
  const blow = wiringLabelsFor('blow_off')
  assert.equal(blow.valve, 'blow-off air line')
})

test('Feeder / indexer wiring labels name the signal in device terms', () => {
  assert.equal(wiringLabelsFor('feeder').out,     'feed START signal')
  assert.equal(wiringLabelsFor('feeder').in_done, 'part-present sensor')
  assert.equal(wiringLabelsFor('indexer').out,     'index START signal')
  assert.equal(wiringLabelsFor('indexer').in_done, 'in-position sensor')
})

test('Every shipped FIXTURE_TYPES entry has wiring_labels (except "other" which uses generic)', () => {
  for (const key of Object.keys(FIXTURE_TYPES)) {
    if (key === 'other') continue
    assert.ok(FIXTURE_TYPES[key].wiring_labels,
      v(`FIXTURE_TYPES.${key} must carry a wiring_labels sub-object `
        + `(or deliberately opt into the generic fallback like "other").`))
  }
})


// ── (2) fixturePortMap uses per-type labels in callouts ─────────────

test('Vice fixturePortMap callout: "Connect <name>\'s clamp air line to <port>"', () => {
  const rec = {
    id: 'f', name: 'Vice 1', type: 'vice',
    valve: 'V05', out: null, in_done: 'IN03',
  }
  const port = fixturePortMap(rec)
  assert.ok(/clamp air line/.test(port.callouts.V05),
    v('Vice valve callout must contain "clamp air line" — the per-type '
      + 'label replaces the generic "air line".'))
  assert.ok(/Vice 1/.test(port.callouts.V05),
    v('Vice valve callout must still name the fixture ("Vice 1") per '
      + 'the pre-2026-10-16 operator-naming pin.'))
  assert.ok(/clamp sensor/.test(port.callouts.IN03),
    v('Vice in_done callout must contain "clamp sensor" — not the '
      + 'generic "DONE sensor".'))
})

test('Door fixturePortMap callout uses door-specific labels', () => {
  const rec = {
    id: 'd', name: 'Door 2', type: 'door',
    valve: 'V06', out: null, in_done: 'IN04',
  }
  const port = fixturePortMap(rec)
  assert.ok(/door air line/.test(port.callouts.V06),
    v('Door valve callout must contain "door air line".'))
  assert.ok(/door position sensor/.test(port.callouts.IN04),
    v('Door in_done callout must contain "door position sensor".'))
})


// ── (3) WiringChecklist component shape ─────────────────────────────

test('ExternalFixtureWizard defines a WiringChecklist component', () => {
  assert.ok(/function WiringChecklist\(\{\s*record,\s*profile,\s*portmap\s*\}\)/
             .test(wizSrc),
    v('ExternalFixtureWizard must define WiringChecklist({ record, '
      + 'profile, portmap }) — the dedicated per-port imperative '
      + 'instruction panel that reads the allocator-assigned ports.'))
})

test('WiringChecklist reads record.valve / record.out / record.in_done', () => {
  const idx = wizSrc.indexOf('function WiringChecklist(')
  const stop = wizSrc.indexOf('\nfunction ', idx + 1)
  const chunk = wizSrc.slice(idx, stop > idx ? stop : idx + 3000)
  assert.ok(/record\.valve/.test(chunk)
         && /record\.out/.test(chunk)
         && /record\.in_done/.test(chunk),
    v('WiringChecklist must read record.valve + record.out + '
      + 'record.in_done — the ports the shared allocator '
      + '(allocateFixturePorts) assigned at compile time. The operator '
      + 'never picks a DO/DI number.'))
})

test('WiringChecklist uses wiringLabelsFor(record.type) for signal names', () => {
  const idx = wizSrc.indexOf('function WiringChecklist(')
  const stop = wizSrc.indexOf('\nfunction ', idx + 1)
  const chunk = wizSrc.slice(idx, stop > idx ? stop : idx + 3000)
  assert.ok(/wiringLabelsFor\(record\.type\)/.test(chunk),
    v('WiringChecklist must call wiringLabelsFor(record.type) — '
      + 'single source of truth for per-type signal names.'))
})

test('WiringChecklist uses profile-aware portDisplayName for port ids', () => {
  const idx = wizSrc.indexOf('function WiringChecklist(')
  const stop = wizSrc.indexOf('\nfunction ', idx + 1)
  const chunk = wizSrc.slice(idx, stop > idx ? stop : idx + 3000)
  assert.ok(
    /portDisplayName\([^,]+,\s*\{\s*profile,\s*portmap\s*\}\)/.test(chunk),
    v('WiringChecklist must call portDisplayName(id, {profile, portmap}) '
      + 'so Synapse mode shows "Valve 05" and OEM mode shows "DO5".'))
})

test('WiringChecklist renders imperative "Connect <name>\'s <label> to <port>" rows', () => {
  const idx = wizSrc.indexOf('function WiringChecklist(')
  const stop = wizSrc.indexOf('\nfunction ', idx + 1)
  const chunk = wizSrc.slice(idx, stop > idx ? stop : idx + 3000)
  // The row body renders "Connect {record.name}'s {row.label} to <port>"
  // — the exact imperative phrasing from the operator order.
  assert.ok(/Connect \{record\.name\}[\s\S]{0,200}\{row\.label\}[\s\S]{0,200}\{row\.port\}/
             .test(chunk),
    v('WiringChecklist row body must render "Connect {record.name}\'s '
      + '{row.label} to {row.port}" — the operator-order imperative '
      + 'phrasing.'))
})

test('WiringChecklist stamps per-port tick-off checkboxes', () => {
  const idx = wizSrc.indexOf('function WiringChecklist(')
  const stop = wizSrc.indexOf('\nfunction ', idx + 1)
  const chunk = wizSrc.slice(idx, stop > idx ? stop : idx + 3000)
  assert.ok(/data-testid="fixture-wiring-checklist"/.test(chunk),
    v('The checklist container must stamp '
      + 'data-testid="fixture-wiring-checklist".'))
  assert.ok(/data-testid="fixture-wiring-row"/.test(chunk),
    v('Each port row must stamp data-testid="fixture-wiring-row" with '
      + 'data-port-kind + data-port-id + data-connected attributes.'))
  assert.ok(/const \[done, setDone\] = useState\(\{\}\)/.test(chunk),
    v('WiringChecklist must track tick-off in local useState (not '
      + 'persisted on the record — just operator working memory '
      + 'while they wire).'))
  assert.ok(/data-testid="fixture-wiring-connected"/.test(chunk),
    v('Each tick-off checkbox must stamp '
      + 'data-testid="fixture-wiring-connected" for e2e.'))
})


// ── (4) SummaryStep mounts WiringChecklist + the shared map ────────

test('SummaryStep renders <WiringChecklist /> above the glowing map', () => {
  const idx = wizSrc.indexOf('function SummaryStep(')
  const stop = wizSrc.indexOf('\nfunction ', idx + 1)
  const chunk = wizSrc.slice(idx, stop > idx ? stop : idx + 4000)
  assert.ok(
    /<WiringChecklist\s+record=\{record\}\s+profile=\{profile\}\s+portmap=\{portmap\}\s*\/>[\s\S]{0,500}<GuidanceBlock\s+port=\{port\}/
      .test(chunk),
    v('SummaryStep must render <WiringChecklist record={record} '
      + 'profile={profile} portmap={portmap} /> IMMEDIATELY BEFORE '
      + '<GuidanceBlock port={port} /> — the imperative instructions '
      + 'read first, then the glowing map visualizes the same ports.'))
})

test('GuidanceBlock import stays intact (shared map — no fork)', () => {
  assert.ok(
    /import\s*\{\s*GuidanceBlock[^}]*\}\s*from\s*['"]\.\/EOATSetupWizard['"]/
      .test(wizSrc),
    v('ExternalFixtureWizard must still import { GuidanceBlock } from '
      + '"./EOATSetupWizard" — the glowing map is the ONE shared '
      + 'surface; no fork for the fixture wizard.'))
})


// ── (5) Clamp-sensor choice: the sensor-completion option IS the question ──

test('Vice completion\'s sensor option labels itself "A clamp sensor tells it"', () => {
  // The 2026-10-16 operator order asked us to CONFIRM the completion
  // step's sensor option covers the "is there a clamp sensor?"
  // decision. The per-type completion copy (shipped e9b1ea9 + the
  // "Recommended" default preselection shipped b6efa51) labels this
  // option "A clamp sensor tells it" for a vice. This pin documents
  // that no separate yes/no clamp-sensor step is needed; the sensor
  // option IS the choice.
  const vice = FIXTURE_TYPES.vice
  assert.equal(vice.completion.sensor.label, 'A clamp sensor tells it',
    v('Vice completion.sensor.label must read "A clamp sensor tells it" '
      + '— this IS the "is there a clamp sensor?" decision; no '
      + 'duplicate yes/no step.'))
  assert.ok(vice.completion.options.includes('sensor'),
    v('Vice completion.options must include "sensor" so the operator '
      + 'can pick it (default-preselected per b6efa51).'))
})
