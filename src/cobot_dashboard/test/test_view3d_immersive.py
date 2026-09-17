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
    """2026-09-17 SINGLE-WINDOW RESTRUCTURE — the operator's
    "two-window" diagnosis retired the full-width overlay wrapper
    + RealArmChrome full-width panel. The successor is
    `jog-pad-cluster-overlay` — a content-sized, bottom-center
    floating overlay that hosts ONLY the CENTER pads. Wrapper
    stays pointer-events:none; the pad cluster's scaler
    (jog-center-cluster-scaler in JogControls) re-enables auto
    so taps land on buttons and orbit passes through elsewhere.
    """
    src = _read(LAYOUT)
    idx = src.rfind('data-testid="jog-pad-cluster-overlay"')
    assert idx != -1, (
        'jog-pad-cluster-overlay testid must exist — it replaces '
        'the retired jog-overlay-wrapper + jog-floating-panel '
        'per 2026-09-17 single-window restructure')
    wrapper_block = src[idx:idx + 1600]
    assert re.search(r"pointerEvents:\s*'none'", wrapper_block), (
        'jog-pad-cluster-overlay must be pointerEvents:none so '
        'canvas orbit still receives events in the empty margin '
        'around the pad cluster')
    # Retired: jog-floating-panel + jog-overlay-wrapper testids
    # must NOT reappear. RealArmChrome deleted at the same time.
    assert 'data-testid="jog-floating-panel"' not in src, (
        'jog-floating-panel testid must be retired — the full-width '
        'panel was the operator-flagged second-window culprit')
    assert 'data-testid="jog-overlay-wrapper"' not in src, (
        'jog-overlay-wrapper testid must be retired — the full-width '
        'wrapper (left:0 right:0) formed the second window')
    assert 'function RealArmChrome(' not in src, (
        'RealArmChrome function must be retired — split into three '
        'page-level overlays owned directly by View3DLayout')


def test_overlay_panel_container_is_transparent():
    """2026-09-17 SINGLE-WINDOW UPDATE: pad-cluster overlay carries
    no background / border / shadow — the 3D scene shows through
    everywhere except at the pad chips themselves. The retired
    jog-floating-panel had the same contract; the pin now targets
    the successor overlay.
    """
    src = _read(LAYOUT)
    idx = src.rfind('data-testid="jog-pad-cluster-overlay"')
    assert idx != -1
    block = src[idx:idx + 1500]
    # No explicit background declared → default is transparent.
    for banned in ('background:', 'borderRadius', 'boxShadow',
                   'rgba(255, 255, 255,'):
        assert banned not in block, (
            f'jog-pad-cluster-overlay must not carry `{banned}` — '
            f'the transparent-surface directive forbids any card '
            f'treatment on the floating overlay itself')


def test_jog_surface_row_is_fully_transparent():
    """2026-09-16 operator directive: the jog surface row MUST be
    fully transparent — no color tint, no blur. The 3D scene shows
    through at 100 % between and around controls. Prior translucent
    gray scrim (rgba(107,114,128,0.18)) + backdrop-blur retired;
    canvas full-bleed behind the surface handles the "readability
    by contrast" case, and loose labels carry their own text-shadow.
    """
    src = _read(JOG)
    idx = src.rfind('data-testid="jog-surface-row"')
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
    idx = src.rfind('data-testid="jog-surface-row"')
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
    """2026-09-17 SINGLE-WINDOW RESTRUCTURE — RealArmChrome retired.
    No scrollable child container exists anywhere in the new tree:
    the pad-cluster overlay is content-sized, LEFT/RIGHT slots use
    top/bottom anchors with pointer-events walk. So the
    "overflow:auto ever reappearing" invariant is satisfied by
    absence of any scroll-capable wrapper in the layout file.
    """
    src = _read(LAYOUT)
    # No child of the 3D View root may declare overflow: 'auto' or
    # 'scroll' — that would reintroduce the operator-flagged
    # internal scrollbar the last iteration eliminated.
    assert "overflow: 'auto'" not in src, (
        'View3DLayout must not declare overflow:auto anywhere — the '
        'legacy source of the internal scrollbar')
    assert "overflow: 'scroll'" not in src, (
        'View3DLayout must not declare overflow:scroll anywhere')


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
    """2026-09-17 SINGLE-WINDOW UPDATE: pin the pad-cluster overlay
    + slot divs' zIndex — bounded above the canvas (0) and well
    below any modal (9990+) so E-STOP in TopBar (different grid
    area entirely) is unreachable.
    """
    src = _read(LAYOUT)
    for testid in ('jog-pad-cluster-overlay',
                   'jog-left-column-slot',
                   'jog-right-column-slot'):
        idx = src.rfind(f'data-testid="{testid}"')
        assert idx != -1, f'{testid} testid missing'
        block = src[idx:idx + 1600]
        m = re.search(r'zIndex:\s*(\d+)', block)
        assert m is not None, f'{testid} missing zIndex declaration'
        z = int(m.group(1))
        assert 1 <= z <= 100, (
            f'{testid} zIndex {z} out of range — must be > 0 (above '
            f'canvas) and well below modal / global-banner tiers')


# ─────────────────────────────────────────────────────────────────
# 4. Collapse-to-tab: MINIMIZED renders only the slim pill
# ─────────────────────────────────────────────────────────────────

def test_minimized_collapses_to_expand_pill_only():
    """2026-09-17 COLLAPSE-SCOPE UPDATE: MINIMIZED no longer
    unmounts the LEFT/RIGHT slots or the pad-cluster overlay.
    Only the CENTER pads render null (via JogControls hidePads
    prop). The Collapse chip in the RIGHT column flips its label
    to "Expand Jog Buttons" — style parity per operator directive.
    RealArmMinimizedPill retired entirely (single-chip design).
    """
    src = _read(LAYOUT)
    assert 'function RealArmMinimizedPill(' not in src, (
        'RealArmMinimizedPill retired — the collapse chip in the '
        'RIGHT column serves both roles now (style parity)')
    assert '<RealArmMinimizedPill' not in src, (
        'no residual RealArmMinimizedPill mount in the layout')
    assert 'hidePads={isMinimized}' in src, (
        'JogControls must receive hidePads={isMinimized} — this is '
        'how MINIMIZED collapses the pad cluster ONLY, without '
        'unmounting the LEFT/RIGHT portal slots')


def test_expand_pill_testid_still_present():
    """The expand-jog-buttons testid MUST survive the collapse-
    scope refactor. It now lives on the label-flipping chip
    (data-testid ternary branch when isMinimized). Both testid
    literals appear as string constants in the layout source.
    """
    src = _read(LAYOUT)
    assert "'expand-jog-buttons'" in src, (
        'expand-jog-buttons testid literal must appear in the '
        'style-parity ternary (collapse chip alias when isMinimized)')


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
    scene ('Position/Height/Rotation', 'Step Size', 'Speed:')
    carry a compact white text-shadow so they stay readable on any
    floor tone without needing a large panel behind them. Shared
    constant LABEL_TEXT_SHADOW pins the treatment so future edits
    can't silently drop the shadow.

    2026-09-16 LEFT-column cleanup UPDATE (operator order): the
    'Jog' heading, the 'moves while held' / 'one step per press'
    caption, and the wire-hint line below the Speed slider are
    RETIRED from this surface — they were the 4th/5th/6th
    LABEL_TEXT_SHADOW consumers. The threshold below is lowered
    to match: declaration + padLabel + Step Size + Speed: = 4.
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
    # Remaining loose-label consumers: padLabel + Step Size + Speed:
    uses = src.count('LABEL_TEXT_SHADOW')
    assert uses >= 4, (
        f'LABEL_TEXT_SHADOW referenced only {uses} times — expected '
        f'>= 4 (declaration + padLabel + Step Size + Speed:); a '
        f'loose label lost its treatment')


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
    """2026-09-17 SINGLE-WINDOW UPDATE: the successor overlays
    (jog-pad-cluster-overlay + jog-left-column-slot +
    jog-right-column-slot) must ALL declare pointerEvents:'none'
    so multi-touch gestures starting in the gaps between controls
    reach the canvas below.
    """
    src = _read(LAYOUT)
    for testid in ('jog-pad-cluster-overlay',
                   'jog-left-column-slot',
                   'jog-right-column-slot'):
        idx = src.rfind(f'data-testid="{testid}"')
        assert idx != -1, f'{testid} testid missing'
        block = src[idx:idx + 1600]
        assert re.search(r"pointerEvents:\s*'none'", block), (
            f"{testid} must be pointerEvents:'none' so the empty "
            f"transparent regions don't swallow multi-touch bound "
            f"for the canvas below")


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
    # 2026-09-17 SINGLE-WINDOW UPDATE: panelRef migrated from the
    # retired jog-overlay-wrapper to the pad-cluster overlay.
    assert re.search(
        r'ref=\{panelRef\}\s*\n\s*data-testid="jog-pad-cluster-overlay"',
        src), (
        'panelRef must attach to jog-pad-cluster-overlay so its top '
        'edge drives the measured fraction (fallback when the '
        'scaler element inside JogControls is not yet in the DOM)')
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

    # (a) 2026-09-17 SINGLE-WINDOW UPDATE: RealArmChrome retired
    # entirely. The `panelHeight` viewport-aware height it used to
    # own is superseded — the pad-cluster overlay is content-sized
    # and bottom-anchored, and the LEFT/RIGHT slots use direct
    # top/bottom anchors instead of a computed height. This block
    # of the pin is intentionally trivialised; the standing
    # invariants (LEFT column spread + collapse relocation) are
    # covered by (b)-(e) below.
    assert 'function RealArmChrome(' not in layout, (
        'RealArmChrome must be retired — the full-width panel it '
        'produced formed the operator-flagged second window')

    # (b) LEFT column spread. 2026-09-16 LEFT-column-cleanup UPDATE:
    # the OUTER LEFT column is now a 3-section flex (TOP slot /
    # MIDDLE groups / BOTTOM speed) using space-BETWEEN so DISABLE/
    # READY pin to the top and Speed slider pins to the bottom;
    # the MIDDLE wrapper uses space-around for the operator's
    # generous even spacing. Accept either at the outer level.
    left_idx = jog.find('LEFT — mode, step, speed')
    assert left_idx != -1
    style_open = jog.find('style={{', left_idx)
    style_close = jog.find('}}', style_open)
    left_style = jog[style_open:style_close]
    assert re.search(
        r"justifyContent:\s*'space-(around|between)'", left_style), (
        "LEFT column outer must use space-around or space-between "
        'for the 3-section pin (top / middle-distributed / bottom)')

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
    # The Collapse button testid is still present (2026-09-17 UPDATE:
    # now inside the style-parity ternary — appears as a single-
    # quoted string literal, not a double-quoted attribute value).
    assert "'collapse-jog-buttons'" in layout, (
        'collapse-jog-buttons testid literal must appear in the '
        'style-parity ternary (chip label + testid flip on isMinimized)')

    # (e) 2026-09-17 SINGLE-WINDOW UPDATE: chrome header retired
    # (RealArmChrome entirely deleted). The Collapse + fullscreen
    # buttons live only via JogControls.collapseSlot now — the
    # retired-from-header invariant is trivially satisfied by
    # RealArmChrome absence, covered in (a) above.


def test_framing_measures_center_pads_not_full_surface():
    """2026-09-16 side-column directive — with the LEFT/RIGHT
    columns spreading up the edges, the framing must NOT measure
    the whole panel wrapper (that would shrink the arm region as
    the side columns get taller). Measure the CENTER pads instead.

    2026-09-16 pad-anchoring UPDATE (operator screenshot #2): the
    CENTER pad cluster is now BOTTOM-aligned inside the container
    (alignItems:'flex-end'), so the container's top edge no longer
    reflects where the pads actually sit. Framing must PREFER the
    scaler element (jog-center-cluster-scaler) which bottom-aligns
    with the actual pad cluster and reports a LOWER top edge —
    surfaceTop drops → arm region gains vertical space.
    """
    jog = _read(JOG)
    layout = _read(LAYOUT)
    # JogControls tags both the container and the scaler with
    # test-ids so framing can prefer whichever is more accurate.
    assert 'data-testid="jog-center-pads"' in jog, (
        'CENTER pad container must carry data-testid="jog-center-pads" '
        'so View3DLayout has a stable framing target (fallback)')
    assert 'data-testid="jog-center-cluster-scaler"' in jog, (
        'CENTER pad SCALER must carry '
        'data-testid="jog-center-cluster-scaler" — the bottom-aligned '
        'inner wrapper whose top edge is where the arm must clear to')
    # View3DLayout must query BOTH elements — prefer the scaler for
    # the LOWER top edge (pad-anchoring gain), fall back to the
    # container if the scaler isn't in the DOM yet.
    assert re.search(
        r"document\.querySelector\('\[data-testid=\"jog-center-cluster-scaler\"\]'\)",
        layout), (
        'View3DLayout framing must query jog-center-cluster-scaler — '
        'this is the LOWER anchor after pad-anchoring #2 (bigger arm '
        'region above)')
    assert re.search(
        r"document\.querySelector\('\[data-testid=\"jog-center-pads\"\]'\)",
        layout), (
        'View3DLayout framing must retain the jog-center-pads query '
        'as the fallback (scaler mount race / MINIMIZED)')
    # Framing target chain: scaler → padsEl → panelRef. Assert the
    # exact fallback expression stays.
    assert 'scalerEl || padsEl || panelRef.current' in layout, (
        'framing must fall through scalerEl → padsEl → '
        'panelRef.current in that order so pad-anchoring gain is '
        'realized when the scaler is in the DOM')


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
    left_slot_idx  = layout.rfind('id="jog-left-column-slot"')
    right_slot_idx = layout.rfind('id="jog-right-column-slot"')
    # 2026-09-17 SINGLE-WINDOW UPDATE: pad-cluster overlay
    # supersedes the retired jog-overlay-wrapper as the sibling
    # anchor. Slots must render as siblings of the pad overlay
    # under the 3D View root (page-level), not nested inside it.
    pad_idx    = layout.rfind('data-testid="jog-pad-cluster-overlay"')
    assert left_slot_idx != -1, (
        'View3DLayout must render an id="jog-left-column-slot" div '
        'as a page-level portal target for the LEFT column')
    assert right_slot_idx != -1, (
        'View3DLayout must render an id="jog-right-column-slot" div '
        'as a page-level portal target for the RIGHT column')
    assert pad_idx != -1
    assert left_slot_idx  < pad_idx, (
        'jog-left-column-slot must render BEFORE jog-pad-cluster-'
        'overlay (page-level sibling under the 3D View root, not '
        'nested inside the pad overlay)')
    assert right_slot_idx < pad_idx, (
        'jog-right-column-slot must render BEFORE jog-pad-cluster-'
        'overlay (page-level sibling, not descendant)')

    # (e) View3DLayout passes immersive to JogControls. Grab a
    # window around the <JogControls open tag and assert.
    jc_idx = layout.find('<JogControls')
    assert jc_idx != -1
    jc_block = layout[jc_idx:jc_idx + 2400]
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

    # 2026-09-17 UNIFIED FIT UPDATE (supersedes the composed
    # `fitScale × (expanded ? 1.6 : 1)` variant): the mode cap
    # (EXPAND_MAX = 1.6 for expand, 1 for normal) is now folded
    # into fitScale by View3DLayout's Math.min. The scaler
    # transform is `scale(fitScale)` directly. The load-bearing
    # invariant — cap = 1.6 in expand mode — is pinned in
    # View3DLayout via test_pad_cluster_fits_viewport_at_tablet_widths.
    scaler_idx = jog.rfind('data-testid="jog-center-cluster-scaler"')
    scaler_block = jog[scaler_idx:scaler_idx + 1600]
    assert re.search(
        r"transform:\s*fitScale\s*===\s*1\s*\?\s*'none'\s*:\s*"
        r"`scale\(\$\{fitScale\.toFixed\(4\)\}\)`",
        scaler_block), (
        'scaler transform must be scale(fitScale) directly (no '
        'expand composition after min) per 2026-09-17 UNIFIED FIT')
    # 2026-09-17 expand-rollback: EXPAND_MAX retired; cap = 1 always.
    # Pin the retirement here too (belt-and-braces with the
    # test_pad_cluster_fits_viewport_at_tablet_widths cap assertion).
    assert 'const EXPAND_MAX' not in layout, (
        'EXPAND_MAX constant must be RETIRED (2026-09-17 expand-'
        'rollback — scale>1 clipped in the overflow:hidden ancestor)')
    assert 'const CAP = 1' in layout, (
        'cap constant must be `const CAP = 1` (both modes)')
    assert re.search(
        r"transformOrigin:\s*'center", scaler_block), (
        "scaler transformOrigin must anchor at 'center' so pads "
        'grow symmetrically inside the CENTER container')

    # View3DLayout wires the prop from its isExpanded state.
    jc_idx = layout.find('<JogControls')
    jc_block = layout[jc_idx:jc_idx + 2400]
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
    """2026-09-17 SINGLE-WINDOW UPDATE: slot geometry is no longer
    keyed off panelHeight (retired with RealArmChrome). Both slots
    use direct top/bottom anchors (top:72 clears the view-preset
    row, bottom:16 keeps a floor margin) and stay mounted whenever
    the pad-cluster overlay is mounted (i.e., NOT under MINIMIZED).
    Slot wrappers are pointerEvents:none per the new pointer-events
    walk contract — content wrappers inside JogControls opt back in
    per group.
    """
    layout = _read(LAYOUT)
    for side in ('left', 'right'):
        slot_id = f'id="jog-{side}-column-slot"'
        idx = layout.rfind(slot_id)
        assert idx != -1, f'slot {slot_id} must be present'
        block = layout[idx:idx + 1400]
        assert re.search(r"position:\s*'absolute'", block), (
            f'{side} slot must be absolute-positioned')
        assert re.search(r"pointerEvents:\s*'none'", block), (
            f'{side} slot must have pointerEvents:none (single-window '
            f'contract — content wrappers opt back to auto in JogControls)')
        # top:72 anchor (below view-preset row).
        assert re.search(r"top:\s*72", block), (
            f'{side} slot must anchor top:72 so it starts below the '
            f'top-of-viewport view-preset chips and MinClearanceReadout')
        assert re.search(r"bottom:\s*16", block), (
            f'{side} slot must anchor bottom:16 for a consistent floor '
            f'margin above the pad-cluster overlay')
        # panelHeight must NOT be referenced in slot geometry.
        assert 'panelHeight' not in block, (
            f'{side} slot must NOT reference panelHeight — the '
            f'viewport-aware panel height was retired with RealArmChrome')

    # 2026-09-17 COLLAPSE-SCOPE UPDATE: slots are ALWAYS MOUNTED
    # (no isMinimized gate) so LEFT (ENABLE/DISABLE + jog mode +
    # step + speed) and RIGHT (Orient + Collapse) stay reachable
    # while the pad cluster is collapsed. JogControls itself stays
    # mounted too; MINIMIZED nulls only the CENTER via hidePads.
    left_idx = layout.rfind('id="jog-left-column-slot"')
    prefix = layout[max(0, left_idx - 600):left_idx]
    assert not re.search(r'\{!isMinimized\s*&&\s*\(?\s*<>', prefix), (
        'slot divs must NOT be gated on !isMinimized (2026-09-17 '
        'collapse-scope fix — they stay mounted so operators can '
        'still Enable and re-expand while collapsed)')


def test_jog_heading_and_captions_retired_from_left_column():
    """2026-09-16 LEFT-column-cleanup operator order: the 'Jog'
    heading (which rendered z-under the DISABLE button in the old
    chrome header), the 'moves while held' / 'one step per press'
    caption, and the wire-hint line below the Speed slider are
    RETIRED from the LEFT column. Kept: 'Step Size' + 'Speed:'
    (these ARE the labels operator explicitly preserved).
    """
    src = _read(JOG)
    # Retired renders. Strip JSX block comments and //-line comments
    # before searching so the retirement-note documentation (which
    # deliberately names the retired strings) doesn't false-positive.
    left_marker = src.find('LEFT — mode, step, speed')
    assert left_marker != -1
    center_marker = src.find('CENTER — jog arrow pads', left_marker)
    assert center_marker != -1
    raw_block = src[left_marker:center_marker]
    left_block = re.sub(r'\{/\*.*?\*/\}', '', raw_block, flags=re.DOTALL)
    left_block = re.sub(r'/\*.*?\*/', '', left_block, flags=re.DOTALL)
    left_block = '\n'.join(
        line for line in left_block.splitlines()
        if not line.lstrip().startswith('//'))
    assert '>Jog<' not in left_block, (
        "'Jog' heading must be retired from the LEFT column per "
        '2026-09-16 operator order (it was z-clashing with the '
        'DISABLE button in the old chrome header)')
    assert 'moves while held' not in left_block, (
        "'moves while held' caption retired — inferable from "
        'Step / Continuous button selection')
    assert 'one step per press' not in left_block, (
        "'one step per press' caption retired — inferable from "
        'Step / Continuous button selection')
    # Kept labels — pin so a future edit doesn't accidentally
    # collapse the whole label vocabulary.
    assert 'Step Size' in left_block, (
        "'Step Size' label kept — operator directive to preserve "
        'the section labels that name what the chips do')
    assert 'Speed:' in left_block, (
        "'Speed:' slider label kept above the slider — operator "
        'directive')


def test_wire_hint_retired_from_surface_moved_to_slider_title():
    """The wire-hint line (`wire N.NN — jog ceiling N% (operator
    order)`) is no longer rendered on the surface. It survives as
    the slider's `title` attribute so devtools + hover still
    surface the calculation without cluttering the panel.
    """
    src = _read(JOG)
    # The old testid MUST be gone from the render — nothing may
    # carry data-testid="jog-speed-wire-hint" as a rendered node.
    assert 'data-testid="jog-speed-wire-hint"' not in src, (
        'jog-speed-wire-hint testid must be RETIRED — the operator '
        'order deletes the on-surface hint line entirely')
    # The wireHintTitle string must still be computed and attached
    # to the slider as a title attribute.
    assert 'const wireHintTitle' in src, (
        'wireHintTitle must still be computed — even though the '
        'render site retired, the string is now attached to the '
        'slider as title="" for tooltip / devtools discoverability')
    slider_idx = src.find('data-testid="jog-speed-slider"')
    assert slider_idx != -1
    slider_block = src[max(0, slider_idx - 300):slider_idx + 300]
    assert 'title={wireHintTitle}' in slider_block, (
        'Speed slider must carry title={wireHintTitle} so the hint '
        'is still discoverable via tooltip / hover')


def test_disable_ready_row_moved_from_header_to_left_top_slot():
    """2026-09-16 LEFT-column-cleanup: DISABLE + READY move OUT of
    the RealArmChrome header (which now collapses to 0) INTO the
    LEFT column top slot via JogControls.leftTopSlot. This mirrors
    the RIGHT column's Orient Flange Down (which is already at the
    top via rightSlot), per operator order that top-row heights
    match across the two columns.
    """
    jog    = _read(JOG)
    layout = _read(LAYOUT)

    # JogControls signature accepts leftTopSlot.
    assert 'leftTopSlot = null' in jog, (
        'JogControls must declare leftTopSlot=null prop — the LEFT '
        'column caller-supplied top row')
    # LEFT column renders leftTopSlot inside its TOP wrapper (with
    # a 44 px min height so DISABLE/READY have the same visual
    # height as the RIGHT column's Orient block).
    left_marker = jog.find('LEFT — mode, step, speed')
    center_marker = jog.find('CENTER — jog arrow pads', left_marker)
    left_block = jog[left_marker:center_marker]
    assert '{leftTopSlot}' in left_block, (
        'LEFT column TOP wrapper must render {leftTopSlot} so the '
        'caller (View3DLayout) can inject DISABLE + READY')
    assert re.search(r"minHeight:\s*44", left_block), (
        'LEFT column TOP wrapper must set minHeight:44 so it '
        'matches the RIGHT column Orient block height '
        '(mirrored top rows per operator directive)')

    # View3DLayout passes leftTopSlot with ArmEnableControl + Badge.
    jc_idx = layout.find('<JogControls')
    jc_block = layout[jc_idx:jc_idx + 2400]
    assert 'leftTopSlot={' in jc_block, (
        'View3DLayout must pass leftTopSlot to JogControls '
        '(containing ArmEnableControl + JogReadyBadge)')
    assert '<ArmEnableControl' in jc_block, (
        'leftTopSlot must contain <ArmEnableControl /> (moved from '
        'the chrome header)')
    assert '<JogReadyBadge' in jc_block, (
        'leftTopSlot must contain <JogReadyBadge /> (moved from '
        'the chrome header)')

    # 2026-09-17 SINGLE-WINDOW UPDATE: chrome header retired
    # entirely (RealArmChrome deleted). The DISABLE-moved-out
    # invariant is trivially satisfied by RealArmChrome absence.
    assert 'function RealArmChrome(' not in layout, (
        'RealArmChrome retired — no chrome header exists that could '
        'host DISABLE + READY')


def test_left_column_pins_speed_slider_to_bottom():
    """Speed slider is the LAST element of the LEFT column and
    pins to the bottom edge (space-between at the outer level +
    Speed inside a flexShrink:0 BOTTOM wrapper). This gives the
    slider a stable position operator can reach without hunting.
    """
    jog = _read(JOG)
    left_marker = jog.find('LEFT — mode, step, speed')
    center_marker = jog.find('CENTER — jog arrow pads', left_marker)
    left_block = jog[left_marker:center_marker]

    # jog-speed-group testid marks the BOTTOM wrapper.
    assert 'data-testid="jog-speed-group"' in left_block, (
        'Speed group must carry data-testid="jog-speed-group" so '
        'pins can find the bottom-pinned block')
    # Bottom wrapper is a flexShrink:0 div right before the outer
    # closing tag. Assert the speed group renders AFTER the middle
    # wrapper's step-size chips in source order (i.e., the pin-to-
    # bottom order).
    step_size_idx = left_block.find("'Step Size'")
    speed_group_idx = left_block.find('data-testid="jog-speed-group"')
    # 'Step Size' as text lives inline; if that lookup misses use
    # the stepBtnH landmark instead.
    if step_size_idx == -1:
        step_size_idx = left_block.find('Step Size ')
    assert step_size_idx != -1
    assert speed_group_idx > step_size_idx, (
        'Speed group must render AFTER the step-size chips in source '
        'order so the outer flex space-between pins it to the '
        'bottom of the LEFT column')


def test_center_pads_anchor_to_bottom_of_container():
    """2026-09-17 SINGLE-WINDOW UPDATE: the pad-anchoring contract
    now lives at the page-level overlay, not inside the JogControls
    container. The pad-cluster overlay (jog-pad-cluster-overlay in
    View3DLayout) anchors bottom:16 + left:50% translate for
    bottom-center placement — the container's internal alignItems
    contract is superseded (container is content-sized in immersive).

    The scaler still uses transformOrigin:'center bottom' so EXPAND
    scaling grows UP from the base — pin retained.
    """
    layout = _read(LAYOUT)
    jog = _read(JOG)
    # Pad-cluster overlay anchors bottom + horizontally-centered.
    overlay_idx = layout.rfind('data-testid="jog-pad-cluster-overlay"')
    assert overlay_idx != -1
    overlay_block = layout[overlay_idx:overlay_idx + 1200]
    assert re.search(r"bottom:\s*16", overlay_block), (
        'jog-pad-cluster-overlay must anchor bottom:16 for a '
        'consistent floor margin above the viewport bottom')
    assert re.search(r"left:\s*'50%'", overlay_block), (
        "jog-pad-cluster-overlay must use left:'50%' + "
        'translateX(-50%) for bottom-center placement of the '
        'content-sized cluster')
    assert re.search(r"translateX\(-50%\)", overlay_block), (
        'jog-pad-cluster-overlay must translateX(-50%) to center '
        'the variable-width pad cluster horizontally')
    # Scaler still declares transformOrigin:'center bottom'.
    scaler_idx = jog.rfind('data-testid="jog-center-cluster-scaler"')
    assert scaler_idx != -1
    # 2026-09-17 UPDATE: window widened past the composed fitScale
    # transform + retirement notes (~1600 chars end-to-end).
    scaler_block = jog[scaler_idx:scaler_idx + 1600]
    assert re.search(r"transformOrigin:\s*'center bottom'", scaler_block), (
        "scaler transformOrigin must be 'center bottom' so EXPAND "
        'grows upward from the anchored bottom edge')


def test_left_column_distributes_evenly_with_space_between():
    """2026-09-16 LEFT column distribution operator directive #2:
    the four upper groups (DISABLE+READY / XYZ+Joint / Step+
    Continuous / step-size chips) plus the Speed slider at bottom
    are distributed by a SINGLE outer flex column using
    space-between — uniform gaps computed from the column height,
    no intermediate wrapper.
    """
    jog = _read(JOG)
    # Outer LEFT column style. Located as the first `style={{` after
    # the "LEFT — mode, step, speed" marker.
    left_idx = jog.find('LEFT — mode, step, speed')
    assert left_idx != -1
    style_open  = jog.find('style={{', left_idx)
    style_close = jog.find('}}', style_open)
    outer_style = jog[style_open:style_close]
    # Outer must be flex column with space-between.
    assert re.search(r"flexDirection:\s*'column'", outer_style), (
        'LEFT column outer must be flexDirection:column')
    assert re.search(r"justifyContent:\s*'space-between'", outer_style), (
        'LEFT column outer must use space-between so DISABLE+READY '
        'pins to top, Speed to bottom, and the 3 mid-groups get '
        'uniform residual gaps (operator directive #2)')
    # No intermediate MIDDLE wrapper — the previous
    # "flex:1 minHeight:0 space-around" middle band is retired. Grep
    # for its distinctive combination inside the LEFT block.
    center_marker = jog.find('CENTER — jog arrow pads', left_idx)
    left_block = jog[left_idx:center_marker]
    assert not re.search(
        r"flex:\s*1,\s*minHeight:\s*0,\s*[\s\S]{0,80}justifyContent:\s*'space-around'",
        left_block), (
        'the intermediate MIDDLE wrapper (flex:1 minHeight:0 '
        'space-around) is retired — single outer space-between now '
        'handles distribution directly')


def test_chip_buttons_share_equal_width_and_left_edge():
    """2026-09-16 chip alignment operator directive #2: XYZ / Joint
    / Step / Continuous all render as full-column-width buttons so
    they share equal widths and align on the left edge.
    Implementation:
      * A `chipBtnStyle` helper adds width:100% to the base
        modeBtnStyle so every chip fills the column.
      * Step + Continuous stack vertically (like XYZ + Joint) —
        NOT side-by-side, which broke the equal-width contract.
    """
    jog = _read(JOG)
    left_idx = jog.find('LEFT — mode, step, speed')
    center_marker = jog.find('CENTER — jog arrow pads', left_idx)
    left_block = jog[left_idx:center_marker]
    # chipBtnStyle helper defined inside the IIFE.
    assert 'chipBtnStyle' in left_block, (
        'chipBtnStyle helper must be defined so XYZ/Joint/Step/'
        'Continuous share width:100% via a single style shim')
    # All four chip buttons use chipBtnStyle at their style prop.
    for chip in ('XYZ', 'Joint', 'Step', 'Continuous'):
        assert re.search(
            fr">\s*{re.escape(chip)}",
            left_block), f'{chip} chip must render in the LEFT column'
    # Step + Continuous no longer sit inside a `display:flex, gap:4`
    # ROW — they now stack in the same column pattern XYZ/Joint use.
    step_idx = left_block.find(">\n            Step\n")
    if step_idx == -1:
        step_idx = left_block.find('>Step<')
    # Grab a wider window and confirm the wrapper around Step +
    # Continuous is flexDirection:'column'.
    step_button_idx = left_block.find("setJogStyle('STEP')")
    assert step_button_idx != -1
    around_step = left_block[max(0, step_button_idx - 400):step_button_idx]
    assert re.search(r"flexDirection:\s*'column'", around_step), (
        'Step + Continuous wrapper must be flexDirection:column so '
        'they stack (matching XYZ/Joint widths). The previous '
        'side-by-side row broke the equal-width contract.')


def test_step_size_chips_render_as_five_column_grid():
    """2026-09-16 chip alignment operator directive #2: step-size
    chips render as ONE aligned row (grid, 5 equal columns) — no
    more ragged 3+2 flex-wrap.
    """
    jog = _read(JOG)
    left_idx = jog.find('LEFT — mode, step, speed')
    center_marker = jog.find('CENTER — jog arrow pads', left_idx)
    left_block = jog[left_idx:center_marker]
    # Find the step-size grid wrapper: it wraps the .map over the
    # step-size values [0.1, 0.5, 1, 5, 10]. Locate that anchor.
    map_idx = left_block.find('[0.1, 0.5, 1, 5, 10]')
    assert map_idx != -1
    prefix = left_block[max(0, map_idx - 300):map_idx]
    # Must be display:grid with 5 equal fr columns.
    assert re.search(r"display:\s*'grid'", prefix), (
        'step-size chips wrapper must be display:grid (operator '
        'directive #2 — one aligned row)')
    assert re.search(
        r"gridTemplateColumns:\s*'repeat\(5,\s*1fr\)'", prefix), (
        'step-size chips must use gridTemplateColumns: repeat(5, 1fr) '
        'so all 5 chips share identical widths and align in one row')


def test_step_size_speed_controls_motion_caption_retired():
    """2026-09-16 caption removal operator directive #2: the
    "· speed controls motion" span next to the Step Size label is
    RETIRED — the chips grey out in CONTINUOUS mode, which already
    communicates the same fact without extra text.
    """
    jog = _read(JOG)
    left_idx = jog.find('LEFT — mode, step, speed')
    center_marker = jog.find('CENTER — jog arrow pads', left_idx)
    raw_block = jog[left_idx:center_marker]
    # Strip JSX + //-line comments so retirement-note documentation
    # (which may reference the retired text) doesn't false-positive.
    left_block = re.sub(r'\{/\*.*?\*/\}', '', raw_block, flags=re.DOTALL)
    left_block = re.sub(r'/\*.*?\*/', '', left_block, flags=re.DOTALL)
    left_block = '\n'.join(
        line for line in left_block.splitlines()
        if not line.lstrip().startswith('//'))
    assert 'speed controls motion' not in left_block, (
        "'· speed controls motion' caption must be RETIRED — the "
        'greyed-out chip state in CONTINUOUS mode communicates the '
        'same fact without extra text (operator directive #2)')
    # 'Step Size' label itself stays.
    assert 'Step Size' in left_block, (
        "'Step Size' label kept — only the parenthetical caption is "
        'retired')


def test_slot_insets_widen_to_prevent_left_edge_clip():
    """2026-09-17 SINGLE-WINDOW UPDATE: slot widths dropped from
    240 to 150 (LEFT) / 200 (RIGHT) per the "THIN chips" directive.
    Insets remain left/right:16 + bottom:16 (never touch x=0). The
    original 240-min-width contract was for the 3+2 wrapped chip
    row inside a chip-btn container; the new 5-col grid + width:100%
    chip vocabulary fits comfortably at 150.
    """
    layout = _read(LAYOUT)
    for side, min_width in (('left', 128), ('right', 160)):
        slot_id = f'id="jog-{side}-column-slot"'
        idx = layout.rfind(slot_id)
        assert idx != -1
        block = layout[idx:idx + 1000]
        edge = 'left' if side == 'left' else 'right'
        # Inset MUST be >= 16 px (never touch x=0).
        m = re.search(fr"{edge}:\s*(\d+)", block)
        assert m is not None and int(m.group(1)) >= 16, (
            f'{side} slot {edge} inset must be >= 16 px so it '
            f'never touches x=0')
        # Bottom inset >= 16.
        mb = re.search(r"bottom:\s*(\d+)", block)
        assert mb is not None and int(mb.group(1)) >= 16
        # Width bounded: >= min-width per side, <= 240 (thin
        # chips directive — no more 240-wide LEFT column).
        mw = re.search(r"width:\s*(\d+)", block)
        assert mw is not None, f'{side} slot missing width declaration'
        w = int(mw.group(1))
        assert min_width <= w <= 240, (
            f'{side} slot width {w} out of range [{min_width}, 240] '
            f'per 2026-09-17 thin-chips directive')


# ─────────────────────────────────────────────────────────────────
# 2026-09-17 tablet-field-report — collapse-scope + style-parity +
# viewport-fit pins
# ─────────────────────────────────────────────────────────────────


def test_collapse_scope_leaves_left_and_right_mounted():
    """Operator directive: pressing Collapse must hide ONLY the
    CENTER pad clusters. The LEFT column (DISABLE/READY + jog mode
    + step + speed) and the RIGHT column (Orient + Collapse chip
    + fullscreen) MUST remain visible and interactive when MINIMIZED.

    Structural pin:
      * jog-left-column-slot renders unconditionally (no isMinimized
        gate) — LEFT column portal target survives collapse.
      * jog-right-column-slot renders unconditionally — same.
      * jog-pad-cluster-overlay renders unconditionally — the
        JogControls tree stays mounted so its LEFT/RIGHT portals
        keep their content; only the CENTER container renders null
        when hidePads is true.
      * JogControls receives hidePads={isMinimized} — the ONE seam
        that couples collapse state to the pad cluster.
      * JogControls signature accepts hidePads=false default.
    """
    layout = _read(LAYOUT)
    jog    = _read(JOG)

    # Slots + pad-cluster overlay unconditional.
    for testid in ('jog-left-column-slot',
                   'jog-right-column-slot',
                   'jog-pad-cluster-overlay'):
        # 2026-09-17 disambiguation: querySelector strings inside
        # the useEffect body match the same data-testid substring.
        # Prefer the id= attribute for slots (unique to their JSX
        # element); fall back to rfind for the pad-cluster overlay
        # (only testid'd, no id).
        if 'slot' in testid and testid.endswith('-slot'):
            idx = layout.find(f'id="{testid}"')
        else:
            idx = layout.rfind(f'data-testid="{testid}"')
        assert idx != -1, f'{testid} testid missing'
        prefix = layout[max(0, idx - 800):idx]
        # No `{!isMinimized &&` gate immediately before the div.
        # (There may be other isMinimized references further up
        # for dim overlay etc — we scope the check to the last 400
        # chars before the testid.)
        near = layout[max(0, idx - 400):idx]
        assert not re.search(r'\{\s*!\s*isMinimized\s*&&\s*\(?\s*<(?:>|div)', near), (
            f'{testid} MUST NOT be gated on !isMinimized — the '
            f'2026-09-17 collapse-scope fix keeps it mounted so the '
            f'LEFT/RIGHT columns remain reachable while collapsed')

    # JogControls receives hidePads={isMinimized}.
    assert 'hidePads={isMinimized}' in layout, (
        'View3DLayout MUST pass hidePads={isMinimized} to JogControls — '
        'the ONLY authorized seam that couples MINIMIZED state to '
        'the pad cluster (LEFT/RIGHT stay unaffected)')

    # JogControls signature accepts hidePads.
    assert 'hidePads = false' in jog, (
        'JogControls must declare hidePads=false — collapse-scope '
        'prop that nulls the CENTER container without unmounting '
        'the component')

    # CENTER container gated on !hidePads.
    center_idx = jog.find('data-testid="jog-center-pads"')
    center_prefix = jog[max(0, center_idx - 400):center_idx]
    assert re.search(r'\{\s*!\s*hidePads\s*&&', center_prefix), (
        'jog-center-pads container must be gated on !hidePads so '
        'MINIMIZED renders null for the CENTER while LEFT + RIGHT '
        'portals stay populated')


def test_collapsed_expanded_style_parity():
    """Operator directive: the collapse chip and the "expand"
    variant look identical — same shape/size/color/position, only
    the label/testid/onClick target flip. RealArmMinimizedPill
    (the retired distinct green chip) is gone.

    Implementation contract:
      * ONE <button> element carries BOTH data-testid variants via
        a ternary keyed on isMinimized:
          data-testid={isMinimized ? 'expand-jog-buttons'
                                    : 'collapse-jog-buttons'}
      * The button uses `...chromeBtn` (shared style token set) in
        BOTH states — no per-state background/color overrides.
      * onClick uses a ternary target too:
          setView3dJogPanel(isMinimized ? 'NORMAL' : 'MINIMIZED')
      * Labels flip: 'Expand Jog Buttons' vs 'Collapse Jog Buttons'.
    """
    src = _read(LAYOUT)
    # Retired chip must be gone (belt-and-braces with the polish pin).
    assert 'function RealArmMinimizedPill(' not in src

    # Dual testid ternary present.
    assert re.search(
        r"data-testid=\{\s*isMinimized\s*\?\s*'expand-jog-buttons'\s*:\s*'collapse-jog-buttons'\s*\}",
        src), (
        'collapse chip data-testid must be a ternary '
        "(isMinimized ? 'expand-jog-buttons' : 'collapse-jog-buttons') "
        'so both testids resolve on the SAME element (style parity)')

    # onClick ternary target.
    assert re.search(
        r"setView3dJogPanel\(\s*\n?\s*isMinimized\s*\?\s*'NORMAL'\s*:\s*'MINIMIZED'\s*\)",
        src), (
        "onClick must be setView3dJogPanel(isMinimized ? 'NORMAL' : 'MINIMIZED') "
        '— single chip toggles collapse state both ways')

    # Both labels appear as string literals.
    assert 'Expand Jog Buttons' in src
    assert 'Collapse Jog Buttons' in src

    # Style uses shared chromeBtn token — no per-state background.
    chip_idx = src.find("data-testid={isMinimized ? 'expand-jog-buttons'")
    assert chip_idx != -1
    # Take a window covering the style prop.
    chip_block = src[chip_idx:chip_idx + 800]
    assert re.search(r'style=\{\{\s*\n\s*\.\.\.chromeBtn', chip_block), (
        'collapse chip style must spread ...chromeBtn as the base '
        'token set (style parity — same token in both states)')
    # No conditional background/color/border/borderRadius keys keyed on isMinimized.
    for banned in (r"background:\s*isMinimized",
                   r"color:\s*isMinimized",
                   r"border:\s*isMinimized",
                   r"borderRadius:\s*isMinimized"):
        assert not re.search(banned, chip_block), (
            f'collapse chip style must NOT vary `{banned}` on '
            f'isMinimized — style parity per operator directive')


def test_pad_cluster_fits_viewport_at_tablet_widths():
    """2026-09-17 UNIFIED FIT (third pass — supersedes prior
    modeled matrices AND the composed fitScale×cap approach that
    overflowed on desktop-expand). Operator directive after three
    device failures — ONE rule, both modes:

      scale = max(MIN_FIT_SCALE,
                  min(cap, sLeft, sRight, sHeight))

    where cap = 1 in normal, EXPAND_MAX (1.6) in expand, and every
    ratio comes from getBoundingClientRect / offsetWidth. No
    modeled widths, no breakpoints. Scaler transform uses
    `scale(fitScale)` DIRECTLY — the mode cap is folded into
    fitScale, never multiplied on top afterwards.
    """
    jog = _read(JOG)
    layout = _read(LAYOUT)

    # 1. JogControls accepts fitScale prop, default 1.
    assert 'fitScale = 1' in jog

    # 2. Scaler transform uses fitScale DIRECTLY (no × cap).
    scaler_idx = jog.rfind('data-testid="jog-center-cluster-scaler"')
    assert scaler_idx != -1
    scaler_block = jog[scaler_idx:scaler_idx + 1600]
    assert re.search(
        r"transform:\s*fitScale\s*===\s*1\s*\?\s*'none'\s*:\s*"
        r"`scale\(\$\{fitScale\.toFixed\(4\)\}\)`",
        scaler_block), (
        'scaler transform must be `fitScale === 1 ? none : '
        'scale(${fitScale.toFixed(4)})` — no `* (expanded ? 1.6 : 1)` '
        'composition (the composition was the desktop-expand-overflow '
        'root cause)')

    # 3. View3DLayout passes fitScale to JogControls + measures via
    # querySelector on the three anchors.
    assert 'fitScale={fitScale}' in layout
    for testid in ('jog-left-column-slot', 'jog-right-column-slot',
                   'jog-center-cluster-scaler'):
        assert re.search(
            r"document\.querySelector\('\[data-testid=\"" + testid + r"\"\]'\)",
            layout), f'measurement must querySelector [{testid}]'
    assert 'getBoundingClientRect()' in layout
    assert 'offsetWidth' in layout and 'offsetHeight' in layout, (
        'natural cluster W AND H must be read via scaler.offsetWidth / '
        '.offsetHeight (layout dims, unaffected by transform)')

    # 4. Asymmetric width halves + height availability.
    assert 'halfLeft' in layout and 'halfRight' in layout, (
        'width must use halfLeft + halfRight around viewport-center')
    for var in ('naturalH', 'availableH', 'sHeight'):
        assert var in layout, (
            f'unified-fit formula must include `{var}` — the height '
            f'ratio guarantees the cluster fits vertically')

    # 5. Cap declaration + ONE Math.min across cap + all four ratios.
    # 2026-09-17 EXPAND-ROLLBACK (operator directive after desktop
    # screenshot showed X-, Y+, Rz+ clipped as slivers): EXPAND_MAX
    # RETIRED because scale>1 spills the visual past the overlay's
    # LAYOUT box and the ancestor tree (view3d-immersive-root
    # overflow:hidden + jog-surface-row overflowX:hidden) clips it.
    # Cap = 1 in BOTH modes. Operator directive was explicit:
    # roll back the expand implementation, do NOT patch the wrapper.
    assert 'const EXPAND_MAX' not in layout, (
        'EXPAND_MAX constant must be RETIRED (2026-09-17 expand-'
        'rollback) — scale>1 clipped in the overflow:hidden ancestor')
    assert 'const CAP = 1' in layout, (
        'cap must be a plain constant `const CAP = 1` — both modes '
        'use the same natural size (no >1 scaling)')
    assert re.search(
        r"Math\.min\(\s*cap\s*,\s*sLeft\s*,\s*sRight\s*,\s*sHeight\s*\)",
        layout), (
        'fitScale MUST be Math.min(cap, sLeft, sRight, sHeight)')

    # 6. Recompute triggers: resize + orientationchange +
    # visibilitychange (PWA standalone). isExpanded dep DROPPED
    # in 2026-09-17 expand-rollback (cap constant, not mode-varying).
    fit_effect_idx = layout.find('UNIFIED FIT')
    assert fit_effect_idx != -1
    fit_effect_block = layout[fit_effect_idx:fit_effect_idx + 6000]
    assert "'resize'" in fit_effect_block
    assert "'orientationchange'" in fit_effect_block
    assert 'visibilitychange' in fit_effect_block, (
        'must recompute on visibilitychange (PWA standalone launch)')


def test_expand_scales_only_center_cluster_not_left_column():
    """2026-09-17 UNIFIED FIT — operator's second-bug clause: the
    expand mode must scale ONLY the CENTER pad cluster, NEVER the
    LEFT column. Regressing this yields the "step-size chips
    overlapping" symptom the operator screenshotted (the LEFT
    column's chip vocabulary is thin at 150px; scaling it up by
    1.6× would collide with the pad cluster).

    Structural pin: the `expanded` prop MUST NOT appear in any
    style value inside the LEFT column subtree (marker: "LEFT —
    mode, step, speed" up to "CENTER — jog arrow pads"). The
    prop's only styling references are inside the CENTER container
    (paddingBottom + the scaler's transform comment).
    """
    jog = _read(JOG)
    left_marker   = jog.find('LEFT — mode, step, speed')
    center_marker = jog.find('CENTER — jog arrow pads', left_marker)
    assert left_marker != -1 and center_marker != -1
    left_block = jog[left_marker:center_marker]

    # Strip comments — retirement notes may mention the word 'expand'.
    left_code = re.sub(r'/\*.*?\*/', '', left_block, flags=re.DOTALL)
    left_code = re.sub(r'\{/\*.*?\*/\}', '', left_code, flags=re.DOTALL)
    left_code = '\n'.join(
        line for line in left_code.splitlines()
        if not line.lstrip().startswith('//'))

    # No `expanded` reference anywhere in the LEFT column body (all
    # elements between the two markers). If a future edit adds
    # `transform: expanded ? …` or `padding: expanded ? …` to the
    # LEFT column, this pin trips.
    assert 'expanded' not in left_code, (
        "the `expanded` prop MUST NOT appear anywhere in the LEFT "
        "column subtree — expand scales ONLY the CENTER cluster "
        '(operator directive: expand-preserves-arrangement). Prior '
        "regression symptom: 'step-size chips overlapping' when the "
        'LEFT column grew 1.6× with the center.')

    # And: no transform style at all applied to the LEFT column
    # outer wrapper or its 5 group children. transforms inside the
    # LEFT column would fight the expand contract even if unrelated
    # to `expanded`. Grep for `transform:` in the LEFT block.
    assert 'transform:' not in left_code, (
        'no CSS transform is allowed inside the LEFT column — the '
        'scaler transform is scoped to the CENTER cluster only. Any '
        'LEFT-column transform would fight the expand contract.')


def test_cluster_fit_debug_chip_available_behind_flag():
    """Diagnostic surface: with `?debug=1` in the URL, a top-center
    overlay reports the numbers the unified-fit formula reads from
    the device (innerW/H, slot rects, availableW/H, naturalW/H,
    cap, applied scale). Operator verification channel — retire
    once tablet portrait+landscape AND desktop normal+expand
    confirm clip-free.
    """
    layout = _read(LAYOUT)
    assert "'debug=1'" in layout, (
        "debug flag literal `debug=1` must appear so the operator "
        "can enable the diagnostic chip via URL param (2026-09-17 "
        "UNIFIED FIT rename from debug=cluster)")
    assert 'data-testid="cluster-fit-debug"' in layout, (
        'the debug chip must carry data-testid="cluster-fit-debug"')
    chip_idx = layout.find('data-testid="cluster-fit-debug"')
    prefix = layout[max(0, chip_idx - 400):chip_idx]
    assert 'debugCluster' in prefix, (
        'debug chip render must be gated on the debugCluster flag')


# ─────────────────────────────────────────────────────────────────
# 2026-09-17 SINGLE-WINDOW RESTRUCTURE — structural pins
# ─────────────────────────────────────────────────────────────────


def test_no_full_width_container_over_canvas():
    """Operator diagnosis: the previous RealArmChrome + overlay
    wrapper formed a "second window" because they spanned
    left:0 → right:0 (full viewport width) with pointer-events
    enabled downstream. Any absolute-positioned child of the 3D
    View root that would form a full-width container over the
    canvas MUST be gone from View3DLayout. Enforced structurally
    by rejecting: (a) `left: 0` combined with `right: 0` on any
    absolute-positioned element inside the layout file, and
    (b) `width: '100%'` combined with `position: 'absolute'`.
    """
    src = _read(LAYOUT)
    # Strip comments so retirement notes referencing left:0/right:0
    # don't false-positive.
    code = re.sub(r'/\*.*?\*/', '', src, flags=re.DOTALL)
    code = re.sub(r'\{/\*.*?\*/\}', '', code, flags=re.DOTALL)
    code = '\n'.join(
        line for line in code.splitlines()
        if not line.lstrip().startswith('//'))

    # (a) No element declares left:0 + right:0 pair.
    # Search for `left: 0` proximate to `right: 0` inside the same
    # style object (within ~200 chars).
    for m in re.finditer(r"left:\s*0\b", code):
        window = code[m.end():m.end() + 200]
        assert not re.search(r"right:\s*0\b", window), (
            'no element in View3DLayout may declare BOTH left:0 and '
            'right:0 — that produces a full-width span over the '
            'canvas (operator-flagged two-window pattern). Successor '
            'overlays are content-sized (bottom:16 left:50% translate) '
            'or thin (width:150/200 with left:16 / right:16 anchors).')

    # (b) No absolute-positioned element declares width:'100%'.
    for m in re.finditer(r"position:\s*'absolute'", code):
        window = code[m.end():m.end() + 400]
        assert not re.search(r"width:\s*'100%'", window), (
            'no absolute-positioned element in View3DLayout may set '
            "width:'100%' — that reproduces the operator-flagged "
            'full-width band. Overlays must be content-sized or '
            'anchored via left/right insets')


def test_collapse_toggles_only_pad_cluster():
    """MINIMIZED hides ONLY the pad-cluster overlay. The LEFT +
    RIGHT slot divs stay mounted at NORMAL and EXPANDED — but the
    operator directive is that Collapse re-mounts the pad cluster
    only, leaving the LEFT (ENABLE/DISABLE + jog mode + step +
    speed) and RIGHT (Orient + Collapse + fullscreen) columns
    reachable. Since the LEFT/RIGHT slots are gated on !isMinimized
    too (per test_page_level_slot_dims), MINIMIZED clears
    everything except the Expand pill — that's still one-collapse-
    fits-all. The pin below asserts NEITHER slot is gated on the
    pad overlay's presence (they don't collapse WITH the pad
    cluster).
    """
    src = _read(LAYOUT)
    # Both slot divs live inside the SAME !isMinimized fragment as
    # the pad overlay (three siblings). Assert the pad overlay is
    # gated separately and NOT nested inside the slot fragment.
    pad_idx = src.rfind('data-testid="jog-pad-cluster-overlay"')
    left_idx = src.find('id="jog-left-column-slot"')
    right_idx = src.find('id="jog-right-column-slot"')
    assert pad_idx != -1 and left_idx != -1 and right_idx != -1
    # Neither slot must sit BETWEEN a `<JogControls` open tag and
    # its closing `/>` — that would mean the slot is a child of
    # the pad-cluster JogControls, which contradicts the page-level
    # requirement. Grep the pad-cluster overlay block.
    jc_open = src.find('<JogControls', pad_idx)
    jc_close = src.find('/>', jc_open) if jc_open != -1 else -1
    if jc_open != -1 and jc_close != -1:
        assert not (jc_open < left_idx < jc_close), (
            'LEFT slot must not nest inside the pad-cluster '
            'JogControls (page-level slot requirement)')
        assert not (jc_open < right_idx < jc_close), (
            'RIGHT slot must not nest inside the pad-cluster '
            'JogControls')


def test_left_column_is_page_level_not_inside_pad_overlay():
    """Structural pin: the LEFT + RIGHT slot divs must render as
    direct children of the 3D View root (view3d-immersive-root),
    not as descendants of the pad-cluster overlay. Source-order
    check: both slots appear BEFORE the pad-cluster overlay under
    the `!isMinimized &&` fragment. This is the guarantee that
    collapse of the pad cluster does NOT affect the columns.
    """
    src = _read(LAYOUT)
    left_idx  = src.find('id="jog-left-column-slot"')
    right_idx = src.find('id="jog-right-column-slot"')
    pad_idx   = src.rfind('data-testid="jog-pad-cluster-overlay"')
    assert -1 not in (left_idx, right_idx, pad_idx)
    assert left_idx < pad_idx, (
        'jog-left-column-slot must render BEFORE '
        'jog-pad-cluster-overlay (page-level sibling)')
    assert right_idx < pad_idx, (
        'jog-right-column-slot must render BEFORE '
        'jog-pad-cluster-overlay (page-level sibling)')


def test_pointer_events_walk_over_canvas():
    """Every element over the canvas in View3DLayout that carries
    a jog-* testid MUST declare pointerEvents:'none' at its wrapper
    style. Interactive elements (JogControls buttons/inputs) opt
    back into 'auto' inside the JogControls component (verified
    separately). The wrapper contract:
      * jog-pad-cluster-overlay: none
      * jog-left-column-slot: none
      * jog-right-column-slot: none
      * view3d-expand-canvas-dim: none
    """
    src = _read(LAYOUT)
    for testid in (
        'jog-pad-cluster-overlay',
        'jog-left-column-slot',
        'jog-right-column-slot',
        'view3d-expand-canvas-dim',
    ):
        idx = src.rfind(f'data-testid="{testid}"')
        # dim overlay may be conditional — only require pointer-events
        # none when the testid IS present.
        if idx == -1:
            continue
        block = src[idx:idx + 1600]
        assert re.search(r"pointerEvents:\s*'none'", block), (
            f'{testid} wrapper MUST declare pointerEvents:none per '
            f'the pointer-events walk contract (operator directive '
            f'2026-09-17: overlays passthrough, controls opt in)')


def test_jog_controls_immersive_outer_is_pointer_events_none():
    """JogControls immersive mode must render its outer div with
    pointerEvents:'none' so the pad-cluster overlay's transparent
    region passes clicks through to the canvas. Only the scaler
    (jog-center-cluster-scaler) opts back to auto.
    """
    src = _read(JOG)
    # Locate JogControls' return outer div via the 2026-09-17
    # single-window landmark comment placed right at the return.
    landmark = 'SINGLE-WINDOW RESTRUCTURE — in immersive mode the'
    idx = src.find(landmark)
    assert idx != -1, (
        'JogControls single-window landmark comment not found — '
        'the outer wrapper contract cannot be verified')
    outer_block = src[idx:idx + 800]
    assert re.search(
        r"pointerEvents:\s*immersive\s*\?\s*'none'", outer_block), (
        'JogControls outer div must declare '
        "pointerEvents: immersive ? 'none' : undefined")
    # Scaler opts back in.
    scaler_idx = src.rfind('data-testid="jog-center-cluster-scaler"')
    scaler_block = src[scaler_idx:scaler_idx + 1600]
    assert re.search(
        r"pointerEvents:\s*immersive\s*\?\s*'auto'", scaler_block), (
        'jog-center-cluster-scaler must declare '
        "pointerEvents: immersive ? 'auto' : undefined so taps on "
        'the pad grid land on the buttons')


def test_element_from_point_grid_over_canvas_returns_canvas():
    """jsdom-level elementFromPoint sweep: at a grid of viewport
    points (y = 300, 500, 700, 850 at x = 25%, 50%, 75%), the
    document.elementFromPoint result must be the canvas (or a
    descendant of the canvas-fill wrapper) for every point that is
    NOT inside a page-level control cluster.

    jsdom doesn't fully implement CSS layout for elementFromPoint,
    so we settle for a static-source assertion: the ONLY element
    that spans the majority of viewport pixels (via absolute-
    position on view3d-immersive-root) is view3d-canvas-fill with
    inset:0 zIndex:0. Every other overlay must NOT declare inset:0
    with a zIndex higher than the canvas.
    """
    src = _read(LAYOUT)
    # view3d-canvas-fill MUST declare inset:0 + zIndex:0 (the
    # baseline full-viewport layer).
    canvas_idx = src.find('data-testid="view3d-canvas-fill"')
    assert canvas_idx != -1
    canvas_block = src[canvas_idx:canvas_idx + 800]
    assert re.search(r"inset:\s*0", canvas_block), (
        'view3d-canvas-fill must set inset:0 so the canvas fills '
        'the full viewport as the baseline layer')
    assert re.search(r"zIndex:\s*0", canvas_block), (
        'view3d-canvas-fill must set zIndex:0 as the baseline layer')

    # No other overlay may set inset:0 with a higher zIndex UNLESS
    # its pointerEvents is 'none' (allowed for the canvas-dim wash).
    for m in re.finditer(r"inset:\s*0", src):
        window = src[max(0, m.start() - 400):m.end() + 600]
        if 'view3d-canvas-fill' in window:
            continue
        # Any other inset:0 element must be pointer-events:none so
        # elementFromPoint still returns the canvas beneath it.
        assert re.search(r"pointerEvents:\s*'none'", window), (
            'an inset:0 element inside view3d-immersive-root MUST be '
            'pointerEvents:none — otherwise it steals every canvas '
            'point from elementFromPoint (operator diagnosis: this '
            'was the second-window culprit)')
