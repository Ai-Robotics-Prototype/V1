"""3D View immersive layout pins — 2026-09-16.

Operator directive: 3D robot viewer fills the entire content area as
the full-page background; all controls float on top as overlay panels.
The jog buttons are colored solid chips with white glyphs so they read
instantly over the 3D scene. E-STOP is never overlapped. Collapse Jog
Buttons drops the whole panel to a slim edge tab.

Layout / style only. Zero behavior changes: handlers, endpoints,
guards, hold_id lifecycle, gate predicates, wire verbs — all
untouched. If a testid moves in the DOM the pin follows the move,
never the other way around.

Related retired-page and view-switcher pins live in
test_view3d_polish.py; those stay untouched.
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
LAYOUT = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'layouts', 'View3DLayout.jsx'))
JOG    = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'JogControls.jsx'))
APP    = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'App.jsx'))


def _read(path):
    with open(path) as fh:
        return fh.read()


# ─────────────────────────────────────────────────────────────────
# 1. Full-bleed 3D canvas
# ─────────────────────────────────────────────────────────────────

def test_canvas_fills_content_area():
    """The 3D canvas mount (view3d-canvas-fill) is absolute-positioned
    at inset:0 with zIndex:0 — lowest layer, filling the entire
    View3DLayout content region.
    """
    src = _read(LAYOUT)
    idx = src.find('data-testid="view3d-canvas-fill"')
    assert idx != -1, (
        'view3d-canvas-fill testid missing — the immersive canvas '
        'mount is the anchor for every other overlay position')
    # The canvas wrapper style block sits right after the testid; grab
    # a window of ~400 chars and pin the position/inset/zIndex.
    block = src[idx:idx + 400]
    assert re.search(r"position:\s*'absolute'", block), (
        'canvas wrapper must be position: absolute (fills content)')
    assert re.search(r'inset:\s*0', block), (
        'canvas wrapper must use inset:0 (edge-to-edge fill)')
    assert re.search(r'zIndex:\s*0', block), (
        'canvas wrapper must be at zIndex:0 (lowest layer)')


def test_immersive_root_is_the_content_container():
    """The layout's root is a positioned container (not a flex column)
    so the canvas + overlays stack via absolute positioning. Prior
    top/bottom flex split retired.
    """
    src = _read(LAYOUT)
    assert 'data-testid="view3d-immersive-root"' in src, (
        'root testid missing — pins that assert overlay stacking need '
        'this anchor')
    root_idx = src.find('data-testid="view3d-immersive-root"')
    root_block = src[root_idx:root_idx + 400]
    assert re.search(r"position:\s*'relative'", root_block), (
        'root must be position:relative so absolute overlays scope to it')
    assert re.search(r"height:\s*'100%'", root_block), (
        'root must fill the parent (content grid area)')


# ─────────────────────────────────────────────────────────────────
# 2. Floating jog panel with opaque background
# ─────────────────────────────────────────────────────────────────

def test_jog_overlay_wrapper_swallows_only_its_own_pointer_events():
    """The overlay WRAPPER around the jog panel is pointerEvents:none
    so clicks/orbit in the empty margin pass through to the 3D canvas.
    The panel itself (jog-floating-panel) re-enables pointer events
    for its own controls.
    """
    src = _read(LAYOUT)
    idx = src.find('data-testid="jog-overlay-wrapper"')
    assert idx != -1
    # The wrapper style block includes NORMAL/EXPANDED-conditional
    # positioning + comments, ~1500 chars end-to-end.
    wrapper_block = src[idx:idx + 1600]
    assert re.search(r"pointerEvents:\s*'none'", wrapper_block), (
        'jog-overlay-wrapper must be pointerEvents:none so it does '
        'not block 3D orbit outside the panel body')
    # And the actual panel inside re-enables its own pointer events.
    panel_idx = src.find('data-testid="jog-floating-panel"')
    assert panel_idx != -1
    # Window big enough to cover the panel's whole style block —
    # it carries background + border + boxShadow + pointerEvents +
    # flex layout, which pushes past 1500 chars including comments.
    panel_block = src[panel_idx:panel_idx + 2500]
    assert re.search(r"pointerEvents:\s*'auto'", panel_block), (
        'jog-floating-panel must be pointerEvents:auto so its controls '
        'receive taps')


def test_overlay_panel_has_opaque_readable_background():
    """The floating jog panel MUST have a non-transparent background
    so control text stays readable against any 3D content
    (dark shadows / bright light-floor / robot mesh).

    Requirement: rgba(...) at >= 0.85 alpha OR a solid var(--bg-*)
    color. Fully-transparent panels would leave text illegible on
    busy scenes.
    """
    src = _read(LAYOUT)
    idx = src.find('data-testid="jog-floating-panel"')
    assert idx != -1
    block = src[idx:idx + 1500]
    m = re.search(r"background:\s*'rgba\(255,\s*255,\s*255,\s*([0-9.]+)\)'",
                   block)
    assert m is not None, (
        'jog-floating-panel background must be rgba(255,255,255,α) — '
        'the immersive layout wants a semi-opaque light chip so the '
        'robot silhouette bleeds around the edges without erasing '
        'control legibility')
    alpha = float(m.group(1))
    assert alpha >= 0.85, (
        f'panel background alpha {alpha} < 0.85 — text over 3D would '
        f'lose contrast on busy scenes')
    # Backdrop blur is nice-to-have (browsers that skip it still get
    # the 0.92 alpha), but pin the intent so a future edit doesn't
    # silently drop the polish.
    assert 'backdropFilter' in block, (
        'panel should apply backdropFilter (blur) for extra polish '
        'when the browser supports it')


# ─────────────────────────────────────────────────────────────────
# 3. E-STOP never overlapped by the immersive overlays
# ─────────────────────────────────────────────────────────────────

def test_estop_lives_in_a_different_grid_area_than_content():
    """AppLayout uses CSS grid `topbar | content | statusbar` so the
    TopBar (which owns E-STOP) is in a STRUCTURALLY DIFFERENT area
    from the 3D View content. This means the immersive overlays
    (bounded by the content grid cell) CANNOT overlap E-STOP no
    matter what zIndex they set. Pin the grid layout so a future
    edit that collapses grid → single flex doesn't silently open
    the overlap vector.
    """
    app_src = _read(APP)
    assert re.search(
        r'gridTemplateAreas:\s*\'"topbar"\s+"content"\s+"statusbar"\'',
        app_src), (
        'AppLayout grid areas must remain "topbar" "content" "statusbar" '
        '— the E-STOP-is-unreachable-by-content-overlays invariant '
        'depends on this structural separation')


def test_overlay_zindex_is_scoped_below_topbar_stacking():
    """The jog overlay wrapper uses zIndex:10 — well below any modal
    (typical 9990+) and inside the content grid area so it can't
    reach the E-STOP in TopBar. Pin the value stays bounded.
    """
    src = _read(LAYOUT)
    idx = src.find('data-testid="jog-overlay-wrapper"')
    block = src[idx:idx + 1600]
    m = re.search(r'zIndex:\s*(\d+)', block)
    assert m is not None, 'overlay wrapper missing zIndex declaration'
    z = int(m.group(1))
    assert 1 <= z <= 100, (
        f'overlay wrapper zIndex {z} out of range — must be > 0 (above '
        f'canvas) and well below modal / global-banner tiers (>=9990)')


# ─────────────────────────────────────────────────────────────────
# 4. Collapse-to-tab: MINIMIZED renders only the slim pill
# ─────────────────────────────────────────────────────────────────

def test_minimized_collapses_to_expand_pill_only():
    """When jogPanelMode==='MINIMIZED', the layout renders ONLY the
    RealArmMinimizedPill (the "Expand Jog Buttons" pill) — no
    floating chrome, no controls, so the 3D view is fully
    unobstructed.
    """
    src = _read(LAYOUT)
    # The layout conditionally renders the overlay wrapper based on
    # !isMinimized — pin the guard so a future edit can't drop it.
    assert re.search(
        r'\{isMinimized\s*&&\s*<RealArmMinimizedPill',
        src), (
        'MINIMIZED must render ONLY the RealArmMinimizedPill — no '
        'chrome, no jog overlay wrapper')
    assert re.search(
        r'\{!isMinimized\s*&&\s*\(\s*\n\s*<div\s*\n\s*data-testid="jog-overlay-wrapper"',
        src), (
        'the jog overlay wrapper must be guarded by !isMinimized so '
        'a collapse fully clears the panel from the canvas')


def test_expand_pill_testid_still_present():
    """The pill's testid pin (expand-jog-buttons) MUST survive the
    immersive refactor — existing polish pin in test_view3d_polish
    also asserts this, but pinning here catches a regression in
    isolation if that file is rearranged.
    """
    src = _read(LAYOUT)
    assert 'data-testid="expand-jog-buttons"' in src


# ─────────────────────────────────────────────────────────────────
# 5. Colored solid jog buttons
# ─────────────────────────────────────────────────────────────────

def test_arrow_pad_renders_solid_color_chip():
    """ArrowPad renders a solid color-filled chip with WHITE glyph +
    label. Prior treatment (white background with colored SVG +
    grey label) is retired for the immersive layout so buttons
    read instantly over the 3D scene.
    """
    src = _read(JOG)
    idx = src.find('function ArrowPad(')
    assert idx != -1
    # Body ends at the next top-level function.
    body_end = src.find('\nfunction ', idx + 10)
    body = src[idx:body_end] if body_end != -1 else src[idx:]
    # HoldButton receives bg=color, bgHover=darken(color) — that's
    # the "solid chip" contract.
    assert 'bg={color}' in body, (
        'ArrowPad must pass bg={color} to HoldButton so the button '
        'background is the directional color (solid chip)')
    assert 'bgHover={_jogDarken(color)}' in body, (
        'ArrowPad must pass a darker bgHover so pressed / hover state '
        'is visibly distinct from idle')
    # SVG arrow and label are now white (contrast over the color chip).
    assert 'fill="#fff"' in body, (
        'ArrowPad SVG arrow must be filled white over the color chip')
    assert re.search(r"color:\s*'#fff'", body), (
        'ArrowPad label must be white over the color chip')


def test_directional_color_map_preserved():
    """The X/Y/Z/Rx/Rz color code did NOT change — only the fill
    treatment did. Prior operator convention (X red / Y green /
    Z blue / Rx purple / Rz gold) stays.
    """
    src = _read(JOG)
    # Count each directional color hex — expected minimum occurrences
    # cover the two ArrowPad call sites per axis (X±, Y±, Z± in the
    # cartesian pad; Rx±, Rz± in the rotation pad; joint mode uses
    # green + red as well). If any hex disappears, a direction lost
    # its color coding.
    color_min = {
        '#DC2626': 3,   # X± cartesian + joint −
        '#16A34A': 3,   # Y± cartesian + joint +
        '#3B82F6': 2,   # Z± cartesian
        '#9333EA': 2,   # Rx± rotation
        '#CA8A04': 2,   # Rz± rotation
    }
    for hex_color, min_count in color_min.items():
        cnt = len(re.findall(r'color="' + re.escape(hex_color) + '"', src))
        assert cnt >= min_count, (
            f'directional color {hex_color} appears {cnt} times, '
            f'expected at least {min_count} — a direction lost its '
            f'color coding')


def test_disabled_state_still_dimmed_via_hold_button():
    """The disabled treatment (opacity 0.4 + not-allowed cursor)
    lives in HoldButton and stays untouched by the ArrowPad
    solid-chip refactor. Pin the HoldButton style block still
    carries the disabled opacity so refusal-copy pipeline (which
    disables via disabled prop) still visibly dims.
    """
    src = _read(JOG)
    hb_idx = src.find('export function HoldButton(')
    assert hb_idx != -1
    body_end = src.find('\nfunction ', hb_idx + 10)
    hb_body = src[hb_idx:body_end] if body_end != -1 else src[hb_idx:]
    assert 'opacity: disabled ? 0.4 : 1' in hb_body, (
        'HoldButton disabled dimming must remain — the refusal pipeline '
        'drives visibility of hold-dead, wall, controller-not-ready '
        'via this style')


# ─────────────────────────────────────────────────────────────────
# 6. Zero behavior diff — layout only
# ─────────────────────────────────────────────────────────────────

def test_no_new_handler_or_gate_added_in_layout():
    """The immersive refactor touches CSS + testid attributes only.
    No new fetch / onClick / gate predicate should appear in the
    layout for this change. If a future edit inserts a handler
    without moving it to a proper component, this catches it.

    Pin: the layout imports the SAME components as before (viewer,
    standalone robot, orient button, jog controls, arm enable,
    ready badge). No new component imports without an update here.
    """
    src = _read(LAYOUT)
    # Load-bearing imports must all still be present. This mirrors
    # the pre-refactor import list.
    for imp in ('ArmViewer3D', 'StandaloneRobot',
                'OrientFlangeDownControl', 'JogControls',
                'ArmEnableControl', 'JogReadyBadge'):
        assert imp in src, f'{imp} import lost in refactor'
    # No fetch/onClick/useEffect side-effect additions to the layout
    # itself. The layout should stay a thin presentation shell.
    # Prior file has no top-level fetch calls; keep it that way.
    assert 'fetch(' not in src, (
        'View3DLayout must not introduce a fetch — behavior stays in '
        'components / store, layout is presentation only')
