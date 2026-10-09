# Bench-verify sheet — continuous (hold-to-move) jog default (2026-08-03, rev 2026-08-05)

_2026-08-04: server deadman tightened 0.3 → 0.2 s; pointerleave stops jog;
tablet drawer viewport check added._
_2026-08-05: **teach-drawer dead buttons fixed** — OverlayJogArrow now
reads shared jogStyle + wires onTap so STEP mode works in the drawer
(pre-fix it hardcoded CONTINUOUS and never fired onTap → dead 1mm buttons).
Silent driver rejections now surface as toasts. Debug HUD removed._

**Before touching the pendant:** the arm was left at 90% / Auto after the last session. Drop pendant speed to **5%** and set mode as required for jog testing (Manual is safest during release-path verification).

## Preconditions

| Check | How | Pass |
|-------|-----|------|
| Speed 5% | Pendant top bar | operator |
| Cell clear | Visual sweep + verbal call-out | operator + observer |
| E-stop reachable | Test press; arm re-safes | operator |
| Dashboard live | `http://localhost:8080` opens; connection chip green | teddy |
| Driver freshness = 0.2 s | `grep jog_freshness_timeout_s src/estun_driver/config/estun.yaml` returns `0.2` (2026-08-04 tightening) | teddy |
| `jog_speed_cap=0.50`, `operator_speed_limit=1.00` | driver log at boot | teddy |
| Frontend flipped | Dashboard → jog panel top toolbar shows **Continuous** as the default-highlighted mode toggle | operator |

## Release-path enumeration (task §3)

Every one of these MUST stop jog motion within one supervise-tick beat (~50 ms client-observable). The server-side 200 ms freshness deadman is the safety backstop; the client should stop BEFORE it fires so the "stop" reason on the wire reads `release cmd`, not `hold staleness`.

For each row, watch `journalctl -u roboai-estun -f | grep -E "hold |stopJog|staleness"` in a separate terminal — the reason string tells you which layer stopped it.

| # | Release path | How to trigger | Expected wire reason | Pass |
|---|--------------|----------------|----------------------|------|
| 1 | `pointerup` | Hold J4+, release finger cleanly on the button | `release cmd` | operator |
| 2 | `pointercancel` | Hold J4+, swipe finger 3+ cm across screen | `release cmd` | operator |
| 3 | `pointerleave` (slide-off) | Hold J4+, slide finger deliberately off the button (2+ cm) | `release cmd` — client emits `release_pointerleave` and stops. (2026-08-04 §5 update — previously a no-op relying on pointer capture; now safety-first: slide-off = stop.) | operator |
| 4 | Component unmount | Hold J4+, switch to a different dashboard tab that removes the JogControls | `release cmd` | operator |
| 5 | Window blur | Hold J4+ on tablet, drag another app over Chrome to switch focus | `release cmd` (client emits `release_window_blur`) | operator |
| 6 | Visibility change | Hold J4+ in mobile Chrome, hit the tablet's home button | `release cmd` (client emits `release_visibility_hidden`) | operator |
| 7 | Page hide | Hold J4+, navigate the browser away (URL bar → enter a new URL) | `release cmd` (`release_pagehide`) | operator |
| 8 | `disabled` mid-hold | Hold J4+, then run `sudo systemctl stop roboai-estun` in another terminal | `release cmd` (`release_disabled_midhold`); server logs "hold staleness" if the WS drop tears connection before the release lands — either is a pass | operator |
| 9 | **Dead-man (the real test)** | Hold J4+, then `kill -9` the browser tab process (task manager → Chrome renderer) | `hold staleness` — server-side 200 ms freshness deadman stops it | operator |

**Line 9 is the non-negotiable one.** If the arm ever continues jogging after a browser crash, the whole design failed. Test it deliberately every deploy.

## Step-mode regression check

| Check | How | Pass |
|-------|-----|------|
| Toggle to Step | Top toolbar → click Step | operator |
| Tap J4+ once | Single fixed increment (5° default step in Joint mode) | operator |
| Hold J4+ | Motion does NOT repeat — one step per press only (STEP is by-design tap-only) | operator |
| Toggle back to Continuous | Top toolbar → click Continuous | operator |

## Tablet teach-drawer viewport (task §7 "drawer unclipped")

The teach drawer uses `height: 100dvh` to anchor against the tablet's dynamic
viewport (URL bar showing or collapsed). A `TeachOverlayDebugHUD` renders in
the top-right corner reporting `innerH / clientH / vv / drawer-scrollH/clientH`
plus an `OVF+N` badge when the drawer's scrollHeight exceeds its clientHeight.

| Check | How | Pass |
|-------|-----|------|
| Drawer opens flush | Program editor → any step → Teach; drawer covers the visible viewport with no gap top or bottom | operator |
| Footer reachable | Cancel + Record buttons visible without scrolling | operator |
| No overflow badge | Debug HUD in top-right shows `drawer:{scrollH}/{clientH}` — the two numbers should be **equal** (no `OVF+` badge) | operator |
| URL bar collapse survives | Scroll the drawer content once so Android/iOS collapses the URL bar; drawer still fills the viewport with footer reachable | operator |
| Rotate landscape → portrait | Drawer relayouts within one frame; no residual clip | operator |

If the HUD shows `OVF+N` on the tablet's default portrait mode, capture the
`innerH / clientH / vv` numbers and file — the fix candidates are (a) trimming
the debug HUD itself once the layout is settled, (b) checking safe-area insets
on iOS Safari, or (c) verifying `viewport-fit=cover` is present in `index.html`.

## Teach-drawer parity (2026-08-05 fix)

The drawer's `OverlayJogArrow` now reads `jogStyle` from the shared store
slice (same as the main pendant) and wires `onTap` so STEP mode fires
per-tap increments. Same handler path as the pendant — a change to
jog dispatch touches BOTH surfaces together.

| Check | How | Expected | Pass |
|-------|-----|----------|------|
| Drawer arrows respond | Open teach drawer, tap X+ once (STEP mode, 1 mm) | Arm moves ~1 mm on live TCP readout (Cartesian STEP is 150 ms pulse @ speed % — approximate for cart, exact for joint) | operator |
| Toggle mode from pendant applies to drawer | Close drawer, toggle to CONTINUOUS on pendant, reopen drawer | Same button now sustains motion while held | operator |
| Step size chip selection honored | STEP mode + Joint tab, select 5° chip, tap J1+ | J1 angle increases by exactly 5° on live readout | operator |
| No debug HUD in top-right corner | Open drawer on tablet | No black `innerH:.../vv:...` badge visible | operator |
| No `TeachOverlayDebugHUD` in bundle | Search served bundle for the string | Not present | teddy |

## Rejection toast (2026-08-05 fix)

Silent driver rejections (`allow_jog=false`, `monitor_only=true`, WS not
connected) now surface as a warning toast.

| Check | How | Expected | Pass |
|-------|-----|----------|------|
| Gate-closed jog → toast | `sudo systemctl stop roboai-estun`, then tap J1+ in the drawer | Toast: "Jog rejected: ws not connected" (or similar reason) | operator |
| Same rejection doesn't re-toast every ws frame | Leave the gate closed, wait 5 s without tapping | No new toasts; last-seen jog reject ts pinned | operator |
| Fresh rejection re-toasts | Tap J1+ again | ONE new toast per new tap | operator |

## Cross-surface check

Task §2 says continuous applies "everywhere JogControls renders". Verify:
| Surface | Path in dashboard | Same behavior? |
|---|---|---|
| Teach drawer | Program editor → any step → Teach | ✓ CONTINUOUS default; all release paths fire |
| Pendant | 3D View → REAL ARM panel | ✓ same |
| Program wizard | New program → Draw taught poses stage | ✓ same |

Same jog store slice powers all three via `useStore((s) => s.jogStyle)`. If any surface diverges, that's a per-page override — find and remove it.

## Long-press context menu (tablet)

| Check | How | Pass |
|---|---|---|
| Long-press J4+ on tablet | No native context menu (copy / select / share sheet); no text selection highlight; button styling stays "pressed" | operator |
| iPad Safari specific | Same — `touch-action:none` + `WebkitTapHighlightColor:transparent` + `onContextMenu:preventDefault` blocks all three | operator |

## Rollback

If continuous causes an unexpected regression:
- **Fast rollback (per-session)**: operator taps the top toolbar → **Step**. Muscle memory kicks in immediately.
- **Full rollback (config)**: revert `useStore.js` default `'CONTINUOUS'` → `'STEP'` + rebuild the frontend. The HoldButton code paths and release listeners stay — they're mode-guarded (STEP mode is a no-op on the release paths since there's nothing to release).
- **Emergency**: e-stop, then hard-reload the browser. Any orphaned press state clears on unmount.
