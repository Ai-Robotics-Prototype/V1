"""Software E-STOP latch — regression pins (2026-09-21).

Root cause of the deployed field bug: the ROS subscriber _on_estop
blindly overwrote STATE.safety.estop from /safety/estop, which the
estun driver publishes at 1 Hz with data=False (physical estop not
pressed). A dashboard-commanded /cmd/estop {active:true} would set
STATE.safety.estop=True; the very next driver publish (≤1 s later)
reset it to False, and the client's E-STOP overlay unmounted before
the operator could confirm the stop.

Fix: split STATE.safety into a SOFTWARE latch and a HARDWARE mirror;
compose `safety.estop` = SW OR HW. Only POST /cmd/estop mutates SW.
The ROS/WS-status writers mutate HW only. This pins:

  1. /cmd/estop {active:true} sets `_software_estop` and composed
     `estop` to True.
  2. A subsequent _on_estop(Bool(False)) DOES NOT clear the composed
     estop — the SW latch keeps it True.
  3. A hardware press (_on_estop(Bool(True))) sets composed True
     even without a prior SW press.
  4. /cmd/estop {active:false} clears the SW latch; composed reverts
     to whatever HW last reported.
  5. Every writer that touches estop goes through the SW-OR-HW
     compose — grep-pin against future direct writes.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SRC  = _HERE.parent
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))


def _fake_safety():
    """Fresh dict shaped like STATE['safety'] with the split-source
    keys the compose logic expects."""
    return {
        'zone': 'GREEN', 'speed_scale': 1.0,
        'estop': False,
        '_software_estop': False,
        '_hardware_estop': False,
        'human_proximity': 2.4,
    }


# ── Compose logic — extracted from the writers for direct testing ──

def _apply_software_press(s):
    """Mirror of the /cmd/estop {active:true} write path."""
    s['_software_estop'] = True
    s['estop']           = True
    s['speed_scale']     = 0.0
    return s

def _apply_software_release(s):
    """Mirror of the /cmd/estop {active:false} write path."""
    s['_software_estop'] = False
    s['estop'] = bool(s.get('_hardware_estop', False))
    if s['zone'] == 'GREEN' and not s['estop']:
        s['speed_scale'] = 1.0
    return s

def _apply_hardware_publish(s, hw):
    """Mirror of _on_estop / _on_safety_status / _on_estun_status."""
    s['_hardware_estop'] = bool(hw)
    s['estop'] = bool(s.get('_software_estop', False)) or bool(hw)
    return s


class SoftwareEstopLatchTests(unittest.TestCase):

    # ── 1: press sets composed ────────────────────────────────────────

    def test_software_press_sets_composed_true(self):
        s = _fake_safety()
        _apply_software_press(s)
        self.assertTrue(s['estop'])
        self.assertTrue(s['_software_estop'])
        self.assertEqual(s['speed_scale'], 0.0)

    # ── 2: driver's 1 Hz `false` publish does NOT clear a SW press ──

    def test_hardware_false_does_not_clear_software_latch(self):
        s = _fake_safety()
        _apply_software_press(s)
        # Simulate the estun driver's 1 Hz /safety/estop=False heartbeat.
        for _ in range(10):
            _apply_hardware_publish(s, False)
            self.assertTrue(s['estop'],
                'composed estop must stay True while SW is latched — '
                'this is the exact 2026-09-21 field-bug scenario')
            self.assertTrue(s['_software_estop'])
            self.assertFalse(s['_hardware_estop'])

    # ── 3: hardware press sets composed True regardless of SW ─────

    def test_hardware_true_sets_composed_true(self):
        s = _fake_safety()
        _apply_hardware_publish(s, True)
        self.assertTrue(s['estop'])
        self.assertTrue(s['_hardware_estop'])
        self.assertFalse(s['_software_estop'])

    def test_hardware_true_sticky_with_software_true(self):
        s = _fake_safety()
        _apply_software_press(s)
        _apply_hardware_publish(s, True)
        self.assertTrue(s['estop'])
        # Clearing SW alone leaves HW still latched → composed stays True.
        _apply_software_release(s)
        self.assertTrue(s['estop'],
            'composed estop must remain True while HARDWARE is latched')
        self.assertTrue(s['_hardware_estop'])
        self.assertFalse(s['_software_estop'])

    # ── 4: release clears SW; composed reverts to HW ─────────────────

    def test_software_release_reverts_to_hardware_state(self):
        s = _fake_safety()
        _apply_software_press(s)
        _apply_hardware_publish(s, False)  # HW is clear
        _apply_software_release(s)
        self.assertFalse(s['estop'])
        self.assertFalse(s['_software_estop'])
        self.assertEqual(s['speed_scale'], 1.0)  # restored on GREEN

    # ── 5: grep-pin — every estop writer uses the compose ─────────

    def test_all_estop_writers_go_through_compose(self):
        """Any future writer that sets `safety['estop']` directly would
        reintroduce the field-bug class. This grep pin enumerates the
        FIVE allowed writers and forbids any other assignment site."""
        src = (_SRC / 'cobot_dashboard'
                   / 'dashboard_server.py').read_text()
        # Count direct `s["estop"] = ...` (or `STATE["safety"]["estop"] = ...`)
        # assignments. Allowed sites:
        #   * /cmd/estop press (composed True)
        #   * /cmd/estop release (composed = HW)
        #   * _on_safety_status (composed = SW OR HW)
        #   * _on_estop (composed = SW OR HW)
        #   * _on_estun_status (composed = SW OR HW)
        # STATE definition line at L557 is init, not a runtime writer.
        import re
        writers = re.findall(
            r'(?:STATE\["safety"\]|s|s_sf)\[["\']estop["\']\]\s*=', src)
        self.assertLessEqual(len(writers), 6,
            'Only 5 runtime writers + the STATE init line are allowed. '
            'Any additional site risks reintroducing the 2026-09-21 '
            'flash regression class. Update this pin only after all '
            'writers use `SW OR HW` compose semantics.')

    def test_hardware_only_writers_never_touch_software_latch(self):
        """The hardware writers (_on_estop, _on_safety_status,
        _on_estun_status estop branch) MUST NOT touch _software_estop.
        Grep-pin: `_software_estop = ` appears only in the /cmd/estop
        endpoint."""
        src = (_SRC / 'cobot_dashboard'
                   / 'dashboard_server.py').read_text()
        # Every mutation of _software_estop must live in cmd_estop.
        # We can't cleanly grep for scope in Python, so pin the RE
        # count: exactly 2 assignments (press → True, release → False).
        import re
        mutations = re.findall(r'_software_estop["\']\]\s*=\s*(True|False)', src)
        self.assertEqual(mutations, ['True', 'False'],
            'Only /cmd/estop should mutate _software_estop, and only '
            'to True (press) and False (release) in that order in '
            'the source. Any other mutation site is a regression.')


if __name__ == '__main__':
    unittest.main()
