# INDEX.md — ledger topic map
> Always loaded. One line per ledger file, in order. Grep this for a topic,
> then read the pointed-at file. The ledger itself lives in `docs/ledger/`.

## Distillates (always-loaded tier)
- `docs/STANDING.md` — session doctrine (rules 1–7, ledger doctrine, tool doctrine)
- `docs/STATE.md` — current truth (rewritten every session end)
- `docs/HARDWARE.md` — robot / network / systemd / safety / alarm-code constants
- `docs/OPERATIONS.md` — every procedure as numbered steps with exact commands
- `docs/FACTS.md` — ambient truths (silent classes, wire quirks, "enabled" per surface)
- `docs/LESSONS.md` — one-line lesson index, all N with pointers
- `docs/INDEX.md` — this file
- `docs/ATTEMPTS.md` — recent-past attempted-but-failed approaches

## Reference tier by topic
- **Robot / arm / kinematics:** HARDWARE.md § Robot arm, § DH table; FACTS.md § Kinematics
- **Network / ports / subnets:** HARDWARE.md § Network (full port table with source citations)
- **Systemd / env drop-ins:** HARDWARE.md § Systemd unit inventory (Environment vs EnvironmentFile gotcha)
- **CRI launch + teardown:** OPERATIONS.md §1, §2 (5-step init; teardown reverse sequence)
- **Enable / servo-on:** OPERATIONS.md §3 (over-the-wire + UI paths)
- **Alarms + WS status probe:** OPERATIONS.md §5; HARDWARE.md § Alarm codes; FACTS.md § Silent classes
- **Backend flip (ros2 ↔ ws):** OPERATIONS.md §7 (drop-in + safe-gated restart)
- **jog_bridge discipline:** OPERATIONS.md §8 (L216/L217/L239)
- **Frontend serving:** OPERATIONS.md §10 (single vite outDir → dist)
- **Session ritual:** OPERATIONS.md §12 (three writes + reference-tier update)

## v46 archive (grep-on-demand, `docs/ledger/`)

### Era 01 — pre-addendum
- `era-01-pre-addendum-general-project-docs.md` — general project docs before addendum numbering began

### Foundations (Jun 15 – early Jul)
- `addendum-01-jun-15-sessions-281.md` — sessions foundation (281)
- `addendum-02-jun-15-s10-140-dimensions.md` — S10-140 dimensions
- `addendum-03-jun-16-articulated-urdf.md` — articulated URDF
- `addendum-04-jun-17-static-keepout.md` — static keep-out zones
- `addendum-05-jun-21-22-pbd-correction-diff.md` — PBD correction-diff loop
- `addendum-06-jun-23-30-investor-materials.md` — investor materials
- `addendum-07-jul-02-3d-viewer.md` — 3D twin viewer
- `addendum-08a-jul-03-calibrated-dh.md` — calibrated DH parameters
- `addendum-08b-jul-03-business-model.md` — business model
- `addendum-09-jul-04-brand-bio-deck-v2.md` — brand / bio / deck v2
- `addendum-10-jul-06-articulating-twin-mechanism.md` — articulating twin mechanism
- `addendum-11-jul-07-twin-baked-in.md` — twin baked in
- `addendum-12-jul-08-robot-arrival.md` — robot arrival

### Robot on the floor (Jul 09 – late Jul)
- `addendum-13-jul-09-network-rearch.md` — network rearchitecture
- `addendum-14-jul-14-repo-lfs-safety-config.md` — repo LFS + safety config
- `addendum-15-jul-15-deck-v3.md` — deck v3
- `addendum-16-jul-14-15-write-path-arc.md` — write-path arc
- `addendum-17-jul-16-c-suite-team-slide.md` — c-suite team slide
- `addendum-18-jul-16-17-validation-signoff.md` — validation sign-off
- `addendum-19-jul-20-move-write-path.md` — move-write path
- `addendum-20-jul-21-io-arc.md` — I/O arc
- `addendum-21-jul-22-testwizard-crash-forensics.md` — testwizard crash forensics
- `addendum-22-jul-23-vacuum-pneumatics.md` — vacuum + pneumatics
- `addendum-23-jul-23-27-effector-composer.md` — effector composer
- `addendum-24-jul-28-stale-service-recurrence.md` — stale-service recurrence
- `addendum-25-jul-29-great-capture-168-verbs.md` — great capture (168 Lua verbs)
- `addendum-26-jul-30-wait-saga.md` — wait saga
- `addendum-27-jul-31-pallet-teach-flow.md` — pallet teach flow

### Program integrity (Aug 03 – Aug 06)
- `addendum-28-aug-03-orientation-lock.md` — orientation lock
- `addendum-29-aug-04-controller-kills-architecture-triad.md` — controller-kills architecture triad
- `addendum-30-aug-05-teach-pipeline-siege.md` — teach-pipeline siege
- `addendum-31-aug-06-palletize-cycle.md` — palletize cycle

## Post-v46 (Aug 17+, from external zips + on-Jetson sessions)
- `addendum-32-aug-17-cri-day.md` — CRI day: transport #2, firmware floor, first ROS2-native motion
- `addendum-33-aug-18-phase-e-closes.md` — Phase E closes: planner takes the arm, 14μm straight line
- `addendum-34-aug-18-phase-f1.md` — Phase F opens: hybrid proven, jog bridge built
- `addendum-35-aug-19-first-human-jog.md` — first human jog over ROS2: 12/12 taps
- `addendum-36-hold-root-cause-and-restructure.md` — hold defect root-caused off-target; ledger split into distillates + archive
- `addendum-37-aug-20-f1-pre-rung-setup.md` — ledger self-lint (ATTEMPTS + builder + 4-duty lint); F1 close pre-rung setup (drop-in + rebuild + jog_bridge null-tolerance + use_mock silent-mock discovery)
- `addendum-38-aug-24-f1-motion-chain-and-hunt.md` — F1 motion chain proven on real arm (+11.75° J6); hold-jog hunt named + partial-fixed; reference tier built (HARDWARE + OPERATIONS + FACTS); Codroid operating UI on :9198 discovered; CriUdpSystem remote-disconnect state-latching named as its own hazard class
- `addendum-39-aug-24-hunt-trace-verdict.md` — hunt-trace verdict = goal-seam (upstream of JTC); reference-cursor anchor + 8.6° guard-threshold tune shipped (CodroidROS2 `f6d4d53`); realized throughput 8.1 % → 79.5 %, sign reversals 28 → 0
- `addendum-40-aug-25-jog-moveit-servo-accel-ramp.md` — goal-replacement retired (J2 trip); moveit_servo migration + 35 Hz ring fix via JointGroupPositionController swap; CC10-A per-cycle accel limit (~25 rad/s²) named as continuous-jog root cause; accel-ramp adapter bypassing Servo (CodroidROS2 `f0e2930`); first-motion smooth then 2015 trip; divergence-guard-snap replaced with two-phase settling (`cb022d3`); phantom stale-tab source + 15 %→22 UI bug named

## By topic (fast lookup)

- **CRI / write path:** 16, 19, 32, 33, 34, 35, 36, 37, 40
- **Jog / F1:** 34, 35, 36, 37, 38, 39, 40
- **moveit_servo / accel-ramp:** 40 (§558–§563)
- **Silent classes / silent-refusal:** 37 (§537), 38 (§542), 40 (§564)
- **Dashboard UI bugs:** 40 (§565 15 %→22)
- **URDF / kinematics:** 3, 8a, 10, 11, 32
- **Palletize:** 27, 31, 36 (§531)
- **PBD:** 5, 30
- **Teach flow:** 27, 30
- **Safety / limits:** 4, 21, 29, 36 (§529), 40 (§562 CC10-A accel limit)
- **Deploy / systemd:** 14, 24, 29
- **Ledger doctrine:** 36 (§532)
- **Fork registry:** 29 (§465), 30
- **Lua verbs / composer:** 23, 25, 26
- **Network:** 13, 32
- **Materials (deck / bio / brand):** 6, 9, 15, 17
- **DH / calibration:** 8a, 32
