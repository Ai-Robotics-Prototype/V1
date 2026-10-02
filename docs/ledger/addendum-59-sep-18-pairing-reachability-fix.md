# addendum-59 — 2026-09-18 — pairing reachability fix

> Field-directed hotfix on top of add-58 (sha 3b89f7e). Operator
> tested the wizard on a real tablet, hit "site cannot be reached"
> at 192.168.2.246 — the tablet was on the WiFi subnet
> (192.168.1.x) where the wired leg is unroutable. Discovery has
> to know the WiFi IP exists AND has to prove reachability from
> the client's side before offering an address.

## §688 — Client-side reachability + honest cross-network copy

### Field evidence

Real tablet at `https://192.168.2.246:8080` → `ERR_ADDRESS_UNREACHABLE`
in the browser. The Jetson had both 192.168.2.246 (eno1, wired) and
192.168.1.143 (wlP1p1s0, WiFi lease) live. The tablet had no way to
know the WiFi address existed. mDNS advertisement was already
publishing both (add-58 §687 verified `avahi-browse -rt` returning
4 interface rows), but the tablet had no way to consume that either
— the wizard's discovery relied on a small hardcoded name list that
worked only when the operator happened to type an address that landed.

### Root cause

1. **Discovery didn't enumerate the robot's own interface list.**
   The Avahi advertisement had it; the wizard didn't consult it.
2. **No client-side reachability filter.** Even if the robot said "I
   listen on X, Y, Z", the wizard would show all three whether or
   not the tablet could route to them.
3. **Wrong copy on unreachable-address entry.** "Could not reach that
   address." doesn't help the operator understand this is a network
   topology issue rather than a wrong-address issue.

### Fix

`identity.py` gains `enumerate_advertised_hosts()` — reads
`hostname -I` at request time, returns `{hostname, mdns_host,
addresses}` with IPv6 link-local (`fe80::`) filtered out (never
routes across subnets, would just clutter the wizard's unreachable
list). Called on every `/api/identity` request; the wizard sees a
live list, not a stale snapshot.

`dashboard_server.py:/api/identity` returns
`{serial, model, friendly_name, network: {hostname, mdns_host,
addresses, port}}`. Port is the incoming request's port so the
wizard doesn't have to guess.

`DevicePairingWizard.jsx:DiscoverPage` rewrite:

1. Fetch `/api/identity` from the current origin (which loaded the
   wizard — so it's reachable by construction).
2. Build a candidate host:port set: current origin + `mdns_host:port`
   + every `address:port` from the network payload.
3. Probe every candidate in PARALLEL from the client's own side via
   `probeRobotIdentity(host)`.
4. Split settled results into `reachable` (id.serial present) and
   `unreachable`.
5. Render `reachable` as clickable rows. The current-origin row is
   sorted to the top and tagged `connected here` so a race that
   made the parallel probe of the same origin fail cannot leave the
   operator with zero options.
6. Render `unreachable` as a greyed-out block with the exact
   operator-approved copy: **"This address didn't respond from your
   device — it may be on a different network than this tablet."**
7. Address-entry fallback: on probe failure, use the same
   verbatim copy — no more "Could not reach that address."

The copy is exported as `UNREACHABLE_COPY` from
`DevicePairingWizard.jsx` — a single site. `test_wizard_carries_
unreachable_copy_verbatim` pins the string byte-for-byte so a
paraphrase drift fails the suite.

### Pins landed

`src/cobot_dashboard/test/test_pairing_backend.py`:

- `test_identity_enumerates_interface_addresses` — module-level:
  `enumerate_advertised_hosts()` returns dict with `mdns_host`
  ending `.local`, `addresses` as list, no `fe80::` link-local.
- `test_identity_endpoint_shape_grep_pins_network_payload` — server
  side: response carries `network.{addresses, mdns_host, port}`.
- `test_wizard_carries_unreachable_copy_verbatim` — the exact copy
  string is present under `export const UNREACHABLE_COPY`.
- `test_wizard_probes_client_side_and_splits_reachable` — DiscoverPage
  calls `/api/identity`, iterates `network.addresses`, renders both
  the "Reachable" section header and the "Advertised but not
  reachable" section header.

19/19 pairing pins green. fork_lint clean. Frontend eslint clean.

### What did NOT change

Backend `/api/pair/*` — unchanged wire shape. Add-57 + add-58
security surfaces intact. Enforcement flag stays OFF this session.
Avahi advertisement unchanged (it was already correct — the fix is
that the wizard now consumes it via `/api/identity` rather than a
static hardcoded name list).

## Reference-tier updates this session

- `docs/LESSONS.md` — L322 appended (pairing reachability fix).
- `docs/STATE.md` — 2026-09-18 session-close block extended.
- `tools/fork_registry.yaml` — jog line refresh if drift.

## Files touched

```
mod  src/cobot_dashboard/cobot_dashboard/identity.py
     — enumerate_advertised_hosts()
mod  src/cobot_dashboard/cobot_dashboard/dashboard_server.py
     — /api/identity returns {..., network:{...}}
mod  src/cobot_dashboard/frontend/src/components/DevicePairingWizard.jsx
     — DiscoverPage rewrite + UNREACHABLE_COPY export
mod  src/cobot_dashboard/test/test_pairing_backend.py
     — 4 new pins (identity payload, wire shape, wizard copy,
       wizard probe/filter behavior)
new  docs/ledger/addendum-59-sep-18-pairing-reachability-fix.md
mod  docs/LESSONS.md
mod  docs/STATE.md
```
