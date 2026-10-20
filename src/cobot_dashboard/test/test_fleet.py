"""Pinned tests for the 2026-09-21 fleet home (Standard-Bots-style).

Invariants pinned here (module level — no fastapi lift needed):

  * derive_fleet_status ladder — first-match precedence per the
    directive: Alarm > Running > Ready > Idle > Offline.
  * dedupe_peers_by_serial — Avahi returns one row per interface;
    the fleet endpoint must collapse to one card per serial.
  * offline_peer helper — the honest offline card carries every
    field the frontend needs and NEVER fabricates identity strings.
  * compose_self_status — the /api/fleet/status body shape stays
    stable across STATE growth (bounded fields only).
  * fleet endpoints are in the unauth allowlist (VIEW-tier).
"""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SRC  = _HERE.parent
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from cobot_dashboard import fleet as _fleet  # noqa: E402


# ── derive_fleet_status ladder ────────────────────────────────────────

class DeriveStatusTests(unittest.TestCase):

    def test_alarm_wins_over_running(self):
        state = {'robot': {'connected': True, 'state_code': 2,
                             'alarm': True,
                             'program': {'state': 2}}}
        self.assertEqual(_fleet.derive_fleet_status(state)['status'],
                          'Alarm')

    def test_running_wins_over_ready(self):
        state = {'robot': {'connected': True, 'state_code': 2,
                             'alarm': False,
                             'program': {'state': 2}}}
        self.assertEqual(_fleet.derive_fleet_status(state)['status'],
                          'Running')

    def test_ready_when_connected_and_enabled(self):
        state = {'robot': {'connected': True, 'state_code': 2,
                             'alarm': False,
                             'program': {'state': 0}}}
        self.assertEqual(_fleet.derive_fleet_status(state)['status'],
                          'Ready')

    def test_idle_when_connected_but_not_enabled(self):
        state = {'robot': {'connected': True, 'state_code': 0,
                             'alarm': False,
                             'program': {'state': 0}}}
        self.assertEqual(_fleet.derive_fleet_status(state)['status'],
                          'Idle')

    def test_offline_when_not_connected(self):
        state = {'robot': {'connected': False, 'state_code': 0,
                             'alarm': False,
                             'program': {'state': 0}}}
        self.assertEqual(_fleet.derive_fleet_status(state)['status'],
                          'Offline')

    def test_current_program_only_when_running(self):
        state = {'robot': {'connected': True, 'state_code': 2,
                             'program': {'state': 2,
                                          'project_id': 'p1',
                                          'task': 'main',
                                          'line': 3}}}
        out = _fleet.derive_fleet_status(state)
        self.assertEqual(out['current_program'],
                          {'id': 'p1', 'task': 'main', 'line': 3})

    def test_current_program_none_when_not_running(self):
        state = {'robot': {'connected': True, 'state_code': 2,
                             'program': {'state': 0,
                                          'project_id': 'p1'}}}
        self.assertIsNone(_fleet.derive_fleet_status(state)['current_program'])


# ── dedupe_peers_by_serial ────────────────────────────────────────────

class DedupeTests(unittest.TestCase):

    def test_multi_interface_collapses_to_one(self):
        # Same serial on wired + wifi + docker interfaces — the
        # grid must render one card, not three.
        recs = [
            {'host': 'a.local', 'address': '192.168.2.10', 'port': 8080,
             'txt': {'serial': 'NR-1'}},
            {'host': 'a.local', 'address': '192.168.1.10', 'port': 8080,
             'txt': {'serial': 'NR-1'}},
            {'host': 'a.local', 'address': '172.17.0.1', 'port': 8080,
             'txt': {'serial': 'NR-1'}},
        ]
        deduped = _fleet.dedupe_peers_by_serial(recs)
        self.assertEqual(len(deduped), 1)
        self.assertEqual(deduped[0]['txt']['serial'], 'NR-1')

    def test_missing_serial_dropped(self):
        recs = [
            {'host': 'a.local', 'address': '10.0.0.1', 'port': 8080,
             'txt': {}},  # no serial
        ]
        self.assertEqual(_fleet.dedupe_peers_by_serial(recs), [])

    def test_different_serials_kept_separately(self):
        recs = [
            {'host': 'a.local', 'address': '10.0.0.1', 'port': 8080,
             'txt': {'serial': 'NR-1'}},
            {'host': 'b.local', 'address': '10.0.0.2', 'port': 8080,
             'txt': {'serial': 'NR-2'}},
        ]
        serials = sorted(r['txt']['serial']
                          for r in _fleet.dedupe_peers_by_serial(recs))
        self.assertEqual(serials, ['NR-1', 'NR-2'])


# ── Offline card honesty ──────────────────────────────────────────────

class OfflineCardTests(unittest.TestCase):

    def test_offline_card_shape(self):
        card = _fleet._offline_peer(
            'https://x:8080', 'x', 8080, 42, reason='exc_ConnectTimeout')
        self.assertFalse(card['online'])
        self.assertEqual(card['status'], 'Offline')
        # Identity must be empty strings — NEVER fabricated.
        self.assertEqual(card['identity']['serial'], '')
        self.assertEqual(card['identity']['friendly_name'], '')
        self.assertEqual(card['identity']['model'], '')
        # Reason is present for support diagnosis, not for the
        # operator (frontend renders "Offline" + a hostname note).
        self.assertEqual(card['offline_reason'], 'exc_ConnectTimeout')
        self.assertIsNone(card['alarm'])
        self.assertIsNone(card['current_program'])


# ── compose_self_status body shape ───────────────────────────────────

class SelfStatusShapeTests(unittest.TestCase):

    def test_bounded_fields_only(self):
        # If /api/state grows a new field, the fleet body MUST NOT
        # leak it. This pin catches a passthrough regression.
        ident = {'serial': 'NR-1', 'model': 'S10-140',
                  'friendly_name': 'line-a'}
        big_state = {
            'robot': {'connected': True, 'state_code': 2,
                       'program': {'state': 0}},
            'joints': {'positions': [0, 0, 0, 0, 0, 0]},  # heavy
            'detections': [{'x': 1}, {'x': 2}],           # heavy
            'scene_graph': {'objects': list(range(100))}, # heavy
        }
        out = _fleet.compose_self_status(ident, big_state)
        self.assertEqual(set(out.keys()),
                          {'identity', 'status', 'connected',
                           'alarm', 'current_program'})
        self.assertNotIn('joints', out)
        self.assertNotIn('detections', out)
        self.assertNotIn('scene_graph', out)


# ── compose_fleet_peers drops self, keeps others ─────────────────────

class ComposePeersTests(unittest.TestCase):

    def test_self_dropped_from_peer_probe(self):
        # Monkey-patch avahi + probe so this test doesn't hit
        # the LAN. Simulate 2 records (self + one peer) and
        # verify self is NOT probed.
        orig_browse = _fleet._avahi_browse_neurobots
        orig_probe  = _fleet.probe_peers_parallel

        def fake_browse():
            return (
                '=;eth;IPv4;NR-SELF;_neurobots._tcp;local;'
                'self.local;10.0.0.1;8080;'
                '"serial=NR-SELF" "model=S10-140" "name=self" "api_version=1"\n'
                '=;eth;IPv4;NR-PEER;_neurobots._tcp;local;'
                'peer.local;10.0.0.2;8080;'
                '"serial=NR-PEER" "model=S10-140" "name=peer" "api_version=1"\n'
            )
        probed_serials = []

        async def fake_probe(records):
            for r in records:
                probed_serials.append(r['txt']['serial'])
            return [_fleet._offline_peer('https://peer.local:8080',
                                          'peer.local', 8080, 5,
                                          reason='test')
                    for _ in records]

        _fleet._avahi_browse_neurobots = fake_browse
        _fleet.probe_peers_parallel    = fake_probe
        try:
            self_status = _fleet.compose_self_status(
                {'serial': 'NR-SELF', 'model': 'S10-140',
                 'friendly_name': 'self'},
                {'robot': {'connected': True, 'state_code': 2,
                            'program': {'state': 0}}})
            out = asyncio.run(
                _fleet.compose_fleet_peers(
                    {'serial': 'NR-SELF'}, self_status))
            self.assertEqual(probed_serials, ['NR-PEER'],
                             'self must NOT be in the peer probe list')
            self.assertEqual(out['total'], 2,   # self + one peer
                              'total counts self + probed peers')
            self.assertTrue(out['self'].get('is_self'))
            self.assertEqual(len(out['peers']), 1)
        finally:
            _fleet._avahi_browse_neurobots = orig_browse
            _fleet.probe_peers_parallel    = orig_probe


# ── /api/fleet/ is in the unauth allowlist (VIEW-tier) ───────────────

class UnauthAllowlistTests(unittest.TestCase):

    def test_fleet_prefix_is_unauth(self):
        # Grep the server source rather than importing the app —
        # importing the FastAPI app pulls in ROS2 etc which we
        # don't want in a unit test.
        src = (_SRC / 'cobot_dashboard' / 'dashboard_server.py').read_text()
        self.assertIn("'/api/fleet/'", src,
            "/api/fleet/ must be in _UNAUTH_PATH_PREFIXES so the "
            "grid renders under AUTH_ENFORCED without a token.")


if __name__ == '__main__':
    unittest.main()
