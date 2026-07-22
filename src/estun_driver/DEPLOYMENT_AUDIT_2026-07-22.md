# Deployment Audit — 2026-07-22 Part A

Baseline before the consolidated stability batch. Confirms HEAD ==
running services == served bundle for all recent motion/UI work.

## Environment
- HEAD: `8a19c29` — raise operator speed cap 0.25 → 0.65 + mid-run safeguards
- Served bundle: `index-CpW0QB4a.js` (sha256 `dd775138c86b`), built 13:10:18 CDT
- Driver: `roboai-estun` PID at boot 3505695, started 13:10:25 CDT
- Dashboard: `roboai-dashboard` PID 3505986, started 13:10:35 CDT

## Change-by-change audit

| Change | Commit | in HEAD | in running svc | in served bundle |
|---|---|---|---|---|
| integer-wait codegen | 3824aa4 | yes | yes | N/A (driver-side) |
| movJ for offset≈0 | 8e546e3 | yes | yes | N/A |
| movL pinned coor/tool (FIX B v2) | e57b245 | yes | yes | N/A |
| home-drift Fix C | 8e546e3 | yes | yes | N/A |
| cap raise 0.65 + speed-scaled margins | 8a19c29 | yes | yes | yes |
| mid-run speed control | 8a19c29 | yes | yes | yes |
| home-reuse Step 1 (wizard editor) | 60e7f2f | yes | yes | yes |
| teach overlay restyle + shared WS | 7e8076f | yes | yes | yes |
| STOP button + STOPPING recovery | 76a8798 | yes | yes | yes |
| POINTS-panel removal | b65995d | yes | yes | yes (removed) |
| driver init-grace | 2788ec3 | yes | yes | N/A (driver-only) |

Bundle presence proven by strings that survive Vite's minification:
`"Mid-run speed"`, `"High speed: increase to"`,
`"Controller wedged in STOPPING"`, `"🔗 Use Step "` (interpolated),
`"operator_speed_limit"` (9 hits), `"POINTS("` (0 hits — removed).

## `git log --oneline -15`

```
8a19c29 raise operator speed cap 0.25 → 0.65 + mid-run safeguards
2788ec3 estun_driver: guard controller boot race with grace + probe + backoff
60e7f2f ProgramEditor: "Use Step 1 home position" link control on later home steps
e57b245 Wrist rotation FIX B v2: movJCoorRel with relative Z offset
7e8076f Teach overlay: route jog through shared WS+keepalive transport, light theme
3824aa4 Fix wait() unit: milliseconds INTEGER (alarm 10006 fix)
8e546e3 Wrist rotation fix: FIX A + B + C for derived poses & home drift
76a8798 Monitor: STOP always enabled during active/wedged states + STOPPING recovery
c3d44e4 Monitor: Return Home + Restart Program buttons, titles-only step list
b1099ea codegen: wait_input → getDI(port); wait stays skipped (verb absent)
380a09f I/O port map: v4 silkscreen-accurate CC10-A plate layout
bd7d474 codegen: emit setDO / setAO for set_io steps (verified via luaenginelib.json)
85099df I/O port map: v3 verified inventory (18 DO / 24 DI / 4 AI / 4 AO)
7da325e Fix "not taught" display for wizard-authored derived + non-motion steps
5522842 I/O port map: CC10-A physical layout (schema v2, provisional)
```

## Conclusion
No rebuild/restart needed — the state before this batch is already
coherent (HEAD == running == served). Parts B–I proceed from this
audited baseline.
