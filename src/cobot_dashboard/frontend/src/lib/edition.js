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
//
// 2026-09-04 OPERATOR SPLIT — Basic hides exactly THREE tabs:
//   * cameras_lidar     (SensorsLayout)
//   * part_recognition  (AdaptivePicking)
//   * safety_page       (SafetyPage — safety configuration only)
//
// The safety PAGE is gated. E-STOP in TopBar renders unconditionally
// in both editions and is safety-invariant (see
// SAFETY_INVARIANT_KEYS in edition.py). Keep this map byte-mirrored
// with cobot_dashboard/edition.py.
export const FEATURE_MAP = Object.freeze({
  monitor:            EDITION_BASIC,
  run_controls:       EDITION_BASIC,
  program_library:    EDITION_BASIC,
  wizard:             EDITION_BASIC,
  demonstration:      EDITION_BASIC,
  speed_control:      EDITION_BASIC,
  corner_smoothing:   EDITION_BASIC,
  deep_editor:        EDITION_BASIC,
  '3d_view':          EDITION_BASIC,
  io_panel:           EDITION_BASIC,
  event_log:          EDITION_BASIC,
  configure:          EDITION_BASIC,
  per_step_overrides: EDITION_BASIC,
  // Full-only (the three surfaces hidden on Basic).
  cameras_lidar:      EDITION_FULL,
  part_recognition:   EDITION_FULL,
  safety_page:        EDITION_FULL,
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
//
// The 'safety' TAB (SafetyPage — the safety configuration surface)
// maps to `safety_page` which IS gated to Full. This is distinct
// from the E-STOP BUTTON in TopBar, which is safety-invariant and
// renders unconditionally in both editions (see
// SAFETY_INVARIANT_KEYS in edition.py — no key in that set may
// appear in FEATURE_MAP).
export const TAB_TO_FEATURE = Object.freeze({
  monitor:          'monitor',
  programs:         'program_library',
  program:          'deep_editor',
  '3dview':         '3d_view',
  sensors:          'cameras_lidar',
  adaptive_picking: 'part_recognition',
  io:               'io_panel',
  safety:           'safety_page',
  event_log:        'event_log',
  configure:        'configure',
})
