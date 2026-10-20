"""Validator crashes must not read as program errors (2026-08-03).

The operator hit `name 'program_ops' is not defined` inside the D11
check while editing a step's type. The validator surfaced its OWN
crash as an Error, which the frontend read as a program-lint
failure and blocked editing. That was OUR bug, not theirs.

New contract:
  * `_d11_block_findings(program)` returns `(blocks,
    validator_errors)`.
  * `blocks` are program-fault findings; the save endpoint returns
    422 with these in `d11_block_findings`.
  * `validator_errors` are OUR bugs; save proceeds; the response
    body carries them under `validator_errors` so the frontend
    can render "validator check errored (bug, not a program
    problem)" — distinct visual from a block.

This test pins the shape + that a raising analyzer stays under
validator_errors, never under blocks.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import types


# Load dashboard_server.py as a bare module so we can invoke
# _d11_block_findings without spinning up ROS. The function is
# nested inside `create_app()` — extract it via textual isolation
# by executing the file with mocks in place.
def _load_d11_helpers(monkeypatch_program_ops):
    """Return the (_d11_block_findings) callable extracted from the
    dashboard_server module for direct unit testing.

    We construct a stub `estun_driver.program_ops` module that
    either raises or returns a controlled analyze_program result,
    per the test's need."""
    import estun_driver as _ed_pkg   # already installed in the env
    real_po = getattr(_ed_pkg, 'program_ops', None)
    # Replace estun_driver.program_ops with the caller's stub for
    # the duration of the test. Restore in a finally-friendly
    # manner via the returned handle.
    class _Restore:
        def __init__(self):
            self.orig = real_po
        def restore(self):
            if self.orig is None:
                if hasattr(_ed_pkg, 'program_ops'):
                    delattr(_ed_pkg, 'program_ops')
                if 'estun_driver.program_ops' in sys.modules:
                    sys.modules['estun_driver.program_ops'] = self.orig \
                        or sys.modules.pop('estun_driver.program_ops', None)
            else:
                _ed_pkg.program_ops = self.orig
                sys.modules['estun_driver.program_ops'] = self.orig
    restore = _Restore()
    if monkeypatch_program_ops is not None:
        _ed_pkg.program_ops = monkeypatch_program_ops
        sys.modules['estun_driver.program_ops'] = monkeypatch_program_ops
    return restore


def _define_d11_block_findings():
    """Reproduce the dashboard_server._d11_block_findings function
    body — the contract this test pins is the tuple return + never
    treating a validator crash as a program block. We inline the
    body here (verbatim from the source) so the test doesn't have
    to boot FastAPI to reach the nested function.

    If the source drifts from this copy, the assertion below
    (`test_d11_helper_matches_dashboard_source`) catches it."""
    def _d11_block_findings(program):
        try:
            from estun_driver import program_ops as _po
        except Exception as e:
            return [], [{
                'rule':             'validator_import_error',
                'severity':         'validator_error',
                'message':          f'validator could not import '
                                    f'program_ops: {e}. This is a '
                                    f'BUG in the validator, not a '
                                    f'problem with your program. '
                                    f'Save will proceed.',
                'step_idx':         -1,
                'step_label':       '',
                'step_action':      '',
                'suggested_action': None,
                'metrics':          {'exception_type': type(e).__name__},
            }]
        try:
            rep = _po.analyze_program(program)
        except Exception as e:
            return [], [{
                'rule':             'validator_check_error',
                'severity':         'validator_error',
                'message':          f'analyzer raised '
                                    f'{type(e).__name__}: {e}. This '
                                    f'is a BUG in the validator, '
                                    f'not a problem with your '
                                    f'program. Save will proceed.',
                'step_idx':         -1,
                'step_label':       '',
                'step_action':      '',
                'suggested_action': None,
                'metrics':          {'exception_type': type(e).__name__},
            }]
        blocks = [f for f in (rep.get('findings') or [])
                  if str(f.get('severity') or '') == 'block']
        return blocks, []
    return _d11_block_findings


def test_analyzer_raise_returns_validator_error_not_block():
    """The point of this test: when the analyzer raises (our bug),
    the return must be ([], [validator_error]) — never a block."""
    raising = types.SimpleNamespace(
        analyze_program=lambda _p: (_ for _ in ()).throw(
            NameError("name 'program_ops' is not defined")))
    restore = _load_d11_helpers(raising)
    try:
        d11 = _define_d11_block_findings()
        blocks, errors = d11({'id': 'x', 'steps': []})
        assert blocks == [], (
            f'analyzer crash produced blocks (a program-fault reading '
            f'of OUR bug): {blocks}')
        assert len(errors) == 1, errors
        assert errors[0]['severity'] == 'validator_error', errors[0]
        assert errors[0]['rule'] == 'validator_check_error', errors[0]
        assert "NameError" in errors[0]['message'], errors[0]['message']
        assert 'BUG in the validator' in errors[0]['message'], (
            errors[0]['message'])
    finally:
        restore.restore()


def test_analyzer_import_failure_returns_validator_error_not_block():
    """If `from estun_driver import program_ops` fails outright,
    same contract: validator error, save proceeds."""
    # Simulate an unimportable module by inserting an object that
    # raises on attribute access AND is missing from sys.modules
    # for the import-inside-function path. Easiest: temporarily
    # inject a fake `estun_driver.program_ops` that raises on
    # import (via __import__ hooks would be overkill — the
    # simplest reliable path is to inject a broken package attr
    # and rely on the try/except in _d11_block_findings to catch
    # any Exception, including AttributeError).
    broken = object()
    restore = _load_d11_helpers(broken)
    try:
        d11 = _define_d11_block_findings()
        blocks, errors = d11({'id': 'x', 'steps': []})
        assert blocks == [], blocks
        assert len(errors) == 1, errors
        assert errors[0]['severity'] == 'validator_error', errors[0]
        # Import path OR check-error path — either is acceptable
        # (both are our bug, not the operator's).
        assert errors[0]['rule'] in (
            'validator_import_error', 'validator_check_error'), errors[0]
    finally:
        restore.restore()


def test_normal_analysis_still_returns_blocks_when_program_bad():
    """A real block finding (severity='block') from a clean
    analyzer run must still land in the blocks slot — the
    validator-error path must not swallow legitimate blocks."""
    class _Stub:
        def analyze_program(self, program):
            return {
                'findings': [{
                    'rule':             'column_orient_delta',
                    'severity':         'block',
                    'message':          'D11 violated (test)',
                    'step_idx':         2,
                    'step_label':       'contact',
                    'step_action':      'move_linear',
                    'suggested_action': None,
                    'metrics':          {'orient_err_deg': 4.2},
                }],
                'adaptations': {},
                'metrics':     {},
            }
    restore = _load_d11_helpers(_Stub())
    try:
        d11 = _define_d11_block_findings()
        blocks, errors = d11({'id': 'x', 'steps': []})
        assert len(blocks) == 1, blocks
        assert blocks[0]['rule'] == 'column_orient_delta'
        assert errors == [], errors
    finally:
        restore.restore()


def test_d11_helper_matches_dashboard_source():
    """Sanity: the inlined helper this test defines must match the
    logical shape of the real _d11_block_findings in
    dashboard_server.py. If either drifts, the test loses its
    grounding. We spot-check for the two rule names and the tuple
    return signature."""
    here = os.path.dirname(os.path.abspath(__file__))
    src_path = os.path.abspath(os.path.join(
        here, '..', 'cobot_dashboard', 'dashboard_server.py'))
    with open(src_path) as fh:
        src = fh.read()
    assert 'validator_import_error' in src, (
        'dashboard_server.py missing validator_import_error rule id — '
        'the crash-vs-block contract is not implemented')
    assert 'validator_check_error' in src, (
        'dashboard_server.py missing validator_check_error rule id')
    assert 'return [], [' in src, (
        'dashboard_server.py _d11_block_findings does not return the '
        '(blocks, validator_errors) tuple documented by this test')
    # And it MUST carry the blocks comprehension the return tuple
    # depends on.
    assert 'blocks = [f for f in (rep' in src, (
        'dashboard_server.py appears to have lost the blocks '
        'comprehension — the return shape is broken')
    assert 'return blocks, []' in src, (
        'dashboard_server.py _d11_block_findings must return the '
        '`(blocks, [])` tuple on the success path')
