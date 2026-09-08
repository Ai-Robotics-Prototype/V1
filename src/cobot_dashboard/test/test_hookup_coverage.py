"""Hookup coverage class fence (2026-09-08).

Directive: derive the hookup page's checklist from the SAME source
codegen consumes. Every emitted step that requires a physical
connection (valve port, sensor input, blow-off line, magnet coil,
etc.) MUST map to a hookup_map entry — enforced by walking a
generated program and asserting every hardware-touching step has
a matching instruction. A step with no hookup entry fails the
test; this can never silently happen again.

The class boundary the test polices:
  * Any emitted step carrying `io_role` (that codegen also stamps
    onto set_io steps and IO-family actions) MUST be covered by a
    hookup_map entry whose `io_role` matches, for the gripper
    the step's cfg names.
  * Blow-off (io_role='blow_off') is the load-bearing case that
    motivates this test — it was silently emitted for months with
    no hookup instruction because no test walked the emission.

The walker is minimal: it runs effectorReady / effectorEngage /
effectorDisengage from lib/effectorVocab (the canonical vocab) for
each gripper type and collects io_role values. Then it looks each
up in hookup_map.gripper_hookups[<gtype>]. Any missing → fail.
"""

from __future__ import annotations

import json
import os
import re
import subprocess


HERE = os.path.dirname(os.path.abspath(__file__))
FRONTEND_ROOT = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src'))
VOCAB = os.path.join(FRONTEND_ROOT, 'lib', 'effectorVocab.js')
HOOKUP_MAP = '/opt/cobot/hookup/hookup_map.json'


def _read(path):
    with open(path) as fh:
        return fh.read()


def _emitted_io_roles_for_gripper(gripper_type):
    """Return the set of io_role values effectorVocab.js emits for
    a given gripper type. Uses a light source-scan of the vocab
    module — pulls every string literal `io_role: 'X'` inside the
    branch for that gripper (identified by `if (e === '<gtype>')`
    inside effectorReady / effectorEngage / effectorDisengage).

    2026-09-08 blow-off audit: this walker is what closes the
    class. Prior to the fix, the vacuum-disengage branch had
    `io_role: 'blow_off'` but no hookup_map entry mentioned
    'blow_off' — the walker would have flagged it. Now the walker
    IS the fence."""
    src = _read(VOCAB)
    roles = set()
    for func_name in ('effectorReady', 'effectorEngage', 'effectorDisengage'):
        func_start = src.find(f'export function {func_name}(')
        if func_start == -1:
            continue
        # Approx function body: until the next top-level `export`
        # or end of file.
        next_export = src.find('\nexport ', func_start + 1)
        func_end = next_export if next_export != -1 else len(src)
        func_body = src[func_start:func_end]
        # Slice the gripper-branch — find `if (e === '<gtype>')`
        # and scan until the next `if (e ===` or return-at-end.
        branch_hit = re.search(
            rf"if \(e === '{re.escape(gripper_type)}'\)", func_body)
        if branch_hit is None:
            # Some grippers get the fall-through path (finger =
            # default `return [...]` at the end of the function).
            # For finger, the fall-through emits close_gripper (in
            # engage) or open_gripper (in disengage) — those DO
            # NOT carry io_role, so nothing to add.
            continue
        branch_start = branch_hit.start()
        next_branch = re.search(
            r"if \(e === '[a-z]+'\)", func_body[branch_start + 5:])
        branch_end = (branch_start + 5 + next_branch.start()
                      if next_branch else len(func_body))
        branch_body = func_body[branch_start:branch_end]
        for m in re.finditer(r"io_role:\s*'([^']+)'", branch_body):
            roles.add(m.group(1))
    return roles


def test_every_emitted_io_role_has_hookup_entry():
    """Class fence: for each gripper type, every io_role emitted
    by lib/effectorVocab MUST appear in
    hookup_map.gripper_hookups[gripper_type][*].io_role. A step
    with no matching hookup entry fails the test — the operator
    would otherwise get a program that fires an IO with no
    documented wiring."""
    with open(HOOKUP_MAP) as fh:
        map_data = json.load(fh)
    for gtype in ('vacuum', 'finger'):
        emitted = _emitted_io_roles_for_gripper(gtype)
        covered = set()
        for h in map_data['gripper_hookups'].get(gtype, []):
            if h.get('io_role'):
                covered.add(h['io_role'])
        missing = emitted - covered
        assert not missing, (
            f'{gtype}: emitted io_role(s) {sorted(missing)} have '
            f'no matching hookup_map entry. Add a hookup_map '
            f'record with io_role in that set (station+port for '
            f'valve, m8_id for sensor).')


def test_blow_off_hookup_entry_present_and_gated():
    """Item 4 spec: blow-off hookup entry exists on the vacuum
    list; it's flagged optional=true with a toggle_answer_key
    (`blow_off_enabled`) and toggle_default matching current
    silent-default behavior (true). needs_operator_confirmation
    until operator names the real port."""
    with open(HOOKUP_MAP) as fh:
        map_data = json.load(fh)
    vac = map_data['gripper_hookups']['vacuum']
    blow = next((h for h in vac if h.get('io_role') == 'blow_off'), None)
    assert blow, 'vacuum hookups must include a blow_off entry'
    assert blow['optional'] is True
    assert blow['toggle_answer_key'] == 'blow_off_enabled'
    assert blow['toggle_default'] is True
    assert blow['needs_operator_confirmation'] is True
    # station+port present (v2 schema).
    assert 'station' in blow and 'port' in blow


def test_hookupguide_renders_optional_toggle_from_map():
    """HookupGuide reads the map's optional entries and renders a
    positive-framing prompt card ("Use blow-off on release?
    Recommended…") with On/Off buttons. Off → the corresponding
    connection card is filtered from the list AND the
    optional-answers map lands on onConfirm's third arg."""
    src = _read(os.path.join(
        FRONTEND_ROOT, 'components', 'HookupGuide.jsx'))
    # Optional-toggle state + prompt render.
    assert 'const [optional, setOptional]' in src
    assert 'data-testid="hookup-optional-prompt"' in src
    assert 'data-testid="hookup-optional-btn-on"' in src
    assert 'data-testid="hookup-optional-btn-off"' in src
    # Card filter honours the toggle.
    assert 'optional[h.toggle_answer_key] === true' in src
    # Confirm handler passes the map back.
    assert 'onConfirm?.(allChecked, noSensor, optional)' in src


def test_wizard_spreads_optional_answers_onto_answers():
    """The wizard's confirm handler spreads the optional-map keys
    onto answers as top-level fields (e.g. answers.blow_off_enabled)
    so buildSteps' _vocabOpts.withBlowOff = answers.blow_off_enabled
    reads the operator's choice."""
    wz = _read(os.path.join(
        FRONTEND_ROOT, 'components', 'ProgramWizard.jsx'))
    # onConfirm receives the optional map.
    assert 'onConfirm={(_allChecked, noSensorMap, optionalMap) =>' in wz
    # Spread into answers.
    assert 'for (const k of Object.keys(opt)) {' in wz
    assert 'setAnswer(k, opt[k])' in wz
    # _vocabOpts wires withBlowOff from answers.blow_off_enabled.
    assert 'withBlowOff: answers.blow_off_enabled !== false' in wz


def test_blow_off_default_matches_prior_behavior():
    """Directive item 2 clarification: `withBlowOff = true` is
    the historical (pre-fix) silent default. To avoid a surprise
    behavioral flip for existing programs, `blow_off_enabled` in
    program.config is treated as opt-out (!== false).  A NEW
    program left un-answered (undefined) still gets blow-off,
    matching what the wizard emitted before the toggle was
    exposed. Answering "Off" explicitly zeros the flag and
    suppresses the triplet.

    If a future operator directive says the default should be
    OFF, update this test and the `!== false` guards in
    ProgramWizard's _vocabOpts computations at the same time
    — otherwise you get silent divergence."""
    wz = _read(os.path.join(
        FRONTEND_ROOT, 'components', 'ProgramWizard.jsx'))
    # Both _vocabOpts sites read `!== false` (opt-out default-on).
    assert wz.count('withBlowOff: answers.blow_off_enabled !== false') >= 2
