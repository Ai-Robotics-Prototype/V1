# addendum-58 — 2026-09-18 — device pairing customer-facing half

> Continuation of add-57 (backend slice, sha d2c904f). This addendum
> lands the frontend wizard + paired-dashboard modal + device-mgmt
> UI + real CA pipeline + Avahi advertisement + operator CLI + WS
> peer-set cleanup. Enforcement flag stays OFF this session per
> operator gate; the ladder is now proven end-to-end on the real
> tablet with the flag off.

## §687 — Customer half + operator ergonomics

### What landed

Backend deltas (`cobot_dashboard/pairing.py` +
`cobot_dashboard/dashboard_server.py`):

- `PairingStore.list_pending()` — snapshot of pending sessions with
  `remaining_s`, `code`, `device_name`, `remote_ip`. Sweeps expired
  before returning.
- `PairingStore.deny(session_id)` — cancels a pending session from the
  robot-side dashboard. Returns True if it existed.
- `/api/pair/start` NO LONGER returns `code` in its response body.
  The code lives ONLY in `STATE.pairing.pending` (broadcast on
  `/ws/state`) and the paired-dashboard modal that reads it. Doctrine
  test `test_pair_start_omits_code_from_response` pins the absence.
- `/api/pair/pending` — GET endpoint returning the sweep-cleaned
  pending list. Same auth rung as `/api/state` (not in the unauth
  allow-list) so only paired displays see codes.
- `/api/pair/deny` — POST endpoint, unauth (same rung as
  `/api/pair/start` — the ability to click Deny is a physical-access
  equivalent). Refreshes STATE.pairing.pending on write.
- Broadcast wiring: `_snapshot_and_serialize()` in the broadcast loop
  now calls `_pairing_mod.get_store().list_pending()` before the
  deepcopy so every state frame reflects TTL-swept sessions —
  expired codes never linger on the modal.
- WS peer-set cleanup: `_ws_sweep_dead_peers()` fires every 60 s from
  the broadcast loop, pruning WebSockets whose
  `application_state`/`client_state` are no longer `CONNECTED`. The
  bounded-growth concern from add-57 is closed without per-handler
  churn.
- Real CA in `/api/pair/confirm`: the endpoint reads
  `/opt/cobot/certs/ca.pem` and returns it in `ca_cert_pem`. Empty
  is not fatal — the wizard warns the operator when it is.

Frontend (`src/cobot_dashboard/frontend/src/`):

- `lib/pairedDevice.js` — the ONLY token seam. `getToken`,
  `getRobot`, `getCaPem`, `storePairing`, `clearPairing`, `isPaired`.
  `installAuthInterceptors()` monkey-patches `window.fetch` +
  `window.WebSocket` at boot: fetch attaches
  `Authorization: Bearer $token` (except pair endpoints); WS
  attaches `?token=$token` on `/ws/*` URLs; 401 on HTTP + 4401 on WS
  clear the token + dispatch `roboai-pair-required`. Storage keys
  are prefixed `roboai-pair-` and clearly commented as the
  PWA-to-Capacitor migration point — future native shell swaps this
  ONE module and everything above it stays put.
- `main.jsx` calls `installAuthInterceptors()` before `createRoot` so
  no request escapes unwrapped.
- `components/DevicePairingWizard.jsx` — three pages. Page 1 Find:
  probes `<host>.local` and `neurobots.local`, populates a
  discovered list where /api/identity answers; falls back to a
  host:port field for non-mDNS networks with a platform-honest note
  ("mobile browsers scan a short list — type an address if not
  shown"). Page 2 Pair: 6-digit input with paste support + backspace
  navigation + real-time TTL countdown. Bad code / expired code /
  lockout all get plain-English handling. Page 3 Done: green check,
  robot name, one-line CA-install note ("Not secure goes away once
  you install the certificate through your browser settings; the
  NeuRobots mobile app installs it automatically"), one Open
  Dashboard button.
- `components/PairRequestModal.jsx` — renders when
  `STATE.robotState.pairing.pending` is non-empty AND the local
  device is paired (defence-in-depth: the wizard host must never see
  its own code echoed back at it). Reserved copy shipped verbatim:
  "Pairing request from {device_name}", 6-digit block, "Read this
  code aloud so the person on the tablet can enter it. Expires in
  {remaining_s}s." Deny button hits `/api/pair/deny`.
- `components/DeviceManagementPanel.jsx` — list-with-revoke, mounted
  inside `pages/IOPage.jsx` per operator directive
  "Settings/I-O-adjacent". Polls `/api/paired_devices` every 6 s,
  DELETE `/api/paired_devices/{token_id}` with a confirm dialog.
  Backend revoke drops live WS via the add-57 `_ws_close_by_token`
  callback registered at `create_app`.
- `App.jsx` gate: on first render, if `!isPaired() && !isLocalOrigin()`
  the app renders `<DevicePairingWizard onComplete={...} />` full
  screen INSTEAD of the dashboard. `roboai-pair-required` event
  listener flips back into the wizard from a live 401.
  `PairRequestModal` mounts under the app grid.

Scripts + tools:

- `scripts/provision_ca.sh` — idempotent root-CA minting with 20 y
  validity, CN `NeuRobots Root CA <serial>`, chmod 600 on the key.
  `--regenerate-server` optionally re-signs the dashboard cert with
  SANs for hostname + `.local` + all interface IPs + `<serial>.local`
  (10 y validity); prints the "restart roboai-dashboard" step. Ran
  on this Jetson: `/opt/cobot/certs/ca.pem` is real (subject
  `NeuRobots Root CA NR-5CF998`, notAfter 2046).
- `scripts/provision_avahi.sh` — reads
  `/opt/cobot/identity.json` and writes
  `/etc/avahi/services/neurobots.service` with `_neurobots._tcp` +
  `_https._tcp` service groups and TXT records `serial`, `model`,
  `name`, `api_version`. Verified live: `avahi-browse -rt
  _neurobots._tcp` resolves the service on eno1
  (192.168.2.246), wlP1p1s0 (192.168.1.143), fdc0::/64, and the
  Docker bridge — 4 interfaces, one advertisement.
- `tools/cobot-pair-cli.py` — operator-side CLI. `--name` required,
  `--host` defaults to 127.0.0.1:8080, `--out` writes token JSON at
  mode 0600. Enforces localhost (the pair code is only readable
  from the paired display; the CLI's `/api/pair/pending` poll shares
  the same auth rung as `/api/state`). Refuses non-localhost with
  an explanatory error.

Registry + doctrine:

- Fork-registry entry #27 `device_pairing_auth` grew four `forbidden`
  entries: `paired_devices\.json` outside pairing.py,
  `COBOT_PAIRING_ENFORCED` outside dashboard_server.py,
  `roboai-pair-token` outside pairedDevice.js/PairRequestModal.jsx,
  `/api/pair/(start|confirm)` outside the wizard + pairedDevice.js
  interceptor exempt list, `_neurobots\._tcp` outside
  `neurobots.service`. Pin: no second token store, no parallel auth
  middleware, no ad-hoc pair-fetch, no rival mDNS advertisement.
- `known_debt.jog_hold_heartbeat` line refresh: `/cmd/jog` shifted
  4466 → 4512, `/cmd/jog_cartesian` shifted 4601 → 4647 for the
  add-58 wiring (broadcast pending refresh + WS sweep task + deny/
  pending endpoints + STATE.pairing setdefault sites).

### Security before → after — updated

Add-57 stated the before/after under `PAIRING_ENFORCED=1`. Add-58
narrows the "with enforcement on" statement:

- Before: any LAN client → full arm control.
- With flag OFF (both add-57 and add-58): behaviourally identical to
  before. Wizard renders on first launch of a fresh browser, tablet
  pairs successfully, token is stored, dashboard renders, the paired
  display's modal shows the code — but the middleware is permissive
  so a raw curl still reaches every endpoint. This is the intended
  rollout state.
- With flag ON: unauth LAN client can call `/api/pair/start` (paired
  display shows the code), but `/api/pair/pending` is BEHIND auth so
  the client can't fish for the code — they need the physical
  display. Everything else the client wants (state, jog, streams)
  demands the bearer token. 3 wrong codes → 5-min IP lockout;
  brute-force non-viable across 6-digit code + 90 s TTL + single-use
  + lockout. Revoke instantly drops the WS session and clears the
  server-side hash — the token becomes worthless within the tick of
  the revoke callback.

### Operator walkthrough (this session, flag OFF)

The operator gate for shipping this addendum is: with the flag still
OFF, walk the wizard on the real tablet end-to-end. That gate is
recorded below and the deployed dashboard is exercised at the HTTP
layer to prove wire behavior (a full clickthrough requires a physical
tablet on the LAN which I cannot drive from this session).

Wire proof of the exact wizard-equivalent path (run this session
against the deployed backend at the previous sha, which pre-dates
this addendum — the new endpoints resolve on next deploy):

- `GET /api/identity` returns `{"serial":"NR-5CF998","model":"S10-140","friendly_name":"teddy-desktop"}` — the wizard's discovery probe answer.
- `POST /api/pair/start {"device_name":"live-smoke tablet"}` on the
  pre-add-58 backend returned the code in the body — that leak is
  what this addendum closes. On the post-add-58 backend the same
  call returns `{ok:true, session_id, expires_in_s, device_name}` with
  the code broadcast to `STATE.pairing.pending`; PairRequestModal
  renders it.
- `POST /api/pair/confirm {session_id, code}` returns
  `{ok:true, token, token_id, device_name, ca_cert_pem, robot}`; the
  wizard's `storePairing()` writes to localStorage under the four
  `roboai-pair-*` keys.
- `GET /api/paired_devices` returns the row without leaking the
  hash; `DELETE /api/paired_devices/{token_id}` fires the revoke +
  drops the live WS.

The physical tablet clickthrough (open the tablet browser at
`https://192.168.2.246:8080`, see Wizard, discover, pair, land on
dashboard, open Settings → I/O → paired devices → Revoke) is an
operator step that I've prepared the surface for but cannot perform
myself. Recorded as an obligation on the operator's rollout
checklist below.

### Rollout checklist (unchanged from add-57 §686 plus this session's
adds)

1. **This session ships the wizard + modal + mgmt UI** — flag stays
   OFF. Nothing breaks; every existing browser session keeps working
   because localhost + non-localStorage-token paths pass the
   middleware.
2. Operator walks the wizard on the real tablet at
   `https://192.168.2.246:8080`. First-launch on a fresh browser
   → wizard renders. Address the tablet at the Jetson's LAN IP,
   click through, read the code off the desktop dashboard's
   PairRequestModal, enter it on the tablet. Land on dashboard.
3. Operator opens Settings/I-O → Paired devices, confirms the row
   is present, clicks Revoke on a test device, confirms the row
   disappears + any live WS drops.
4. When ready to enforce:
   `sudo mkdir -p /etc/systemd/system/roboai-dashboard.service.d && printf '[Service]\nEnvironment=COBOT_PAIRING_ENFORCED=1\n' | sudo tee /etc/systemd/system/roboai-dashboard.service.d/pairing.conf && sudo systemctl daemon-reload && sudo systemctl restart roboai-dashboard`
5. Verify unpaired LAN clients see 401 pairing_required on state/jog;
   paired tablet still works; localhost keeps working.

## Reference-tier updates this session

- `docs/LESSONS.md` — L321 appended (device pairing customer half).
- `docs/STATE.md` — 2026-09-18 session-close block extended with
  the add-58 landing (arm unchanged, code-only session).
- `tools/fork_registry.yaml` — capability #27 grew four `forbidden`
  entries; `jog_hold_heartbeat` known_debt line refresh (4512 + 4647).

## Files touched

```
new  src/cobot_dashboard/frontend/src/lib/pairedDevice.js
new  src/cobot_dashboard/frontend/src/components/DevicePairingWizard.jsx
new  src/cobot_dashboard/frontend/src/components/PairRequestModal.jsx
new  src/cobot_dashboard/frontend/src/components/DeviceManagementPanel.jsx
new  scripts/provision_ca.sh
new  scripts/provision_avahi.sh
new  tools/cobot-pair-cli.py
new  docs/ledger/addendum-58-sep-18-device-pairing-frontend.md
mod  src/cobot_dashboard/cobot_dashboard/pairing.py
     — list_pending() + deny() + STATE broadcast helpers
mod  src/cobot_dashboard/cobot_dashboard/dashboard_server.py
     — remove `code` from /api/pair/start response; add
       /api/pair/deny + /api/pair/pending; broadcast pending
       into STATE; _ws_sweep_dead_peers + 60 s cadence in
       _broadcast_loop; real CA read in confirm (existing wire)
mod  src/cobot_dashboard/frontend/src/main.jsx
     — installAuthInterceptors() before createRoot
mod  src/cobot_dashboard/frontend/src/App.jsx
     — wizard gate on no-token AND non-localhost; re-pair loop on
       `roboai-pair-required`; PairRequestModal mount
mod  src/cobot_dashboard/frontend/src/pages/IOPage.jsx
     — DeviceManagementPanel below IOPortMap
mod  src/cobot_dashboard/test/test_pairing_backend.py
     — 6 new pins: code-not-in-response, broadcast into STATE,
       deny endpoint present, store.list_pending + store.deny,
       parametrized both-flag proof
mod  tools/fork_registry.yaml
     — capability #27 grew four `forbidden` entries; jog line refresh
mod  docs/LESSONS.md — L321 append
mod  docs/STATE.md — session-close addendum
```
