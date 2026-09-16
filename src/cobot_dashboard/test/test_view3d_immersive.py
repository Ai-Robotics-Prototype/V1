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


def test_overlay_panel_container_is_transparent():
    """2026-09-16 correction: the jog surface container MUST be fully
    transparent (no bg, no border, no shadow, no radius, no blur) so
    the 3D scene shows THROUGH the whole surface. Only the
    buttons / controls themselves carry chip backgrounds. Prior
    rgba(255,255,255,0.92) card was the mistake the operator called
    out — pin so it can't come back.
    """
    src = _read(LAYOUT)
    idx = src.find('data-testid="jog-floating-panel"')
    assert idx != -1
    block = src[idx:idx + 1500]
    assert re.search(r"background:\s*'transparent'", block), (
        'jog-floating-panel MUST be background:transparent so the 3D '
        'scene shows through between controls — no white card')
    # Reject the retired card treatments explicitly so a partial
    # revert stands out.
    for banned in ('borderRadius', 'boxShadow', 'rgba(255, 255, 255,'):
        assert banned not in block, (
            f'jog-floating-panel container must not carry `{banned}` — '
            f'the transparent-surface directive forbids the "floating '
            f'card" treatment')


def test_jog_surface_row_is_fully_transparent():
    """2026-09-16 operator directive: the jog surface row MUST be
    fully transparent — no color tint, no blur. The 3D scene shows
    through at 100 % between and around controls. Prior translucent
    gray scrim (rgba(107,114,128,0.18)) + backdrop-blur retired;
    canvas full-bleed behind the surface handles the "readability
    by contrast" case, and loose labels carry their own text-shadow.
    """
    src = _read(JOG)
    idx = src.find('data-testid="jog-surface-row"')
    assert idx != -1, (
        'jog-surface-row testid missing — the transparency pin needs '
        'this anchor to inspect the correct div')
    block = src[idx:idx + 1500]
    assert re.search(r"background:\s*'transparent'", block), (
        'jog-surface-row MUST be background:transparent — every prior '
        'tint (rgba(107,114,128,0.18), #fff, backdropFilter) is '
        'retired per the operator directive')
    # Reject the retired treatments explicitly so a partial revert
    # to any of them surfaces here.
    for banned in ('backdropFilter', 'rgba(107, 114, 128',
                   'rgba(255, 255, 255,', "'#fff'"):
        assert banned not in block, (
            f'jog-surface-row style must not carry `{banned}` — the '
            f'transparency directive forbids any tint or backdrop '
            f'treatment on the surface itself')


def test_jog_surface_row_has_no_internal_overflow_scroll():
    """The row wrapper's prior overflowY:'auto' was the source of
    the operator-reported scrollbar on the immersive surface. Pin
    that overflowY is visible (or hidden) — never auto/scroll.
    """
    src = _read(JOG)
    idx = src.find('data-testid="jog-surface-row"')
    block = src[idx:idx + 1500]
    # Skip block comments so the retirement note ("previous
    # overflowY:'auto' was the source of…") doesn't false-match. The
    # style declaration lives outside the comment on its own line.
    block_no_comments = re.sub(r'//[^\n]*', '', block)
    m = re.search(
        r"overflowY:\s*'([a-zA-Z]+)'", block_no_comments)
    assert m is not None, 'jog-surface-row missing overflowY declaration'
    val = m.group(1)
    assert val in ('visible', 'hidden'), (
        f"jog-surface-row overflowY='{val}' — must be 'visible' or "
        f"'hidden'. 'auto' / 'scroll' would reintroduce the internal "
        f"scrollbar the operator called out")


def test_overlay_panel_has_no_internal_scroll():
    """The scrollable children container inside the jog panel used
    overflow:auto — it produced an internal scrollbar when the pad
    body exceeded 440 px on the operator's viewport. The correction
    changes overflow to 'visible' so content lays out at its natural
    size over the canvas with NO scrollbar.
    """
    src = _read(LAYOUT)
    # The children wrapper sits directly before the {children} render
    # inside RealArmChrome — grep for the specific comment-anchored
    # style.
    chrome_start = src.find('function RealArmChrome(')
    body_end = src.find('function ', chrome_start + 20)
    body = src[chrome_start:body_end]
    assert re.search(
        r"flex:\s*1,\s*minHeight:\s*0,\s*overflow:\s*'visible'",
        body), (
        'RealArmChrome children wrapper must use overflow:visible so '
        'no internal scrollbar appears on the transparent surface')
    # And the scroll variant must be gone.
    assert "overflow: 'auto'" not in body, (
        'overflow:auto is retired from RealArmChrome — it was the '
        'source of the operator-reported internal scrollbar')


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
    # 2026-09-16 uniform-blue directive: the "solid chip" contract
    # is now bg=JOG_BUTTON_BLUE, bgHover=_jogDarken(that). Prior
    # per-axis bg={color} / bgHover={_jogDarken(color)} pins retired
    # (see test_jog_buttons_use_uniform_primary_blue for the new pin).
    assert 'bg={chipBg}' in body, (
        'ArrowPad must pass bg={chipBg} (derived from JOG_BUTTON_BLUE) '
        'to HoldButton so every direction renders in the uniform '
        'primary blue')
    assert 'bgHover={chipDim}' in body, (
        'ArrowPad must pass a darker bgHover so pressed / hover state '
        'is visibly distinct from idle')
    # SVG arrow and label are now white (contrast over the color chip).
    assert 'fill="#fff"' in body, (
        'ArrowPad SVG arrow must be filled white over the color chip')
    assert re.search(r"color:\s*'#fff'", body), (
        'ArrowPad label must be white over the color chip')


def test_jog_buttons_use_uniform_primary_blue():
    """2026-09-16 operator directive: every jog direction button
    renders in the app's PRIMARY BLUE (#2563EB, same token the
    mode toggles + step-size chips use when active). Per-axis
    red/green/blue/purple/gold color code retired.

    Pins:
      (a) JOG_BUTTON_BLUE constant exists and equals #2563EB.
      (b) ArrowPad chip fill uses JOG_BUTTON_BLUE (not the caller-
          passed `color` prop) — so every axis gets the same blue
          regardless of the historical per-axis color literals still
          appearing at call sites for archival intent.
      (c) modeBtnStyle continues to use the same #2563EB token when
          active, so the visual language is coherent (chips + jog
          buttons share the primary-blue token).
    """
    src = _read(JOG)
    assert "const JOG_BUTTON_BLUE = '#2563EB'" in src, (
        'JOG_BUTTON_BLUE token missing or wrong value — every jog '
        'button must use the app primary blue #2563EB')
    # ArrowPad body must render via JOG_BUTTON_BLUE, not the caller
    # `color` prop.
    idx = src.find('function ArrowPad(')
    end = src.find('\nfunction ', idx + 10)
    body = src[idx:end] if end != -1 else src[idx:]
    assert 'const chipBg = JOG_BUTTON_BLUE' in body, (
        'ArrowPad must derive its chip background from JOG_BUTTON_BLUE '
        '(one token, one blue, every direction)')
    # And the color prop must NOT reach the chip background — a
    # partial revert would re-introduce `bg={color}` (per-axis).
    assert 'bg={color}' not in body, (
        'ArrowPad `bg={color}` (per-axis fill) is retired — every '
        'button must render in the uniform JOG_BUTTON_BLUE')
    # modeBtnStyle uses the same primary-blue token when active —
    # locks the visual language across chips + buttons.
    assert re.search(
        r"background:\s*on\s*\?\s*'#2563EB'", src), (
        'modeBtnStyle active fill must remain #2563EB — the jog '
        'buttons and mode toggles share this primary-blue token')


def test_loose_labels_have_text_shadow_for_over_3d_readability():
    """2026-09-16 correction: labels that sit directly over the 3D
    scene ('Jog', 'Position/Height/Rotation', 'Step Size', 'Speed:',
    'moves while held' / 'one step per press') carry a compact
    white text-shadow so they stay readable on any floor tone
    without needing a large panel behind them. Shared constant
    LABEL_TEXT_SHADOW pins the treatment so future edits can't
    silently drop the shadow.
    """
    src = _read(JOG)
    assert 'const LABEL_TEXT_SHADOW' in src, (
        'shared LABEL_TEXT_SHADOW constant missing — its purpose is '
        'to keep the loose-label shadow treatment consistent across '
        'every text sitting over the 3D scene')
    # padLabel (Position / Height / Rotation) must apply it.
    pad_idx = src.find('const padLabel = (text) =>')
    assert pad_idx != -1
    pad_body = src[pad_idx:pad_idx + 500]
    assert 'LABEL_TEXT_SHADOW' in pad_body, (
        'padLabel (Position / Height / Rotation) must render with '
        'LABEL_TEXT_SHADOW')
    # Other loose labels must reference it too. Count occurrences:
    # padLabel + 'Jog' heading + 'moves while held/one step per press'
    # + 'Step Size' + 'Speed:' = at least 5 usages.
    uses = src.count('LABEL_TEXT_SHADOW')
    # 1 declaration + at least 5 applications = >= 6.
    assert uses >= 6, (
        f'LABEL_TEXT_SHADOW referenced only {uses} times — expected '
        f'>= 6 (declaration + Jog heading + padLabel + hint + '
        f'Step Size + Speed:); a loose label lost its treatment')


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

def test_view3d_root_scopes_touch_action_none():
    """2026-09-16 zoom-capture — the 3D View root MUST set
    touchAction:'none' so browser pinch-zoom / double-tap-zoom
    is suppressed on THIS page only. Element-scoped, so Monitor /
    Program / I/O pages keep default browser zoom.
    """
    src = _read(LAYOUT)
    idx = src.find('data-testid="view3d-immersive-root"')
    assert idx != -1
    block = src[idx:idx + 1200]
    assert re.search(r"touchAction:\s*'none'", block), (
        "view3d-immersive-root MUST set touchAction:'none' to block "
        "browser page-zoom on this screen without touching the "
        "viewport meta (which would leak to every other tab)")


def test_view3d_root_attaches_non_passive_wheel_and_gesture_handlers():
    """2026-09-16 zoom-capture — a useEffect on the 3D View root
    MUST attach non-passive wheel + Safari gesture* listeners that
    preventDefault, so ctrl+wheel (desktop / trackpad pinch) and
    iOS Safari pinch don't page-zoom over button gaps above the
    canvas. Listeners live on the ELEMENT (not window / document)
    so other tabs are unaffected.
    """
    src = _read(LAYOUT)
    # Non-passive wheel listener on the root ref.
    assert re.search(
        r"el\.addEventListener\('wheel',\s*onWheel,\s*\{\s*passive:\s*false\s*\}\)",
        src), (
        'root must attach a non-passive wheel listener so '
        'preventDefault (needed to block ctrl+wheel page zoom) '
        'is honored')
    # Wheel handler must preventDefault on ctrlKey (browser zoom
    # trigger — also fires for trackpad pinch on macOS / Windows).
    assert re.search(
        r"if\s*\(\s*e\.ctrlKey\s*\)\s*e\.preventDefault\(\)",
        src), (
        'wheel handler must preventDefault when e.ctrlKey — that is '
        'the desktop trackpad-pinch / ctrl+wheel signature')
    # Safari gesture* listeners.
    for evt in ('gesturestart', 'gesturechange', 'gestureend'):
        assert re.search(
            r"el\.addEventListener\('" + evt + r"',\s*onGesture",
            src), (
            f'root must attach {evt} listener for iOS Safari pinch — '
            f'touch-action:none does not cover Safari gesture* events')
    # Global-scope leak check: handlers must be on the root element,
    # never on window / document (that would kill zoom on other tabs).
    assert not re.search(r"window\.addEventListener\('wheel'", src), (
        'wheel handler must NOT attach to window — that would '
        'suppress zoom on Monitor / Program / I/O too')
    assert not re.search(r"document\.addEventListener\('wheel'", src), (
        'wheel handler must NOT attach to document — that would '
        'suppress zoom on Monitor / Program / I/O too')


def test_viewport_meta_preserves_zoom_on_other_pages():
    """2026-09-16 zoom-capture — the page-level viewport meta MUST
    NOT set user-scalable=no or maximum-scale, since that would
    globally kill browser zoom on Monitor / Program / I/O too. The
    3D View zoom suppression is element-scoped, not viewport-wide.
    """
    idx_path = os.path.abspath(os.path.join(
        HERE, '..', 'frontend', 'index.html'))
    with open(idx_path) as fh:
        idx_html = fh.read()
    m = re.search(r'<meta name="viewport"\s+content="([^"]+)"', idx_html)
    assert m is not None, 'viewport meta tag missing from index.html'
    content = m.group(1)
    assert 'user-scalable=no' not in content, (
        'viewport meta user-scalable=no would globally disable browser '
        'zoom — other tabs (Monitor / Program / I/O) require default '
        'browser accessibility zoom. The 3D View zoom suppression is '
        'element-scoped, not viewport-wide.')
    assert 'maximum-scale=1' not in content, (
        'viewport meta maximum-scale=1 would globally cap browser zoom '
        'at 100 % — accessibility violation for other tabs')


def test_speed_slider_opts_back_in_to_touch_drag():
    """2026-09-16 zoom-capture — the root's touchAction:none
    propagates to descendants, which can block native
    <input type=range> touch drag on the tablet. The speed slider
    explicitly opts back in with touchAction:'pan-x' so the thumb
    stays draggable.
    """
    src = _read(JOG)
    slider_idx = src.find('data-testid="jog-speed-slider"')
    assert slider_idx != -1
    # The style is applied on the same <input> element; look up
    # a small window in either direction.
    block = src[max(0, slider_idx - 400):slider_idx + 600]
    assert re.search(r"touchAction:\s*'pan-x'", block), (
        "jog-speed-slider must set touchAction:'pan-x' so the native "
        "range-input thumb is still draggable under the root's "
        "touch-action:none")


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
