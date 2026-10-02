"""Custom End-of-Arm Tool wizard subflow pinned regression (2026-09-08).

Phase 2 shipping surface pins:
  1. CustomGripperPanel replaced with the new subflow that routes
     through /api/tools/* (NOT the legacy /api/gripper/upload).
  2. Sub-step machine: pick_or_upload → alignment → tcp → payload.
  3. TCP + payload each have MANDATORY refusals surfaced in the UI
     with the exact operator copy from tools_library.py.
  4. The wizard promotes answers.custom_tool_id to config.tool_id
     on save so codegen picks it up (per item 4 pin
     test_custom_eoat_codegen.py).
  5. ArmViewer3D parents the tool GLB to the flange via the new
     `/api/tools/{id}/mesh` URL when program.config.tool_id is set.
  6. HookupGuide filters gripper_hookups.custom by the current
     program's config.tool_id (item 6 schema extension).
  7. Wizard-internal state (custom_tool_substep, custom_tool_id) is
     stripped from the saved config so on-disk programs stay clean.

All assertions are static reads on the JSX + JS source — the wizard
is a fat React component whose actual behavior is exercised in the
frontend node smoke test (dashboard's separate jest surface); these
Python fences pin the WIRING so a future refactor can't silently
regress the shape.
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
WIZARD = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'ProgramWizard.jsx'))
HOOKUP = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'HookupGuide.jsx'))
VIEWER = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'ArmViewer3D.jsx'))
API = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'lib', 'toolsApi.js'))
LIB = os.path.abspath(os.path.join(
    HERE, '..', 'cobot_dashboard', 'tools_library.py'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def _strip_all_comments(src):
    s = re.sub(r'\{/\*.*?\*/\}', '', src, flags=re.DOTALL)
    s = re.sub(r'/\*.*?\*/', '', s, flags=re.DOTALL)
    s = '\n'.join(
        line for line in s.splitlines()
        if not line.lstrip().startswith('//'))
    return s


def test_wizard_routes_through_new_tools_api_not_legacy_gripper_api():
    """Legacy /api/gripper/upload is gone from CustomGripperPanel;
    the new /api/tools/upload path (via toolsApi.js wrapper) is
    used instead."""
    code = _strip_all_comments(_read(WIZARD))
    # The custom tool subflow imports the new API module.
    assert "from '../lib/toolsApi'" in code
    # These wrappers are the only intended callers into the API.
    for fn in ('uploadTool', 'pollUntilConverted',
               'putMountTransform', 'putTcp',
               'putPayload', 'confirmTool'):
        assert fn in code, f'toolsApi.{fn} must be wired from wizard'


def test_wizard_carries_all_five_substep_ids():
    """Sub-step machine: pick_or_upload → alignment → tcp →
    payload. Each id is checked in a top-level substep === '<id>'
    branch."""
    code = _strip_all_comments(_read(WIZARD))
    for sid in ('pick_or_upload', 'alignment', 'tcp', 'payload'):
        assert f"substep === '{sid}'" in code, \
            f'wizard sub-step {sid!r} branch missing'


def test_wizard_promotes_custom_tool_id_to_config_tool_id():
    """On save, answers.custom_tool_id becomes config.tool_id so
    codegen (program_ops.py _emit_tool_var) can pick it up. Wizard-
    internal state is stripped so on-disk programs stay clean."""
    code = _strip_all_comments(_read(WIZARD))
    assert 'config.tool_id = answers.custom_tool_id' in code
    # Wizard-internal state must be stripped.
    assert 'delete config.custom_tool_substep' in code
    assert 'delete config.custom_tool_id' in code


def test_tcp_and_payload_surface_the_backend_refusal_copy():
    """The wizard checks TCP-all-zero client-side (fast refusal) and
    payload<=0 client-side, using the SAME operator copy the backend
    emits so a refusal is identical whichever side catches it."""
    code = _strip_all_comments(_read(WIZARD))
    assert 'the robot needs to know where this tool works' in code
    assert 'payload is required so the robot can plan safe motion' in code
    # And those constants exist verbatim in the backend module too.
    lib_src = _read(LIB)
    assert 'the robot needs to know where this tool works' in lib_src
    assert 'payload is required so the robot can plan safe motion' in lib_src


def test_retro_edit_confirm_modal_wired():
    """directive item 7 guard: putTcp returns
    {retroEditRequired:true, programs, message} when the tool is
    referenced by existing programs; the wizard MUST render a modal
    naming those programs before writing."""
    code = _strip_all_comments(_read(WIZARD))
    assert 'RetroEditConfirmModal' in code
    assert 'retroGuard' in code
    # And the modal names the affected programs.
    assert '(programs || []).map' in code


def test_viewer_parents_glb_to_flange_via_new_mesh_url():
    """directive item 5: when program.config.tool_id is set, the
    3D viewer resolves the glb URL to /api/tools/<id>/mesh (not the
    legacy /grippers/glb/<id>.glb path). Precedence: tool_id wins
    over legacy gripper_model_id so pre-EOAT programs still render."""
    code = _strip_all_comments(_read(VIEWER))
    assert '/api/tools/${encodeURIComponent(_toolId)}/mesh' in code
    # Legacy path stays as fallback for pre-EOAT programs.
    assert '/grippers/glb/' in code


def test_hookup_guide_filters_custom_by_tool_id():
    """directive item 6: gripper_hookups.custom entries carry an
    optional tool_id field; the HookupGuide filters to entries
    matching the current program's config.tool_id (or entries with
    no tool_id at all — the legacy shape)."""
    code = _strip_all_comments(_read(HOOKUP))
    assert 'gripperType === \'custom\'' in code
    assert 'program?.config?.tool_id' in code
    assert 'h.tool_id === activeToolId' in code


def test_hookup_guide_accepts_program_prop():
    """The filter needs the current program, threaded as a prop."""
    code = _strip_all_comments(_read(HOOKUP))
    assert 'program = null' in code, \
        'HookupGuide must accept `program` prop to filter custom hookups'


def test_tools_api_wrappers_use_named_refusal_pattern():
    """Every wrapper in toolsApi.js goes through _refuseByName
    on !res.ok, which throws with the backend's detail (the
    operator copy) — no HTTP status leakage past this layer."""
    code = _strip_all_comments(_read(API))
    for fn in ('uploadTool', 'putMountTransform',
               'putPayload', 'confirmTool', 'deleteTool'):
        # Find the function and check it routes through _refuseByName.
        m = re.search(
            rf'export async function {fn}\([^)]*\) \{{([\s\S]*?)\n\}}',
            code)
        assert m, f'{fn} export not found'
        body = m.group(1)
        assert '_refuseByName(res)' in body, \
            f'{fn} must route errors through _refuseByName'


def test_toolmeshurl_helper_exists_and_matches_backend_route():
    code = _read(API)
    assert 'export function toolMeshUrl(toolId)' in code
    assert '/api/tools/${encodeURIComponent(toolId)}/mesh' in code
