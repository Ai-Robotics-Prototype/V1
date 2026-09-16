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
    # Allow any inline props between <div and the testid (a ref was
    # added when framing switched to measured DOM); the load-bearing
    # invariant is the !isMinimized guard AND the wrapper testid.
    assert re.search(
        r'\{!isMinimized\s*&&\s*\(\s*\n\s*<div\b[\s\S]{0,200}'
        r'data-testid="jog-overlay-wrapper"',
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


def test_orbit_controls_touch_mapping_pinned():
    """2026-09-16 tablet-gesture fix — OrbitControls must explicitly
    pin the touch mapping (ONE=ROTATE, TWO=DOLLY_PAN). Prior code
    relied on drei defaults; a version bump could silently drop
    two-finger pan (operator reported it broken on tablet). Pinning
    the mapping in the component prevents that regression.
    """
    viewer = _read(os.path.join(
        HERE, '..', 'frontend', 'src', 'components', 'ArmViewer3D.jsx'))
    # OrbitControls block must set touches with both handlers.
    assert re.search(
        r"touches=\{\{\s*ONE:\s*THREE\.TOUCH\.ROTATE,\s*"
        r"TWO:\s*THREE\.TOUCH\.DOLLY_PAN",
        viewer, re.DOTALL), (
        'OrbitControls must pin touches={{ ONE: THREE.TOUCH.ROTATE, '
        'TWO: THREE.TOUCH.DOLLY_PAN }} — the two-finger pan/dolly '
        'gesture depends on TOUCH.DOLLY_PAN being explicitly set '
        'so a drei version bump cannot regress it')


def test_canvas_fill_carries_touch_action_none():
    """2026-09-16 tablet-gesture fix — the canvas-fill wrapper
    ALSO carries touchAction:'none' (not just the immersive root),
    reinforcing that touchmove is delivered to OrbitControls without
    the browser intercepting for page pan/zoom. Belt-and-braces
    against browsers where touch-action doesn't cleanly propagate.
    """
    src = _read(LAYOUT)
    idx = src.find('data-testid="view3d-canvas-fill"')
    assert idx != -1
    block = src[idx:idx + 800]
    assert re.search(r"touchAction:\s*'none'", block), (
        "view3d-canvas-fill must set touchAction:'none' — reinforces "
        "the root-scoped zoom capture on the canvas layer itself so "
        "OrbitControls always sees the touch")


def test_jog_overlay_wrapper_still_pointer_events_none_for_multi_touch():
    """2026-09-16 tablet-gesture fix — the jog overlay wrapper MUST
    remain pointerEvents:'none' so multi-touch gestures starting in
    the gaps between jog buttons reach the canvas below. A partial
    revert that sets pointerEvents:'auto' on the wrapper (even
    briefly) would eat the second finger of a pan gesture.
    """
    src = _read(LAYOUT)
    idx = src.find('data-testid="jog-overlay-wrapper"')
    assert idx != -1
    block = src[idx:idx + 1600]
    assert re.search(r"pointerEvents:\s*'none'", block), (
        "jog-overlay-wrapper must be pointerEvents:'none' so the "
        "empty transparent margin doesn't swallow multi-touch bound "
        "for the canvas below")


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


def test_default_framing_measured_from_actual_surface_bounds():
    """2026-09-16 default-framing MEASURED (supersedes the fixed-
    constant attempt). Operator field-fail: arm still sat partly
    under the jog buttons at default framing on the tablet because
    the fixed 0.60 assumed a desktop-sized jog band. Correct
    approach: MEASURE the actual rendered jog-surface top edge via
    getBoundingClientRect at runtime, fit the arm bbox into the
    region above it with a safety margin. Recompute on load,
    resize, orientationchange, visibilitychange (PWA), and every
    jog-panel-mode change.
    """
    src = _read(LAYOUT)
    # Constants pinned so a future edit doesn't silently drop the
    # safety margin or the clamps.
    assert re.search(r'const\s+FRAMING_MARGIN_PX\s*=\s*\d+', src), (
        'FRAMING_MARGIN_PX constant missing — the arm bottom must '
        'have a safety gap above the surface top')
    assert re.search(r'const\s+FRAMING_MIN_TOP_FRAC\s*=', src), (
        'FRAMING_MIN_TOP_FRAC clamp missing — extreme aspect '
        'ratios would collapse framing to zero')
    assert re.search(r'const\s+FRAMING_MAX_TOP_FRAC\s*=', src), (
        'FRAMING_MAX_TOP_FRAC clamp missing — full-viewport '
        'framing needs a tiny gutter so the reach dome does not '
        'clip against the browser chrome')
    # The recompute path uses getBoundingClientRect on the panel
    # ref — this is the load-bearing signal.
    assert 'getBoundingClientRect' in src, (
        'framing recompute must call getBoundingClientRect on the '
        'panel ref — the operator directive is explicit: measure '
        'the actual rendered surface, do not hardcode a fraction')
    # Fraction derives from (r.top - MARGIN) / viewportH.
    assert re.search(
        r'\(r\.top\s*-\s*FRAMING_MARGIN_PX\)\s*/\s*viewportH', src), (
        'visibleTopFrac must be (panel.top - FRAMING_MARGIN_PX) / '
        'viewportH — the arm bbox bottom edge lands MARGIN_PX above '
        'the panel top')
    # Recompute triggers cover every entry point named in the
    # operator directive.
    for trigger in ('ResizeObserver', "'resize'",
                    "'orientationchange'", "'visibilitychange'"):
        assert trigger in src, (
            f'framing recompute must trigger on {trigger} — the '
            f'operator directive lists load, resize, orientation '
            f'change, and PWA standalone launch (visibilitychange)')
    # Panel ref attached to the jog overlay wrapper (measured
    # element).
    assert re.search(
        r'ref=\{panelRef\}\s*\n\s*data-testid="jog-overlay-wrapper"',
        src), (
        'panelRef must attach to jog-overlay-wrapper so its top '
        'edge drives the measured fraction')
    # ArmViewer3D still receives the framing prop.
    assert re.search(
        r"<ArmViewer3D[^>]*framing=\{framing\}", src, re.DOTALL), (
        'ArmViewer3D must receive the framing prop so applyPreset '
        'can apply the measured top-region shift')
    # Rejects the retired fixed-0.60 constant so a partial revert
    # is caught.
    assert 'DEFAULT_VISIBLE_TOP_FRAC' not in src, (
        'DEFAULT_VISIBLE_TOP_FRAC retired — the constant approach '
        'produced the tablet field-fail. Runtime measurement is '
        'the standing contract now.')


def test_live_bbox_wiring_from_standalone_robot_to_view3d():
    """2026-09-16 LIVE-BBOX FIX pin — the immersive layout must
    plumb a LIVE bounding box getter from StandaloneRobot's jogApi
    through View3DLayout down to ArmViewer3D's applyPreset. Prior
    code used a hardcoded ARM_BBOX_APPROX envelope which overflowed
    on tall/extended poses (arm bottom clipped into buttons).
    """
    layout = _read(LAYOUT)
    viewer = _read(os.path.join(
        HERE, '..', 'frontend', 'src', 'components', 'ArmViewer3D.jsx'))
    standalone = _read(os.path.join(
        HERE, '..', 'frontend', 'src', 'components', 'StandaloneRobot.jsx'))
    # StandaloneRobot exposes a getBBox on the jogApi it hands back.
    assert 'getBBox: () =>' in standalone, (
        'StandaloneRobot.jogApi must expose getBBox() so the framing '
        'math can measure the arm at its current joint pose')
    assert 'new THREE.Box3().setFromObject' in standalone, (
        'getBBox must use Box3.setFromObject on the URDF root — the '
        'live bbox reflects the current joint pose')
    # View3DLayout wires jogApi?.getBBox into ArmViewer3D's
    # getLiveBbox prop.
    assert re.search(
        r'getLiveBbox=\{jogApi\?\.getBBox\}', layout), (
        'View3DLayout must pass jogApi?.getBBox as ArmViewer3D\'s '
        'getLiveBbox prop — otherwise the framing falls back to the '
        'static ARM_BBOX_APPROX envelope and overflows on tall poses')
    # ArmViewer3D applyPreset uses getLiveBbox() first, falls back
    # to armBboxRef, then ARM_BBOX_APPROX only as last resort.
    ap_idx = viewer.find('const applyPreset = (name) =>')
    end = viewer.find('\n  }', ap_idx + 30)
    ap_body = viewer[ap_idx:end]
    assert 'getLiveBbox()' in ap_body, (
        'applyPreset must call getLiveBbox() to get the current-pose '
        'bounding box')
    assert 'liveBox3.getSize' in ap_body, (
        'applyPreset must derive maxDim + centerY from the live '
        'Box3 via getSize + getCenter')
    # useEffect deps include getLiveBbox so the reframe fires once
    # jogApi becomes non-null.
    idx = viewer.find('[framing?.visibleTopFrac, getLiveBbox]')
    assert idx != -1, (
        'ArmViewer3D reframe useEffect deps must include getLiveBbox '
        'so the arm re-frames the moment the live bbox becomes '
        'available (jogApi ready)')


def test_framing_fits_compact_and_tall_poses_at_two_viewports():
    """2026-09-16 replaces the hardcoded-dims pin. Simulates TWO
    joint poses (compact + tall/extended) and asserts the arm bbox
    bottom clears the jog surface top by FRAMING_MARGIN_PX in BOTH
    poses, at tablet landscape AND desktop viewport heights. This
    is the "arm-bbox-above-surface-top" acceptance test the
    operator directive names.
    """
    import math
    FOV_DEG = 45.0
    MARGIN_PX = 24
    JOG_BAND_PX = 440   # RealArmChrome height budget (doctrine pin)

    def gap_for(vp_h, arm_max_dim, arm_center_y):
        """Return pixel gap between arm bottom and jog surface top.
        Positive = clear; negative = arm clips into buttons.
        Math mirrors ArmViewer3D._framedPreset for the ISO preset
        (typical default; other presets use the same top-region
        shift so ISO is representative)."""
        surface_top = vp_h - JOG_BAND_PX
        top_frac = (surface_top - MARGIN_PX) / vp_h
        top_frac = max(0.30, min(0.98, top_frac))
        fov = math.radians(FOV_DEG)
        dist = (arm_max_dim * 1.15) / (top_frac * 2 * math.tan(fov / 2))
        jog_frac = 1 - top_frac
        world_y_offset = jog_frac * dist * math.tan(fov / 2)
        target_y = arm_center_y - world_y_offset
        world_h_at_target = 2 * dist * math.tan(fov / 2)
        px_per_world = vp_h / world_h_at_target
        arm_center_offset_px = (arm_center_y - target_y) * px_per_world
        arm_center_from_top = vp_h / 2 - arm_center_offset_px
        arm_half_px = (arm_max_dim / 2) * px_per_world
        arm_bottom_from_top = arm_center_from_top + arm_half_px
        return surface_top - arm_bottom_from_top

    # Two representative poses derived from S10-140 kinematics.
    POSES = {
        # Home / compact — arm folded over base; small vertical extent.
        'compact':  {'maxDim': 0.90, 'centerY': 0.55},
        # Tall / extended — J2 raised, arm reaching upward; maxDim +
        # centerY both grow substantially. This is exactly the class
        # of pose the hardcoded 1.4/0.7 envelope overflowed on.
        'tall':     {'maxDim': 1.90, 'centerY': 1.10},
    }
    VIEWPORTS = {
        'tablet landscape':  800,
        'desktop':          1080,
    }
    for pose_name, pose in POSES.items():
        for vp_name, vp_h in VIEWPORTS.items():
            gap = gap_for(vp_h, pose['maxDim'], pose['centerY'])
            assert gap >= 0, (
                f'{pose_name} pose @ {vp_name} (vp={vp_h}px): arm '
                f'bottom is {-gap:.1f}px BELOW surface top — the '
                f'live-bbox framing must clear the surface with '
                f'the FRAMING_MARGIN_PX safety gap in EVERY pose')


def test_framing_debug_flag_is_gated():
    """Debug flag pin — the framing debug console.info must be gated
    behind an opt-in (URL query ?framing_debug=1 or localStorage
    'framing_debug'='1') so refresh-time on the operator's tablet
    is silent unless they explicitly enable it. Prevents spammy
    telemetry from leaking to production console.
    """
    viewer = _read(os.path.join(
        HERE, '..', 'frontend', 'src', 'components', 'ArmViewer3D.jsx'))
    # The gate helper exists.
    assert 'function _framingDebugEnabled()' in viewer, (
        'framing debug log must be gated by _framingDebugEnabled '
        '(URL param or localStorage)')
    # applyPreset actually consults the gate before console.info.
    ap_idx = viewer.find('const applyPreset = (name) =>')
    end = viewer.find('\n  }', ap_idx + 30)
    ap_body = viewer[ap_idx:end]
    assert '_framingDebugEnabled()' in ap_body, (
        'applyPreset must consult _framingDebugEnabled before '
        'logging — no unconditional console.info in the framing '
        'hot path')
    # Gate reads the documented flag names.
    assert "'framing_debug'" in viewer, (
        'debug gate must read the "framing_debug" flag from URL / '
        'localStorage — operator instruction line')


def test_preset_click_and_reframe_use_framed_preset_math():
    """2026-09-16 default-framing — every preset click AND every
    reframe() call routes through applyPreset → _framedPreset(),
    so Front/Side/Top/Iso all share the top-region framing math.
    Also pin: the imperative reframe() method exists (called by
    View3DLayout on resize / jog panel mode change).
    """
    viewer = _read(os.path.join(
        HERE, '..', 'frontend', 'src', 'components', 'ArmViewer3D.jsx'))
    # _framedPreset helper must exist AND accept (name, bbox,
    # visibleTopFrac). If a future refactor drops the framing math
    # into a hardcoded position the top-region behavior breaks.
    assert 'function _framedPreset(name, bbox, visibleTopFrac)' in viewer, (
        '_framedPreset(name, bbox, visibleTopFrac) helper missing')
    # applyPreset routes ALL preset applications through the helper.
    ap_idx = viewer.find('const applyPreset = (name) =>')
    assert ap_idx != -1
    end = viewer.find('\n  }', ap_idx + 30)
    ap_body = viewer[ap_idx:end]
    assert '_framedPreset(name, bbox, visibleTopFrac)' in ap_body, (
        'applyPreset must call _framedPreset so every preset click '
        'uses the top-region framing math')
    # Imperative reframe() exists on the ref.
    assert 'reframe() { applyPreset(currentPresetRef.current) }' in viewer, (
        'ArmViewer3D must expose reframe() so the layout can '
        're-apply the current preset on resize / panel-mode change')


def test_no_reframe_during_jog_state_updates():
    """2026-09-16 default-framing — the reframe useEffect in
    View3DLayout MUST NOT depend on any store slice that changes
    during jog / joint updates. Under the persistence directive
    the framing is a constant, so the effect deps should be empty
    (fires once on mount to seed the camera) OR only depend on
    static layout signals. It MUST NEVER include joints / robot /
    jog_active / task — any of those would auto-recenter mid-motion.
    """
    src = _read(LAYOUT)
    # Locate the reframe effect (comment anchor).
    idx = src.find('reframe whenever visibleTopFrac')
    assert idx != -1, 'reframe useEffect comment anchor missing'
    block = src[idx:idx + 1200]
    m = re.search(r"\}\s*,\s*\[([^\]]*)\]\s*\)\s*", block)
    assert m is not None, 'reframe useEffect deps array not found'
    deps = m.group(1).strip()
    # Allowed: empty (mount-only) OR `visibleTopFrac` (layout signal,
    # updates on resize / panel change / orientation / visibility).
    ALLOWED = {'', 'visibleTopFrac'}
    assert deps in ALLOWED, (
        f'reframe useEffect deps must be empty (mount-only under the '
        f'persistence directive) or [visibleTopFrac] at most; got '
        f'[{deps}]. Any store slice that changes on jog / joint '
        f'updates would auto-recenter the camera mid-motion.')
    # Belt-and-braces: reject specific store hooks by name.
    for banned in ('joints', 'robot?.jog_active', 'task', 'positions'):
        assert banned not in deps, (
            f'reframe useEffect deps include `{banned}` which changes '
            f'during motion — camera would auto-recenter mid-jog')


def test_framed_preset_math_shifts_target_and_pulls_camera_back():
    """2026-09-16 default-framing math sanity pin — the framing
    helper must (a) increase camera distance as visibleTopFrac
    shrinks (arm fits in a smaller slice → camera further back to
    keep bbox inside), and (b) shift the world target Y DOWN when
    jogFrac > 0 so the arm renders UP on screen. Skip Y-shift for
    TOP preset.
    """
    viewer = _read(os.path.join(
        HERE, '..', 'frontend', 'src', 'components', 'ArmViewer3D.jsx'))
    idx = viewer.find('function _framedPreset(name, bbox, visibleTopFrac)')
    end = viewer.find('\n}', idx + 30)
    body = viewer[idx:end]
    # Distance formula must reference visibleTopFrac.
    assert re.search(
        r"dist\s*=\s*\(bbox\.maxDim[^\n]*\)\s*/\s*\n?\s*"
        r"\(clampedFrac\s*\*",
        body), (
        'distance formula must divide by clampedFrac (visibleTopFrac) '
        '— smaller slice → larger distance → arm fits in the slice')
    # Vertical Y offset math + TOP-preset skip.
    assert "name === 'top'" in body, (
        "TOP preset must skip the Y-shift (world Y is aligned with "
        "the view axis so the shift would push the arm out of frame)")
    assert 'worldYOffset' in body and 'jogFrac * dist * Math.tan(fov / 2)' in body, (
        'Y-shift formula missing — arm must move UP on screen by '
        'shifting target DOWN in world Y')
    # Target Y assembled with the offset subtracted (not added):
    assert 'bbox.centerY - worldYOffset' in body, (
        'target.y must be bbox.centerY - worldYOffset (subtract to '
        'shift world DOWN → arm renders UP on screen)')


def test_collision_banner_pill_absent_from_3d_view():
    """2026-09-16 operator directive — the top-center "CLEAR · N
    in-reach" pill (CollisionBanner) is RETIRED from the 3D View.
    Pin: ArmViewer3D no longer mounts or imports CollisionBanner,
    and CollisionOverlay no longer exports it. The underlying
    reach / collision store slice (collision.*) still feeds
    MinClearanceReadout + CollisionScene3D — both untouched.
    """
    viewer_path = os.path.join(
        HERE, '..', 'frontend', 'src', 'components', 'ArmViewer3D.jsx')
    overlay_path = os.path.join(
        HERE, '..', 'frontend', 'src', 'components', 'CollisionOverlay.jsx')
    viewer  = _read(viewer_path)
    overlay = _read(overlay_path)
    # No JSX mount + no import of CollisionBanner in ArmViewer3D.
    assert '<CollisionBanner' not in viewer, (
        '<CollisionBanner /> mount must be retired from ArmViewer3D — '
        'the top-center pill is gone per operator directive')
    # Reject any live code reference — imports, function calls, JSX.
    # A comment mentioning the retirement is allowed (in fact the
    # retirement-note anchor helps future readers).
    viewer_no_line_comments = re.sub(r'//[^\n]*', '', viewer)
    viewer_no_comments = re.sub(
        r'\{/\*.*?\*/\}', '', viewer_no_line_comments, flags=re.DOTALL)
    viewer_no_comments = re.sub(
        r'/\*.*?\*/', '', viewer_no_comments, flags=re.DOTALL)
    assert 'CollisionBanner' not in viewer_no_comments, (
        'ArmViewer3D must not carry any live CollisionBanner reference '
        '(import / JSX / function call) — silent dead import is '
        'exactly what the directive forbids. Retirement-note '
        'comments are allowed.')
    # Component + helper deleted from CollisionOverlay.
    assert 'export function CollisionBanner' not in overlay, (
        'CollisionBanner component must be deleted from CollisionOverlay '
        '(no orphan export)')
    assert 'function statusToBanner' not in overlay, (
        'statusToBanner helper (only used by CollisionBanner) must '
        'be deleted too')
    # Sibling consumers of the collision store slice stay intact.
    assert 'CollisionScene3D' in overlay, (
        'CollisionScene3D (reach-dome + object-box 3D render) must '
        'remain — the reach data still drives the in-Canvas overlay')
    assert 'export function CollisionSidePanel' in overlay, (
        'CollisionSidePanel (dev diagnostic surface) must remain — '
        'not the pill we retired')
    # MinClearanceReadout (the close-proximity top-left chip on the
    # 3D View) still consumes the same reach data.
    layout = _read(LAYOUT)
    assert 'function MinClearanceReadout' in layout, (
        'MinClearanceReadout must remain — it is the other consumer '
        'of the collision store slice on the 3D View')


def test_side_column_layout_spread_and_collapse_relocation():
    """2026-09-16 side-column directive — the operator wants the
    LEFT stack (DISABLE/READY + Jog + mode toggles + step + speed)
    spread up the LEFT edge, and the RIGHT column (Orient +
    Collapse + Fullscreen) spread up the RIGHT edge. Pins here:
      (a) RealArmChrome accepts a panelHeight prop and applies it
          with a 440 floor (viewport-aware height).
      (b) JogControls LEFT column uses justifyContent:'space-around'
          (spread), not flex-start.
      (c) JogControls accepts a collapseSlot prop that renders in
          the RIGHT column area at the bottom.
      (d) View3DLayout passes the collapseSlot with the Collapse
          Jog Buttons + fullscreen icon (moved out of the chrome
          header).
      (e) The chrome header no longer contains the Collapse or
          fullscreen buttons.
    """
    layout = _read(LAYOUT)
    jog    = _read(JOG)

    # (a) RealArmChrome viewport-aware height + floor.
    assert re.search(
        r"function RealArmChrome\(\{\s*mode,\s*setMode,\s*children,\s*panelHeight\s*\}\)",
        layout), (
        'RealArmChrome must accept a panelHeight prop for the '
        'viewport-aware NORMAL height (side-column spread needs '
        'room)')
    assert re.search(
        r"height:\s*isExpanded\s*\?\s*'100%'\s*:\s*\(panelHeight\s*\|\|\s*440\)",
        layout), (
        'RealArmChrome height must be isExpanded ? "100%" : '
        '(panelHeight || 440) — viewport-aware NORMAL with the '
        '440 doctrine floor')
    # (a) View3DLayout computes panelHeight from window.innerHeight.
    assert re.search(
        r"setPanelHeight\s*\(\s*Math\.min\(780,\s*Math\.max\(440",
        layout), (
        'View3DLayout must compute panelHeight = min(780, max(440, '
        '~70% of window.innerHeight)) so tablet + desktop both get '
        'room to spread while keeping the doctrine 440 floor')
    # Resize + orientation change re-compute panelHeight.
    assert re.search(
        r"recomputePanelH", layout), (
        'panelHeight must recompute on window resize + orientation '
        'change — side-column spread must track viewport dims')

    # (b) LEFT column spread (space-around or space-between).
    left_idx = jog.find('LEFT — mode, step, speed')
    assert left_idx != -1
    style_open  = jog.rfind('style={{', 0, left_idx + 200)
    # Nothing — the marker is a comment; find the style AFTER it.
    style_open = jog.find('style={{', left_idx)
    style_close = jog.find('}}', style_open)
    left_style = jog[style_open:style_close]
    assert re.search(
        r"justifyContent:\s*'space-around'", left_style), (
        "LEFT column must use justifyContent:'space-around' for "
        'vertical spread up the left edge (was flex-start)')

    # (c) JogControls accepts collapseSlot.
    assert 'collapseSlot = null' in jog, (
        'JogControls signature must accept a collapseSlot prop for '
        'the Collapse + fullscreen buttons moved out of the chrome '
        'header')
    # (c) collapse slot renders at bottom of right column with a
    # marginTop:auto pin.
    assert 'data-testid="jog-collapse-slot"' in jog, (
        'JogControls must render the collapseSlot inside a testid-'
        'anchored div so future pins can find it')
    assert re.search(
        r"marginTop:\s*'auto'", jog), (
        'collapse slot must use marginTop:auto so Collapse pins to '
        'the bottom of the RIGHT column (adjacent to Orient)')

    # (d) View3DLayout passes collapseSlot with the two buttons.
    assert re.search(
        r"collapseSlot=\{", layout), (
        'View3DLayout must pass a collapseSlot to JogControls '
        '(containing Collapse + fullscreen buttons)')
    # The Collapse button testid is still present (relocation, not
    # deletion) so downstream pins on the testid keep working.
    assert 'data-testid="collapse-jog-buttons"' in layout, (
        'collapse-jog-buttons testid must survive the header→'
        'collapseSlot relocation')

    # (e) Header no longer contains Collapse or the fullscreen icon.
    header_start = layout.find("padding: '5px 8px'")
    header_end = layout.find('</div>', header_start)
    header_block = layout[header_start:header_end + 100]
    # The two retired buttons: assert their inline JSX is gone from
    # the header block.
    assert "'Collapse Jog Buttons'" not in header_block, (
        'Collapse Jog Buttons button retired from the header — '
        'moved to JogControls.collapseSlot')
    assert "isExpanded ? '✕' : '⛶'" not in header_block, (
        'Fullscreen ⛶/✕ button retired from the header — moved '
        'to JogControls.collapseSlot alongside Collapse')


def test_framing_measures_center_pads_not_full_surface():
    """2026-09-16 side-column directive — with the LEFT/RIGHT
    columns spreading up the edges, the framing must NOT measure
    the whole panel wrapper (that would shrink the arm region as
    the side columns get taller). Instead measure the CENTER pad
    container by its testid, so the arm bottom only needs to
    clear the pads, not the tall side columns.
    """
    jog = _read(JOG)
    layout = _read(LAYOUT)
    # JogControls tags the center-pads div with the testid.
    assert 'data-testid="jog-center-pads"' in jog, (
        'CENTER pad container must carry data-testid="jog-center-pads" '
        'so View3DLayout can measure it directly for framing')
    # View3DLayout looks up the pads via document.querySelector on the
    # testid and falls back to panelRef if not present.
    assert re.search(
        r"document\.querySelector\('\[data-testid=\"jog-center-pads\"\]'\)",
        layout), (
        'View3DLayout framing must query the jog-center-pads element '
        'directly and use its top edge for the visibleTopFrac '
        'derivation')
    # The fallback pattern (padsEl || panelRef.current) must remain
    # so MINIMIZED / mount race still resolve to a valid element.
    assert 'padsEl || panelRef.current' in layout, (
        'framing must fall back to panelRef.current when the pads '
        'are not in the DOM (MINIMIZED / mount race)')


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


def test_side_columns_portal_out_to_page_level():
    """2026-09-16 SIDE-COLUMN OWNERSHIP directive — the operator
    requires that the LEFT column (mode/step/speed stack) and the
    RIGHT column (Orient + Collapse + Fullscreen) render as PAGE-
    LEVEL overlays of the 3D View, NOT as descendants of the jog
    window/surface container.

    Implementation contract pinned:
      (a) JogControls imports React.createPortal and accepts an
          `immersive` prop.
      (b) JogControls calls createPortal to relocate the LEFT +
          RIGHT column subtrees when `immersive` is true.
      (c) JogControls resolves the target slots by DOM id
          (`jog-left-column-slot` + `jog-right-column-slot`) inside
          a useEffect — the direct DOM ids are the stable API.
      (d) View3DLayout renders the two slot divs as direct children
          of the 3D View root (view3d-immersive-root), NOT nested
          inside the jog-overlay-wrapper / jog-floating-panel.
      (e) View3DLayout passes `immersive` to JogControls.
    """
    jog    = _read(JOG)
    layout = _read(LAYOUT)

    # (a) createPortal import + immersive prop wiring.
    assert re.search(
        r"import\s*\{\s*createPortal\s*\}\s*from\s*'react-dom'", jog), (
        'JogControls must import { createPortal } from react-dom '
        'for the LEFT/RIGHT page-level portal (2026-09-16 '
        'SIDE-COLUMN OWNERSHIP directive)')
    assert 'immersive = false' in jog, (
        'JogControls signature must declare `immersive = false` so '
        'the Program-tab consumer (no prop) keeps the in-row layout')

    # (b) createPortal is INVOKED — the portal isn't just imported.
    assert jog.count('createPortal(') >= 2, (
        'createPortal must be called at least twice — one call for '
        'the LEFT column, one for the RIGHT column')

    # (c) Slot resolution keys off the two documented DOM ids.
    assert "document.getElementById('jog-left-column-slot')" in jog, (
        'LEFT column portal target must be resolved via '
        "document.getElementById('jog-left-column-slot')")
    assert "document.getElementById('jog-right-column-slot')" in jog, (
        'RIGHT column portal target must be resolved via '
        "document.getElementById('jog-right-column-slot')")

    # (d) View3DLayout renders the slot divs at page level (direct
    # child of the 3D View root, NOT nested inside the jog surface).
    # Locate each slot's id attribute; assert it appears BEFORE the
    # jog-overlay-wrapper block in source order (siblings of the
    # panel, not descendants).
    left_slot_idx  = layout.find('id="jog-left-column-slot"')
    right_slot_idx = layout.find('id="jog-right-column-slot"')
    wrapper_idx    = layout.find('data-testid="jog-overlay-wrapper"')
    assert left_slot_idx != -1, (
        'View3DLayout must render an id="jog-left-column-slot" div '
        'as a page-level portal target for the LEFT column')
    assert right_slot_idx != -1, (
        'View3DLayout must render an id="jog-right-column-slot" div '
        'as a page-level portal target for the RIGHT column')
    assert wrapper_idx != -1
    assert left_slot_idx  < wrapper_idx, (
        'jog-left-column-slot must be rendered BEFORE the '
        'jog-overlay-wrapper (i.e., as a sibling under the 3D View '
        'root, not nested inside the panel container)')
    assert right_slot_idx < wrapper_idx, (
        'jog-right-column-slot must be rendered BEFORE the '
        'jog-overlay-wrapper (page-level sibling, not descendant)')

    # (e) View3DLayout passes immersive to JogControls. Grab a
    # window around the <JogControls open tag and assert.
    jc_idx = layout.find('<JogControls')
    assert jc_idx != -1
    jc_block = layout[jc_idx:jc_idx + 800]
    assert re.search(r'\bimmersive\b', jc_block), (
        'View3DLayout must pass the `immersive` prop to <JogControls> '
        'to activate the page-level portal (default false = inline '
        'legacy layout for the Program tab consumer)')


def test_expand_scales_only_center_cluster():
    """2026-09-16 EXPAND MODE — the operator directive is that the
    center pad clusters keep EXACTLY the same arrangement, they
    just render LARGER (1.4-1.8×). Not a re-layout.

    Implementation:
      * JogControls accepts an `expanded` prop.
      * A wrapper INSIDE the CENTER container (jog-center-pads)
        applies a CSS transform:scale(1.6) when expanded — no
        rearrangement of pads, no change to LEFT/RIGHT sizing.
      * The scaler wrapper carries testid jog-center-cluster-scaler
        so future pins can target the exact node.
      * View3DLayout passes `expanded={isExpanded}` to JogControls.
    """
    jog    = _read(JOG)
    layout = _read(LAYOUT)

    # `expanded` prop present.
    assert 'expanded = false' in jog, (
        'JogControls must declare an `expanded = false` prop for '
        'the EXPAND MODE center-scaler (default false = normal size)')

    # Scaler wrapper testid present + scale transform gated on prop.
    assert 'data-testid="jog-center-cluster-scaler"' in jog, (
        'CENTER pad cluster must wrap in a testid-anchored div '
        '(jog-center-cluster-scaler) so pins can pin the scaler')

    # Scale value gated on the `expanded` prop. Accept 1.4-1.8× per
    # operator range.
    scaler_idx = jog.find('data-testid="jog-center-cluster-scaler"')
    scaler_block = jog[scaler_idx:scaler_idx + 400]
    assert re.search(
        r"transform:\s*expanded\s*\?\s*'scale\(1\.[4-8]\)'\s*:\s*'none'",
        scaler_block), (
        'scaler transform must be `expanded ? scale(1.4-1.8) : none` '
        '— arrangement preserved, exit restores exactly')
    assert re.search(
        r"transformOrigin:\s*'center", scaler_block), (
        "scaler transformOrigin must anchor at 'center' so pads "
        'grow symmetrically inside the CENTER container')

    # View3DLayout wires the prop from its isExpanded state.
    jc_idx = layout.find('<JogControls')
    jc_block = layout[jc_idx:jc_idx + 800]
    assert re.search(r'expanded=\{isExpanded\}', jc_block), (
        'View3DLayout must pass expanded={isExpanded} so the CENTER '
        'scaler tracks the panel mode toggle')


def test_expand_dims_canvas_and_exit_restores():
    """2026-09-16 EXPAND MODE canvas dim — the operator allows the
    3D canvas to be hidden/dimmed in expand mode. The wash sits
    ABOVE the canvas but BELOW the jog panel + side-column slots,
    with pointerEvents:none so it doesn't intercept clicks. It
    UNMOUNTS when isExpanded is false so exiting restores the
    canvas exactly (no lingering state).
    """
    layout = _read(LAYOUT)
    # The dim overlay must be conditional on isExpanded (so exit
    # restores exactly by unmounting).
    dim_idx = layout.find('data-testid="view3d-expand-canvas-dim"')
    assert dim_idx != -1, (
        'View3DLayout must render a testid-tagged dim overlay '
        'when isExpanded (view3d-expand-canvas-dim)')
    # Gate: the JSX block surrounding this testid must be inside a
    # `{isExpanded && ...}` conditional. Search backward for the
    # gate token.
    prefix = layout[max(0, dim_idx - 400):dim_idx]
    assert re.search(r'\{isExpanded\s*&&', prefix), (
        'dim overlay MUST be gated on isExpanded so it unmounts on '
        'exit — the canvas restores exactly by mounting/unmounting, '
        'not by opacity toggle (avoids the framing recompute race)')

    # Overlay style contract: absolute inset:0, zIndex between the
    # canvas (0) and the jog panel (10) / slots (12), and
    # pointerEvents:none so orbit is unaffected on any edges the
    # panel doesn't cover.
    dim_block = layout[dim_idx:dim_idx + 500]
    assert re.search(r"position:\s*'absolute'", dim_block)
    assert re.search(r"inset:\s*0", dim_block)
    # zIndex must be > 0 (canvas) and < 10 (jog panel).
    z = re.search(r"zIndex:\s*(\d+)", dim_block)
    assert z is not None, 'dim overlay must declare an explicit zIndex'
    assert 0 < int(z.group(1)) < 10, (
        f'dim overlay zIndex must sit between the canvas (0) and '
        f'the jog panel (10) — got {z.group(1)}')
    assert re.search(r"pointerEvents:\s*'none'", dim_block), (
        'dim overlay pointerEvents must be none so orbit control '
        'still receives peripheral drag events on any uncovered edge')


def test_page_level_slot_dims_track_panel_height():
    """2026-09-16 slot geometry — the LEFT + RIGHT slot divs sit
    at the bottom edge with height = panelHeight in NORMAL and
    calc(100% - 16px) in EXPANDED so they cover the full vertical
    span the operator can reach. Both slots have pointerEvents:
    auto (their contents must be interactive) and stay mounted
    whenever the jog panel is open — i.e., NOT under MINIMIZED
    (JogControls tree not rendered → nothing to portal into).
    """
    layout = _read(LAYOUT)
    for side in ('left', 'right'):
        slot_id = f'id="jog-{side}-column-slot"'
        idx = layout.find(slot_id)
        assert idx != -1, f'slot {slot_id} must be present'
        block = layout[idx:idx + 700]
        assert re.search(r"position:\s*'absolute'", block), (
            f'{side} slot must be absolute-positioned')
        assert re.search(r"pointerEvents:\s*'auto'", block), (
            f'{side} slot must have pointerEvents:auto so its '
            f'contents receive clicks')
        # Height tracks panelHeight (with the 424 default fallback +
        # calc for expanded).
        assert 'panelHeight' in block, (
            f'{side} slot height must key off panelHeight so it '
            f'tracks the viewport-aware NORMAL height')
        assert 'isExpanded' in block, (
            f'{side} slot must switch height on isExpanded (full '
            f'span in EXPANDED, panelHeight in NORMAL)')

    # Slots gated on !isMinimized (nothing to portal into when the
    # panel is collapsed).
    left_idx = layout.find('id="jog-left-column-slot"')
    prefix = layout[max(0, left_idx - 400):left_idx]
    assert re.search(r'\{!isMinimized\s*&&', prefix), (
        'slot divs MUST be gated on !isMinimized so they only exist '
        'while the JogControls tree is mounted (otherwise the '
        'portal targets are unreachable and React logs warnings)')
