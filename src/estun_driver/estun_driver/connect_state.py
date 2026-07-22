"""Connection-lifecycle state machine for the Estun driver.

Owns the connect / grace / probe / ready / cooldown transitions that
sit between the raw WebSocket layer and the subscribe burst. Split into
its own module so the state machine can be unit-tested without a live
controller or a running ROS node — see test/test_connect_state.py.

The whole reason this exists is a boot-race we caused on the controller:
C2Control starts its WebSocket server about 9 seconds into boot, well
before the Robot plugin's real-time loop has populated its joint vectors
(EtherCAT slaves are still reaching OP). The old driver retried the
connection every 2 seconds, so it landed ~16 ms after the port opened
and immediately blasted the full subscribe burst including RobotPosture
and RobotCoordinate. The publish path indexed an empty Vector<double>
in Robot::step(), firmware called exitProcess, the service died, systemd
brought it right back up, and our 2 s retry re-crashed it — a boot loop
we caused. On boots where the client (posture.py, a browser) happens to
land ~2 s later, the same subscribes are fine.

States
------
DISCONNECTED  — no WS. Reconnect timer honours ``next_backoff_s``.
INITIALIZING  — WS open. Only the ``probe`` subscription set is on;
                we send a lightweight readiness probe every
                ``probe_interval_s`` and wait for a valid answer.
                Full topic subscribe (posture, coordinate, …) is
                withheld until the probe answers AND the grace period
                has elapsed.
READY         — full subscribe burst sent; normal telemetry mirror.
COOLDOWN      — crash-loop tripped (>= ``crashloop_threshold`` connect →
                disconnect cycles inside ``crashloop_window_s``). Skip
                connect attempts entirely for ``crashloop_cooldown_s``.

Exponential backoff (base 2, capped at ``backoff_max_s``) applies to
connect failures. Backoff only resets to ``backoff_initial_s`` once a
session has stayed in READY for ``backoff_reset_healthy_s``; a
brief-lived healthy session doesn't count.
"""

from __future__ import annotations

import time
from typing import Callable, Optional, Tuple


class ConnectStateMachine:
    DISCONNECTED = 'disconnected'
    INITIALIZING = 'initializing'
    READY        = 'ready'
    COOLDOWN     = 'cooldown'

    def __init__(
        self,
        *,
        grace_period_s: float = 5.0,
        probe_interval_s: float = 1.0,
        backoff_initial_s: float = 2.0,
        backoff_max_s: float = 30.0,
        backoff_reset_healthy_s: float = 60.0,
        crashloop_threshold: int = 3,
        crashloop_window_s: float = 120.0,
        crashloop_cooldown_s: float = 120.0,
        now_fn: Optional[Callable[[], float]] = None,
    ):
        self.grace_period_s = float(grace_period_s)
        self.probe_interval_s = float(probe_interval_s)
        self.backoff_initial_s = float(backoff_initial_s)
        self.backoff_max_s = float(backoff_max_s)
        self.backoff_reset_healthy_s = float(backoff_reset_healthy_s)
        self.crashloop_threshold = int(crashloop_threshold)
        self.crashloop_window_s = float(crashloop_window_s)
        self.crashloop_cooldown_s = float(crashloop_cooldown_s)
        self._now = now_fn or time.time

        self.state: str = self.DISCONNECTED
        self.connect_ts: float = 0.0
        self.ready_ts: float = 0.0
        self.last_probe_ts: float = 0.0
        self.probe_responded: bool = False
        self.cooldown_until_ts: float = 0.0
        self.next_backoff_s: float = self.backoff_initial_s
        self.next_attempt_ts: float = 0.0
        self._disconnect_events: list[float] = []
        self.last_transition_reason: str = 'init'

    # ── attempt gating ─────────────────────────────────────────

    def can_attempt_connect(self, now: Optional[float] = None) -> Tuple[bool, str]:
        """Should the outer connect timer try to open a new WS now?"""
        now = self._now() if now is None else now
        if self.state in (self.INITIALIZING, self.READY):
            return False, 'already-connected'
        if self.state == self.COOLDOWN:
            remaining = self.cooldown_until_ts - now
            if remaining > 0:
                return False, f'cooldown-{remaining:.0f}s'
            # Cooldown elapsed — fall through to attempt again.
            self.state = self.DISCONNECTED
            self.last_transition_reason = 'cooldown-elapsed'
        if now < self.next_attempt_ts:
            return False, f'backoff-{self.next_attempt_ts - now:.1f}s'
        return True, 'ok'

    # ── connect result ─────────────────────────────────────────

    def on_connect_success(self, now: Optional[float] = None) -> None:
        """WS handshake succeeded. Enter INITIALIZING; the caller is
        expected to have already subscribed to the *probe-only* topic
        set (see PROBE_TOPICS in estun_driver_node.py). The full
        subscribe burst is withheld until should_subscribe_full()
        returns True."""
        now = self._now() if now is None else now
        self.state = self.INITIALIZING
        self.connect_ts = now
        self.probe_responded = False
        self.last_probe_ts = 0.0
        self.last_transition_reason = 'connect-ok'

    def on_connect_failure(self, now: Optional[float] = None) -> None:
        """WS handshake failed. Bump exponential backoff for the next
        attempt (no reset unless a healthy session lands later)."""
        now = self._now() if now is None else now
        self.next_backoff_s = min(
            self.backoff_max_s, max(self.backoff_initial_s, self.next_backoff_s * 2.0)
        )
        self.next_attempt_ts = now + self.next_backoff_s
        self.state = self.DISCONNECTED
        self.last_transition_reason = 'connect-failed'

    # ── probe / readiness ─────────────────────────────────────

    def should_send_probe(self, now: Optional[float] = None) -> bool:
        """Return True if the driver should emit a readiness probe
        frame right now. First probe fires immediately on entering
        INITIALIZING; subsequent probes throttle to probe_interval_s."""
        if self.state != self.INITIALIZING:
            return False
        if self.probe_responded:
            return False
        now = self._now() if now is None else now
        if self.last_probe_ts == 0.0:
            return True
        return (now - self.last_probe_ts) >= self.probe_interval_s

    def note_probe_sent(self, now: Optional[float] = None) -> None:
        self.last_probe_ts = self._now() if now is None else now

    def note_probe_response(self, now: Optional[float] = None) -> None:
        """A valid, well-formed probe answer arrived. Marks the probe
        as satisfied — but the grace period ALSO has to elapse before
        should_subscribe_full() opens the full subscribe path. A
        response before the grace floor is honoured (recorded) but
        does not shortcut the wait."""
        if self.state != self.INITIALIZING:
            return
        self.probe_responded = True

    def grace_elapsed(self, now: Optional[float] = None) -> bool:
        if self.state != self.INITIALIZING:
            return False
        now = self._now() if now is None else now
        return (now - self.connect_ts) >= self.grace_period_s

    def should_subscribe_full(self, now: Optional[float] = None) -> bool:
        """READY-transition guard. Both conditions must hold:
          1. probe answered (controller responds to queries → past init)
          2. grace period elapsed (belt-and-braces time floor even if
             the probe answers instantly)"""
        if self.state != self.INITIALIZING:
            return False
        if not self.probe_responded:
            return False
        return self.grace_elapsed(now=now)

    def on_subscribed_full(self, now: Optional[float] = None) -> None:
        """Caller has sent the full subscribe burst; enter READY."""
        now = self._now() if now is None else now
        self.state = self.READY
        self.ready_ts = now
        self.last_transition_reason = 'subscribed-full'

    # ── disconnect / crash-loop ────────────────────────────────

    def on_disconnect(self, now: Optional[float] = None) -> str:
        """WS closed for any reason. Returns 'crashloop' if the cycle
        crossed the crashloop threshold and we entered COOLDOWN, else
        'normal'. Callers should schedule the next attempt against
        next_attempt_ts (updated by this method)."""
        now = self._now() if now is None else now
        # Only cycles that reached a live WS count toward crash-loop.
        # A failed connect() bumps backoff via on_connect_failure()
        # instead.
        if self.connect_ts > 0.0:
            self._disconnect_events.append(now)
            self._prune_disconnects(now)

        # Healthy-session backoff reset: if we spent at least
        # backoff_reset_healthy_s in READY, treat the past disconnects
        # as history and reset the backoff to the initial value.
        if self.state == self.READY and self.ready_ts > 0.0:
            if (now - self.ready_ts) >= self.backoff_reset_healthy_s:
                self.next_backoff_s = self.backoff_initial_s
                self._disconnect_events = []

        if len(self._disconnect_events) >= self.crashloop_threshold:
            self.state = self.COOLDOWN
            self.cooldown_until_ts = now + self.crashloop_cooldown_s
            self.next_attempt_ts = self.cooldown_until_ts
            self._disconnect_events = []
            self.last_transition_reason = 'crashloop-cooldown'
            return 'crashloop'

        # Normal disconnect — schedule the next attempt against the
        # current backoff and bump backoff for the FOLLOWING attempt.
        self.next_attempt_ts = now + self.next_backoff_s
        self.next_backoff_s = min(self.backoff_max_s, self.next_backoff_s * 2.0)
        self.state = self.DISCONNECTED
        self.last_transition_reason = 'disconnect'
        return 'normal'

    def _prune_disconnects(self, now: float) -> None:
        cutoff = now - self.crashloop_window_s
        self._disconnect_events = [t for t in self._disconnect_events if t >= cutoff]

    # ── snapshot for /estun/status ────────────────────────────

    def status_snapshot(self, now: Optional[float] = None) -> dict:
        now = self._now() if now is None else now
        cooldown_remaining = (
            max(0.0, self.cooldown_until_ts - now) if self.state == self.COOLDOWN else 0.0
        )
        return {
            'conn_state':        self.state,
            'connect_ts':        self.connect_ts,
            'ready_ts':          self.ready_ts,
            'probe_responded':   self.probe_responded,
            'grace_period_s':    self.grace_period_s,
            'next_backoff_s':    self.next_backoff_s,
            'next_attempt_ts':   self.next_attempt_ts,
            'next_attempt_in_s': max(0.0, self.next_attempt_ts - now),
            'recent_disconnects': len(self._disconnect_events),
            'cooldown_remaining_s': cooldown_remaining,
        }
