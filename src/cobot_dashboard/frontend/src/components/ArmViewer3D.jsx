import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import URDFLoader from 'urdf-loader'
import * as THREE from 'three'
import { useStore } from '../store/useStore'
import { CollisionScene3D, CollisionBanner } from './CollisionOverlay'

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
// The per-link GLBs at /robot/links/*_light.glb are decimated to ≈ 29 k
// triangles total (no Draco compression) so the tablet GPU holds them
// without OOM. DRACOLoader is NOT registered — the previous Draco-
// compressed assets silently hung GLTFLoader on the tablet when the
// Draco worker couldn't initialise.
//
// Public API (unchanged from prior builds):
//   - forwardRef → setCameraPreset(name)
//   - props: { joints, children, overlay }
//   - OrbitControls + Front/Side/Top/Iso presets
//   - Joint readout (degrees) top-right
//   - Status pill bottom-right with phase telemetry
//   - Custom-gripper GLB overlay parented to the URDF flange
// ──────────────────────────────────────────────────────────────────

const JOINT_NAMES  = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6']
const JOINT_COLORS = ['#3B82F6', '#16A34A', '#CA8A04', '#DC2626', '#9333EA', '#F97316']

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
//   - LiDAR (x,y,z) → Three (x, z, y), matching LidarPanel.lidarToThree
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
      // LiDAR (ROS Z-up) → Three (Y-up): (x, y, z) → (x, z, y)
      positions[i * 3]     = px
      positions[i * 3 + 1] = pz
      positions[i * 3 + 2] = py
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
        // LiDAR (ROS Z-up) → Three (Y-up): (x, y, z) → (x, z, y)
        positions[i * 3]     = px
        positions[i * 3 + 1] = pz
        positions[i * 3 + 2] = py
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
        positions[i * 3 + 2] = py
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
function URDFArm({ urdfUrl, onFlangeReady, onStatus, onLoaded }) {
  const groupRef    = useRef(null)
  const robotRef    = useRef(null)
  const targetsRef  = useRef([0, 0, 0, 0, 0, 0])
  const currentRef  = useRef([0, 0, 0, 0, 0, 0])
  const storePositions = useStore((s) => s.joints?.positions)
  const { scene } = useThree()

  // Mirror live joints into a ref. 25 Hz interval below applies the
  // lerp without triggering React renders.
  useEffect(() => {
    if (Array.isArray(storePositions) && storePositions.length >= 6) {
      targetsRef.current = storePositions
        .slice(0, 6)
        .map((v) => (Number.isFinite(v) ? Number(v) : 0))
    }
  }, [storePositions])

  // URDF load — fires once per urdfUrl. Per-mesh telemetry posted
  // via [URDF] console logs and the onStatus callback so the
  // diagnostic pill shows dispatched/loaded/failed counts in real
  // time.
  useEffect(() => {
    if (!urdfUrl) return undefined
    let cancelled = false
    let attached  = null

    onStatus?.({ state: 'loading', detail: 'fetching URDF…' })

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
          // Reset baked-in mesh-root transforms — the per-link GLBs
          // were SolidWorks exports with each link's geometry already
          // positioned in world space. URDF joint origins set the
          // link frame; the mesh should sit at the link frame's
          // origin. Resetting root + children eliminates any residual
          // CAD transform.
          obj.position.set(0, 0, 0)
          obj.rotation.set(0, 0, 0)
          obj.scale.set(1, 1, 1)
          obj.updateMatrixWorld(true)
          obj.traverse((child) => {
            if (child !== obj) {
              child.position.set(0, 0, 0)
              child.rotation.set(0, 0, 0)
              child.scale.set(1, 1, 1)
              child.updateMatrix()
            }
            if (child.isMesh) {
              child.material = ROBOT_MATERIAL
              child.castShadow = true
              child.receiveShadow = true
            }
          })

          let meshCount = 0
          obj.traverse((c) => { if (c.isMesh) meshCount += 1 })
          const bb = new THREE.Box3().setFromObject(obj)
          const sz = bb.getSize(new THREE.Vector3())
          // eslint-disable-next-line no-console
          console.log('[MESH]', path.split('/').pop(),
            'meshes:', meshCount,
            'bbox:', `${sz.x.toFixed(3)}x${sz.y.toFixed(3)}x${sz.z.toFixed(3)}`)

          loadedN += 1
          done(obj)
        }
        emitProgress()
        maybeEmitFinal()
      }

      const ext = (path.split('.').pop() || '').toLowerCase()
      if (ext === 'glb' || ext === 'gltf') {
        new GLTFLoader(manager).load(
          path,
          (gltf) => finish(gltf.scene),
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
        // URDF is Z-up; tilt onto scene Y-up so the arm stands.
        urdf.rotation.x = -Math.PI / 2
        const g = groupRef.current
        if (!g) return
        g.add(urdf)
        attached = urdf
        robotRef.current = urdf
        urdfRoot = urdf

        const flange = (urdf.links && (urdf.links.tool0 || urdf.links.link6_flange))
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
      if (attached && attached.parent) attached.parent.remove(attached)
      robotRef.current = null
      onFlangeReady?.(null)
    }
  }, [urdfUrl, scene, onFlangeReady, onStatus, onLoaded])

  // 25 Hz joint lerp toward target at factor 0.3. Reads from refs so
  // the interval doesn't trigger React renders.
  useEffect(() => {
    const id = setInterval(() => {
      const robot = robotRef.current
      if (!robot || !robot.joints) return
      const tgt = targetsRef.current
      const cur = currentRef.current
      for (let i = 0; i < 6; i++) {
        const t = tgt[i] || 0
        cur[i] = cur[i] + (t - cur[i]) * 0.3
        const j = robot.joints[JOINT_NAMES[i]]
        if (j && typeof j.setJointValue === 'function') {
          j.setJointValue(cur[i])
        }
      }
    }, 40)
    return () => clearInterval(id)
  }, [])

  return <group ref={groupRef} />
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
  return (
    <div style={{
      position: 'absolute', top: 8, left: 8, padding: '6px 10px',
      background: 'rgba(255,255,255,0.95)', borderRadius: 8,
      border: '1px solid #fed7aa',
      boxShadow: '0 2px 8px rgba(0,0,0,0.08)', zIndex: 11,
      display: 'flex', alignItems: 'center', gap: 8,
      fontSize: 11, color: '#9a3412',
    }}>
      <span style={{ width: 10, height: 10, borderRadius: 2,
                     background: '#ea580c', border: '1px solid #c2410c' }} />
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
        <input type="checkbox" checked={!!value}
          onChange={(e) => onChange(e.target.checked)} />
        <span style={{ fontWeight: 600 }}>Static keep-out zones</span>
      </label>
    </div>
  )
}

const ArmViewer3D = forwardRef(function ArmViewer3D({ joints, children, overlay }, ref) {
  const controlsRef = useRef(null)
  const [flange, setFlange] = useState(null)
  const [urdfStatus, setUrdfStatus] = useState({ state: 'idle', detail: '' })
  // Show baseline-built static keep-out zones by default; the
  // operator can hide them via the StaticZonesToggle.
  const [showStaticZones, setShowStaticZones] = useState(true)
  // What BaselineCloudInScene last reported — drives the inline
  // "no commissioned baseline" notice for the empty case.
  const [baselineStatus, setBaselineStatus] = useState(null)
  const autoFittedRef = useRef(false)

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

  // Joint readout: prop wins, otherwise live store positions (radians → deg).
  const storePositions = useStore((s) => s.joints?.positions)
  let liveJointsDeg
  if (joints && joints.length >= 6) {
    liveJointsDeg = joints
  } else if (storePositions && storePositions.length >= 6) {
    liveJointsDeg = storePositions.slice(0, 6).map((rad) => (rad || 0) * 180 / Math.PI)
  } else {
    liveJointsDeg = [0, 0, 0, 0, 0, 0]
  }

  const applyPreset = (name) => {
    const pos = DEFAULT_PRESETS[name] ?? DEFAULT_PRESETS.iso
    const c = controlsRef.current
    if (!c) return
    c.object.position.set(pos[0], pos[1], pos[2])
    c.target.set(DEFAULT_ORBIT_TARGET[0], DEFAULT_ORBIT_TARGET[1], DEFAULT_ORBIT_TARGET[2])
    c.update()
  }
  useImperativeHandle(ref, () => ({ setCameraPreset(name) { applyPreset(name) } }))

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
        <ambientLight intensity={0.7} />
        <directionalLight position={[5, 10, 5]}  intensity={0.9} castShadow />
        <directionalLight position={[-5, 5, -5]} intensity={0.4} />
        <pointLight       position={[0, 3, 0]}   intensity={0.3} />
        <OrbitControls
          ref={controlsRef}
          enablePan enableZoom
          target={DEFAULT_ORBIT_TARGET}
          minDistance={0.5}
          maxDistance={20}
        />
        <gridHelper args={[4, 20, '#cccccc', '#e5e5e5']} />
        <URDFArm
          urdfUrl="/robot/urdf"
          onFlangeReady={setFlange}
          onStatus={setUrdfStatus}
          onLoaded={handleUrdfLoaded}
        />
        <CustomGripperModel url={gripperGlbUrl} flange={flange} />
        <BaselineCloudInScene onStatusChange={setBaselineStatus} />
        <CollisionScene3D showStatic={showStaticZones} />
        {children}
      </Canvas>
      {overlay}

      {/* Static keep-out zones toggle — top-left. Hidden when the
          collision payload has no baseline-static obstacles so the
          UI doesn't dangle a useless toggle. */}
      <StaticZonesToggle value={showStaticZones} onChange={setShowStaticZones} />

      {/* Baseline cloud status — inline notice for the empty / not-
          captured cases so the operator isn't staring at an empty
          scene wondering whether the system is broken. The success
          case (cloud rendered) only surfaces a tiny pt-count chip. */}
      <BaselineStatusNotice status={baselineStatus} />

      {/* Collision banner — centered at top */}
      <div style={{
        position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)',
        zIndex: 12, pointerEvents: 'none',
      }}>
        <CollisionBanner />
      </div>

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

      {/* Joint readout, top-right */}
      <div style={{
        position: 'absolute', top: 8, right: 8, padding: '8px 12px',
        background: 'rgba(255,255,255,0.95)', borderRadius: 8, fontSize: 12,
        fontFamily: 'var(--font-mono, monospace)', color: '#374151', zIndex: 10,
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
      }}>
        {JOINT_NAMES.map((name, i) => (
          <div key={name} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
            <span style={{ fontWeight: 600, color: JOINT_COLORS[i] }}>{name}</span>
            <span>{(liveJointsDeg[i] || 0).toFixed(1)}°</span>
          </div>
        ))}
      </div>

      {/* Status pill, bottom-right — DEV scaffolding. Hidden by default;
          reveal with ?debug=1 in the URL when diagnosing URDF or
          GLB-fetch issues. The pill used to display "URDF: loading /
          fetching URDF / GLB fetch 200 OK" in the normal view, which
          was distracting once the model loaded reliably. */}
      {(typeof window !== 'undefined' && /[?&]debug=1\b/.test(window.location.search)) && (
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
