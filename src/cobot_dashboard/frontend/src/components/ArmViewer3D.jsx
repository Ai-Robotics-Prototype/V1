import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment'
import URDFLoader from 'urdf-loader'
import * as THREE from 'three'
import { useStore } from '../store/useStore'
import { CollisionScene3D, CollisionBanner } from './CollisionOverlay'
import JointJogPanel from './JointJogPanel'
import IKGizmo from './IKGizmo'
import { startHomeMove } from '../lib/homeAnim'
import { startJointAnimation } from '../lib/jointAnim'

// ──────────────────────────────────────────────────────────────────
// ArmViewer3D — Estun S10-140 ARTICULATED view.
//
// Loads /robot/urdf (the provisional URDF derived from the technical-
// drawing dimensions + manual limits) and attaches per-link GLB meshes
// via the urdf-loader mesh callback → three.js GLTFLoader. Animates
// the six revolute joints from the Zustand store's joints.positions
// (radians, fed by the dashboard's 25 Hz /ws/state broadcast) using a
// 25 Hz lerp toward target at factor 0.3.
//
// The per-link GLBs at /robot/links/*.glb are decimated so the tablet
// GPU holds them without OOM. DRACOLoader is registered (shared, cheap)
// — the current base + shoulder GLBs are uncompressed, but registration
// is harmless and lets future Draco-compressed exports drop in.
//
// Public API (unchanged from prior builds):
//   - forwardRef → setCameraPreset(name)
//   - props: { joints, children, overlay }
//   - OrbitControls + Front/Side/Top/Iso presets
//   - Joint readout (degrees) top-right
//   - Status pill bottom-right with phase telemetry
//   - Custom-gripper GLB overlay parented to the URDF flange
// ──────────────────────────────────────────────────────────────────

const JOINT_NAMES  = ['joint_1', 'joint_2', 'joint_3', 'joint_4', 'joint_5', 'joint_6']
const JOINT_COLORS = ['#3B82F6', '#16A34A', '#CA8A04', '#DC2626', '#9333EA', '#F97316']

// Twin telemetry interpolation — tunable render-lag buffer. Each new
// /ws/state joint frame is appended to a small ring buffer with its
// server timestamp (msg.t). The RAF loop plays back frames delayed by
// RENDER_LAG_MS from the newest received frame, linearly interpolating
// each joint angle between the two samples straddling that playback
// time. This turns jitter (17 Hz uneven source × 25 Hz broadcast) into
// visually smooth motion regardless of network cadence.
//
// Tuning guidance (measured against the Estun v2.3 stream):
//   source rate ≈ 17 Hz; gaps p50=50 ms · p95=100 ms · p99=152 ms
//   render-lag must exceed p99 gap or the twin freezes on late frames
//   200 ms was chosen with ~48 ms of headroom above p99
//     too low → twin freezes/surges when a frame is late (slow surge)
//     too high → twin feels laggy behind the physical arm (motion tail)
//   bufCap ≈ 8 samples ≈ 470 ms of history at 17 Hz — enough to
//   bracket a renderT slipped up to ~300 ms behind newest.
//
// Both values are OVERRIDABLE at runtime via URL query params so a
// browser reload is enough to A/B-test values (no rebuild). Examples:
//   https://…:8080/?rl=180              — 180 ms render-lag
//   https://…:8080/?rl=250&bc=10        — 250 ms lag, 10-sample buffer
// Params are parsed once at module load; unset params keep defaults.
const _urlParams = (typeof window !== 'undefined')
  ? new URLSearchParams(window.location.search)
  : new URLSearchParams()
function _urlInt(key, alt, fallback, min, max) {
  const raw = _urlParams.get(key) ?? _urlParams.get(alt)
  if (raw == null || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}
const RENDER_LAG_MS  = _urlInt('rl', 'renderLag', 200, 0, 1000)
const SAMPLE_BUF_CAP = _urlInt('bc', 'bufCap',      8, 2,   64)
if (typeof console !== 'undefined') {
  console.log(`[twin] RENDER_LAG_MS=${RENDER_LAG_MS} SAMPLE_BUF_CAP=${SAMPLE_BUF_CAP}`)
}

// URDF axis convention gate. The URDF variants we serve at /robot/urdf
// don't all agree: the calibrated-CS full twin is Y-up (native three.js
// frame, NO tilt), while the earlier hybrid/partial URDFs were Z-up
// (REP-103, tilt -90° into three.js). Flip this one constant when
// swapping the served URDF between conventions. Applied to both
// ArmViewer3D and StandaloneRobot for parity.
const URDF_UP_AXIS = 'Y'  // 'Y' → no tilt · 'Z' → rotation.x = -π/2
const URDF_ROT_X   = URDF_UP_AXIS === 'Y' ? 0 : -Math.PI / 2

// Defaults used before the URDF reports its bbox; auto-fit overrides
// these on first load. Sized for a ~1.4 m arm in scene-Y after the
// Z-up → Y-up tilt the URDFLoader applies.
const DEFAULT_PRESETS = {
  front: [0,   0.8, 3.0],
  side:  [3.0, 0.8, 0  ],
  top:   [0,   4.0, 0.01],
  iso:   [2.5, 1.6, 2.5],
}
const DEFAULT_ORBIT_TARGET = [0, 0.7, 0]

const ROBOT_MATERIAL = new THREE.MeshPhongMaterial({
  color: 0xC0C8D4, specular: 0x4a4a4a, shininess: 30,
})

// Shared Draco decoder — registered once for the app lifetime. Twin
// GLBs are now Draco-compressed (see models/robots/estun_s10-140/links/;
// uncompressed originals live under links.uncompressed/), so the decoder
// is now hot.
const DRACO = new DRACOLoader()
DRACO.setDecoderPath('/draco/')

// Memoize GLB byte responses by URL across viewer mounts. GLTFLoader
// reads through FileLoader which honors THREE.Cache when enabled, so a
// Program → 3D View → Program round-trip skips the re-fetch (browser
// HTTP cache still gates the very first hit).
THREE.Cache.enabled = true

// SceneEnvironment — builds a small PMREM environment map from
// three's RoomEnvironment once, assigns it to scene.environment so
// GLB MeshStandardMaterial samples proper reflections instead of
// rendering near-black. Mount inside <Canvas>.
function SceneEnvironment() {
  const { scene, gl } = useThree()
  useEffect(() => {
    if (!gl || !scene) return undefined
    const pmrem = new THREE.PMREMGenerator(gl)
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
    const prev  = scene.environment
    scene.environment = envRT.texture
    return () => {
      scene.environment = prev
      envRT.dispose()
      pmrem.dispose()
    }
  }, [gl, scene])
  return null
}

// ──────────────────────────────────────────────────────────────────
// LidarCloudInScene — live point-cloud overlay rendered INSIDE the
// arm Canvas so the operator sees the same world the robot is in.
//
// History: before this was added the 3D view subscribed to nothing —
// only the URDF and (more recently) the collision boxes were drawn,
// so operators saw an empty room. The Cameras & LiDAR tab uses its
// own cloud renderer in LidarPanel.jsx; this is a deliberate parallel
// implementation, NOT a shared import. Constants / mapping mirror
// LidarPanel exactly so the two views read identically:
//
//   - subscribes to /ws/lidar (same wire format)
//   - LiDAR (x,y,z) → Three (x, z, -y), handedness-preserving,
//     matching LidarPanel.lidarToThree exactly. The -y negation
//     prevents the left/right mirror that a bare (x, z, y) swap
//     produced (right-handed ROS → left-handed Three = reflection).
//   - same height ramp, same `size: 0.005`, same sizeAttenuation
//
// URDF gets its own Z-up→Y-up via `urdf.rotation.x = -π/2` (see
// below). Both end up in the same visual frame.
// ──────────────────────────────────────────────────────────────────
const LIDAR_MAX_PTS = 131072
const LIDAR_HOST     = typeof window !== 'undefined' ? window.location.host : 'localhost:8080'
const LIDAR_WS_PROTO = typeof window !== 'undefined'
  && window.location.protocol === 'https:' ? 'wss' : 'ws'

function lidarHeightColor(z) {
  if (z < 0.1) return new THREE.Color(0.15, 0.35, 0.85)
  if (z < 0.5) return new THREE.Color(0.15, 0.75, 0.50)
  if (z < 1.0) return new THREE.Color(0.85, 0.75, 0.10)
  return         new THREE.Color(0.85, 0.25, 0.15)
}

// BaselineCloudInScene — render the ACTIVE cell's SAVED baseline cloud
// (the wizard-captured PCD), NOT the live LiDAR feed. The robot view
// is intended to show the world the robot was commissioned in; live
// LiDAR overlays belong on the Cameras & LiDAR tab where LidarPanel
// already runs that path. Falls back to a no-baseline inline notice
// rendered via the parent's HTML overlay slot.
//
// Source of truth for the active cell: useStore.activeCellId, written
// by Configure on Activate and hydrated once at app boot from
// /api/cells/active. We then GET /api/cells/{id}/baseline/cloud — same
// JSON shape the WS broadcast speaks ({n, p:[x,y,z,...]}). We
// voxel-downsample server-side so the SPA stays smooth.
//
// Replaces the previous local 4 s poll, which caused two failure
// modes: (a) an initial-mount flash of "No active cell" before the
// first fetch landed, and (b) up to a 4 s lag after Configure
// activated a different cell.
function BaselineCloudInScene({ onStatusChange }) {
  const geoRef    = useRef(new THREE.BufferGeometry())
  const posBufRef = useRef(new Float32Array(LIDAR_MAX_PTS * 3))
  const colBufRef = useRef(new Float32Array(LIDAR_MAX_PTS * 3))
  const [cloud,  setCloud]  = useState(null)  // {n, p:[...]} or null

  // Subscribe to the shared store. Render reactively when Configure
  // activates a different cell. `activeCellHydrated` distinguishes
  // "haven't asked the backend yet" (don't show "No active cell")
  // from "backend confirmed there is no active cell" (do show it).
  const activeCellId       = useStore((s) => s.activeCellId)
  const activeCell         = useStore((s) => s.activeCell)
  const activeCellHydrated = useStore((s) => s.activeCellHydrated)
  const hydrateActiveCell  = useStore((s) => s.hydrateActiveCell)

  // Belt-and-suspenders: App.jsx hydrates at boot, but if this
  // component mounts before that finished (or the boot fetch failed),
  // re-trigger so we don't render stale.
  useEffect(() => {
    if (!activeCellHydrated) hydrateActiveCell()
  }, [activeCellHydrated, hydrateActiveCell])

  // Re-fetch the cell's profile + baseline whenever the active id
  // changes. We don't trust the cached `activeCell.baseline_captured`
  // alone because Configure's local refresh may lag behind a fresh
  // capture; ask the baseline endpoint directly — its 404 vs 200
  // tells us authoritatively.
  useEffect(() => {
    if (!activeCellHydrated) {
      onStatusChange?.({ cell_id: null, n: 0,
                         hydrated: false, message: 'loading' })
      return
    }
    if (!activeCellId) {
      setCloud(null)
      onStatusChange?.({ cell_id: null, n: 0,
                         hydrated: true, has_baseline: false,
                         message: 'no_active_cell' })
      return
    }
    const cellName = activeCell?.name || ''
    let cancelled = false
    onStatusChange?.({ cell_id: activeCellId, name: cellName,
                       hydrated: true, n: 0, message: 'loading_baseline' })
    // Fetch as many points as the SPA buffer can hold so the saved
    // baseline reads as DENSE as the live LidarPanel cloud. The
    // server returns the cloud voxel-downsampled to fit under this
    // cap; 131 072 is LIDAR_MAX_PTS, the size of the GPU buffer we
    // populate below — no point requesting more.
    fetch(`/api/cells/${encodeURIComponent(activeCellId)}/baseline/cloud?max_points=${LIDAR_MAX_PTS}`)
      .then(async (r) => {
        if (cancelled) return
        if (r.status === 404) {
          // Authoritative: active cell has no baseline file yet.
          setCloud(null)
          onStatusChange?.({ cell_id: activeCellId, name: cellName,
                             hydrated: true, has_baseline: false,
                             n: 0, message: 'no_baseline' })
          return
        }
        if (!r.ok) {
          setCloud(null)
          onStatusChange?.({ cell_id: activeCellId, name: cellName,
                             hydrated: true, has_baseline: true,
                             n: 0, message: 'load_failed' })
          return
        }
        const j = await r.json()
        if (cancelled) return
        if (typeof j?.n === 'number' && Array.isArray(j?.p)) {
          setCloud(j)
          onStatusChange?.({
            cell_id: activeCellId, name: cellName,
            hydrated: true, has_baseline: true, n: j.n,
            captured_at: j.captured_at,
            total_in_file: j.total_in_file,
          })
        }
      })
      .catch(() => {
        if (cancelled) return
        setCloud(null)
        onStatusChange?.({ cell_id: activeCellId, name: cellName,
                           hydrated: true, has_baseline: true,
                           n: 0, message: 'load_failed' })
      })
    return () => { cancelled = true }
  }, [activeCellId, activeCell?.name, activeCellHydrated, onStatusChange])

  // Build the buffer once when the cloud lands. The baseline is
  // static — no useFrame loop needed.
  useEffect(() => {
    const g = geoRef.current
    g.setAttribute('position', new THREE.BufferAttribute(posBufRef.current, 3))
    g.setAttribute('color',    new THREE.BufferAttribute(colBufRef.current, 3))
    if (!cloud || !Array.isArray(cloud.p) || !cloud.n) {
      g.setDrawRange(0, 0)
      return
    }
    const positions = posBufRef.current
    const colors    = colBufRef.current
    const p = cloud.p
    const n = Math.min(cloud.n, LIDAR_MAX_PTS)
    for (let i = 0; i < n; i++) {
      const px = p[i * 3], py = p[i * 3 + 1], pz = p[i * 3 + 2]
      // LiDAR (ROS Z-up) → Three (Y-up): (x, y, z) → (x, z, -y)
      // The -y is essential: a bare (x, z, y) swap is a REFLECTION,
      // not a rotation, and produces a mirrored scene.
      positions[i * 3]     = px
      positions[i * 3 + 1] = pz
      positions[i * 3 + 2] = -py
      const c = lidarHeightColor(pz)
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
    }
    g.setDrawRange(0, n)
    g.attributes.position.needsUpdate = true
    g.attributes.color.needsUpdate    = true
  }, [cloud])

  if (!cloud || !cloud.n) return null
  return (
    <points>
      <primitive object={geoRef.current} attach="geometry" />
      <pointsMaterial
        // 0.012 m world-size dots — matches the dense look of
        // LidarPanel on the Cameras & LiDAR tab. The previous
        // 0.006 was visually correct for raw live LiDAR at 30 Hz
        // (each frame adds points, the eye integrates), but for a
        // static, downsampled baseline the cloud needs bigger
        // dots to read as solid.
        size={0.012}
        vertexColors
        sizeAttenuation={true}
        transparent
        opacity={0.95}
        depthWrite={false}
      />
    </points>
  )
}

// Legacy live-LiDAR cloud — kept as exported diagnostics for the
// Cameras & LiDAR tab; not mounted in the robot view.
function LidarCloudInScene() {
  const geoRef    = useRef(new THREE.BufferGeometry())
  const posBufRef = useRef(new Float32Array(LIDAR_MAX_PTS * 3))
  const colBufRef = useRef(new Float32Array(LIDAR_MAX_PTS * 3))
  const pointsRef = useRef(null)

  // Subscribe once. Supports both wire formats the dashboard speaks:
  //   - JSON {p:[x0,y0,z0,...], n}
  //   - binary: uint32 n, followed by float32 xyz·n
  useEffect(() => {
    const url = `${LIDAR_WS_PROTO}://${LIDAR_HOST}/ws/lidar`
    let ws, alive = true
    try { ws = new WebSocket(url) }
    catch { return () => {} }
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (ev) => {
      if (!alive) return
      if (typeof ev.data === 'string') {
        try {
          const j = JSON.parse(ev.data)
          if (Array.isArray(j.p) && typeof j.n === 'number') {
            pointsRef.current = j
          }
        } catch {}
      } else {
        const view = new DataView(ev.data)
        const n = view.getUint32(0, true)
        const floats = new Float32Array(ev.data, 4, n * 3)
        pointsRef.current = { binary: true, floats, n }
      }
    }
    return () => { alive = false; try { ws.close() } catch {} }
  }, [])

  useEffect(() => {
    const g = geoRef.current
    g.setAttribute('position', new THREE.BufferAttribute(posBufRef.current, 3))
    g.setAttribute('color',    new THREE.BufferAttribute(colBufRef.current, 3))
    g.setDrawRange(0, 0)
  }, [])

  useFrame(() => {
    const d = pointsRef.current
    if (!d) return
    const positions = posBufRef.current
    const colors    = colBufRef.current
    let n = 0
    if (d.binary && d.floats) {
      const f = d.floats
      n = Math.min(d.n, LIDAR_MAX_PTS)
      for (let i = 0; i < n; i++) {
        const px = f[i * 3], py = f[i * 3 + 1], pz = f[i * 3 + 2]
        // LiDAR (ROS Z-up) → Three (Y-up): (x, y, z) → (x, z, -y)
        positions[i * 3]     = px
        positions[i * 3 + 1] = pz
        positions[i * 3 + 2] = -py
        const c = lidarHeightColor(pz)
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
      }
    } else if (Array.isArray(d.p) && typeof d.n === 'number') {
      const p = d.p
      n = Math.min(d.n, LIDAR_MAX_PTS)
      for (let i = 0; i < n; i++) {
        const px = p[i * 3], py = p[i * 3 + 1], pz = p[i * 3 + 2]
        positions[i * 3]     = px
        positions[i * 3 + 1] = pz
        positions[i * 3 + 2] = -py
        const c = lidarHeightColor(pz)
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
      }
    } else return

    const g = geoRef.current
    g.setDrawRange(0, n)
    g.attributes.position.needsUpdate = true
    g.attributes.color.needsUpdate    = true
  })

  return (
    <points>
      <primitive object={geoRef.current} attach="geometry" />
      <pointsMaterial
        size={0.006}
        vertexColors
        sizeAttenuation={true}
        transparent
        opacity={0.95}
        depthWrite={false}
      />
    </points>
  )
}

// ──────────────────────────────────────────────────────────────────
// URDFArm — inner Canvas child. Loads the URDF, mounts the per-link
// GLBs, runs the 25 Hz articulation lerp, and emits load telemetry
// up via onStatus so a silent failure can never reappear without a
// visible signal in the status pill.
// ──────────────────────────────────────────────────────────────────
function URDFArm({ urdfUrl, onFlangeReady, onStatus, onLoaded, onDragActive, onDragInfo, onRobotReady }) {
  const groupRef    = useRef(null)
  const robotRef    = useRef(null)
  const targetsRef  = useRef([0, 0, 0, 0, 0, 0])
  const currentRef  = useRef([0, 0, 0, 0, 0, 0])
  // Manual FK-drag override: index in JOINT_NAMES currently being
  // dragged, or -1. The 25 Hz lerp below skips this index so the
  // store target does not fight the pointer.
  const manualJointRef   = useRef(-1)
  const dragStateRef     = useRef(null)
  const dragHandlersRef  = useRef(null)
  // Per-joint manual-jog override for JointJogPanel. When mask[i] is
  // true the store mirror skips joint i, so slider authority holds.
  const manualMaskRef    = useRef([false, false, false, false, false, false])
  // Active Home animation handle (see lib/homeAnim.js). Non-null while
  // the smooth-return is running; slider/IK writes cancel it.
  const homeAnimRef      = useRef(null)
  // Interpolation buffer: last N joint samples with their server-side
  // timestamps (msg.t, ms). RAF loop below reads this to play back
  // twin motion with a fixed RENDER_LAG_MS behind newest.
  //   sampleBufRef.current: [{t, q: [j1..j6]}, ...] oldest → newest
  //   anchorRef.current:    { serverT, localT } — most-recent sample's
  //                          server time paired with the local
  //                          performance.now() at receive. Interp uses
  //                          performance.now() (monotonic) for elapsed,
  //                          so browser wall-clock skew vs the Jetson
  //                          does NOT affect visual smoothness.
  const sampleBufRef     = useRef([])
  const anchorRef        = useRef(null)
  const rafRef           = useRef(null)
  const storePositions   = useStore((s) => s.joints?.positions)
  const lastMessageTime  = useStore((s) => s.lastMessageTime)
  const { scene, camera, gl } = useThree()

  // Ingest new joint samples into the interpolation ring buffer.
  // Fires once per /ws/state message (positions is a fresh array each
  // JSON.parse; lastMessageTime updates in the same set() call).
  useEffect(() => {
    if (!Array.isArray(storePositions) || storePositions.length < 6) return
    if (!lastMessageTime) return
    const buf = sampleBufRef.current
    const last = buf[buf.length - 1]
    // Dedupe: server broadcasts at 25 Hz but source joints arrive
    // at ~15 Hz, so ~45% of frames are stale repeats. Refresh the
    // anchor timestamp on duplicates (so interp keeps advancing)
    // but don't append — otherwise the interp would sit still with
    // zero span between identical samples.
    if (last) {
      if (last.t === lastMessageTime) return
      let identical = true
      for (let i = 0; i < 6; i++) {
        if (last.q[i] !== storePositions[i]) { identical = false; break }
      }
      if (identical) {
        last.t = lastMessageTime
        anchorRef.current = { serverT: last.t, localT: performance.now() }
        return
      }
    }
    buf.push({ t: lastMessageTime, q: storePositions.slice(0, 6) })
    while (buf.length > SAMPLE_BUF_CAP) buf.shift()
    anchorRef.current = { serverT: lastMessageTime, localT: performance.now() }
  }, [storePositions, lastMessageTime])

  // URDF load — fires once per urdfUrl. Per-mesh telemetry posted
  // via [URDF] console logs and the onStatus callback so the
  // diagnostic pill shows dispatched/loaded/failed counts in real
  // time.
  useEffect(() => {
    if (!urdfUrl) return undefined
    let cancelled = false
    let attached  = null

    onStatus?.({ state: 'loading', detail: 'fetching URDF…' })

    const timeLabel = `[urdf-load] URDFArm ${urdfUrl}`
    // eslint-disable-next-line no-console
    console.time(timeLabel)

    const loader = new URDFLoader()
    // package://robot_description/links/foo.glb → /robot/links/foo.glb
    loader.packages = { robot_description: '/robot' }
    loader.parseVisual    = true
    loader.parseCollision = false

    let dispatched = 0
    let loadedN    = 0
    let failed     = 0
    let urdfRoot   = null
    let finalEmitted = false
    const firstErrors = []
    const MESH_TIMEOUT_MS = 30000
    const pendingTimers = new Set()

    function emitProgress() {
      const parts = [`dispatched=${dispatched}`, `loaded=${loadedN}`]
      if (failed) parts.push(`failed=${failed}`)
      onStatus?.({ state: 'loading', detail: parts.join(' · ') })
    }

    function maybeEmitFinal() {
      if (finalEmitted) return
      if (!urdfRoot) return
      if (dispatched === 0) return
      if (loadedN + failed < dispatched) return
      finalEmitted = true
      for (const t of pendingTimers) clearTimeout(t)
      pendingTimers.clear()

      const linkCount = urdfRoot.links ? Object.keys(urdfRoot.links).length : 0
      const box = new THREE.Box3().setFromObject(urdfRoot)
      const sz  = box.getSize(new THREE.Vector3())
      const bboxStr = `${sz.x.toFixed(2)}×${sz.y.toFixed(2)}×${sz.z.toFixed(2)} m`
      let meshTotal = 0
      urdfRoot.traverse((c) => { if (c.isMesh) meshTotal += 1 })
      // eslint-disable-next-line no-console
      console.log(`loaded ${meshTotal} meshes, bbox `
        + `${sz.x.toFixed(2)}x${sz.y.toFixed(2)}x${sz.z.toFixed(2)}`)
      // eslint-disable-next-line no-console
      try { console.timeEnd(timeLabel) } catch {}
      const state = (loadedN > 0 && failed === 0)
        ? 'loaded'
        : (loadedN === 0 ? 'error' : 'loaded')
      onStatus?.({
        state,
        detail:
          `${linkCount} links · ${loadedN}/${dispatched} meshes`
          + (failed ? ` · ${failed} failed` : '')
          + ` · bbox ${bboxStr}`
          + (firstErrors.length ? ` · err: ${firstErrors[0].slice(0, 80)}` : ''),
      })
      // eslint-disable-next-line no-console
      console.info('[URDF] final', {
        dispatched, loaded: loadedN, failed,
        links: Object.keys(urdfRoot.links || {}),
        joints: Object.keys(urdfRoot.joints || {}),
        bbox: { x: sz.x, y: sz.y, z: sz.z },
        errors: firstErrors,
      })
      if (sz.x > 0.01 && sz.y > 0.01 && sz.z > 0.01) {
        onLoaded?.(urdfRoot, box)
      }
    }

    loader.loadMeshCb = (path, manager, done) => {
      dispatched += 1
      emitProgress()
      // eslint-disable-next-line no-console
      console.info('[URDF] dispatch', path.split('/').pop())

      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        failed += 1
        const msg = `timeout: ${path.split('/').pop()}`
        firstErrors.push(msg)
        done(null, new Error(msg))
        emitProgress()
        maybeEmitFinal()
      }, MESH_TIMEOUT_MS)
      pendingTimers.add(timer)

      const finish = (obj, err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        pendingTimers.delete(timer)
        if (err || !obj) {
          failed += 1
          firstErrors.push(`${path.split('/').pop()}: ${err?.message || err || 'no obj'}`)
          // eslint-disable-next-line no-console
          console.error('[URDF] mesh failed', path, err)
          done(null, err)
        } else {
          // Reset baked-in mesh-root transforms — the final_linkN GLBs
          // are SolidWorks exports whose geometry is positioned in
          // world space. URDF joint origins set each link frame; the
          // mesh should sit at the link frame's origin. Resetting the
          // root and every child cancels the residual CAD transform,
          // which is what snaps the links from "scattered" to
          // "assembled". LOAD-BEARING — do not delete.
          obj.position.set(0, 0, 0)
          obj.rotation.set(0, 0, 0)
          obj.scale.set(1, 1, 1)
          obj.updateMatrixWorld(true)
          let meshCount    = 0
          let withMaterial = 0
          obj.traverse((child) => {
            if (child !== obj) {
              child.position.set(0, 0, 0)
              child.rotation.set(0, 0, 0)
              child.scale.set(1, 1, 1)
              child.updateMatrix()
            }
            if (child.isMesh) {
              meshCount += 1
              // Fallback only — preserve the GLB's baked material
              // where it exists so the robot renders in color rather
              // than flat grey. See withMaterial: count in the log.
              if (child.material) withMaterial += 1
              else child.material = ROBOT_MATERIAL
              child.castShadow    = true
              child.receiveShadow = true
            }
          })
          const bb = new THREE.Box3().setFromObject(obj)
          const sz = bb.getSize(new THREE.Vector3())
          // eslint-disable-next-line no-console
          console.log('[MESH]', path.split('/').pop(),
            'meshes:', meshCount,
            'withMaterial:', withMaterial,
            'bbox:', `${sz.x.toFixed(3)}x${sz.y.toFixed(3)}x${sz.z.toFixed(3)}`)

          loadedN += 1
          done(obj)
        }
        emitProgress()
        maybeEmitFinal()
      }

      const ext = (path.split('.').pop() || '').toLowerCase()
      if (ext === 'glb' || ext === 'gltf') {
        const gltf = new GLTFLoader(manager)
        gltf.setDRACOLoader(DRACO)
        gltf.load(
          path,
          (g) => finish(g.scene),
          undefined,
          (e) => finish(null, e),
        )
      } else {
        // STL / DAE fallback through urdf-loader's default loader.
        try { loader.defaultMeshLoader(path, manager, finish) }
        catch (e) { finish(null, e) }
      }
    }

    loader.load(
      urdfUrl,
      (urdf) => {
        if (cancelled) return
        // Axis convention gate (see URDF_UP_AXIS at top). Current
        // served URDF (s10-140-full) is Y-up → rotation stays 0.
        urdf.rotation.x = URDF_ROT_X
        const g = groupRef.current
        if (!g) return
        g.add(urdf)
        attached = urdf
        robotRef.current = urdf
        urdfRoot = urdf

        // Inject a tool0 frame at link6 so the IK solver, the TCP
        // readout, and the flange-attached gripper share one canonical
        // name. Twin URDF has no tool0 and no link_6 (underscore), so
        // this is where we introduce it. TODO: swap the identity
        // transform for a real tool offset (mm from flange face to TCP)
        // when the operator picks a gripper.
        if (urdf.links && urdf.links.link6 && !urdf.links.tool0) {
          const tool0 = new THREE.Object3D()
          tool0.name = 'tool0'
          urdf.links.link6.add(tool0)
          urdf.links.tool0 = tool0
        }

        // Expose an FK-only jog handle for sibling DOM panels
        // (JointJogPanel). setJointRad writes both refs so the 25 Hz
        // FK lerp holds the pose instead of yanking back to the store
        // target — mirrors the click-drag release sync in onPointerUp.
        // Cancel any active Home animation. Called from every jogApi
        // write path so a slider tug or IK drag mid-Home hands
        // authority back to the interrupting caller cleanly.
        const cancelHome = () => {
          if (homeAnimRef.current) {
            homeAnimRef.current.cancel()
            homeAnimRef.current = null
          }
        }
        const jogApi = {
          robot: urdf,
          setJointRad: (idx, rad) => {
            if (idx < 0 || idx >= 6) return
            const j = urdf.joints?.[JOINT_NAMES[idx]]
            if (!j || typeof j.setJointValue !== 'function') return
            cancelHome()
            // Latch manual override BEFORE writing target so the very
            // next store-mirror tick can't stomp it. Slider becomes
            // the sole authority for this joint until resetAll().
            manualMaskRef.current[idx] = true
            j.setJointValue(rad)
            currentRef.current[idx] = rad
            targetsRef.current[idx] = rad
          },
          resetAll: () => {
            cancelHome()
            for (let i = 0; i < 6; i++) {
              // Release control back to the store, then zero the pose.
              manualMaskRef.current[i] = false
              urdf.joints?.[JOINT_NAMES[i]]?.setJointValue?.(0)
              currentRef.current[i] = 0
              targetsRef.current[i] = 0
            }
          },
          // Batched write for the IK solver: latch all six masks,
          // apply the full q vector to the URDF + refs. Non-finite
          // entries are skipped (belt-and-braces; ikStep guards NaN).
          setJointsRad: (rads) => {
            if (!Array.isArray(rads) || rads.length < 6) return
            cancelHome()
            for (let i = 0; i < 6; i++) {
              const rad = Number(rads[i])
              if (!Number.isFinite(rad)) continue
              const j = urdf.joints?.[JOINT_NAMES[i]]
              if (!j || typeof j.setJointValue !== 'function') continue
              manualMaskRef.current[i] = true
              j.setJointValue(rad)
              currentRef.current[i] = rad
              targetsRef.current[i] = rad
            }
          },
          // Smooth coordinated return to all-zeros. See lib/homeAnim.js.
          // Repeated presses restart cleanly from the current
          // interpolated pose — never queue.
          home: () => {
            cancelHome()
            homeAnimRef.current = startHomeMove({
              robot: urdf,
              currentRef, targetsRef, manualMaskRef,
              onComplete: () => { homeAnimRef.current = null },
            })
          },
          // Twin-only interpolated move to an arbitrary target joint
          // vector. Used by QuickOrientButtons; also usable by any
          // future twin-preview feature. Masks stay latched at
          // completion so the twin holds at the target pose — call
          // resetAll() to release + zero, or click Home for a smooth
          // return. Shares the homeAnimRef slot with home() so cancels
          // are unified.
          runJointAnimation: (q_target, durationMs) => {
            cancelHome()
            homeAnimRef.current = startJointAnimation({
              robot: urdf,
              q_target,
              duration: Number(durationMs) || 1500,
              currentRef, targetsRef, manualMaskRef,
              onComplete: () => { homeAnimRef.current = null },
            })
          },
        }
        onRobotReady?.(jogApi)

        // ── STEP 0 (diagnostic) ────────────────────────────────
        // Enumerate every joint urdf-loader actually created so
        // we can distinguish URDF-parse failure from a wiring
        // issue upstream.
        try {
          const jointRows = Object.keys(urdf.joints || {}).map((k) => {
            const j = urdf.joints[k]
            return {
              name: j.name,
              jointType: j.jointType,
              axis: j.axis ? [j.axis.x, j.axis.y, j.axis.z] : null,
              limit: j.limit ? { lower: j.limit.lower, upper: j.limit.upper } : null,
            }
          })
          // eslint-disable-next-line no-console
          console.log('[DIAG:STEP0] urdf.joints keys:', Object.keys(urdf.joints || {}))
          // eslint-disable-next-line no-console
          console.table(jointRows)
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[DIAG:STEP0] enumeration failed', e)
        }

        // tool0 injected above; link6 (twin) and link_6 (older URDFs) as
        // fallbacks so this resolves across URDF variants.
        const flange = (urdf.links && (urdf.links.tool0 || urdf.links.link6 || urdf.links.link_6))
                       || null
        onFlangeReady?.(flange)

        if (dispatched === 0) {
          // URDF parsed but loadMeshCb never fired — usually means
          // urdf-loader's XML parser disagreed with the file. Flag
          // it visibly.
          finalEmitted = true
          onStatus?.({
            state: 'error',
            detail: 'URDF parsed but 0 mesh dispatches — '
                  + 'check console for "pkg not found" or XML issues.',
          })
        } else {
          maybeEmitFinal()
        }
      },
      undefined,
      (err) => {
        if (cancelled) return
        // eslint-disable-next-line no-console
        console.error('[URDF] URDF load failed:', err)
        onStatus?.({
          state: 'error',
          detail: `URDF load failed: ${err?.message || err}`,
        })
      },
    )

    return () => {
      cancelled = true
      if (homeAnimRef.current) {
        homeAnimRef.current.cancel()
        homeAnimRef.current = null
      }
      if (attached && attached.parent) attached.parent.remove(attached)
      robotRef.current = null
      onFlangeReady?.(null)
      onRobotReady?.(null)
    }
    // Load once for the lifetime of this component. Re-running this
    // effect on parent-callback identity changes caused the URDF to
    // be re-fetched every render, producing a flicker loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // RAF interpolator: on every animation frame, play back the joint
  // stream at (serverT_of_newest_sample − RENDER_LAG_MS + elapsed
  // local monotonic time). Bracket that renderT in the sample buffer,
  // lerp per-joint linearly between the two straddling samples, and
  // write to the URDF joints. Skips manual-drag joint (manualJointRef)
  // and any joint under slider authority (manualMaskRef). Uses
  // performance.now() rather than Date.now() so clock skew between
  // the Jetson and the browser does not enter the render clock.
  useEffect(() => {
    const step = () => {
      const robot = robotRef.current
      const buf   = sampleBufRef.current
      const anchor = anchorRef.current
      if (robot && robot.joints && anchor && buf.length > 0) {
        const cur = currentRef.current
        const tgt = targetsRef.current
        const mask = manualMaskRef.current
        const manualIdx = manualJointRef.current

        const renderT = anchor.serverT
                      - RENDER_LAG_MS
                      + (performance.now() - anchor.localT)

        // Bracket search — buffer is tiny (≤ SAMPLE_BUF_CAP) so a
        // linear scan is fine.
        let i0 = 0
        let i1 = 0
        if (buf.length === 1 || renderT <= buf[0].t) {
          i0 = i1 = 0
        } else if (renderT >= buf[buf.length - 1].t) {
          i0 = i1 = buf.length - 1
        } else {
          for (let i = 0; i < buf.length - 1; i++) {
            if (buf[i].t <= renderT && buf[i + 1].t >= renderT) {
              i0 = i; i1 = i + 1
              break
            }
          }
        }

        const s0 = buf[i0]
        const s1 = buf[i1]
        const span = s1.t - s0.t
        const alpha = span > 0 ? Math.max(0, Math.min(1, (renderT - s0.t) / span)) : 0

        for (let j = 0; j < 6; j++) {
          if (j === manualIdx) continue
          if (mask[j]) continue
          const v = span > 0 ? s0.q[j] + (s1.q[j] - s0.q[j]) * alpha : s0.q[j]
          cur[j] = v
          // Keep targetsRef aligned with the played-back pose so
          // home() and jogApi.setJointRad slide from what the user
          // actually sees, not from a stale "last commanded" target.
          tgt[j] = v
          const joint = robot.joints[JOINT_NAMES[j]]
          if (joint && typeof joint.setJointValue === 'function') {
            joint.setJointValue(v)
          }
        }
      }
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  // ── Click-and-drag joint manipulation ──────────────────────────
  // Pointer-down on any URDF mesh → walk up to nearest revolute
  // joint → arcball rotation about that joint's world axis. FK only;
  // downstream links follow via urdf-loader's chain. See the top-of-
  // file plan for math. Handler identity kept stable via refs so the
  // matching add/removeEventListener pair references the same fn.
  useEffect(() => {
    const dom = gl?.domElement
    if (!dom) return undefined

    const findJointAncestor = (obj) => {
      let cur = obj
      while (cur) {
        if (cur.isURDFJoint && JOINT_NAMES.indexOf(cur.name) >= 0) return cur
        cur = cur.parent
      }
      return null
    }

    const clampToLimits = (joint, value) => {
      const lim = joint.limit || {}
      const lo = Number(lim.lower)
      const hi = Number(lim.upper)
      if (joint.jointType === 'continuous') return value
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo < hi) {
        return Math.max(lo, Math.min(hi, value))
      }
      return value
    }

    const raycaster = new THREE.Raycaster()
    const plane     = new THREE.Plane()
    const hit       = new THREE.Vector3()
    const tmpNdc    = new THREE.Vector2()
    const tmpCross  = new THREE.Vector3()

    const onPointerMove = (ev) => {
      const s = dragStateRef.current
      if (!s) return
      const rect = dom.getBoundingClientRect()
      tmpNdc.set(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(tmpNdc, camera)
      plane.setFromNormalAndCoplanarPoint(s.jointAxisW, s.jointOriginW)
      if (!raycaster.ray.intersectPlane(plane, hit)) return
      const currentVec = hit.clone().sub(s.jointOriginW)
      // Both vectors lie in the plane perpendicular to axis, so
      // signed angle is atan2((a × b) · axis, a · b).
      tmpCross.crossVectors(s.initialVec, currentVec)
      const delta = Math.atan2(tmpCross.dot(s.jointAxisW), s.initialVec.dot(currentVec))
      const newAngle = clampToLimits(s.joint, s.initialAngle + delta)
      s.joint.setJointValue(newAngle)
      s.lastAngle = newAngle
      onDragInfo?.({ jointName: s.joint.name, angleDeg: newAngle * 180 / Math.PI })
    }

    const onPointerUp = (ev) => {
      const s = dragStateRef.current
      dom.removeEventListener('pointermove', onPointerMove)
      dom.removeEventListener('pointerup', onPointerUp)
      try { dom.releasePointerCapture?.(ev.pointerId) } catch {}
      if (!s) return
      // Sync FK loop to the released value so the lerp holds the pose
      // rather than yanking back to the store target. When live joint
      // telemetry lands, a subsequent store update will legitimately
      // overwrite this override.
      const jv = (s.joint.jointValue && s.joint.jointValue[0]) ?? s.lastAngle ?? s.initialAngle
      currentRef.current[s.idx] = jv
      targetsRef.current[s.idx] = jv
      manualJointRef.current    = -1
      dragStateRef.current      = null
      onDragActive?.(true)
      onDragInfo?.(null)
    }

    dragHandlersRef.current = { onPointerMove, onPointerUp, findJointAncestor }
    return () => {
      dom.removeEventListener('pointermove', onPointerMove)
      dom.removeEventListener('pointerup', onPointerUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, camera])

  // r3f dispatches this when the ray hits any child mesh of the
  // group. event.object = hit mesh, event.point = world-space hit.
  const handleGroupPointerDown = (event) => {
    const robot = robotRef.current
    const h = dragHandlersRef.current
    if (!robot || !h) return
    const joint = h.findJointAncestor(event.object)
    if (!joint) return
    const jt = joint.jointType
    if (jt !== 'revolute' && jt !== 'continuous') return
    const idx = JOINT_NAMES.indexOf(joint.name)
    if (idx < 0) return
    event.stopPropagation()

    const jointOriginW = joint.getWorldPosition(new THREE.Vector3())
    const jointAxisW   = joint.axis.clone()
      .transformDirection(joint.matrixWorld)
      .normalize()
    const initialAngle = (joint.jointValue && joint.jointValue[0]) ?? 0
    // event.point is the world-space intersection. Subtract axis
    // component so initialVec lies in the rotation plane.
    const initialVec = event.point.clone().sub(jointOriginW)
    const axisComp   = jointAxisW.clone().multiplyScalar(initialVec.dot(jointAxisW))
    initialVec.sub(axisComp)

    dragStateRef.current = {
      joint, idx, initialAngle, jointOriginW, jointAxisW, initialVec,
      lastAngle: initialAngle,
    }
    manualJointRef.current = idx

    const dom = gl.domElement
    try { dom.setPointerCapture?.(event.pointerId) } catch {}
    dom.addEventListener('pointermove', h.onPointerMove)
    dom.addEventListener('pointerup',   h.onPointerUp)

    onDragActive?.(false)
    onDragInfo?.({ jointName: joint.name, angleDeg: initialAngle * 180 / Math.PI })
  }

  return <group ref={groupRef} onPointerDown={handleGroupPointerDown} />
}


// ──────────────────────────────────────────────────────────────────
// CustomGripperModel — parents to the URDF flange link if available.
// ──────────────────────────────────────────────────────────────────
function CustomGripperModel({ url, flange }) {
  const [model, setModel] = useState(null)
  const innerRef = useRef(null)

  useEffect(() => {
    if (!url) { setModel(null); return undefined }
    let cancelled = false
    const loader = new GLTFLoader()
    loader.load(
      url,
      (gltf) => {
        if (cancelled) return
        const root = gltf.scene
        const mat = new THREE.MeshStandardMaterial({
          color: '#A8B0C0', metalness: 0.5, roughness: 0.35,
        })
        root.traverse((o) => { if (o.isMesh) { o.material = mat; o.castShadow = true } })
        const box = new THREE.Box3().setFromObject(root)
        const size   = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())
        const maxDim = Math.max(size.x, size.y, size.z) || 1
        const scale  = 0.2 / maxDim
        root.position.sub(center).multiplyScalar(scale)
        root.scale.setScalar(scale)
        setModel(root)
      },
      undefined,
      () => { if (!cancelled) setModel(null) },
    )
    return () => { cancelled = true }
  }, [url])

  useEffect(() => {
    if (!model || !innerRef.current) return undefined
    const wrap = innerRef.current
    if (flange) {
      flange.add(wrap)
      return () => { if (wrap.parent === flange) flange.remove(wrap) }
    }
    return undefined
  }, [model, flange])

  if (!model) return null
  return (
    <group ref={innerRef} position={flange ? [0, 0, 0.05] : [0, 1.5, 0]}>
      <primitive object={model} />
    </group>
  )
}


// ──────────────────────────────────────────────────────────────────
// ArmViewer3D — the public component.
// ──────────────────────────────────────────────────────────────────
function BaselineStatusNotice({ status }) {
  if (!status) return null
  const { cell_id, name, has_baseline, n, message, captured_at, hydrated } = status
  // Quiet success state: a tiny readout sitting in the top-center
  // beneath the collision banner. Loud only when there's something
  // for the operator to act on.
  if (cell_id && has_baseline && n > 0) {
    return (
      <div style={{
        position: 'absolute', top: 56, left: '50%',
        transform: 'translateX(-50%)',
        padding: '3px 8px', borderRadius: 4, zIndex: 9,
        fontSize: 10, fontFamily: 'var(--font-mono, monospace)',
        background: 'rgba(15,23,42,0.6)', color: '#e2e8f0',
        pointerEvents: 'none', letterSpacing: 0.2,
      }}>
        Baseline · {name || cell_id} · {n.toLocaleString()} pts
        {captured_at ? ' · ' + captured_at : ''}
      </div>
    )
  }
  // Pre-hydration: don't claim "no active cell" — we don't know yet.
  // The store hasn't heard from the backend at all, so this is
  // genuinely "loading", not an empty state. This was the original
  // bug: the previous code defaulted to "No active cell" when
  // cell_id was null, even on the very first render before any
  // network round-trip.
  if (hydrated === false) {
    return (
      <div style={{
        position: 'absolute', top: 56, left: '50%',
        transform: 'translateX(-50%)',
        padding: '6px 12px', borderRadius: 6, zIndex: 9,
        fontSize: 11, color: '#94a3b8',
        background: 'rgba(15,23,42,0.7)',
        border: '1px solid rgba(148,163,184,0.3)',
        pointerEvents: 'none',
      }}>Loading active cell…</div>
    )
  }
  const msg = !cell_id
    ? 'No active cell — pick one in Configure → Cells.'
    : !has_baseline
      ? `Active cell "${name || cell_id}" has no baseline — capture one in the Setup Wizard.`
      : message === 'load_failed'
        ? 'Baseline cloud failed to load — check the Setup Wizard.'
        : message === 'loading_baseline'
          ? `Loading baseline for "${name || cell_id}"…`
          : 'Loading baseline…'
  // Loading-baseline state is informational, not a problem; the others
  // are amber so the operator notices.
  const looksLikeLoading = message === 'loading_baseline'
  return (
    <div style={{
      position: 'absolute', top: 56, left: '50%',
      transform: 'translateX(-50%)',
      padding: '8px 14px', borderRadius: 6, zIndex: 11,
      fontSize: 12, fontWeight: 600,
      background: looksLikeLoading
        ? 'rgba(15,23,42,0.75)'
        : 'rgba(254,243,199,0.96)',
      color: looksLikeLoading ? '#cbd5e1' : '#92400e',
      border: looksLikeLoading
        ? '1px solid rgba(148,163,184,0.35)'
        : '1px solid #fcd34d',
      boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
      maxWidth: '70%', textAlign: 'center',
    }}>{msg}</div>
  )
}

function StaticZonesToggle({ value, onChange }) {
  // Probe the live collision payload for any baseline-built obstacles
  // so we don't dangle an inert toggle when no cell has zones yet.
  const hasStatic = useStore((s) => (s.collision?.objects || []).some(
    (o) => o.source === 'baseline_static'))
  if (!hasStatic) return null
  // Larger control sized for tablet thumbs — pill-shaped sliding
  // switch instead of a native checkbox. On = orange (#ea580c)
  // matching the baseline-static box color; off = neutral gray.
  const on = !!value
  return (
    <div style={{
      position: 'absolute', top: 8, left: 8,
      padding: '10px 14px',
      background: 'rgba(255,255,255,0.96)', borderRadius: 10,
      border: '1px solid #fed7aa',
      boxShadow: '0 2px 10px rgba(0,0,0,0.10)', zIndex: 11,
      display: 'flex', alignItems: 'center', gap: 12,
      fontSize: 13, color: '#9a3412',
      cursor: 'pointer',
      userSelect: 'none',
    }}
      role="switch"
      tabIndex={0}
      aria-checked={on}
      aria-label="Static keep-out zones"
      onClick={() => onChange(!on)}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          onChange(!on)
        }
      }}>
      <span style={{
        width: 14, height: 14, borderRadius: 3,
        background: '#ea580c', border: '1px solid #c2410c', flexShrink: 0,
      }} />
      <span style={{ fontWeight: 600, fontSize: 14 }}>Static keep-out zones</span>
      {/* Sliding switch — track + knob. 44px wide × 24px tall track
          with a 20px knob meets the typical tablet touch target. */}
      <span style={{
        position: 'relative',
        width: 44, height: 24, flexShrink: 0,
        borderRadius: 999,
        background: on ? '#ea580c' : '#cbd5e1',
        transition: 'background 160ms ease',
        boxShadow: on
          ? 'inset 0 1px 2px rgba(0,0,0,0.18)'
          : 'inset 0 1px 2px rgba(0,0,0,0.10)',
      }}>
        <span style={{
          position: 'absolute',
          top: 2, left: on ? 22 : 2,
          width: 20, height: 20,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
          transition: 'left 160ms ease',
        }} />
      </span>
    </div>
  )
}

const ArmViewer3D = forwardRef(function ArmViewer3D({ joints, children, overlay, noRobot = false }, ref) {
  const controlsRef = useRef(null)
  const [flange, setFlange] = useState(null)
  const [urdfStatus, setUrdfStatus] = useState({ state: 'idle', detail: '' })
  // Show baseline-built static keep-out zones by default; the
  // operator can hide them via the StaticZonesToggle.
  const [showStaticZones, setShowStaticZones] = useState(true)
  const autoFittedRef = useRef(false)

  // Active click-drag joint (null when not dragging). Populated by
  // URDFArm via onDragInfo; drives the drag-status pill.
  const [dragInfo, setDragInfo] = useState(null)
  // FK jog handle exposed by URDFArm once the URDF resolves; passed to
  // JointJogPanel below. Null while loading or when noRobot=true.
  const [jogApi, setJogApi] = useState(null)
  // Cartesian-drag state. `cartMode` toggles the IK gizmo; `gizmoMode`
  // chooses translate vs rotate. Both driven from JointJogPanel.
  const [cartMode, setCartMode]   = useState(false)
  const [gizmoMode, setGizmoMode] = useState('translate')
  // AT LIMIT indicator — flipped from IKGizmo onTargetPose whenever the
  // sticky-boundary snap detects the gizmo commanded pose diverged
  // from what the arm actually achieved (joint-limit-clamped FK).
  const [ikAtLimit, setIkAtLimit] = useState(false)
  const setOrbitEnabled = (enabled) => {
    if (controlsRef.current) controlsRef.current.enabled = enabled
  }

  // === DIAGNOSTIC — independent fetch of one per-link GLB so a
  // network/cert problem appears in orange immediately, before the
  // URDF loader even runs. Remove after the model is confirmed live.
  const [diagMsg, setDiagMsg] = useState('GLB: testing…')
  useEffect(() => {
    const testUrl = '/robot/links/link0_base_light.glb'
    fetch(testUrl)
      .then((r) => {
        const ctype = r.headers.get('content-type') || '(no content-type)'
        const clen  = r.headers.get('content-length') || '?'
        const info = `GLB fetch: ${r.status} ${r.statusText} (${ctype}, ${clen} B)`
        // eslint-disable-next-line no-console
        console.log('[DIAG]', info)
        setDiagMsg(info)
      })
      .catch((err) => {
        const info = `GLB fetch ERROR: ${err?.message || err}`
        // eslint-disable-next-line no-console
        console.error('[DIAG]', info)
        setDiagMsg(info)
      })
  }, [])
  // === END DIAGNOSTIC ===

  // Prior versions read `useStore((s) => s.joints?.positions)` here to
  // feed a top-right joint-readout overlay. That overlay was removed
  // (see the note near the closing JSX). The subscription remained,
  // re-rendering ArmViewer3D at the ~25 Hz WS cadence, which recreated
  // every inline arrow prop below — including IKGizmo's onDragChange
  // — and tore TransformControls down mid-drag. Deleting the zombie
  // subscription drops re-renders to state-change-only. URDFArm still
  // subscribes internally (line ~414) so live telemetry keeps flowing
  // to the FK loop.

  const applyPreset = (name) => {
    const pos = DEFAULT_PRESETS[name] ?? DEFAULT_PRESETS.iso
    const c = controlsRef.current
    if (!c) return
    c.object.position.set(pos[0], pos[1], pos[2])
    c.target.set(DEFAULT_ORBIT_TARGET[0], DEFAULT_ORBIT_TARGET[1], DEFAULT_ORBIT_TARGET[2])
    c.update()
  }
  useImperativeHandle(ref, () => ({
    setCameraPreset(name) { applyPreset(name) },
    // Expose OrbitControls enable/disable so a sibling in the same
    // Canvas (an IKGizmo mounted from View3DLayout's JSX children) can
    // freeze the orbit while dragging the gizmo.
    setOrbitEnabled(v) { setOrbitEnabled(v) },
  }))

  // One-shot auto-fit on first load. After that the operator's
  // manual orbit + presets win.
  const handleUrdfLoaded = (_robot, bbox) => {
    if (autoFittedRef.current) return
    const c = controlsRef.current
    if (!c) return
    const sz     = bbox.getSize(new THREE.Vector3())
    const center = bbox.getCenter(new THREE.Vector3())
    const maxDim = Math.max(sz.x, sz.y, sz.z)
    if (!Number.isFinite(maxDim) || maxDim < 0.01) return
    autoFittedRef.current = true
    c.object.position.set(
      center.x + maxDim * 1.5,
      center.y + maxDim * 0.5,
      center.z + maxDim * 1.5,
    )
    c.target.copy(center)
    c.update()
    // eslint-disable-next-line no-console
    console.info('[URDF] camera auto-fit', {
      size:   { x: sz.x, y: sz.y, z: sz.z },
      center: { x: center.x, y: center.y, z: center.z },
    })
  }

  const currentProgram = useStore((s) => s.currentProgram)
  const gripperCfg     = currentProgram?.config?.gripper || {}
  const gripperType    = gripperCfg.gripper_type || gripperCfg.type || null
  const gripperGlbUrl  = gripperType === 'custom' && gripperCfg.gripper_model_id
    ? (gripperCfg.gripper_glb_url || `/grippers/glb/${gripperCfg.gripper_model_id}.glb`)
    : null
  const gripperName    = gripperCfg.gripper_name || gripperCfg.name || ''

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', background: '#fafafa' }}>
      <Canvas camera={{ position: DEFAULT_PRESETS.iso, fov: 45 }}
              gl={{ antialias: true }} shadows>
        <SceneEnvironment />
        <hemisphereLight  args={['#e6ecf5', '#1f2937', 0.55]} />
        <directionalLight position={[5, 10, 5]} intensity={0.9} castShadow />
        <ambientLight     intensity={0.15} />
        <OrbitControls
          ref={controlsRef}
          enablePan enableZoom
          target={DEFAULT_ORBIT_TARGET}
          minDistance={0.5}
          maxDistance={20}
        />
        <gridHelper args={[4, 20, '#cccccc', '#e5e5e5']} />
        {!noRobot && (
          <URDFArm
            urdfUrl="/robot/urdf"
            onFlangeReady={setFlange}
            onStatus={setUrdfStatus}
            onLoaded={handleUrdfLoaded}
            onDragActive={setOrbitEnabled}
            onDragInfo={setDragInfo}
            onRobotReady={setJogApi}
          />
        )}
        <CustomGripperModel url={gripperGlbUrl} flange={flange} />
        <CollisionScene3D showStatic={showStaticZones} />
        {/* IK gizmo for the URDFArm path (Program tab). Only mounts
            while Cartesian mode is on; unmount disposes the
            TransformControls cleanly. */}
        {!noRobot && cartMode && (
          <IKGizmo jogApi={jogApi} enabled mode={gizmoMode}
                   onDragChange={(d) => {
                     setOrbitEnabled(!d)
                     if (!d) setIkAtLimit(false)   // clear on release
                   }}
                   onTargetPose={(p) => {
                     if (!!p.atLimit !== ikAtLimit) setIkAtLimit(!!p.atLimit)
                   }} />
        )}
        {children}
      </Canvas>
      {overlay}

      {/* Static keep-out zones toggle — top-left. Hidden when the
          collision payload has no baseline-static obstacles so the
          UI doesn't dangle a useless toggle. */}
      <StaticZonesToggle value={showStaticZones} onChange={setShowStaticZones} />

      {/* AT LIMIT — top-right. Only visible while Cartesian drag is
          active AND the IK sticky-boundary snap detected the gizmo
          diverged from the arm's achievable pose. Cleared on release. */}
      {cartMode && ikAtLimit && (
        <div style={{
          position: 'absolute', top: 8, right: 8, zIndex: 20,
          padding: '4px 10px', borderRadius: 4,
          background: '#DC2626', color: '#fff',
          fontSize: 12, fontFamily: 'var(--font-mono, monospace)',
          fontWeight: 700, letterSpacing: 0.6,
          boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
          pointerEvents: 'none',
        }}>
          AT LIMIT
        </div>
      )}

      {/* Collision banner — centered at top */}
      <div style={{
        position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)',
        zIndex: 12, pointerEvents: 'none',
      }}>
        <CollisionBanner />
      </div>

      {/* Drag-manipulation status — shows only while the operator is
          click-dragging a joint. Below the collision banner so both
          can coexist. */}
      {dragInfo && (
        <div style={{
          position: 'absolute', top: 36, left: '50%',
          transform: 'translateX(-50%)', zIndex: 13,
          padding: '4px 10px', borderRadius: 4,
          background: 'rgba(37,99,235,0.92)', color: '#fff',
          fontSize: 12, fontFamily: 'var(--font-mono, monospace)',
          fontWeight: 600, pointerEvents: 'none', letterSpacing: 0.2,
        }}>
          {dragInfo.jointName} · {dragInfo.angleDeg >= 0 ? '+' : ''}
          {dragInfo.angleDeg.toFixed(1)}°
        </div>
      )}

      {/* (Removed) Collision side panel — was dev scaffolding showing
          per-object distances + Mock injection + home-pose state in the
          bottom-left. CollisionSidePanel is still exported from
          CollisionOverlay for diagnostic pages. */}

      {gripperGlbUrl && (
        <div style={{
          position: 'absolute', bottom: 8, left: 8,
          padding: '6px 12px', borderRadius: 8,
          background: 'rgba(255,255,255,0.95)',
          border: '1px solid #e5e7eb',
          fontSize: 12, color: '#374151', fontWeight: 600,
          boxShadow: '0 2px 8px rgba(0,0,0,0.08)', zIndex: 10,
        }}>
          Custom Gripper: {gripperName || '(unnamed)'}
        </div>
      )}

      {/* Joint readout overlay removed — the J1..J6 angles were
          duplicate scaffolding once the URDF and live pose were
          rendering correctly. Keep JOINT_NAMES / JOINT_COLORS in
          this file (the FK loop uses them); just don't render
          the floating readout chip in the top-right anymore. */}

      {/* Status pill, bottom-right — currently shown ALWAYS so the two
          tabs (Program vs 3D View) can be compared side-by-side while
          we chase the "no robot on 3D View" report. Re-gate on
          ?debug=1 after the tabs are confirmed matching. */}
      <div style={{
        position: 'absolute', bottom: 8, right: 8, padding: '6px 10px',
        borderRadius: 6, fontSize: 11, lineHeight: 1.35,
        fontFamily: 'var(--font-mono, monospace)', zIndex: 10,
        maxWidth: 360,
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        background: urdfStatus.state === 'error'
          ? 'rgba(220,38,38,0.95)'
          : urdfStatus.state === 'loaded'
            ? 'rgba(22,163,74,0.92)'
            : 'rgba(15,23,42,0.85)',
        color: '#fff',
      }}>
        <div style={{ fontWeight: 700, marginBottom: 2 }}>URDF: {urdfStatus.state}</div>
        <div style={{ opacity: 0.92, wordBreak: 'break-all' }}>{urdfStatus.detail || '—'}</div>
        <div style={{
          fontSize: 11, color: '#ff9900', marginTop: 4, wordBreak: 'break-all',
        }}>{diagMsg}</div>
      </div>

      {/* FK jog pane, right-docked. Only mounts when URDFArm is active
          (noRobot=false) — the View3D tab uses StandaloneRobot and has
          no jogApi, so the panel is intentionally hidden there. */}
      {!noRobot && (
        <JointJogPanel
          jogApi={jogApi}
          cartesianMode={cartMode}
          onCartesianModeChange={setCartMode}
          gizmoMode={gizmoMode}
          onGizmoModeChange={setGizmoMode}
          onHome={() => {
            // Smooth coordinated 2-second return to all-zeros (see
            // lib/homeAnim.js). Interrupt with any slider / IK write.
            jogApi?.home?.()
          }}
          onAtLimit={(atLimit) => setIkAtLimit(!!atLimit)}
        />
      )}

      {/* Camera presets, top-left */}
      <div style={{
        position: 'absolute', top: 8, left: 8, display: 'flex', gap: 4, zIndex: 10,
      }}>
        {[
          { label: 'Front', key: 'front' },
          { label: 'Side',  key: 'side'  },
          { label: 'Top',   key: 'top'   },
          { label: 'Iso',   key: 'iso'   },
        ].map((p) => (
          <button
            key={p.key}
            onClick={() => applyPreset(p.key)}
            style={{
              padding: '4px 10px', fontSize: 10, fontWeight: 600,
              background: 'rgba(255,255,255,0.92)', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer',
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  )
})

export default ArmViewer3D
