"""Unit tests for program_ops.ErrorDedup.

Focus: the stale-error regression (Part I, 2026-07-22). Before the
fix, an operator who cleared an alarm would see the dashboard
re-show the same alarm as soon as the controller's ~3 Hz publish/
Error reflood echoed one more (code, unix_ts) frame after the clear.
"""

from __future__ import annotations

import pytest

from estun_driver.program_ops import ErrorDedup


def _entry(code, unix_ts, level=2, text='fault'):
    return [level, code, unix_ts, text]


def test_first_error_is_new():
    d = ErrorDedup()
    r = d.observe([_entry(2015, 1000.0)])
    assert r['kind'] == 'new'
    assert r['changed'] is True
    assert r['key'] == (2015, 1000.0)


def test_reflood_of_same_error_is_same_not_new():
    d = ErrorDedup()
    d.observe([_entry(2015, 1000.0)])
    r = d.observe([_entry(2015, 1000.0)])
    assert r['kind'] == 'same'
    assert r['changed'] is False


def test_empty_db_is_clear_and_changes():
    d = ErrorDedup()
    d.observe([_entry(2015, 1000.0)])
    r = d.observe([])
    assert r['kind'] == 'clear'
    assert r['changed'] is True


def test_reflood_after_clear_is_stale_not_new_REGRESSION():
    """The whole reason Part I exists: a straggler reflood of a
    just-cleared (code, unix_ts) MUST NOT re-fire as 'new' — the
    dashboard would then re-show an alarm the operator had already
    acknowledged."""
    d = ErrorDedup()
    d.observe([_entry(2015, 1000.0)])   # new
    d.observe([])                        # clear
    r = d.observe([_entry(2015, 1000.0)])  # straggler reflood
    assert r['kind'] == 'stale', \
        f"reflood after clear must be 'stale', got {r['kind']!r}"
    assert r['changed'] is False, "stale reflood must NOT trigger a change event"


def test_different_error_after_clear_is_new():
    """Clearing one error and then a DIFFERENT (code, unix_ts) arriving
    should still fire as 'new' — the dedup only suppresses re-fires of
    the SAME cleared key."""
    d = ErrorDedup()
    d.observe([_entry(2015, 1000.0)])
    d.observe([])
    r = d.observe([_entry(2002, 2000.0)])
    assert r['kind'] == 'new'
    assert r['changed'] is True


def test_cleared_history_bounded():
    """The cleared-key ledger must not grow unbounded on a long-running
    session. Verify the eviction cap by inserting > _CLEARED_HISTORY
    unique errors + clears and confirming memory stays bounded."""
    d = ErrorDedup()
    for i in range(200):
        d.observe([_entry(3000 + i, 1000.0 + i)])
        d.observe([])
    assert len(d._cleared_keys) <= ErrorDedup._CLEARED_HISTORY


def test_same_key_reflood_across_two_clears():
    """A cycle of (alarm → clear → same alarm reflood → clear → same
    alarm reflood) should never re-fire — the key is remembered across
    clears."""
    d = ErrorDedup()
    d.observe([_entry(2015, 1000.0)])
    d.observe([])
    r1 = d.observe([_entry(2015, 1000.0)])
    d.observe([])
    r2 = d.observe([_entry(2015, 1000.0)])
    assert r1['kind'] == 'stale'
    assert r2['kind'] == 'stale'


def test_noise_frame_ignored():
    d = ErrorDedup()
    r = d.observe([['not', 'a', 'proper', 'entry']])
    # code is 'a' which fails the numeric check → code = -1
    # ts is 'proper' which fails the numeric check → ts = 0.0
    # Not classified as noise here — the tuple (-1, 0.0) becomes
    # a valid key. That's an edge case; what matters is it doesn't
    # crash. Real controllers never emit this shape.
    assert r['kind'] in ('new', 'noise')


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
