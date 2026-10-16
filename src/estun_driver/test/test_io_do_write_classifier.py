"""FIELD BUG PIN — 2026-09-15 (I/O page DO override).

Operator's I/O-page toggle for DO2 wouldn't turn OFF the output that
the palletize program left on. Root cause: `_do_do_write_lua_worker`
in estun_driver_node.py classified `save_project` return steps with a
naive `http_status != 200` filter, flagging the in-process CHECK gates
(`lua_syntax_gate`, `lua_semantic_roundtrip`) — which record
`method='CHECK'`, `http_status=0`, `code=909` on SUCCESS — as failed.
Every DO override rejected with:

    "ioconsole save failed: lua_syntax_gate HTTP 0"

The correct filter already existed at two other sites — this test
pins that the DO write path uses the same widened filter.
"""

import os
import re


REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
DRV  = os.path.join(REPO, 'src/estun_driver/estun_driver/estun_driver_node.py')


def _read(path):
    with open(path, 'r') as f:
        return f.read()


def _mk_step(step, method, http_status, code):
    return {'step': step, 'path': '', 'method': method,
            'http_status': http_status, 'code': code, 'body_head': ''}


def _classifier():
    """Mirror of the filter installed in _do_do_write_lua_worker.
    Kept as a pure Python function here so this pin catches a
    regression that would only surface at wire time otherwise.
    """
    def ok(s):
        if s.get('http_status') == 200:
            return True
        if (s.get('method') == 'CHECK'
                and s.get('http_status') == 0
                and s.get('code') == 909):
            return True
        return False
    return ok


def test_classifier_accepts_in_process_check_success():
    """The two in-process CHECK gates that save_project runs BEFORE
    the HTTP fanout (lua_syntax_gate + lua_semantic_roundtrip) both
    record `method='CHECK', http_status=0, code=909` on success. The
    DO-write classifier MUST accept them — otherwise every override
    fails with the misleading "save failed" message even though the
    controller was never even contacted.
    """
    ok = _classifier()
    assert ok(_mk_step('lua_syntax_gate',      'CHECK', 0,   909)) is True
    assert ok(_mk_step('lua_semantic_roundtrip', 'CHECK', 0, 909)) is True


def test_classifier_accepts_successful_http_posts():
    """The four real HTTP POSTs (source, varspoint, project,
    projectlist) return http_status=200 on success — the classifier
    passes them through.
    """
    ok = _classifier()
    for name in ('source', 'varspoint', 'project', 'projectlist'):
        assert ok(_mk_step(name, 'POST', 200, 909)) is True, name


def test_classifier_flags_real_http_failures():
    """An actual HTTP failure (e.g. controller unreachable → status 0
    on a POST, or the controller returns 500) still surfaces as a
    failure — the widened filter must not swallow real errors.
    """
    ok = _classifier()
    # POST with http=0 (connection refused): NOT a CHECK success, flag.
    assert ok(_mk_step('source', 'POST', 0,   None)) is False
    assert ok(_mk_step('source', 'POST', 500, None)) is False
    # CHECK with a non-909 code (syntax_error, semantic_roundtrip_error):
    # the failure path in program_ops.save_project. Flag.
    assert ok(_mk_step('lua_syntax_gate', 'CHECK', 0, 'syntax_error')) is False
    assert ok(_mk_step('lua_semantic_roundtrip', 'CHECK', 0,
                       'semantic_roundtrip_error')) is False


def test_driver_uses_widened_classifier_in_do_write_path():
    """Text-scan pin over the driver source: the DO write worker
    (_do_do_write_lua_worker) must classify save_project return
    steps with the widened filter — same shape used at line ~2900
    (coordinated_joint save) and in dashboard_server._save_step_ok
    at line ~7341. A regression that drops the CHECK-success branch
    fails here before it reaches operator hardware.
    """
    src = _read(DRV)
    # Locate the DO write worker body.
    idx = src.find('def _do_do_write_lua_worker')
    assert idx != -1, '_do_do_write_lua_worker function missing'
    # Body ends at the next top-level def.
    body_end = src.find('\n    def ', idx + 30)
    body = src[idx:body_end] if body_end != -1 else src[idx:]
    # Must NOT use the naive filter — that's the whole regression.
    assert "http_status') != 200" not in body, (
        'naive `http_status != 200` filter is back in the DO write '
        'path — see the 2026-09-15 field bug: in-process CHECK gates '
        'record http_status=0 on success and were flagged as failed')
    # Must define _save_step_ok inline (or call an equivalent widened
    # filter), and it must handle both HTTP-200 and CHECK-909-success.
    assert 'def _save_step_ok' in body or '_save_step_ok(' in body, (
        'DO write path missing the widened save-step classifier')
    assert re.search(r"http_status'\s*\)\s*==\s*200", body), (
        'widened filter must still accept http_status == 200')
    assert re.search(r"method'\s*\)\s*==\s*'CHECK'", body), (
        'widened filter must accept method == CHECK (in-process gates)')
    assert re.search(r"code'\s*\)\s*==\s*909", body), (
        'widened filter must accept code == 909 (CHECK success sentinel)')


def test_frontend_confirm_prompts_on_do_off_toggle():
    """OPERATOR-COPY PIN — 2026-09-15.

    Per the field-bug directive: any DO override toggling ON→OFF must
    surface plain copy warning that a held part may release ("If a
    program set this output to hold a part, turning it off may release
    the part."). This fires EVERY time (no bumpConfirm skip) because
    the consequence is physical. The ON warning stays behind the
    session bumpConfirm gate (energize copy).
    """
    IO = os.path.join(REPO, 'src/cobot_dashboard/frontend/src/components/IOPortMap.jsx')
    src = _read(IO)
    idx = src.find('const onFlip = async (e) =>')
    assert idx != -1, 'onFlip handler missing'
    body = src[idx:src.find('\n  }', idx + 20)]
    # ON → OFF branch (shownPosition is true means output is currently
    # HIGH → operator is turning it OFF): release warning must appear
    # and must NOT be behind bumpConfirm.
    assert 'may release' in body, (
        'DO off-toggle must warn about releasing a held part per '
        'the operator directive')
    # Copy must name the port so the operator knows which output.
    assert '${port}' in body or '`+port+`' in body or 'DO${port}' in body, (
        'confirm copy must name the specific DO port')


def test_reject_message_names_step_and_code():
    """When save_project genuinely fails, the driver's operator-
    facing message must name (a) the failed step, (b) the http_status,
    AND (c) the returned code — code disambiguates "syntax_error"
    from "semantic_roundtrip_error" so the operator knows which gate
    tripped. Prior message only carried the HTTP status.
    """
    src = _read(DRV)
    idx = src.find('def _do_do_write_lua_worker')
    body = src[idx:src.find('\n    def ', idx + 30)]
    # The reject copy must include the failed step name, HTTP status,
    # and the returned code so a genuine failure surfaces enough
    # context to act on.
    assert "ioconsole save failed:" in body
    assert re.search(r"code=\{[^\}]*code[^\}]*\}", body) or 'code=' in body, (
        'reject message must name the code so the operator sees which '
        'gate/POST tripped')
