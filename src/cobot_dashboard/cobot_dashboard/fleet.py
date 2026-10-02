"""Fleet discovery + per-robot status snapshot.

Two endpoints registered by dashboard_server:

  * GET /api/fleet/status — VIEW-tier. A small, purpose-built snapshot
    of THIS robot's identity + state / program / alarm. Other robots'
    fleet-home pages poll this at low frequency to render a card. It
    is NOT /api/state — that payload is heavy (joints, detections,
    scene graph). This one is bounded and shaped for a grid cell.

  * GET /api/fleet/peers — VIEW-tier. Enumerates advertised NeuRobots
    peers via `avahi-browse -rt _neurobots._tcp -p -t` and probes each
    peer's /api/fleet/status in parallel with a 1500 ms timeout.
    Peers that fail to respond return `online=False` — the fleet grid
    renders them as honest offline cards, never fabricated state.

Design invariants:

  * VIEW-tier: neither endpoint accepts a control payload. Fleet
    coordination lives on this surface EXCLUSIVELY as a discovery +
    read view. Start/Stop/Enable/E-STOP never appear here — the
    operator taps a card and works from that robot's own dashboard.
  * Fleet control is DEFERRED to v2: the surface here has ONE tap
    action (open the robot) and no other affordance. The registry
    stays a read model until the deferred design lands.
  * "Registry" == mDNS `_neurobots._tcp` peers, deduped by serial.
    No separate persistence — the source of truth is whatever avahi
    can see on the LAN this moment.
  * SELF is always in the list even when Avahi is silent, so the
    single-robot dashboard renders one honest card (or, more
    commonly, App.jsx skips the grid entirely — one is not a fleet).
"""
from __future__ import annotations

import asyncio
import subprocess
from typing import Any, Dict, List, Optional


# Timeouts kept tight so the fleet grid never blocks the whole app
# waiting for a slow LAN peer. 1.5 s covers a warm HTTPS + local
# handshake with generous headroom; anything slower is honestly
# offline from the operator's point of view.
_AVAHI_BROWSE_TIMEOUT_S = 2.0
_PEER_PROBE_TIMEOUT_S   = 1.5

# HTTPS scheme used for peer probes. Every dashboard serves on HTTPS
# only (see run_dashboard.sh + certs at /opt/cobot/certs/). Peer certs
# are self-signed under the NeuRobots root CA — we skip verification
# here because the trust boundary is "peer advertised _neurobots._tcp
# on this LAN," not "peer's cert chains to a public CA."
_PEER_SCHEME = 'https'


# ── Avahi discovery ──────────────────────────────────────────────────

def _avahi_browse_neurobots() -> str:
    """Return the raw `avahi-browse -rt _neurobots._tcp -p -t` output.
    Isolated for tests to monkey-patch. Empty string on any failure
    (avahi-daemon down, avahi-browse missing, timeout) so callers
    treat "no peers" and "no discovery available" identically."""
    try:
        proc = subprocess.run(
            ['avahi-browse', '-rt', '-p', '-t', '_neurobots._tcp'],
            capture_output=True, text=True,
            timeout=_AVAHI_BROWSE_TIMEOUT_S,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return ''
    return (proc.stdout or '') if proc.returncode == 0 else ''


def _parse_avahi_resolve_lines(raw: str) -> List[Dict[str, Any]]:
    """Parse avahi-browse -p output; return one record per `=` line.
    Each record: {interface, protocol, name, host, address, port, txt}.
    Duplicate (same-host-different-interface) rows are preserved here
    — the caller dedupes by (host, port) after unpacking TXT."""
    out: List[Dict[str, Any]] = []
    for line in (raw or '').splitlines():
        if not line.startswith('='):
            continue
        # Format: =;iface;proto;name;type;domain;host;address;port;txt
        # TXT rows are semicolon-safe (avahi escapes internal chars),
        # so a naive split(';') is stable for our four TXT keys.
        parts = line.split(';')
        if len(parts) < 10:
            continue
        _, iface, proto, name, _svc, _dom, host, address, port, txt = parts[:10]
        try:
            port_int = int(port)
        except (TypeError, ValueError):
            port_int = 0
        # TXT records are quoted whitespace-separated k=v pairs on the
        # avahi line. Peel the quotes; keep unknown keys.
        txt_map: Dict[str, str] = {}
        for tok in _split_txt_tokens(txt or ''):
            if '=' not in tok:
                continue
            k, v = tok.split('=', 1)
            txt_map[k.strip()] = v.strip()
        out.append({
            'interface': iface,
            'protocol':  proto,
            'name':      name,
            'host':      host,
            'address':   address,
            'port':      port_int,
            'txt':       txt_map,
        })
    return out


def _split_txt_tokens(txt: str) -> List[str]:
    """Split avahi's TXT field like `"a=1" "b=2 space"` into tokens.
    Handles a single level of double quotes; nothing exotic — avahi's
    own escaping is limited to shell-quoting."""
    tokens: List[str] = []
    buf: List[str] = []
    in_q = False
    for ch in txt:
        if ch == '"':
            if in_q:
                tokens.append(''.join(buf))
                buf = []
                in_q = False
            else:
                in_q = True
            continue
        if in_q:
            buf.append(ch)
    if buf:
        tokens.append(''.join(buf))
    return tokens


def _pick_advertised_host(rec: Dict[str, Any]) -> str:
    """Prefer the mDNS hostname when Avahi resolves it (portable across
    address changes); fall back to the raw address. Skip IPv6 link-
    local addresses (fe80::) because they don't route across subnets
    — the same pattern add-59 §688 uses for /api/identity."""
    host = str(rec.get('host') or '').strip()
    addr = str(rec.get('address') or '').strip()
    if host:
        return host
    if addr and not addr.lower().startswith('fe80:'):
        return addr
    return ''


def dedupe_peers_by_serial(records: List[Dict[str, Any]]
                            ) -> List[Dict[str, Any]]:
    """Fold Avahi's multi-interface duplicates down to one record per
    serial (TXT `serial=NR-XXXXXX`). When a serial appears on multiple
    interfaces, prefer the first record whose host resolves to a real
    hostname (not the raw IP), IPv4 over IPv6 link-local, and skip
    fe80:: link-local addresses per L288 (add-59 §688).
    Records missing a serial are dropped — an unnamed peer can't be
    rendered honestly on the grid."""
    by_serial: Dict[str, Dict[str, Any]] = {}
    for rec in records:
        serial = str((rec.get('txt') or {}).get('serial') or '').strip()
        if not serial:
            continue
        host = _pick_advertised_host(rec)
        if not host:
            continue
        # First writer wins for a given serial — Avahi returns the
        # highest-priority interface first in practice, but we don't
        # depend on that. If a later record has a resolvable host and
        # the earlier one didn't, upgrade.
        existing = by_serial.get(serial)
        if existing is None:
            by_serial[serial] = {**rec, 'resolved_host': host}
            continue
        if not existing.get('resolved_host') and host:
            by_serial[serial] = {**rec, 'resolved_host': host}
    return list(by_serial.values())


# ── Per-robot status shape (SELF and peer) ───────────────────────────

_STATUS_READY  = 'Ready'
_STATUS_RUNNING = 'Running'
_STATUS_ALARM  = 'Alarm'
_STATUS_IDLE   = 'Idle'
_STATUS_OFFLINE = 'Offline'

FLEET_STATUSES = (_STATUS_READY, _STATUS_RUNNING, _STATUS_ALARM,
                  _STATUS_IDLE, _STATUS_OFFLINE)


def derive_fleet_status(state: Dict[str, Any]) -> Dict[str, Any]:
    """Reduce STATE (or /api/state payload) to a fleet-card snapshot.
    Purpose-built shape — never a passthrough of STATE — so the fleet
    endpoint is cheap AND the schema stays stable across STATE growth.

    Status derivation ladder (first match wins):
      1. robot.alarm=True → 'Alarm'
      2. robot.program.state ∈ {2, 3} → 'Running'
      3. robot.connected=True AND robot.state_code==2 → 'Ready'
      4. robot.connected=True → 'Idle'
      5. otherwise → 'Offline' (no live driver)

    The final /api/fleet/peers layer may override the peer's status
    to 'Offline' when the probe itself times out — that's honest even
    if the peer's last-published status said Ready 10 seconds ago.
    """
    robot   = (state or {}).get('robot')   or {}
    prog    = robot.get('program')          or {}
    connected = bool(robot.get('connected', False))
    state_code = int(robot.get('state_code') or 0)
    alarm      = bool(robot.get('alarm', False))
    prog_state = int(prog.get('state') or 0)

    if alarm:
        status = _STATUS_ALARM
    elif prog_state in (2, 3):
        status = _STATUS_RUNNING
    elif connected and state_code == 2:
        status = _STATUS_READY
    elif connected:
        status = _STATUS_IDLE
    else:
        status = _STATUS_OFFLINE

    # Structured active alarm — {severity, code, ts, text} or None.
    active_alarm = robot.get('active_alarm')
    if not isinstance(active_alarm, dict):
        active_alarm = None

    # Current program surface — only render when a run is actually in
    # progress. project_id + task ARE the identifier pair on the
    # driver's ProjectState. name is intentionally omitted from the
    # driver-side event; the frontend can resolve name from the
    # program list if the grid ever needs it.
    current_program = None
    if prog_state in (2, 3):
        pid = prog.get('project_id')
        if pid:
            current_program = {
                'id':   str(pid),
                'task': prog.get('task') or None,
                'line': prog.get('line') or None,
            }

    return {
        'status':          status,
        'connected':       connected,
        'alarm':           active_alarm,
        'current_program': current_program,
    }


def compose_self_status(identity: Dict[str, Any],
                         state: Dict[str, Any]) -> Dict[str, Any]:
    """The /api/fleet/status response body. Small, stable, VIEW-tier."""
    ident_view = {
        'serial':        str(identity.get('serial') or ''),
        'model':         str(identity.get('model') or ''),
        'friendly_name': str(identity.get('friendly_name') or ''),
    }
    return {
        'identity': ident_view,
        **derive_fleet_status(state),
    }


# ── Peer probe (parallel, bounded) ───────────────────────────────────

async def _probe_one_peer(client: Any, host: str, port: int
                           ) -> Dict[str, Any]:
    """One peer probe. Returns the peer card:
      {url, host, port, identity, status, connected, alarm,
       current_program, online, probe_ms}
    online=False + status='Offline' when the HTTP fetch fails or the
    peer returns a non-2xx / unparseable body. Never raises."""
    import time
    url = f'{_PEER_SCHEME}://{host}:{port}'
    started = time.time()
    try:
        resp = await client.get(f'{url}/api/fleet/status',
                                 timeout=_PEER_PROBE_TIMEOUT_S)
        probe_ms = int((time.time() - started) * 1000)
        if resp.status_code != 200:
            return _offline_peer(url, host, port, probe_ms,
                                  reason=f'http_{resp.status_code}')
        body = resp.json()
        if not isinstance(body, dict):
            return _offline_peer(url, host, port, probe_ms,
                                  reason='body_not_dict')
        ident  = body.get('identity') if isinstance(body.get('identity'),
                                                     dict) else {}
        status = str(body.get('status') or _STATUS_OFFLINE)
        if status not in FLEET_STATUSES:
            status = _STATUS_OFFLINE
        return {
            'url':             url,
            'host':            host,
            'port':            port,
            'identity':        {
                'serial':        str(ident.get('serial') or ''),
                'model':         str(ident.get('model') or ''),
                'friendly_name': str(ident.get('friendly_name') or ''),
            },
            'status':          status,
            'connected':       bool(body.get('connected', False)),
            'alarm':           body.get('alarm')
                                 if isinstance(body.get('alarm'), dict)
                                 else None,
            'current_program': body.get('current_program')
                                 if isinstance(body.get('current_program'),
                                                dict)
                                 else None,
            'online':          True,
            'probe_ms':        probe_ms,
        }
    except Exception as e:
        probe_ms = int((time.time() - started) * 1000)
        return _offline_peer(url, host, port, probe_ms,
                              reason=f'exc_{type(e).__name__}')


def _offline_peer(url: str, host: str, port: int, probe_ms: int,
                   reason: str) -> Dict[str, Any]:
    """Honest offline card. The grid renders these — never fabricated
    state. `reason` lands in the technicalDetail slot the frontend
    exposes for support diagnosis; the operator sees only 'Offline'."""
    return {
        'url':             url,
        'host':            host,
        'port':            port,
        'identity':        {'serial': '', 'model': '',
                             'friendly_name': ''},
        'status':          _STATUS_OFFLINE,
        'connected':       False,
        'alarm':           None,
        'current_program': None,
        'online':          False,
        'probe_ms':        probe_ms,
        'offline_reason':  reason,
    }


async def probe_peers_parallel(peer_records: List[Dict[str, Any]]
                                ) -> List[Dict[str, Any]]:
    """Fetch each peer's /api/fleet/status in parallel. Bounded fan-out
    at 16 to keep a runaway-large LAN discovery from opening hundreds
    of sockets at once."""
    if not peer_records:
        return []
    try:
        import httpx
    except ImportError:
        # Without httpx we can't probe; return honest offline for each
        # advertised peer so the grid still renders (and the operator
        # sees a clue that the fleet layer is degraded).
        return [_offline_peer(
            f'{_PEER_SCHEME}://{_pick_advertised_host(r) or ""}:'
            f'{int(r.get("port") or 0)}',
            _pick_advertised_host(r) or '',
            int(r.get('port') or 0), 0, reason='httpx_missing')
                for r in peer_records]

    sem = asyncio.Semaphore(16)
    async with httpx.AsyncClient(verify=False, http2=False) as client:
        async def _one(rec: Dict[str, Any]):
            host = _pick_advertised_host(rec)
            port = int(rec.get('port') or 0)
            if not host or not port:
                return _offline_peer(
                    f'{_PEER_SCHEME}://{host}:{port}',
                    host, port, 0, reason='missing_host_or_port')
            async with sem:
                return await _probe_one_peer(client, host, port)
        return await asyncio.gather(*[_one(r) for r in peer_records])


# ── Composition entry points ─────────────────────────────────────────

async def compose_fleet_peers(self_identity: Dict[str, Any],
                               self_status: Dict[str, Any],
                               ) -> Dict[str, Any]:
    """Return the /api/fleet/peers response body:

      {
        'self':  { identity + fleet status of THIS robot },
        'peers': [ ... peers other than self, honest offline
                    entries included ... ],
        'total': int  # self + peers count, used by App.jsx to decide
                       #  whether to render the grid at all
      }
    """
    self_serial = str((self_identity or {}).get('serial') or '')
    records = _parse_avahi_resolve_lines(_avahi_browse_neurobots())
    deduped = dedupe_peers_by_serial(records)
    # Drop self out of the peer probe — the caller already knows this
    # robot's status without a round-trip.
    non_self = [r for r in deduped
                if str((r.get('txt') or {}).get('serial') or '') != self_serial]
    peer_cards = await probe_peers_parallel(non_self)

    # SELF is always presented in the same card shape as peers so the
    # frontend can render one component for the whole grid.
    self_card = {
        'url':             '',            # empty = "this dashboard"
        'host':            '',
        'port':            0,
        'identity':        self_status.get('identity') or {},
        'status':          self_status.get('status')  or _STATUS_OFFLINE,
        'connected':       bool(self_status.get('connected', False)),
        'alarm':           self_status.get('alarm'),
        'current_program': self_status.get('current_program'),
        'online':          True,
        'probe_ms':        0,
        'is_self':         True,
    }

    return {
        'self':  self_card,
        'peers': peer_cards,
        'total': 1 + len(peer_cards),
    }
