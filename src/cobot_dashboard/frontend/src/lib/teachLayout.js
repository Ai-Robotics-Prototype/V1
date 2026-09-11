// Shared layout math for the fullscreen teach overlay.
//
// The teach screen has a hard operator rule (2026-07-31 directive):
// every jog button + the Record Position footer + the pallet diagram
// side panel MUST be visible without vertical scroll, at every
// supported breakpoint. This module owns the budget arithmetic that
// enforces that; TeachOverlay reads from here at render time, and the
// pinned test in components/PalletFrameDiagram.pinned.test.js
// evaluates the same function at each supported viewport.
//
// Layout regions consumed above / below the jog grid (fixed heights):
//   header (60) + instruction band (48) + mode row (~56) +
//   step/speed row (~60) + slim footer (~76 incl. safe-area pad)
// Everything else is the vertical envelope for 3 D-pad rows + 2 gaps.
//
// Horizontal split (pallet-frame teach only): jog area on the LEFT,
// diagram side panel on the RIGHT. Panel width depends on breakpoint.

export const TEACH_FIXED_HEIGHT = 60 + 48 + 56 + 60 + 76   // 300 px

export function teachLayoutMetrics({ vw, vh }) {
  const isWide    = vw > 1400
  const isTabletW = vw <= 1280
  const gridHeightBudget = Math.max(240, vh - TEACH_FIXED_HEIGHT)
  const gridPadBtnCeil = isTabletW ? 96  : isWide ? 160 : 140
  const gridPadBtnFit  = Math.floor((gridHeightBudget - 24) / 3)
  const padBtn = Math.max(56, Math.min(gridPadBtnCeil, gridPadBtnFit))
  const hideSectionLabels = padBtn < 96
  const svgPx    = Math.round(padBtn * 0.44)
  const padGap   = isTabletW ? 10  : padBtn < 120 ? 12 : 14
  const groupGap = isTabletW ? 24  : padBtn < 120 ? 24 : 40
  const modeBtnH    = isTabletW ? 48  : isWide ?  64 :  56
  const modeBtnFont = isTabletW ? 14  : isWide ?  17 :  16
  // Diagram side-panel width. Only consumed when a pallet-frame
  // teach step is active; non-pallet steps get the full width.
  const diagramPanelWidth = isTabletW ? 240 : isWide ? 300 : 260
  return {
    isWide, isTabletW,
    gridHeightBudget,
    padBtn, hideSectionLabels,
    svgPx, padGap, groupGap,
    modeBtnH, modeBtnFont,
    diagramPanelWidth,
  }
}
