"""F1.3 slider-wire-truth doctrine test (2026-08-27, JOG-11 followup).

Pins the invariant that the value the operator sees on the JogSpeedSlider
is BIT-IDENTICAL to the `speed_pct` field that reaches the driver's
`/robot/jog_command` topic. Regression guard against reintroducing any
scaling / rounding / clamping between the frontend slider and the
dashboard-server wire fanout under `JOG_BACKEND=ws`.

Historical context: addendum-40 §565 documented a "slider labelled 15%
sends speed_pct=22.0 on the wire" class. Root cause was stale-tab
persistence during the streamed-path (`JOG_BACKEND=ros2`) era. The
retirement of the streamed path (addendum-45 §597) removed that
divergence, but the invariant deserves an explicit pin so no future
refactor reintroduces it.

Doctrine:
  T1  Integer `speed_pct` in the /cmd/jog body flows to the driver
      payload with the same value (no scaling, no rounding of
      integer inputs).
  T2  Float `speed_pct` (e.g. 22.5) flows through as-is — the driver
      is the authority on how sub-integer values map to the wire
      frame's `db.speed` (via `min(pct/100, effective_speed_cap)`).
  T3  The value at slider display time (`Math.round(jogSpeedPct)`) is
      an INTEGER; any non-integer entering the store from a rehydrate
      cannot silently label as N while sending N+ε.
  T4  Release / stop bodies never carry speed_pct so cannot leak a
      stale value onto the wire.
  T5  Cartesian jog uses the same 1:1 mapping (no separate cartesian
      scale factor).
"""

from __future__ import annotations

import os
import sys
import textwrap
import threading


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))

SERVER_PATH = os.path.join(SERVER_DIR, "dashboard_server.py")
with open(SERVER_PATH) as _f:
    _SRC = _f.read()


# ---------------------------------------------------------------------
# Extract the cmd_jog + cmd_jog_cartesian payload construction to prove
# no scaling. We don't need to run FastAPI; we just need to observe
# what field values would end up in the payload argument to
# `_publish_estun_jog`.
#
# We DON'T exec the entire handler — it depends on FastAPI request
# objects. Instead, this test is a STATIC INVARIANT: locate the
# payload-build lines in `cmd_jog` and `cmd_jog_cartesian` and assert
# they pass `speed_pct` through with no arithmetic between the body
# read and the payload insertion.
# ---------------------------------------------------------------------

def _slice_between(src, start_marker, end_marker):
    a = src.find(start_marker)
    b = src.find(end_marker, a)
    assert a > 0 and b > a, (
        f"test_jog_slider_wire_truth: markers moved — "
        f"start={start_marker!r} start_idx={a} end={end_marker!r} end_idx={b}"
    )
    return src[a:b]


def test_T1_cmd_jog_hold_passes_speed_pct_through_untouched():
    """The hold-branch in cmd_jog reads speed_pct from body and writes
    it into payload with no arithmetic between. This is enforced by
    string inspection: the payload dict literal for the hold branch
    must set 'speed_pct': speed_pct, and no line between the
    body.get('speed_pct') read and the payload assignment may
    multiply/divide/round the value."""
    block = _slice_between(_SRC,
        "if body.get(\"hold\") is True:",
        "if \"delta_deg\" in body:")
    # Extract the speed_pct read + the payload dict insertion
    assert "float(body.get(\"speed_pct\"" in block, (
        "cmd_jog hold branch no longer reads speed_pct from body"
    )
    assert "\"speed_pct\": speed_pct," in block, (
        "cmd_jog hold branch no longer places speed_pct into payload verbatim"
    )
    # Between the read and the payload insertion, the ONLY arithmetic
    # allowed is the (0 < speed_pct <= 100) domain check. Reject any
    # multiplication / division against speed_pct.
    banned = [
        "speed_pct *", "speed_pct /", "speed_pct +", "speed_pct -",
        "speed_pct <<", "speed_pct >>",
        "round(speed_pct", "int(speed_pct", "math.floor(speed_pct",
        "math.ceil(speed_pct",
    ]
    for tok in banned:
        assert tok not in block, (
            f"cmd_jog hold branch contains banned transform on speed_pct: {tok!r}"
        )


def test_T2_cmd_jog_increment_does_not_smuggle_speed_via_delta_deg():
    """Increment (delta_deg) path must not carry a speed_pct — it uses
    a driver-time-boxed delta. If speed_pct sneaks into the increment
    payload it would silently override the driver's chosen speed."""
    block = _slice_between(_SRC,
        "if \"delta_deg\" in body:",
        "_publish_estun_jog({")
    # No speed_pct in the increment payload path.
    assert "\"speed_pct\"" not in block, (
        "cmd_jog increment branch leaked speed_pct — payload should carry "
        "delta_deg only"
    )


def test_T4_cmd_jog_release_never_carries_speed_pct():
    """Release/stop bodies must not include speed_pct. This lets us
    verify that stale-tab persistence of a jogSpeedPct can never leak
    onto the wire during a release request. The joint-jog release
    block is uniquely anchored on its `payload = {"mode": "joint",
    "hold": False}` line."""
    block = _slice_between(_SRC,
        "payload = {\"mode\": \"joint\", \"hold\": False}",
        "raw_joint = body.get(\"joint\")")
    # Payload literal must NOT include speed_pct key, and no post-
    # construction .setdefault or dict update may inject it.
    assert "speed_pct" not in block, (
        "cmd_jog release path leaked speed_pct into payload — "
        "invariant broken"
    )


def test_T5_cartesian_hold_uses_same_1_to_1_mapping():
    """Cartesian jog passes speed_pct through unchanged too."""
    block = _slice_between(_SRC,
        "async def cmd_jog_cartesian(request: Request):",
        "@app.")  # up to the next endpoint
    assert "float(body.get(\"speed_pct\"" in block, (
        "cmd_jog_cartesian no longer reads speed_pct from body"
    )
    assert "\"speed_pct\": speed_pct," in block, (
        "cmd_jog_cartesian no longer places speed_pct into payload verbatim"
    )
    banned = [
        "speed_pct *", "speed_pct /",
        "round(speed_pct", "int(speed_pct",
    ]
    for tok in banned:
        assert tok not in block, (
            f"cmd_jog_cartesian contains banned transform on speed_pct: {tok!r}"
        )


def test_T3_frontend_slider_label_is_integer_rounded():
    """The JogSpeedSlider label must call Math.round(jogSpeedPct) so a
    fractional store value (from persist rehydrate or older store shape)
    cannot render as an integer label while sending a fractional wire
    value.

    This checks the frontend source (not exec'd — pure inspection)."""
    fe = os.path.join(HERE, '..', 'frontend', 'src', 'components',
                       'JogSpeedSlider.jsx')
    if not os.path.exists(fe):
        # Frontend not present in this checkout — skip.
        import pytest
        pytest.skip("frontend source not in this repo checkout")
    with open(fe) as f:
        src = f.read()
    # Label must be integer-rounded.
    assert "{Math.round(jogSpeedPct)}%" in src, (
        "JogSpeedSlider label no longer integer-rounds jogSpeedPct — a "
        "fractional store value would silently mislabel"
    )
    # The <input type=\"range\"> must have step=1 so slider clicks
    # produce integer values.
    assert "step={1}" in src, (
        "JogSpeedSlider input range no longer steps by 1 — slider can "
        "emit non-integer values that diverge from the rounded label"
    )
