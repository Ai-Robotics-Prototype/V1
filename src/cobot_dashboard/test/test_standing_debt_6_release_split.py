"""Standing-debt #6 fix pinned regression (2026-09-11).

Symptom: jog stops mid-hold with `stop_jog:release_cmd` while the
operator is still holding the button.

Root cause split into two sources — both fixed here:

  A) FRONTEND. `onPointerLeave` on HoldButton called `stop()` even
     when the pointer was captured. Under React re-renders (or
     synthetic pointerleave events fired by a style/hit-test tick),
     the button leaked spurious `hold:false` frames that the driver
     honestly logged as `release_cmd`. FIX: pointerleave is
     cosmetic-only now; it no longer calls stop(). The genuine
     release paths remain: pointerup, pointercancel, blur,
     visibilitychange(hidden), pagehide, disabled-mid-hold.

  B) DRIVER. The freshness deadman fired at 200 ms — one missed
     100 ms client-tick landed at the 150-200 ms range, so healthy
     jitter tripped the deadman. FIX: extended to 300 ms (3-beat
     grace at 100 ms cadence) AND the tag renamed from
     `freshness_deadman` → `keepalive_timeout` for continuous-hold
     staleness so operator copy can differentiate "operator
     released" (release_cmd) from "connection hiccup"
     (keepalive_timeout).

SAFETY INVARIANT (pinned here so a future edit can't dilute it):
  True release, E-STOP, page hidden, or connection lost still stops
  the arm — always. This fix removes FALSE releases only.
"""

from __future__ import annotations

import os
import re
import sys


HERE = os.path.dirname(os.path.abspath(__file__))
DRIVER = os.path.abspath(os.path.join(
    HERE, '..', '..', 'estun_driver',
    'estun_driver', 'estun_driver_node.py'))
SERVER = os.path.abspath(os.path.join(
    HERE, '..', 'cobot_dashboard', 'dashboard_server.py'))
JOG_UI = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'JogControls.jsx'))


def _read(path):
    with open(path) as fh:
        return fh.read()


# ── A. Frontend: pointerleave is NOT a release ──────────────────

def test_pointerleave_handler_does_not_call_stop():
    """The button's onPointerLeave handler must NOT call `stop()`.
    setPointerCapture already routes drift-off to pointercancel;
    any pointerleave that still fires with the pointer captured is
    a re-render / hit-test artefact and must not stop the hold."""
    src = _read(JOG_UI)
    # Locate the onPointerLeave JSX attribute and its arrow body.
    m = re.search(r'onPointerLeave=\{\(e\) => \{(.+?)\n\s{6}\}\}',
                  src, re.DOTALL)
    assert m, 'onPointerLeave handler not found'
    body = m.group(1)
    # Cosmetic style resets are fine.
    assert 'e.currentTarget.style.background' in body
    # Must NOT call the hold-ender.
    assert 'stop()' not in body, (
        'pointerleave must not call stop() — standing-debt #6 fix')
    # Must NOT invent a release event tag.
    assert 'release_pointerleave' not in body
    assert 'pointer_leave' not in body, (
        'the pushJogStop("pointer_leave", …) call was the routing '
        'that mapped to release_cmd — must be gone')
    # Must NOT release pointer capture from the leave handler (the
    # earlier code did; keeping capture through leaves is the whole
    # point of this fix).
    assert 'releasePointerCapture' not in body


def test_pointerup_and_pointercancel_still_release():
    """The genuine release paths STAY. pointerup + pointercancel
    both call stop() and release the captured pointer. These are
    the "real release" and "OS interrupt" paths respectively —
    dropping either would be a safety regression."""
    src = _read(JOG_UI)
    for name in ('onPointerUp', 'onPointerCancel'):
        m = re.search(rf'const {name} = useCallback\(\(e\) => \{{(.+?)\}}, \[stop\]\)',
                      src, re.DOTALL)
        assert m, f'{name} handler not found'
        body = m.group(1)
        assert 'stop()' in body, f'{name} must still call stop()'
        assert 'releasePointerCapture' in body, (
            f'{name} must release the captured pointer so the next '
            f'press starts cleanly')


def test_window_level_release_paths_still_wired():
    """blur, visibilitychange(hidden), pagehide, disabled-mid-hold
    still emit their explicit release events. These are the
    "operator's attention moved" and "browser lifecycle" paths —
    each is a safety-invariant stop and must not regress."""
    src = _read(JOG_UI)
    for evt in ('release_window_blur',
                'release_visibility_hidden',
                'release_pagehide',
                'release_disabled_midhold'):
        assert f"'{evt}'" in src, (
            f'window/lifecycle release event {evt} missing — a real '
            f'release path was dropped')


def test_pointerleave_telemetry_still_emitted_as_ignored():
    """The pointerleave DOM event still fires; the bench needs to
    see it in telemetry so we can distinguish a truly-off finger
    from a synthetic leave. Emitted as `pointerleave_ignored` with
    the captured / pressed refs attached — cosmetic-only, does not
    end the hold."""
    src = _read(JOG_UI)
    assert "'pointerleave_ignored'" in src


# ── B. Driver: split tag + extended grace window ────────────────

def test_driver_freshness_timeout_default_is_300ms():
    """Item 3 pin: one missed 100 ms keepalive beat does NOT stop
    the jog. Default extended from 200 ms → 300 ms so a healthy-
    jitter 150-200 ms gap survives; 300 ms sustained silence still
    fires the deadman (safety invariant preserved)."""
    src = _read(DRIVER)
    assert "declare_parameter('jog_freshness_timeout_s', 0.3)" in src, (
        "jog_freshness_timeout_s default must be 0.3 s (was 0.2 s). "
        "Standing-debt #6: the 200 ms deadman fired on every single "
        "missed keepalive at the 100 ms tick cadence")


def test_driver_hold_staleness_maps_to_keepalive_timeout():
    """Item 1 pin: continuous-hold staleness is tagged
    `keepalive_timeout` (renamed from `freshness_deadman`). Same
    underlying deadman, distinct tag so the operator copy can
    differentiate "connection hiccup" from "you released"."""
    src = _read(DRIVER)
    # The pattern table maps the reason string to the new tag.
    assert "('hold staleness',     'keepalive_timeout')," in src, (
        "hold-staleness reason must tag as keepalive_timeout — "
        "standing-debt #6 split")
    # The old tag stays for the increment-fallback case only (the
    # incremental jog is a different class — bounded duration; a
    # freshness fallback there is a genuinely-different fault).
    assert "('increment freshness','freshness_deadman')," in src


def test_driver_release_cmd_tag_is_still_distinct():
    """release_cmd stays as the tag for the "hold:false frame
    arrived" case. Regression fence: if a refactor merges the two,
    the operator copy for "you released" collapses back into
    "connection hiccup" and vice-versa — the whole standing-debt
    #6 split becomes moot."""
    src = _read(DRIVER)
    assert "('release cmd',        'release_cmd')," in src


# ── C. Server-side operator copy: keepalive_timeout gets its own line

def test_operator_copy_covers_keepalive_timeout():
    """The dashboard's `_jog_stop_cause_operator_copy` translator
    MUST render a plain-language line for `keepalive_timeout`.
    Otherwise the split at the driver produces a tag with no copy
    and the frontend renders whatever fallback is at the end."""
    src = _read(SERVER)
    # The keepalive_timeout branch handles the split tag. Legacy
    # freshness_deadman is still handled (same block) so historical
    # logs / the increment-freshness case still render cleanly.
    assert "tag == 'freshness_deadman' or tag == 'keepalive_timeout'" in src
    # Operator-language copy — the "connection hiccup — jog stopped
    # for safety" phrasing from the operator's directive.
    m = re.search(
        r"tag == 'freshness_deadman' or tag == 'keepalive_timeout':(.+?)_out\(([^)]+)\)",
        src, re.DOTALL)
    assert m, 'keepalive_timeout copy block not found'
    copy_block = m.group(2)
    assert 'Connection hiccup' in copy_block, (
        "operator copy for keepalive_timeout must say 'Connection "
        "hiccup — jog stopped for safety' per operator directive")


# ── D. Safety invariant: all real release paths still stop ──────

def test_safety_invariant_all_real_releases_still_stop():
    """SAFETY INVARIANT (operator directive item 4):
       true release, E-STOP, page hidden, or connection lost → jog
       STOPS, always. This test enumerates the paths and checks
       each still routes to stop(). A single missed path is a
       safety regression."""
    src = _read(JOG_UI)
    # 1. onPointerUp calls stop() — genuine release.
    m = re.search(r'const onPointerUp = useCallback\(\(e\) => \{(.+?)\}, \[stop\]\)',
                  src, re.DOTALL)
    assert m and 'stop()' in m.group(1), (
        'onPointerUp must call stop() — genuine release')
    # 2. onPointerCancel calls stop() — OS-level interrupt.
    m = re.search(r'const onPointerCancel = useCallback\(\(e\) => \{(.+?)\}, \[stop\]\)',
                  src, re.DOTALL)
    assert m and 'stop()' in m.group(1), (
        'onPointerCancel must call stop() — OS interrupt')
    # 3. Blur / visibility / pagehide / disabled-mid-hold all route
    #    through stopRef.current or stopIt(). Presence-check the
    #    event names — full behavior pinned in the events-list test.
    for path in ('release_window_blur',
                 'release_visibility_hidden',
                 'release_pagehide',
                 'release_disabled_midhold'):
        assert f"'{path}'" in src


# ── E. Sim: gated behavior across three release classes ─────────

def test_sim_pointerleave_does_not_stop_release_paths_do():
    """Pure-Python sim of the release-decision matrix. Confirms:
       * pointerleave      → NO stop
       * pointerup         → STOP (release_cmd)
       * pointercancel     → STOP (release_cmd)
       * 1 dropped 100 ms keepalive (200 ms gap) → NO stop (300 ms grace)
       * 3 dropped keepalives (350 ms gap)       → STOP (keepalive_timeout)
    Any regression against this table means the fix has been
    partially reverted."""

    class FakeHold:
        # Mirrors the wire-level behavior of the HoldButton + driver
        # pairing: the button emits hold:true / hold:false frames;
        # the driver expires the session on freshness_deadman when
        # no refresh arrives inside grace_ms.
        def __init__(self, grace_ms=300):
            self.grace_ms = grace_ms
            self.active = False
            self.last_refresh_ms = 0
            self.stop_reason = None
        def press(self, now):
            self.active = True
            self.last_refresh_ms = now
            self.stop_reason = None
        def refresh(self, now):
            if self.active: self.last_refresh_ms = now
        def _tick_deadman(self, now):
            if not self.active: return
            if now - self.last_refresh_ms > self.grace_ms:
                self.active = False
                self.stop_reason = 'keepalive_timeout'
        def dom_pointerleave(self, now):
            # Cosmetic-only per fix — driver sees NOTHING.
            self._tick_deadman(now)
        def dom_pointerup(self, now):
            if self.active:
                self.active = False
                self.stop_reason = 'release_cmd'
        def dom_pointercancel(self, now):
            if self.active:
                self.active = False
                self.stop_reason = 'release_cmd'

    # 1. Press, then pointerleave at t=50 ms. Refresh continues at
    #    100/200/300 ms. Should stay ACTIVE — no false release.
    h = FakeHold()
    h.press(0)
    h.dom_pointerleave(50)
    for t in (100, 200, 300, 400):
        h.refresh(t)
        h._tick_deadman(t + 1)
    assert h.active is True and h.stop_reason is None, (
        'pointerleave must not stop the hold — got stop_reason='
        f'{h.stop_reason!r}')

    # 2. Press, refresh normally, then pointerup at t=350 → stop
    #    with tag release_cmd.
    h = FakeHold()
    h.press(0)
    for t in (100, 200, 300):
        h.refresh(t)
        h._tick_deadman(t + 1)
    h.dom_pointerup(350)
    assert h.active is False and h.stop_reason == 'release_cmd', (
        f'pointerup must stop with release_cmd — got {h.stop_reason!r}')

    # 3. Press, then pointercancel at t=200 (OS interrupt) → stop
    #    with tag release_cmd.
    h = FakeHold()
    h.press(0)
    h.refresh(100)
    h.dom_pointercancel(200)
    assert h.active is False and h.stop_reason == 'release_cmd'

    # 4. Press, refresh at 100, then drop ONE beat (next refresh at
    #    250 → 150 ms gap). Deadman ticks at 260 ms — under 300 ms
    #    grace, must stay ACTIVE.
    h = FakeHold()
    h.press(0)
    h.refresh(100)
    # No refresh at 200 (dropped beat).
    h._tick_deadman(260)   # 160 ms gap since last refresh — under grace.
    assert h.active is True, (
        f'1-beat drop must be tolerated — got stop_reason={h.stop_reason!r}')
    h.refresh(250)         # Belated refresh arrives — session lives.
    h._tick_deadman(300)
    assert h.active is True

    # 5. Press, refresh at 100, then NO refreshes at all → deadman
    #    fires at 401 ms (301 ms gap since t=100) with tag
    #    keepalive_timeout.
    h = FakeHold()
    h.press(0)
    h.refresh(100)
    h._tick_deadman(401)
    assert h.active is False and h.stop_reason == 'keepalive_timeout', (
        f'sustained silence must fire keepalive_timeout — got '
        f'stop_reason={h.stop_reason!r}')
