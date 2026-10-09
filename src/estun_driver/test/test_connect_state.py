"""State-machine unit tests for the Estun connect lifecycle.

Runs with a fake clock (no wall-clock sleeps) so the whole test file
executes in milliseconds. Focus is the boot-race fix: connecting
during the controller's INITIALIZING window must NOT trigger the
full subscribe burst until a lightweight probe answers AND the grace
floor has elapsed.
"""

from __future__ import annotations

import pytest

from estun_driver.connect_state import ConnectStateMachine


class FakeClock:
    def __init__(self, t0: float = 1000.0):
        self.t = t0

    def now(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


def _sm(clock: FakeClock, **kw) -> ConnectStateMachine:
    defaults = dict(
        grace_period_s=5.0,
        probe_interval_s=1.0,
        backoff_initial_s=2.0,
        backoff_max_s=30.0,
        backoff_reset_healthy_s=60.0,
        crashloop_threshold=3,
        crashloop_window_s=120.0,
        crashloop_cooldown_s=120.0,
        now_fn=clock.now,
    )
    defaults.update(kw)
    return ConnectStateMachine(**defaults)


# ── The boot-race fix, front and centre ─────────────────────────

def test_connect_during_init_holds_full_subscribe_until_probe_and_grace():
    """The exact scenario the fix targets: WS opens but the controller
    is still initializing; no full subscribe until the probe answers
    AND the grace period floor has elapsed."""
    c = FakeClock()
    sm = _sm(c)

    ok, _ = sm.can_attempt_connect()
    assert ok
    sm.on_connect_success()
    assert sm.state == ConnectStateMachine.INITIALIZING
    # First probe should be due immediately, then throttled.
    assert sm.should_send_probe() is True
    sm.note_probe_sent()
    assert sm.should_send_probe() is False
    # We're NOT allowed to do the full subscribe yet — nothing has
    # answered and no time has passed.
    assert sm.should_subscribe_full() is False

    # Probe answers early (before grace floor). Full subscribe still
    # withheld until grace floor elapses.
    c.advance(0.5)
    sm.note_probe_response()
    assert sm.probe_responded is True
    assert sm.should_subscribe_full() is False

    # Advance to just before the grace floor — still not allowed.
    c.advance(4.0)  # total 4.5s
    assert sm.should_subscribe_full() is False

    # Cross the grace floor.
    c.advance(0.6)  # total 5.1s
    assert sm.grace_elapsed() is True
    assert sm.should_subscribe_full() is True

    sm.on_subscribed_full()
    assert sm.state == ConnectStateMachine.READY


def test_no_probe_response_means_no_full_subscribe_no_matter_how_long():
    """If the controller never answers the probe, the driver must
    keep probing gently and NEVER promote to the full subscribe burst.
    (A silent socket is not a healthy controller.)"""
    c = FakeClock()
    sm = _sm(c)
    sm.on_connect_success()
    sm.note_probe_sent()

    # Advance 60 seconds without any probe response.
    for _ in range(60):
        c.advance(1.0)
        # Every second, we're due to send another probe.
        if sm.should_send_probe():
            sm.note_probe_sent()
    # Grace elapsed long ago, but probe never answered → no full sub.
    assert sm.grace_elapsed() is True
    assert sm.probe_responded is False
    assert sm.should_subscribe_full() is False
    assert sm.state == ConnectStateMachine.INITIALIZING


def test_probe_cadence_throttles_to_interval():
    c = FakeClock()
    sm = _sm(c, probe_interval_s=1.0)
    sm.on_connect_success()

    # First one is free.
    assert sm.should_send_probe() is True
    sm.note_probe_sent()
    c.advance(0.2)
    assert sm.should_send_probe() is False
    c.advance(0.9)  # total 1.1s since last send
    assert sm.should_send_probe() is True


# ── Reconnect backoff ────────────────────────────────────────────

def test_exponential_backoff_progresses_and_caps():
    c = FakeClock()
    sm = _sm(c, backoff_initial_s=2.0, backoff_max_s=30.0)

    # Repeated failed connects grow the backoff: 4, 8, 16, 30 (cap).
    sm.on_connect_failure()
    assert sm.next_backoff_s == 4.0
    sm.on_connect_failure()
    assert sm.next_backoff_s == 8.0
    sm.on_connect_failure()
    assert sm.next_backoff_s == 16.0
    sm.on_connect_failure()
    assert sm.next_backoff_s == 30.0  # capped
    sm.on_connect_failure()
    assert sm.next_backoff_s == 30.0  # stays capped


def test_backoff_only_resets_after_sustained_healthy():
    """A brief-lived healthy session must NOT reset backoff — that
    was the whole reason we hammered the initializing controller."""
    c = FakeClock()
    sm = _sm(c, backoff_initial_s=2.0, backoff_reset_healthy_s=60.0)
    # Push backoff up.
    sm.on_connect_failure()
    sm.on_connect_failure()
    assert sm.next_backoff_s == 8.0

    # A short-lived healthy session (30s in READY) — should NOT reset.
    # Advance past the pending backoff window so a connect is allowed.
    c.advance(sm.next_attempt_ts - c.now() + 0.01)
    ok, _ = sm.can_attempt_connect()
    assert ok
    sm.on_connect_success()
    sm.note_probe_response()
    c.advance(5.5)   # grace + a moment
    assert sm.should_subscribe_full()
    sm.on_subscribed_full()
    c.advance(30.0)  # only half of the healthy-reset window
    sm.on_disconnect()
    assert sm.next_backoff_s > 8.0  # bumped, not reset

    # Now a long healthy session: full reset.
    c.advance(sm.next_attempt_ts - c.now() + 0.01)
    ok, _ = sm.can_attempt_connect()
    assert ok
    sm.on_connect_success()
    sm.note_probe_response()
    c.advance(5.5)
    sm.on_subscribed_full()
    c.advance(90.0)  # comfortably past 60s
    sm.on_disconnect()
    assert sm.next_backoff_s == 4.0  # reset to initial (2) then bumped to 4


def test_next_attempt_ts_respects_backoff():
    c = FakeClock(1000.0)
    sm = _sm(c)
    sm.on_connect_success()
    c.advance(1.0)
    sm.on_disconnect()
    ok, reason = sm.can_attempt_connect()
    assert not ok and reason.startswith('backoff')
    # Advance past the scheduled attempt time.
    c.advance(sm.next_attempt_ts - c.now() + 0.01)
    ok, _ = sm.can_attempt_connect()
    assert ok


# ── Crash-loop detection ─────────────────────────────────────────

def test_crashloop_after_threshold_disconnects_in_window():
    c = FakeClock()
    sm = _sm(c, crashloop_threshold=3, crashloop_window_s=120.0,
             crashloop_cooldown_s=120.0)

    # Three rapid connect→disconnect cycles inside the window.
    for _ in range(3):
        sm.on_connect_success()
        c.advance(1.0)
        result = sm.on_disconnect()
        c.advance(0.1)
    # The third disconnect should have flipped us into COOLDOWN.
    assert result == 'crashloop'
    assert sm.state == ConnectStateMachine.COOLDOWN

    # can_attempt_connect refuses during the cooldown window.
    ok, reason = sm.can_attempt_connect()
    assert not ok and reason.startswith('cooldown')

    # Once cooldown elapses we're allowed again.
    c.advance(120.5)
    ok, _ = sm.can_attempt_connect()
    assert ok
    assert sm.state == ConnectStateMachine.DISCONNECTED


def test_disconnects_outside_window_do_not_trigger_crashloop():
    c = FakeClock()
    sm = _sm(c, crashloop_threshold=3, crashloop_window_s=60.0)

    # Two disconnects, then a big gap, then one more — should NOT trip.
    for _ in range(2):
        sm.on_connect_success()
        c.advance(1.0)
        sm.on_disconnect()
        c.advance(0.1)
    c.advance(120.0)   # window has fully elapsed
    sm.on_connect_success()
    c.advance(1.0)
    result = sm.on_disconnect()
    assert result == 'normal'
    assert sm.state == ConnectStateMachine.DISCONNECTED


# ── Snapshot for /estun/status ───────────────────────────────────

def test_status_snapshot_shape_matches_dashboard_contract():
    c = FakeClock()
    sm = _sm(c)
    sm.on_connect_success()
    snap = sm.status_snapshot()
    assert snap['conn_state'] == ConnectStateMachine.INITIALIZING
    assert snap['grace_period_s'] == 5.0
    assert 'probe_responded' in snap
    assert 'cooldown_remaining_s' in snap
    assert 'next_attempt_in_s' in snap


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
