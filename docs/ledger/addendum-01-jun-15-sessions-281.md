---
ledger_split: addendum-01
source: cobot_project_conversation_v46.md
source_lines: 9481-9721 (inclusive)
title: Sessions 281+ — MotionCam-3D, workflow reset
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# SESSION ADDENDUM — June 15, 2026 (Sessions 281+)
*(Appended in full. Nothing above this line was removed. This documents the entire June 15 working session plus carried-over pending items.)*

## 1. MOTIONCAM-3D COLOR S+ — EVALUATED AND ADOPTED (reverses Section 274)

**DECISION: Pursue the Photoneo (now Zebra) MotionCam-3D Color S+ (Blue), wrist-mounted (eye-in-hand).** This REVERSES the earlier "MotionCam not pursued" conclusion (which was based on the M+ variant's 660mm/1.5kg wrist-mount dealbreaker).

**Datasheet:** MotionCam-3D-Color-Sp_Blue_-Datasheet-01-2026-v1_0 (uploaded). Key specs:
- **Parallel Structured Light (PSL)** — continuous 3D capture DURING motion. THE patented differentiator. 3D video, no stop-scan-stitch.
- Dimensions **319×68×85mm** (the S+ is HALF the rejected M+'s ~660mm — wrist-viable), weight **1000g** (1kg), PoE or 24V.
- Onboard NVIDIA Jetson TX2 does reconstruction. 1GbE. IP65. Blue laser.
- Scanning range **630–907–1574mm** (near–sweet–far). **Min focus 630mm.** Sweet-spot area 828×649mm.
- Point-to-point **0.52mm at 907mm**. Up to 8Mpix color, 2Mpix depth (1680×1200).
- **2fps static (Scanner mode) / 20fps dynamic (Camera mode).**
- Outputs: 3D points, normals, depth, color, texture, confidence, event map.
- Camera mode slightly noisier than Scanner (0.43mm vs 0.29mm local planarity at sweet spot).

**Fit analysis:** The 319mm/1kg fits the S10-140's 10kg payload (~6kg margin after gripper). Concerns: (1) 319mm body cantilevered off the wrist creates moment-arm torque — mount close to flange, reduce J4/J5/J6 accel; (2) the 630mm MINIMUM focus means the robot holds the camera ~63–90cm above the bin — which pushes somewhat toward a FIXED OVERHEAD mount at ~0.9m as an alternative to eye-in-hand.

**KEY REFRAME (user-emphasized):** The MotionCam's real value is NOT bin-picking precision — it's **PSL continuous-during-motion perception** (3D video, no stop-scan-stitch), the prerequisite for autonomous self-setup and workspace mapping. The dense 0.5mm data is also what makes recognition + FoundationPose viable (the D435i was too sparse — this was the real missing piece all along).

**Why chosen over alternatives:** Mech-Eye was a $16K shock quote. Zivid 2+ M60 (~$5.5K) was the price/value alternative. MotionCam S+ chosen specifically for the **PSL autonomy capability**, not just precision.

### MotionCam PENDING ACTION ITEMS
- **Email Photoneo** (photoneo-sales-us@zebra.com): (1) confirm ROS2 Humble driver on Jetson AGX Orin ARM64/JetPack 6 — **THE #1 technical unknown** (the phoxi_camera driver has historically been x86-focused); (2) Locator licensing cost + whether it runs on Orin or needs a separate x86 host; (3) eval-unit availability to test on real BT225 + delrin parts.
- Decide mounting: eye-in-hand vs fixed-overhead (given the 630mm min focus).
- Confirm reach budget (0.9m scan height within the 1.4m envelope).
- Use **PoE** (single-cable wrist routing).
- Grab CAD from photoneo.com/kb/device-resources for the mount.
- **Order the MotionCam** (longest lead — it's the critical path to autonomy).

## 2. PROPRIETARY RECOGNITION STACK — DECIDED + BUILD PROMPTS AUTHORED

**DECISION: Build NeuRobots's OWN proprietary, point-cloud-first recognition stack** rather than license Photoneo Locator. Recognition is platform IP, not a licensed dependency.

**Honest framing (must be maintained):** "We built our own implementation/integration on proven geometric methods (PPF + ICP)" — NOT "we invented a new algorithm." PPF (Point Pair Features) and ICP are decades-old published methods; the proprietary part is NeuRobots's specific implementation, integration, tuning, and how it plugs into the autonomy stack. The first claim is defensible and normal; the second would be false.

**Architecture (point-cloud-first, like Photoneo Locator):**
```
Dense point cloud (MotionCam) + normals + color + confidence
 → Preprocess (downsample, denoise, crop, remove ground plane)
 → Segment (cluster into candidate instances)
 → DETECT + CLASSIFY (PPF geometric match vs CAD/taught models → identity + confidence)
 → POSE (coarse pose from matching vote → ICP refinement → optionally FoundationPose for hard cases)
 → Grasp (apply part's pick direction → grasp pose)
 → hand off to motion planning → pick
```

**De-risking strategy:** Build the own stack AND eval Photoneo Locator in parallel as GROUND TRUTH. Compare head-to-head on real BT225 + delrin parts when the camera arrives. Migrate fully to the own stack once it matches Locator. Then the "we built our own, no dependencies" claim is fully true. (FoundationPose is already on the Jetson from Section 275, has a documented volume-bias issue with silhouette-normalization fix deferred, and can be used as one component without undermining the "built our own" claim.)

**Honest tradeoffs:** PPF+ICP done robustly on real shiny/cluttered/symmetric parts is harder than the happy-path demo. Photoneo spent a decade hardening Locator. Expect months to production reliability, not weeks. NCC+histogram (the prototype approach) is PROTOTYPE-ONLY, not commercial-robust.

### Recognition Stack — Build Prompts Authored This Session

**(a) CAD→MODEL PIPELINE — the highest-value headstart, fully buildable NOW (no camera).** Build prompt authored and delivered. Creates `src/object_detection/object_detection/cad_model_builder.py` + `grasp_definition.py`:
- STEP → dense model point cloud (~0.5mm spacing to match the MotionCam sweet-spot) + normals + precomputed PPF descriptor index + grasp definition (in the part's local frame, from the existing pick-direction).
- Saves to `/opt/cobot/parts/models/{part_id}/` (model_cloud.ply, model_cloud_coarse.ply, ppf_index.npz, model_meta.json, grasp_def.json).
- Reuses `step_parser.py`. Adds model-status UI to the Part Recognition tab. numpy/scipy/open3d/trimesh only (no torch).
- Validatable NOW against real STEP files (BT225L24/L28/L13/L22, delrin). This is the entire REFERENCE side of the recognition stack — ~30–40% of the work — buildable before the camera ships. The scene side (matching live clouds) consumes these models when the camera arrives.
- **STATUS: PENDING — confirm run/results.**

**(b) LIGHTWEIGHT SYNTHETIC SCENE GENERATOR + BENCHMARK HARNESS — runs on current hardware (CPU/Open3D), no camera/GPU-sim.** Build prompt authored. Creates `synthetic_scene_gen.py` (scatter CAD model clouds in a synthetic bin, single-viewpoint occlusion via hidden-point-removal, realistic sensor noise/dropout/confidence approximating the MotionCam) + `recognition_benchmark.py` (pluggable `recognition_fn` interface so own-stack / FoundationPose / Locator all score identically against ground truth: identity accuracy, pose error mm/deg, per-part confusion).
- Honest caveat (must be maintained): synthetic data validates CORRECTNESS, not real-world ROBUSTNESS. Don't over-tune to synthetic noise.
- **STATUS: PENDING run/confirm.**

## 3. SIMULATION — ISAAC SIM HARDWARE-BLOCKED, LIGHTWEIGHT SYNTHETIC IS THE NEAR-TERM PATH

**DECISION: Full Isaac Sim is DEFERRED — gated on acquiring RTX hardware (workstation or cloud GPU) AND the Estun URDF.**

**Hardware findings (definitive):**
- Full Isaac Sim requires an **x86 workstation with a real RTX GPU** (RTX 4070/4080/4090-class, 8GB+ VRAM ideally 16GB+, 32GB+ RAM, ~50GB disk). RTX is non-negotiable (Omniverse renderer needs RT cores).
- User's laptop (DESKTOP-S2CF6QM): 11th-gen i7-11800H, **NVIDIA T1200 Laptop GPU 4GB (NOT RTX-class)**, 16GB RAM → does NOT qualify (T1200 is Turing-workstation, no RTX feature set; RAM is half the minimum).
- **Jetson AGX Orin CANNOT run Isaac Sim** either — it's ARM64, not an Isaac Sim target platform (Isaac Sim has no ARM build). The Orin is the DEPLOYMENT/runtime target, not a sim host.
- Isaac Sim cannot be "uploaded here" — it's a GPU-bound interactive application; the Claude sandbox is CPU-only and cannot run or display it. Claude can write Isaac Sim Python scripts; the user runs them on a GPU machine and reports back.

**Near-term simulation value** is met by the **lightweight synthetic scene generation** (item 2b above) — runs on existing hardware, gives ground-truth-labeled scenes for developing/benchmarking the recognition stack. Full Isaac Sim's unique value (physics-accurate grasping, rendered full sense-plan-act loop) becomes relevant LATER, closer to having the real robot.

**RTX procurement** is framed as a planned purchase gated to the phase where full sim earns its keep — NOT a blocker on current progress. Cloud-GPU rental (NVIDIA/AWS/Azure RTX/L40/A40) is the low-risk way to start before buying a workstation.

## 4. PROGRAMMING BY DEMONSTRATION (PBD) — MAJOR AUTONOMY KEYSTONE — BUILT THIS SESSION

**DECISION: Build the PBD layer — the concrete realization of "the robot generates its own tasks from human intent."** Input = VIDEO + VOICE together; backend = API-AGNOSTIC (pluggable; API now, local on-Jetson model later); output = DRAFT program into the existing program library with placeholder poses (resolved later by the recognition stack).

**CRITICAL USER CONSTRAINT (honored throughout):** *"We don't want to be training Claude, we only want to be training our own model, this is proprietary."* Clarified and architected: calling an API to INTERPRET a demonstration does NOT train the API provider's model. The learning store builds NeuRobots's OWN proprietary dataset (local only, `/opt/cobot/demonstrations/`) to train NeuRobots's OWN model later via distillation (offline GPU training → deploy to Jetson → shift the pluggable backend from API to local). The API is a disposable interpreter that is never trained and never owns the data. Added zero-data-retention API config + data-provenance tracking + an isolated API backend removable in one config change.

**Honest note on "learning toward on-device":** It is via the dataset→train→deploy cycle (accumulate corpus → periodically fine-tune a small local model offline on a GPU machine → deploy to Jetson), NOT live self-modification on the Jetson. The API is the teacher generating training data for its eventual local replacement.

### PBD — Build Prompts Authored + Delivered This Session

**(a) PBD CORE — full build prompt authored + delivered (with API-data-handling block merged in).** New ROS2 package `src/programming_by_demonstration/`:
- `pbd_node.py` (orchestrator/service), `voice_transcriber.py` (LOCAL Whisper), `understanding_backend.py` (pluggable ABC), `backends/api_backend.py` (isolated, zero-retention) + `backends/local_backend.py` (stub for the future proprietary model) + `backends/retrieval_augment.py` (few-shot retrieval, lightweight similarity), `program_composer.py` (intent → draft using the REAL existing program schema/operation templates — never invents parts/ops; all poses placeholder "awaiting_perception"), `learning_store.py` (captures video+transcript+frames+AI-draft+human-corrected to `/opt/cobot/demonstrations/{demo_id}/`, SQLite index, training-ready export), `schema.py` (StructuredIntent + ProgramDraft).
- Dashboard "Program from Demonstration" entry point + review-&-correct view (human-corrected.json) + drafts flagged "poses pending perception". `/api/pbd/*` endpoints. systemd `roboai-pbd`.
- API data handling: zero-data-retention header, data-provenance in backend_used.json, learning store local-only, API receives only the current demonstration (never the accumulated dataset), API backend fully isolated/removable in one config change.
- Honest boundary: generated programs are DRAFTS with placeholder poses — NOT executable until the recognition stack (MotionCam) resolves poses AND the robot arrives. What's verifiable NOW: correct understanding + grounded draft generation.
- **STATUS: PENDING run/confirm.**

**(b) PBD DEEPER SCENE EXTRACTION — extension prompt authored.** Extends the PBD package (does NOT duplicate). Richer video frame sampling (key moments, ordered + timestamped); FUSED video+narration understanding (video shows, voice explains, AI combines, per-element source/confidence); extended StructuredIntent "scene" section (objects grounded to library, locations, spatial_summary) — v1 CORE only (objects/sequence/locations, no metric poses); review UI "Scene Understanding" section; learning store captures scene + corrections. Honest boundary: video gives semantic/sequence/relationships; metric precision is awaiting_perception (MotionCam later).
- **STATUS: PENDING run/confirm.**

**(c) PBD LIVE CAMERA CAPTURE — prompt authored.** The wizard had no recording controls. Added live in-browser camera+mic recording (getUserMedia rear camera facingMode 'environment' + audio, MediaRecorder, one combined clip, Start/Stop, preview, camera switch) feeding the existing /api/pbd/upload. Upload fallback retained as secondary.
- **BLOCKER FOUND + RESOLVED:** getUserMedia requires a SECURE CONTEXT (HTTPS/localhost) — blocked on plain HTTP over the network. User confirmed the block ("secure context required... getUserMedia not available"). User wants fluid auto-camera-mode, not uploads. Solution = serve the dashboard over HTTPS (see §5). Honest: there is NO frontend workaround for the secure-context rule — HTTPS is the only fix.
- **STATUS: PENDING verify live camera works in the wizard over HTTPS.**

## 5. HTTPS ENABLEMENT (to unblock camera) — DEPLOYED

**Prompt authored + deployed.** Self-signed cert (`scripts/generate_dashboard_cert.sh`, openssl, CN=192.168.1.246 + subjectAltName IP, 10yr, `/opt/cobot/certs/`), uvicorn ssl-certfile/keyfile, keep port 8080, fallback to HTTP if cert missing, WebSocket ws→wss switch (derive from window.location.protocol — prevents mixed-content/Disconnected), PBD wizard auto-enters camera mode on HTTPS.
- **STATUS: HTTPS confirmed working** (dashboard loads at https://192.168.1.246:8080, "Not secure" = expected self-signed warning, Connected, wss working, E-STOP visible).
- One-time self-signed cert acceptance per device (Chrome: Advanced→Proceed). For the kiosk (Fully Kiosk): enable **"Ignore SSL Errors" / "Accept untrusted certificates"** in Advanced Web Settings — the kiosk silently fails on a self-signed cert without it (unlike Chrome which warns + lets you proceed). Kiosk Start URL is now https://192.168.1.246:8080/ with camera/video-capture toggles on.
- **PENDING:** confirm kiosk reaches HTTPS after enabling Ignore-SSL; verify camera works in the PBD wizard over HTTPS.

## 6. DASHBOARD — THE TABLET RIGHT-EDGE CUTOFF SAGA (RESOLVED) + RELATED FIXES

### 6a. Deterministic deploy path (CRITICAL — now canonical, must never be re-derived)
The dashboard frontend is a **Vite/React app**. The single source of confusion behind repeated "fix did nothing" episodes was not knowing the served artifact vs the edited source. CANONICAL DEPLOY PATH:
```
EDIT   src/cobot_dashboard/frontend/src/...        # React source
BUILD  cd src/cobot_dashboard/frontend && npm run build
        # vite writes DIRECTLY to ../mock_server/static/ (vite.config.js outDir).
        # static/ is gitignored — pure build artifact (this is why it's not in repo zips).
SERVE  roboai-dashboard.service runs cobot_dashboard/dashboard_server.py
        which serves mock_server/static/ UNCONDITIONALLY
        (_STATIC_DIR = parent/"mock_server"/"static"; outDir == _STATIC_DIR — confirmed match).
        (mock_server/server.py is a fallback NOT used by the running service.)
RESTART sudo systemctl restart roboai-dashboard    # ONLY if Python changed.
        # Pure frontend rebuilds are picked up on next page load (index.html is no-cache).
VERIFY curl -s http://localhost:8080/ | grep -oE 'index-[A-Za-z0-9_]+\.js'
        → must match the just-built filename in static/assets/.
```
Confirmed on the Jetson this session: build writes to the same dir the server reads; the network-served JS bytes contained the new code (E-STOP present, byte-equivalent to the built bundle); single dashboard process on :8080; outDir == _STATIC_DIR == /home/teddy/cobot_ws/src/cobot_dashboard/mock_server/static.

### 6b. The right-edge cutoff — TRUE ROOT CAUSE (after many failed rounds)
**Symptom:** On the ONN 11" Android tablet (1920×1200 physical; CSS viewport iw=1338, DPR≈1.38), every tab appeared cut off on the right; E-STOP not visible; bottom also cut off in Chrome.

**Many rounds of fixes did NOTHING** because they all targeted page OVERFLOW — but `body.scrollWidth` ALWAYS equalled `innerWidth` (1338=1338), proving there was NO page overflow. Theories chased: viewport meta tag (was already correct: width=device-width), DPR/CSS-viewport, app-shell width, stale bundle, client cache, service worker, screen-wider-than-viewport (gap was only 1px — killed that theory too).

**THE BREAKTHROUGH came from an enhanced ?debug=1 overlay that measured the ELEMENT's right edge, not body.scrollWidth.** It reported: `iw 1338 · sw 1338 · screenW 1339 · gap 1 · vvW 1338 · scale 1 · topbarRight 1542`. **`topbarRight=1542` vs viewport 1338 — the TopBar flex row was 204px too wide and CLIPPED its right portion (where E-STOP lives).** A flex row clipping its overflow does NOT increase body.scrollWidth — which is exactly why every overflow-targeted fix and every measurement of scrollWidth missed it.

**THE FIX (the real one):** TopBar nav `flex: 1 1 0` + `min-width: 0` + `overflow-x: auto` (lets the nav shrink/scroll its tabs instead of pushing the E-STOP cluster off-screen); right cluster `flexShrink: 0`; TopBar `overflow: hidden`, `max-width: 100%`. **CONFIRMED WORKING** — "That works now." E-STOP visible, TopBar fits.

A flex `flex:1` child without `min-width:0` refuses to shrink below its content size and shoves siblings (the E-STOP cluster) off the edge — and because it's a flex push (not content overflow), scrollWidth stays equal to innerWidth. **This is the signature: edge content clipped while sw=iw → flex child missing min-width:0.**

Foundation fixes also done earlier in the saga (kept): viewport meta `width=device-width, initial-scale=1, viewport-fit=cover`, global `box-sizing: border-box`, `100dvh` (fixed the Chrome bottom cutoff under the dynamic address bar), safe-area insets, `overflow-x: hidden` on root.

**REMAINING:** the same flex-clipping pattern may lurk on other tabs/toolbars/the teach-wizard rows — same fix if found.

### 6c. PROCESS LESSON (re-affirmed, now in a SECOND subsystem)
The right-edge saga is the vision-saga lesson all over again: many "fixes" produced no change because they targeted an assumed cause (overflow) that the actual measurement (sw=iw) disproved. The fix came only after measuring the REAL thing (the element's right edge via the debug overlay). **Diagnose from the actual measurement, not the assumed cause. A proxy metric (body.scrollWidth) that misses the failure mode (flex clipping) will mislead indefinitely.**

### 6d. Other dashboard work this session
- **E-STOP immediate-trigger (SAFETY):** removed the confirm-before-trigger step (dangerous delay). First tap stops immediately. KEPT the release safeguard (release stays deliberate/guarded — green zone required — so the robot can't be accidentally un-stopped). Made the E-STOP button bigger and the nav tabs bigger (touch sizing), preserving the right-edge fix. **HONEST SAFETY NOTE:** the software/dashboard E-STOP depends on the network (~38–564ms WS latency observed) and the browser; it is a SUPPLEMENT to, never a replacement for, a physical hardware E-STOP wired into the robot safety circuit. (The manual confirms the hardware E-STOP triggers Stop Category 1.)
- **Descend/Lift derived-position fix:** "Descend to part" (z+0) and "Lift part" (z+100) made DERIVED steps (relative_to:"pick", z_offset) — no Teach button, not counted untaught. CONFIRMED deployed (screenshot showed "from prev, z+0mm/z+100mm" — also proved the deploy chain works for some builds).
- **Within-session teach position reuse** (Reuse/Re-teach choice; reusedSteps in ProgramWizard state; hollow-blue 'reused' dots) + follow-up to add duplicate position keys to forward-flow ops (Machine Tend return-home reusing taught_home). PENDING confirm.
- **Machine Tending React crash** after approach-height page — diagnostic-first prompt (find actual cause, audit wizard paths, add navigation guard). PENDING confirm.
- **Remove three wizard operations fully** (UI + step-generation): "Pick and Inspect", "Inspect & Verify", "Scan & Identify". KEEP the Quality Inspection TAB, inspection_pipeline, recognition pipelines — wizard-scope removal only. Consistent with stripping the wizard as autonomy supersedes manual programming. CONFIRMED done.
- **Teach pendant TRUE fullscreen**, label-clipping fix, **PWA manifest** (display:standalone, landscape, dark #0A0A0B) for tablet home-screen install. Note: "Add to Home Screen" only launches standalone (no Chrome bar) if the manifest declares display:standalone — otherwise it's a plain shortcut with the address bar. PENDING assorted confirms.
- **MotionCam visualization UI** in Cameras & LiDAR tab (Live Feed color + 3D cloud; Scene accumulated workspace model with Start/Stop/Clear/Save; recognized-parts overlay with 3D OBB + labels + 6DoF axis triad + pick-direction arrows; mock-data toggle so it's testable before the camera). Backend WS /ws/motioncam_cloud, /ws/motioncam_recognition, /api/motioncam/*. Configurable phoxi_camera topic names (TBD with Photoneo). Honest: recognized-parts overlay is empty with real data until recognition is wired to the MotionCam (later build). PENDING confirm.

## 7. TABLET / KIOSK SETUP NOTES
- ONN 11" tablet, Android, ~1920×1200 physical, CSS viewport ~1338px, DPR≈1.38.
- Fully Kiosk Browser loads a URL (NOT an installed app) — set Start URL to https://192.168.1.246:8080/. Enable Ignore-SSL for the self-signed cert.
- Termux on the tablet can SSH to the Jetson: `pkg install openssh` then `ssh teddy@192.168.1.246`. Termux: Volume-Down = Ctrl, Volume-Up = Esc/Tab/arrows row.
- Tablet/laptop responsive target: laptops + tablets are the real targets, phone is nice-to-have. Adaptive touch sizing (touch on tablet/phone, normal on laptop). Build 1 (foundation: viewport/box-sizing/overflow/dvh) done; Build 2 (full responsive system: nav collapse, panel stacking, breakpoints) was scoped but the right-edge fix (flex min-width:0) resolved the immediate blocker.

## 8. RESPONSIVE / COMMERCIALIZATION ARCHITECTURE NOTE
The dashboard is a web app; the responsive work (foundation + responsive system) is required regardless of distribution. Commercialization will likely wrap it as a **hybrid native app** (Electron/Capacitor-style) for installable distribution + a controlled webview (which removes browser-quirk bugs like the viewport/flex issues AND makes HTTPS/camera native), keeping the single web codebase — NOT a full native rebuild (overkill for a network-connected control dashboard). PWA (Path 1) keeps the web responsive problem as-is; hybrid (Path 2) is the sweet spot; full native (Path 3) is overkill.

## 9. AR / AUTONOMY-STEPPING-STONE CONCLUSION
AR was considered as an autonomy stepping stone. **Conclusion:** the FUNCTION (human-assisted verification/correction/bootstrap feeding the autonomous perception + task-gen stack, as a staged "human does less each rung" bridge) is the valuable part and should be built into the DASHBOARD first (cheaper, on-path, no frame-registration headache). The dashboard 3D scene view + overlays + correction mechanisms already deliver every functional rung. AR itself is DEFERRED as a later spatial-experience front-end, gated on proving the value in 2D and justifying the frame-registration engineering. **Video-demonstration-to-program (PBD) is the stronger, more autonomy-aligned path and is the one being built.** AR's unique value over the dashboard is only spatial intuition (overlays registered onto the real cell), achieved at much higher engineering cost.

## 10. 3D ROBOT VIEW — MESH LOADING + URDF-FROM-MANUAL

### 10a. Mesh loading (in progress)
3D View loaded the URDF structure (8 links) but rendered NO robot — overlay: "8 links · 0 MESHES · bbox 0.00×0.00×0.00 m". Joint angles J1–J6 display/update. Root cause = meshes not loaded/served (NOT a placeholder-only URDF as first theorized — the user HAS the meshes).
- **KEY FACT:** user HAS the mesh files — 8 per-link files in BOTH GLB and STL format (one per link).
- **DECISION:** use GLB (baked colors/materials → robot looks correct, not gray); STL as fallback.
- Prompt authored: place 8 GLBs in the served static dir (fetchable over HTTPS); fix URDF mesh paths; CRITICAL — route .glb through THREE.GLTFLoader via the urdf-loader mesh-load callback (standard urdf-loader defaults to STL/DAE and won't load GLB without this); STL fallback via STLLoader; primitive box last resort; auto-fit camera to bbox. Verify overlay → "8 links · 8 meshes · bbox [non-zero]" and joint sliders articulate. PENDING run/verify.
- INSIGHT: having meshes + an 8-link URDF means the REAL robot can be VISUALIZED now; the still-pending Estun dependency is precise KINEMATICS (DH params, joint limits) for accurate MOTION PLANNING, not visualization.

### 10b. URDF FROM THE ESTUN MANUAL — manual obtained + analyzed
**The actual manual was uploaded:** "Estun_Manual.pdf" = Codroid (Estun) **S-Series Gen2 Hardware User Manual (V1.0, 2026/2/24)**, 57 pages, Chinese. (Note: the project's document_pdf.pdf is the COMPANY STRATEGY doc, not the manual — the manual was separate.) It covers the full S-Series Gen2 line (S3-60, S5-90, S7-80, **S10-140**, S12-125, S16-98, S20-180) and S-CC control cabinets.

**Extracted S10-140 (Eco) values usable for a URDF:**
- 6 revolute joints (J1–J6). 
- **Joint POSITION limits (EXACT):** J1,J2,J4,J5,J6 = ±360°; **J3 = ±160°**.
- **Joint VELOCITY (EXACT, Eco):** J1/2/3 = 150°/s; J4/5/6 = 180°/s.
- Reach (arm span) **1400mm**; self-weight **39kg**; payload **10kg**; repeatability ±0.03mm.
- Flange **ISO 9409-1-50-4-M6**; flange comms 2DI/2DO/24VDC/RS485.
- Mounting: any angle (non-vertical requires setting the mount angle in software).
- APPROXIMATE link dimensions from **Figure 4-9 (S10-140 installation-dimension drawing, p.34):** two major arm segments ~**700mm** each, offsets ~175mm and ~221mm, base region ~186mm, base diameter ~Ø198.5, mounting ~209.3.
- Control cabinet for S10-140 = **CC10-A** (typical 0.35kW, peak 2.5kW; AC 100–240V or DC 48V; MODBUS TCP/RS485/TCP-IP/CAN/EtherCAT standard, ProfiNET/EtherNetIP optional; DI/DO PNP/NPN 16ch, AI/AO 4ch each 12-bit; 4 safety E-stop inputs + 1 output; remote script + API for secondary development).
- Eco models have **no torque sensors** (Pro models do: torque-sensor accuracy <2% F.S — but the ordered robot is the S10-140 **ECO**, motor-current collision detection only). Stop categories: Cat 0/1/2; E-STOP = Stop Category 1.
- M8 flange end interface: pins RS485-/RS485+/TO0/TO1/PWR(0/12/24V)/TI0/TI1/GND.
- Min terminal config: tablet 1920×1200+, 10.1"+, CPU 2.0GHz×4+, 6GB+ RAM, 128GB+, gigabit NIC, 1GB+ VRAM, LAN/Wi-Fi.

**HONEST LIMITATION:** the manual provides OUTLINE/INSTALLATION dimensions + EXACT joint limits/speeds, but does **NOT** contain a full **DH parameter table** or precise joint-axis offsets/twists/zero-frame definitions. So a manual-derived URDF is **PROVISIONAL** — good for visualization, workspace approximation, and motion-planning prep; NOT a substitute for Estun's official URDF for precise collision-accurate planning. The small perpendicular joint offsets must be approximated from typical cobot geometry. Treat as provisional until validated against the real robot or replaced by Estun's official URDF.

**Prompt authored:** build `config/estun_s10_140_provisional.urdf` from the manual values (exact joint limits/speeds; approximate link lengths from Fig 4-9; typical 6-DOF cobot layout to total ~1400mm reach) + attach the 8 per-link GLB meshes via the GLTFLoader callback; clear "PROVISIONAL — manual-derived" header comment; point the 3D View at it. Verify 8 links · 8 meshes · ~1.4m bbox, articulating within correct limits (J3 ±160°). PENDING run/verify.

## 11. ESTUN / HARDWARE STATUS (updated)
- Estun **S10-140 ECO** (10kg payload, 1400mm reach, 39kg, no torque sensors): software ready, awaiting arrival. Arrival-day 90min checklist in MD §earlier (subnet conflict Jetson 192.168.1.x vs Estun default 192.168.101.100; driver IP; scripts/test_estun_connection.py; joint direction; first run 15%).
- Control cabinet: **CC10-A**.
- **PENDING (BLOCKING precise planning):** authoritative URDF / DH parameters from Estun for MoveIt2 collision-aware planning AND Isaac Sim. Manual-derived provisional URDF (§10b) is plan B for visualization. Request official URDF/DH from Estun before ship.
- Other pending hardware: gripper selection (1–3wk lead, Custom Gripper wizard ready), AprilTag 100mm tag36h11 board (~$30, hand-eye calibration), MotionCam S+ order (critical path).

## 12. CONSOLIDATED PENDING ITEMS (June 15, 2026)

| Item | Priority | Status |
|------|----------|--------|
| Email Photoneo: ROS2 Humble driver on Orin ARM64/JetPack6; Locator licensing/host; eval unit | CRITICAL | #1 technical unknown for the camera path |
| Order MotionCam-3D Color S+ (longest lead, critical path to autonomy) | CRITICAL | Decided; place order |
| Request official URDF / DH params from Estun | BLOCKING precise planning | Manual gives only outline dims; provisional URDF is plan B |
| Run/verify CAD→model pipeline build | HIGH | Prompt authored; fully testable now vs real STEPs |
| Run/verify synthetic scene generator + benchmark | HIGH | Prompt authored; runs on current hardware |
| Run/verify PBD core + scene-extension + live-capture | HIGH | Prompts authored; verify over HTTPS |
| Verify kiosk reaches HTTPS (enable Ignore-SSL); camera in PBD wizard | HIGH | HTTPS confirmed in Chrome; kiosk pending |
| Run/verify 3D robot GLB mesh loading (→8 meshes, non-zero bbox) | HIGH | Prompt authored |
| Run/verify provisional URDF from manual (articulates within limits) | MEDIUM | Prompt authored; flagged provisional |
| Order gripper (1–3wk lead) | MEDIUM | Custom Gripper wizard ready |
| Order AprilTag 100mm tag36h11 board (~$30) | MEDIUM | Hand-eye calibration |
| Audit other tabs/toolbars for the flex-clipping pattern (sw=iw + edge clipped) | MEDIUM | Same fix: flex:1 1 0 + min-width:0 |
| Remove debug overlays (?debug=1) before customer-facing builds | LOW | Diagnostic scaffolding |
| Confirm assorted dashboard builds deployed (teach reuse, machine-tend crash, fullscreen, PWA) | MEDIUM | Several PENDING confirm |
| RTX workstation / cloud GPU for full Isaac Sim | DEFERRED | Gated to when full sim earns its keep |
| FoundationPose volume-bias fix (silhouette normalization) | DEFERRED | Use as one component; eval vs own stack |

## 13. PROCESS LESSONS — CONSOLIDATED (must govern all future sessions)
1. **Diagnose from live logs, actual code, and actual measurements — NEVER from documentation or assumptions.** (Vision saga + tablet-cutoff saga both proved this, in two different subsystems.)
2. **Identical output across changes = the change isn't running or isn't on the failure path.** Stop changing things; verify what actually executes.
3. **Verify the SERVED artifact matches the edited source** (the served bundle hash, not the source file). The Vite deploy path (§6a) is now canonical so this premise doesn't recur.
4. **A proxy metric that misses the failure mode will mislead indefinitely.** body.scrollWidth=innerWidth hid a flex-clipping overflow for many rounds; measuring the element's actual right edge cracked it instantly. Measure the real thing.
5. **One concrete fix per problem, grounded in observed behavior** — not a cascade of theory-driven fixes.
6. **Honest scoping over optimistic promises** — state what's buildable/verifiable NOW vs gated on hardware (camera, RTX GPU, robot, URDF), and say so plainly.

---

*Last updated: June 15, 2026*
*v15 covers everything in v14 (unchanged, nothing removed) PLUS the June 15 session: the AUTONOMY NORTH-STAR elevated to the top organizing principle; MotionCam-3D Color S+ evaluated and ADOPTED wrist-mounted (reverses §274), chosen for PSL continuous-motion perception as the prerequisite to autonomy; the proprietary point-cloud-first recognition stack DECIDED (PPF+ICP, built in-house, validated vs Locator as ground truth) with the CAD→model pipeline + synthetic-scene-generator + benchmark-harness build prompts authored as the pre-camera headstart; full Isaac Sim DEFERRED (no RTX hardware — T1200 laptop and ARM Jetson both disqualified; lightweight synthetic generation is the near-term sim path); the Programming-by-Demonstration autonomy layer BUILT (API-agnostic understanding backend, local Whisper, learning store building NeuRobots's OWN proprietary distillation dataset — never training the API — few-shot retrieval, draft-program output with placeholder poses; core + deeper-scene-extraction + live-camera-capture prompts authored); HTTPS enabled on the dashboard (self-signed cert, ws→wss) to unblock browser camera access; the multi-round tablet RIGHT-EDGE CUTOFF saga RESOLVED — true root cause was the TopBar flex row laying out 204px wider than the viewport and CLIPPING its right portion (topbarRight 1542 vs iw 1338) which body.scrollWidth never captured (sw always =iw), fixed with flex:1 1 0 + min-width:0 on the nav so it shrinks/scrolls instead of pushing the E-STOP cluster off-screen; the canonical Vite deploy path documented (edit src → npm run build → vite writes to mock_server/static → served unconditionally → verify bundle hash); E-STOP made immediate-trigger (no confirm) with the release safeguard kept, plus the honest note that a software E-STOP supplements but never replaces a hardware E-STOP; the Estun S-Series Gen2 hardware manual obtained and analyzed (exact joint limits ±360°/J3 ±160°, velocities 150/180°/s, 1400mm reach, CC10-A cabinet, ECO has no torque sensors) yielding a PROVISIONAL manual-derived URDF (outline dims only, no DH table — for visualization/planning-prep, not precise planning; request Estun's official URDF); the 3D-view GLB-mesh-loading fix (route .glb through GLTFLoader via the urdf-loader callback); the AR conclusion (build the human-assist autonomy-bridge FUNCTION into the dashboard first, defer AR as a later spatial front-end); the commercialization note (hybrid web-in-native-shell, not a native rebuild); and the consolidated PROCESS LESSONS re-affirmed across a second subsystem: diagnose from actual measurements, identical output means the change isn't running, verify the served artifact, and a proxy metric that misses the failure mode misleads indefinitely.*

---
---

<!-- v46-content-end -->
