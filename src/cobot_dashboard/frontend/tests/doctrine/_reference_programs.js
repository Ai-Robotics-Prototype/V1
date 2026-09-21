// Reference programs used by the doctrine suite.
//
// Shape mirrors the templates the wizard + PBD composer emit today.
// If you change a template, sync the reference here — the doctrine
// tests treat these as canonical.
//
// Every reference program's `steps` uses fresh integer ids so the
// resolvers can index them consistently.

// Pick & place (single station) — the base template every operator
// starts from.
export const REF_PICK_AND_PLACE = {
  name: 'ref/pick_and_place',
  steps: [
    { id: 1, action: 'move_home',   label: 'Move to home' },
    { id: 2, action: 'move_linear', label: 'Approach above pick',
      derived_from: 'pick', offset_z_mm: -80 },
    { id: 3, action: 'move_linear', label: 'Pick — contact',
      position_role: 'pick' },
    { id: 4, action: 'set_io',      label: 'Grip part',
      io_id: 1, value: true },
    { id: 5, action: 'wait',        label: 'Wait for grip',
      duration_s: 0.3 },
    { id: 6, action: 'move_linear', label: 'Retreat above pick',
      derived_from: 'pick', offset_z_mm: 100 },
    { id: 7, action: 'move_linear', label: 'Approach above place',
      derived_from: 'place', offset_z_mm: -60 },
    { id: 8, action: 'move_linear', label: 'Place — contact',
      position_role: 'place' },
    { id: 9, action: 'set_io',      label: 'Release',
      io_id: 1, value: false },
    { id: 10, action: 'move_linear', label: 'Retreat above place',
      derived_from: 'place', offset_z_mm: 100 },
    { id: 11, action: 'move_home',  label: 'Return to home' },
  ],
  config: {},
}

// Pallet — Palletize1 shape from the field audit. Has detect +
// move_to_pallet + loop + zero-init corner_tcp placeholder.
export const REF_PALLET = {
  name: 'ref/pallet',
  steps: [
    { id: 1,  action: 'move_home',      label: 'Move to home position' },
    { id: 2,  action: 'detect',         label: 'Find library part' },
    { id: 3,  action: 'move_linear',    label: 'Approach above pick',
      derived_from: 'pick', offset_z_mm: -80 },
    { id: 4,  action: 'move_linear',    label: 'Pick — contact',
      position_role: 'pick' },
    { id: 5,  action: 'set_io',         label: 'Grip part' },
    { id: 6,  action: 'wait',           label: 'Wait for vacuum seal' },
    { id: 7,  action: 'move_linear',    label: 'Retreat above pick',
      derived_from: 'pick', offset_z_mm: 200 },
    { id: 8,  action: 'move_to_pallet', label: 'Place at pallet slot' },
    { id: 9,  action: 'loop',           label: 'Pallet loop — 4 cycles' },
    { id: 10, action: 'move_home',      label: 'Return to home' },
  ],
  config: {
    pallet: { corner_tcp: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 } },
    pallet_place: { rows: 2, cols: 2, layers: 1 },
  },
}

// Machine tending — pick + machine load/unload station.
export const REF_TENDING = {
  name: 'ref/tending',
  steps: [
    { id: 1, action: 'move_home',   label: 'Move to home' },
    { id: 2, action: 'move_linear', label: 'Approach above pick',
      derived_from: 'pick', offset_z_mm: -80 },
    { id: 3, action: 'move_linear', label: 'Pick — contact',
      position_role: 'pick' },
    { id: 4, action: 'set_io',      label: 'Grip part' },
    { id: 5, action: 'move_linear', label: 'Retreat above pick',
      derived_from: 'pick', offset_z_mm: 120 },
    { id: 6, action: 'move_linear', label: 'Approach above machine load',
      derived_from: 'machine_load', offset_z_mm: -80 },
    { id: 7, action: 'move_linear', label: 'Machine load — contact',
      position_role: 'machine_load' },
    { id: 8, action: 'set_io',      label: 'Release + clamp' },
    { id: 9, action: 'move_linear', label: 'Retreat above machine load',
      derived_from: 'machine_load', offset_z_mm: 200 },
    { id: 10, action: 'wait',       label: 'Machine cycle', duration_s: 12 },
    { id: 11, action: 'move_home',  label: 'Return to home' },
  ],
  config: {},
}

// Programming-by-Demonstration composed draft (skeleton). PBD emits
// the same {action, derived_from, position_role} shape as the wizard.
export const REF_PBD_DEMO = {
  name: 'ref/pbd_demo',
  steps: [
    { id: 1, action: 'move_home',   label: 'Start home' },
    { id: 2, action: 'move_linear', label: 'Approach above pick',
      derived_from: 'pick', offset_z_mm: -60 },
    { id: 3, action: 'move_linear', label: 'Pick — contact',
      position_role: 'pick' },
    { id: 4, action: 'set_io',      label: 'Grip' },
    { id: 5, action: 'move_linear', label: 'Retreat above pick',
      derived_from: 'pick', offset_z_mm: 90 },
    { id: 6, action: 'move_linear', label: 'Approach above place',
      derived_from: 'place', offset_z_mm: -60 },
    { id: 7, action: 'move_linear', label: 'Place — contact',
      position_role: 'place' },
    { id: 8, action: 'move_home',   label: 'End home' },
  ],
  config: {},
}

// Every reference program the D1/D2 sweeps compose.
export const ALL_REFERENCE_PROGRAMS = [
  REF_PICK_AND_PLACE,
  REF_PALLET,
  REF_TENDING,
  REF_PBD_DEMO,
]
