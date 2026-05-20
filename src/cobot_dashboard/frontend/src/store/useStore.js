import { create } from 'zustand'

const JOINT_LIMITS = [
  [-Math.PI,      Math.PI],
  [-Math.PI,      0],
  [-2.35619,      2.35619],
  [-Math.PI,      Math.PI],
  [-2.09440,      2.09440],
  [-2 * Math.PI,  2 * Math.PI],
]

export const useStore = create((set, get) => ({
  // ── Connection ───────────────────────────────────────────────────────
  connected: false,

  // ── Robot state (mirrors server broadcast) ───────────────────────────
  safety: {
    zone:            'UNKNOWN',
    speed_scale:      0,
    estop:            true,
    human_proximity:  99,
  },

  joints: {
    names:      ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'],
    positions:  [0, -1.5708, 0, -1.5708, 0, 0],
    velocities: [0, 0, 0, 0, 0, 0],
  },

  task: {
    state:   'IDLE',
    running: false,
    paused:  false,
  },

  tcpPose:    { x: 0, y: 0, z: 300, rx: 0, ry: 0, rz: 0 },
  detections: [],
  sceneGraph: { objects: [] },
  gripper:    { state: 'open', position_mm: 85 },

  // ── UI state ─────────────────────────────────────────────────────────
  mode:          'operator',   // 'operator' | 'engineer'
  jogEnabled:    false,
  selectedJoint: 0,

  // ── UI actions ────────────────────────────────────────────────────────
  setMode:          (mode)  => set({ mode }),
  enableJog:        ()      => set({ jogEnabled: true }),
  disableJog:       ()      => set({ jogEnabled: false }),
  setSelectedJoint: (j)     => set({ selectedJoint: j }),

  // ── Generic HTTP command wrapper ──────────────────────────────────────
  sendCommand: async (endpoint, body) => {
    try {
      const res = await fetch(`/cmd/${endpoint}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      return await res.json()
    } catch (e) {
      console.error('sendCommand error:', e)
      return { ok: false, error: e.message }
    }
  },

  // ── Optimistic jog with server sync ──────────────────────────────────
  jogJoint: async (joint, deltaRad) => {
    // 1. Optimistic update — move arm immediately in viewer
    const positions = [...get().joints.positions]
    const [lo, hi]  = JOINT_LIMITS[joint]
    positions[joint] = Math.max(lo, Math.min(hi, positions[joint] + deltaRad))
    set((s) => ({ joints: { ...s.joints, positions } }))

    // 2. Sync to server
    const result = await get().sendCommand('jog', { joint, delta: deltaRad })
    if (result?.ok && result.joints?.positions) {
      set((s) => ({ joints: { ...s.joints, positions: result.joints.positions } }))
    }
    return result
  },

  // ── WebSocket connection ──────────────────────────────────────────────
  connectWS: () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws    = new WebSocket(`${proto}://${location.host}/ws`)

    ws.onopen = () => set({ connected: true })

    ws.onclose = () => {
      set({ connected: false })
      setTimeout(() => get().connectWS(), 2000)
    }

    ws.onerror = () => ws.close()

    ws.onmessage = ({ data }) => {
      try {
        const d = JSON.parse(data)
        if (d.type === 'pong') return

        set({
          safety: {
            zone:            d.safety_zone      ?? 'UNKNOWN',
            speed_scale:     d.speed_scale       ?? 0,
            estop:           d.estop             ?? true,
            human_proximity: d.human_proximity   ?? 99,
          },
          joints: {
            names:      ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'],
            positions:  d.joint_positions   || [0, -1.5708, 0, -1.5708, 0, 0],
            velocities: d.joint_velocities  || [0, 0, 0, 0, 0, 0],
          },
          task: {
            state:   d.task_state  ?? 'IDLE',
            running: d.task_state  === 'RUNNING',
            paused:  d.task_state  === 'PAUSED',
          },
          tcpPose:    d.tcp_pose      ?? get().tcpPose,
          detections: d.detections    ?? [],
          sceneGraph: { objects: d.scene_objects ?? [] },
        })
      } catch (_) {}
    }

    // Keep-alive ping every 5 s
    const hb = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'ping' }))
    }, 5000)

    ws.addEventListener('close', () => clearInterval(hb))
  },
}))
