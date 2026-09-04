"""CRI-proxy staleness decision logic — pure Python, no ROS/rclpy imports.

Extracted from dashboard_server.py so the F1.4 hold-bug fix can be
unit-tested with a fake clock (see test_cri_proxy_staleness.py).

Root-cause history (2026-08-19, F1.4 rung-3 fingerprint):
The dashboard's _cri_proxy_staleness_loop originally flipped
STATE['robot'] fields to DISCONNECTED after a single tick with
js_age > 1.0 s. Under JOG_BACKEND=ros2, `estun_stale` is ALWAYS
true (the WS estun_driver is intentionally down this session, so
/estun/status never updates), so any single > 1.0 s GIL stall
slammed robot.connected=False → frontend jogGateOk=false →
operator taps died in the browser with zero network activity.

py-spy proved the PIL cam-encode thread is the recurring GIL hog
(_encode_tile on 640×480 rgb8 frames). Even a single 1.5 s stall
was enough to trigger the disconnected-flip and force the frontend
into an unclickable state that only cleared on the NEXT fresh JS
(which itself may have been GIL-starved). Result: intermittent
"cannot enable" episodes on every real-arm session.

Fix (this module):
  - Threshold 1.0 s → 3.0 s (matches natural CRI stream jitter).
  - Hysteresis: require 3 CONSECUTIVE stale ticks (5 Hz loop) to
    flip DOWN; a single fresh JS instantly flips UP. GIL-starved
    wall clock needs the slack; real disconnects sustain past it.
  - Flap instrumentation exposed via the caller — cri_proxy_stats
    dict lands on /health for operator visibility.
"""

# Type alias for readability.
Flip = str  # 'up' | 'down' | None


DEFAULT_STALE_THRESHOLD_S = 3.0
DEFAULT_CONSECUTIVE_STALE_REQ = 3
# Estun status is judged stale beyond 3 s regardless of JS liveness — the
# ros2-session estun driver publishes at ~2 Hz when up, so this threshold
# leaves 6 tick-widths of slack under normal operation.
DEFAULT_ESTUN_STALE_THRESHOLD_S = 3.0


def staleness_decide(
    js_age_s: float,
    estun_age_s: float,
    consecutive_stale_ticks: int,
    is_disconnected: bool,
    threshold_s: float = DEFAULT_STALE_THRESHOLD_S,
    consecutive_stale_req: int = DEFAULT_CONSECUTIVE_STALE_REQ,
    estun_stale_threshold_s: float = DEFAULT_ESTUN_STALE_THRESHOLD_S,
) -> tuple:
    """Pure decision for one iteration of the CRI-proxy staleness loop.

    Called at 5 Hz cadence from `_cri_proxy_staleness_loop`. Given the
    current sample ages and prior tick state, returns the new state +
    an optional flip event.

    Args:
        js_age_s: seconds since last /joint_states message (monotonic).
        estun_age_s: seconds since last /estun/status message (wall clock).
        consecutive_stale_ticks: prior tick counter (starts 0, monotonic
            up until a fresh JS resets it to 0).
        is_disconnected: current flip state.
        threshold_s: max js_age before considered stale.
        consecutive_stale_req: required consecutive stale ticks before
            flipping to disconnected (hysteresis parameter).
        estun_stale_threshold_s: max estun_age before considered stale.

    Returns:
        (new_consecutive_stale_ticks: int,
         new_is_disconnected: bool,
         flip_event: 'up' | 'down' | None)

        - flip='down' fires the FIRST tick the counter reaches
          consecutive_stale_req; subsequent stale ticks do not re-flip.
        - flip='up' fires the FIRST tick a fresh sample arrives while
          we were disconnected.
        - flip=None means no state change to publish.
    """
    estun_stale = estun_age_s > estun_stale_threshold_s
    js_stale = js_age_s > threshold_s
    if estun_stale and js_stale:
        new_stale = consecutive_stale_ticks + 1
        if new_stale >= consecutive_stale_req and not is_disconnected:
            return (new_stale, True, 'down')
        return (new_stale, is_disconnected, None)
    # Fresh: reset counter. If we were disconnected, flip back up
    # (the _on_joint_states callback populates the robot fields with
    # fresh 'connected'/'enabled' values on every JS message; the loop
    # here only handles bookkeeping and the DOWN edge).
    if is_disconnected:
        return (0, False, 'up')
    return (0, False, None)
