// Edition mirror — MUST stay byte-equal to
// cobot_dashboard/edition.py's FEATURE_MAP and SAFETY_INVARIANT_KEYS.
// test_edition_matrix.py compares the two so drift fails at commit
// time. Do not add a feature key here without also adding it there;
// the same rule applies in reverse.

export const EDITION_BASIC = 'basic'
export const EDITION_FULL  = 'full'
export const EDITIONS      = [EDITION_BASIC, EDITION_FULL]

// Safety, delete integrity, refusal gates, and codegen behaviour are
// edition-INDEPENDENT — identical in both editions. These keys are
// hard-rejected by the map loader; a runtime attempt to gate them
// (via a hardcoded key in a Guard component, for instance) is a bug
// the regression test catches on the backend side.
export const SAFETY_INVARIANT_KEYS = Object.freeze([
  'estop',
  'safety_interlocks',
  'delete_integrity',
  'codegen',
  'refusal_gates',
])

// feature_key -> minimum edition
export const FEATURE_MAP = Object.freeze({
  // basic tier (operator tablet)
  monitor:          EDITION_BASIC,
  run_controls:     EDITION_BASIC,
  program_library:  EDITION_BASIC,
  wizard:           EDITION_BASIC,
  demonstration:    EDITION_BASIC,
  speed_control:    EDITION_BASIC,
  corner_smoothing: EDITION_BASIC,
  // full tier (our PC + advanced)
  deep_editor:        EDITION_FULL,
  '3d_view':          EDITION_FULL,
  cameras_lidar:      EDITION_FULL,
  part_recognition:   EDITION_FULL,
  io_panel:           EDITION_FULL,
  event_log:          EDITION_FULL,
  configure:          EDITION_FULL,
  per_step_overrides: EDITION_FULL,
})

// Load-time validation mirroring backend's _validate_map.
function _validateMap() {
  for (const k of SAFETY_INVARIANT_KEYS) {
    if (k in FEATURE_MAP) {
      throw new Error(
        `edition.js: safety-invariant key ${JSON.stringify(k)} `
        + `must not appear in FEATURE_MAP`)
    }
  }
  for (const [k, v] of Object.entries(FEATURE_MAP)) {
    if (!EDITIONS.includes(v)) {
      throw new Error(
        `edition.js: FEATURE_MAP[${JSON.stringify(k)}]=${JSON.stringify(v)} `
        + `is not a valid edition`)
    }
  }
}
_validateMap()

export function isFeatureEnabled(featureKey, edition) {
  if (!EDITIONS.includes(edition)) return false
  const minEd = FEATURE_MAP[featureKey]
  if (minEd === undefined) return true          // unknown = basic-safe
  if (minEd === EDITION_BASIC) return true
  return edition === EDITION_FULL
}

// Tab id -> feature key. The TopBar filters against this so basic
// devices don't render Full tabs at all (absent, not disabled-greyed).
export const TAB_TO_FEATURE = Object.freeze({
  monitor:          'monitor',
  programs:         'program_library',
  program:          'deep_editor',
  '3dview':         '3d_view',
  sensors:          'cameras_lidar',
  adaptive_picking: 'part_recognition',
  io:               'io_panel',
  // safety is edition-INDEPENDENT — E-STOP + interlocks must always
  // be reachable. Do NOT add 'safety' to FEATURE_MAP; leaving it
  // unmapped lets isFeatureEnabled return true for every edition.
  safety:           'safety',
  event_log:        'event_log',
  configure:        'configure',
})
