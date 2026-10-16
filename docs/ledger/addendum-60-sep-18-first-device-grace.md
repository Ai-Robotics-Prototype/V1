# addendum-60 — 2026-09-18 — first-device grace + wizard-offers-not-blocks

> Field-directed hotfix on top of add-59 (sha b841827). Operator hit
> a bootstrap deadlock: with an empty paired-devices store, EVERY
> browser (including the operator's own PC) was gated into the wizard,
> and the pairing code had no already-paired dashboard to render on —
> the robot has no built-in screen. The wizard's copy even said
> "robot's screen." Impossible to bootstrap through the UI.

## §689 — Bootstrap-deadlock: first-device grace + optional wizard

### Root cause

Two bugs stacked:

1. **First-device paradox.** Add-58 §687 required a code shown on
   the paired display + entered on the tablet. With ZERO paired
   devices, there is no paired display, so the first device could
   only pair via `tools/cobot-pair-cli.py --name X` from localhost.
   That's fine for the operator on the Jetson but the operator's
   *remote PC browser* has no CLI path — it would just spin.
2. **Wizard-blocks-dashboard under dev posture.** Add-58's
   `App.jsx` gate refused to render the dashboard when
   `!isPaired() && !isLocalOrigin()`. Under
   `COBOT_PAIRING_ENFORCED=0` the backend serves every request
   unauthenticated anyway — the wizard's block was pure UI ahead
   of enforcement.

### Fix

**Backend (`cobot_dashboard/pairing.py` + `dashboard_server.py`):**

- `PairingStore.start()` returns `first_device: true` when
  `len(self._devices) == 0` at start time; false otherwise.
  Snapshotted into the pending-session dict too so the confirm
  handler sees the same view.
- `PairingStore.confirm()` skips code validation entirely when the
  device store is empty at confirm time. Once ANY device is paired,
  the branch is dead — every subsequent confirm requires the code.
  Threat model documented inline: physical-network-presence trust,
  operator pairs immediately during install, procedural mitigation
  is the story. No cryptographic mitigation is possible without
  either a printed cabinet QR (deferred board note) or a
  provisioning secret shipped with the robot.
- `/api/pair/start` response now carries
  `{ok, session_id, expires_in_s, device_name, first_device}`.
- `/api/pair/confirm` response carries `first_device: <bool>` so
  the wizard's Done page can render "you're the first device" copy
  when appropriate.

**Frontend (`components/DevicePairingWizard.jsx` + `App.jsx`):**

- `PairPage.start()` short-circuits when `first_device: true` on
  the start response: immediately POSTs `/api/pair/confirm` with
  `code: ''`, sets `status: 'first-device'` (green box, "You're the
  first device — connecting…"), and lands on the Done page. If a
  race puts another device in the store between start + confirm,
  the code path resumes with a friendly hint ("Another device just
  paired — enter the code from that screen.").
- `DevicePairingWizard` probes `/api/paired_devices` (auth-only) at
  mount. 200 → dev posture, `devPosture: true`, wizard renders
  with a "Continue without pairing" skip button + a small footnote
  explaining it. 401 → enforced, no skip button. Anything else
  leaves the posture undefined and the wizard defaults to no skip.
- `App.jsx` accepts an `onSkip` handler on the wizard; the skip
  path clears `needsPair` for the browser session (reload puts the
  wizard back so pairing stays discoverable).
- Code-page copy updated verbatim per operator directive:
  "Enter the code shown on the robot's screen" →
  "Enter the code shown on an already-connected NeuRobots screen."

**CLI (`tools/cobot-pair-cli.py`):**

- New `--reset-store` flag: deletes
  `/opt/cobot/paired_devices.json` (via `os.remove`, requires
  sudo), then runs `systemctl restart roboai-dashboard` so the
  in-memory `PairingStore` singleton reloads from an empty file.
  Documented as the "factory-reset the paired store" operator
  step the field directive requires.

### Store-reset command

```
sudo python3 ~/cobot_ws/tools/cobot-pair-cli.py --reset-store
```

Equivalent manual steps:

```
sudo rm -f /opt/cobot/paired_devices.json
sudo systemctl restart roboai-dashboard
```

After reset, the next `/api/pair/start` returns `first_device: true`;
the next `/api/pair/confirm` accepts codeless.

### QR path — deferred board note

The field directive named this explicitly: provisioning-time QR
printed on the cabinet as the stronger first-device proof for
customer units. That path replaces "physical LAN presence + empty
store" with "physical possession of a code sticker on the robot
itself." Not built this session. When it lands:

- Provisioning script mints a one-time provisioning token (32-byte
  random, hashed on disk); prints a QR to a label PDF for the
  cabinet.
- `/api/pair/confirm` accepts EITHER a matching provisioning-token
  scan OR a matching six-digit code from a paired display. First-
  device grace path is retired.
- CLI `--reset-store` regenerates the provisioning token +
  reprints the label.

The customer-unit story becomes: read the QR from the cabinet, no
CLI, no first-device grace, no LAN-presence trust window.

### Pins (24/24 green)

`src/cobot_dashboard/test/test_pairing_backend.py`:

- `test_first_device_flag_true_when_store_empty` — start returns
  `first_device: true` on empty store.
- `test_first_device_flag_false_after_first_pair` — after one
  confirm, next start returns `first_device: false`.
- `test_empty_store_accepts_codeless_confirm` — confirm with
  `code=''` succeeds when store empty, returns
  `first_device: true`, mints token.
- `test_non_empty_store_refuses_codeless_confirm` — after seeding
  one device, codeless confirms return `bad_code`; correct code
  still works and returns `first_device: false`.
- `test_first_device_grace_survives_middleware_grep` — server
  source carries `'first_device':` in both start and confirm
  response builders.
- Existing `test_pair_bad_code_is_single_shot` +
  `test_three_fails_locks_out` refactored to seed a first device
  before exercising the wrong-code refusal ladder.

### Operator gate — full re-run

The gate the directive asks for: factory-reset the paired store,
PC pairs as first-device codeless, tablet pairs second via the code
shown on the PC, revoke/re-pair clean. I execute this end-to-end
at the wire layer post-deploy in the report.

## Reference-tier updates this session

- `docs/LESSONS.md` — L323 appended (bootstrap-deadlock fix).
- `docs/STATE.md` — 2026-09-18 close block extended.
- No `tools/fork_registry.yaml` shape change; jog line numbers
  stable (I checked; no drift beyond the `identity.py` insertion
  which is pyflakes-safe).

## Files touched

```
mod  src/cobot_dashboard/cobot_dashboard/pairing.py
     — start() returns first_device; confirm() codeless when empty
mod  src/cobot_dashboard/cobot_dashboard/dashboard_server.py
     — /api/pair/{start,confirm} responses carry first_device
mod  src/cobot_dashboard/frontend/src/components/DevicePairingWizard.jsx
     — PairPage first-device short-circuit; DiscoverPage skip when
       devPosture: true; code-page copy update
mod  src/cobot_dashboard/frontend/src/App.jsx
     — onSkip handler wired to needsPair-off
mod  tools/cobot-pair-cli.py
     — --reset-store flag + _reset_store() helper
mod  src/cobot_dashboard/test/test_pairing_backend.py
     — 5 new pins + 2 existing tests seeded past first-device grace
new  docs/ledger/addendum-60-sep-18-first-device-grace.md
mod  docs/LESSONS.md
mod  docs/STATE.md
```
