"""Unit tests for the CRI-proxy staleness decision helper.

Root cause replay (2026-08-19, F1.4 rung-3 fingerprint):
Pre-fix, `_cri_proxy_staleness_loop` flipped robot.enabled=False on a
single tick with js_age > 1.0s. Under JOG_BACKEND=ros2 estun_stale is
ALWAYS true (WS driver down by design), so ANY 1.5 s GIL stall (PIL
cam-encode was py-spy proven) instantly killed jog until the next
fresh JS. This test suite pins the hysteresis fix:

  1. A single 1.5 s stale sample does NOT flip.
  2. 3 consecutive stale samples past the 3.0 s threshold DO flip DOWN.
  3. A single fresh JS instantly flips UP after any DOWN state.
  4. Flap ping-pongs increment the DOWN counter, not the same event.
  5. Non-consecutive stales (fresh in between) DO NOT accumulate.
"""

from __future__ import annotations

import os
import sys


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
sys.path.insert(0, SERVER_DIR)

from staleness import staleness_decide  # noqa: E402


# --- helpers -----------------------------------------------------------


def _tick(state, js_age_s, estun_age_s=999.0):
    """Advance the state machine one 5 Hz tick. `state` is a dict with
    keys `consecutive_stale_ticks`, `is_disconnected`, `flips_down`,
    `flips_up`. Returns the flip event ('up' | 'down' | None) that fired
    on this tick. Default estun_age_s=999 s matches the ros2-session
    invariant where the WS estun_driver is down (never publishes)."""
    new_stale, new_disc, flip = staleness_decide(
        js_age_s=js_age_s,
        estun_age_s=estun_age_s,
        consecutive_stale_ticks=state["consecutive_stale_ticks"],
        is_disconnected=state["is_disconnected"],
    )
    state["consecutive_stale_ticks"] = new_stale
    state["is_disconnected"] = new_disc
    if flip == "down":
        state["flips_down"] += 1
    elif flip == "up":
        state["flips_up"] += 1
    return flip


def _fresh_state():
    return {"consecutive_stale_ticks": 0, "is_disconnected": False,
            "flips_down": 0, "flips_up": 0}


# --- tests -------------------------------------------------------------


def test_single_stale_tick_does_not_flip():
    """A single tick with js_age=1.5 s (above the old 1.0 threshold
    but below the new 3.0) must NOT flip. This is the exact
    regression path — the 2026-08-19 GIL stall from PIL cam-encode
    was ~1.5 s and pre-fix instantly flipped DOWN."""
    s = _fresh_state()
    flip = _tick(s, js_age_s=1.5)
    assert flip is None, "1.5 s stale must NOT flip under new threshold"
    assert s["is_disconnected"] is False
    assert s["flips_down"] == 0
    assert s["consecutive_stale_ticks"] == 0  # 1.5 < 3.0 → not counted stale


def test_two_ticks_past_threshold_still_do_not_flip():
    """Hysteresis: 2 consecutive stale ticks (past the 3.0 threshold)
    still must NOT flip — need 3."""
    s = _fresh_state()
    assert _tick(s, js_age_s=3.5) is None
    assert _tick(s, js_age_s=4.0) is None
    assert s["is_disconnected"] is False
    assert s["consecutive_stale_ticks"] == 2
    assert s["flips_down"] == 0


def test_three_consecutive_stale_ticks_flip_down():
    """The THIRD consecutive stale tick past threshold triggers the
    DOWN flip. Subsequent stale ticks do not re-flip (edge-triggered)."""
    s = _fresh_state()
    assert _tick(s, js_age_s=3.5) is None
    assert _tick(s, js_age_s=3.7) is None
    assert _tick(s, js_age_s=3.9) == "down"
    assert s["is_disconnected"] is True
    assert s["flips_down"] == 1
    # A 4th stale tick does NOT re-fire the DOWN edge.
    assert _tick(s, js_age_s=4.1) is None
    assert s["flips_down"] == 1  # unchanged


def test_single_fresh_js_instantly_flips_up_after_down():
    """From a DOWN state, ONE fresh /joint_states sample must
    instantly flip UP. GIL-starved sessions bounce quickly."""
    s = _fresh_state()
    _tick(s, js_age_s=3.5)
    _tick(s, js_age_s=3.7)
    _tick(s, js_age_s=3.9)
    assert s["is_disconnected"] is True
    # Fresh JS: js_age tiny (250 Hz stream → ~4 ms).
    flip = _tick(s, js_age_s=0.004)
    assert flip == "up"
    assert s["is_disconnected"] is False
    assert s["flips_up"] == 1
    assert s["consecutive_stale_ticks"] == 0


def test_non_consecutive_stales_do_not_accumulate():
    """A fresh JS between stale ticks resets the counter to 0. This
    is the load-bearing property: transient GIL blips (2 ticks
    stale, 1 fresh, 2 more stale) don't count as 4 toward the flip
    threshold — they count as at most 2 in a row."""
    s = _fresh_state()
    _tick(s, js_age_s=3.5)
    _tick(s, js_age_s=3.7)
    # A single fresh tick resets.
    _tick(s, js_age_s=0.004)
    assert s["consecutive_stale_ticks"] == 0
    _tick(s, js_age_s=3.5)
    _tick(s, js_age_s=3.7)
    # 2 more stale — still below threshold; no flip.
    assert s["is_disconnected"] is False
    assert s["flips_down"] == 0


def test_estun_fresh_prevents_flip_even_with_stale_js():
    """Guard: if /estun/status IS publishing (WS driver came back
    up mid-session — belt-and-suspenders), estun_stale is false
    and we don't flip regardless of js_age. Only both stale
    together trigger."""
    s = _fresh_state()
    # estun_age=1.0s < threshold=3.0s → not stale
    _tick(s, js_age_s=10.0, estun_age_s=1.0)
    _tick(s, js_age_s=10.0, estun_age_s=1.0)
    _tick(s, js_age_s=10.0, estun_age_s=1.0)
    _tick(s, js_age_s=10.0, estun_age_s=1.0)
    assert s["is_disconnected"] is False
    assert s["consecutive_stale_ticks"] == 0
    assert s["flips_down"] == 0


def test_flap_ping_pong_counts_each_transition():
    """Repeat down→up cycles each increment their respective counter.
    Ops read this on /health as 'this thing is flapping'."""
    s = _fresh_state()
    # Flap 1: down → up
    _tick(s, js_age_s=3.5)
    _tick(s, js_age_s=3.5)
    _tick(s, js_age_s=3.5)
    _tick(s, js_age_s=0.004)
    # Flap 2: down → up
    _tick(s, js_age_s=3.5)
    _tick(s, js_age_s=3.5)
    _tick(s, js_age_s=3.5)
    _tick(s, js_age_s=0.004)
    # Flap 3: partial (down) — stays down at end
    _tick(s, js_age_s=3.5)
    _tick(s, js_age_s=3.5)
    _tick(s, js_age_s=3.5)
    assert s["flips_down"] == 3
    assert s["flips_up"] == 2
    assert s["is_disconnected"] is True


def test_boundary_exactly_three_seconds_is_not_stale():
    """js_age exactly at threshold (3.0) is NOT stale — strictly
    greater comparison. Prevents boundary flapping when the loop's
    5 Hz timing lines up with the 3.0 s threshold."""
    s = _fresh_state()
    _tick(s, js_age_s=3.0)
    _tick(s, js_age_s=3.0)
    _tick(s, js_age_s=3.0)
    assert s["is_disconnected"] is False
    assert s["consecutive_stale_ticks"] == 0
