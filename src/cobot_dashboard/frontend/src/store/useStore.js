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
  // ── Connection ────────────────────────────────────────────────────────────
  connected: false,

  // ── Robot state (mirrors server broadcast) ────────────────────────────────
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
    torques:    [0, 0, 0, 0, 0, 0],
  },

  task: {
    state:   'IDLE',
    running: false,
    paused:  false,
  },

  // tcp_pose: [x,y,z,rx,ry,rz] in metres (sim) / mm (ROS FK)
  tcp_pose: [0, 0, 0.5, 0, 0, 0],

  // tcpPose: object form kept for legacy RobotControls TcpPose sub-component
  tcpPose: { x: 0, y: 0, z: 0.5, rx: 0, ry: 0, rz: 0 },

  detections:  [],
  sceneGraph:  { objects: [] },

  gripper:      { state: 'open', position_mm: 85 },
  program:      { steps: [], name: 'Program 1' },
  robot:        { connected: false, brand: 'generic', ip: '192.168.1.10', error_code: 0, mode: 'idle' },
  saved_points: [],
  system:       { ros2: false, mock: true, uptime_s: 0 },
  speed_override: 100,

  // ── UI state ──────────────────────────────────────────────────────────────
  mode:          'operator',
  jogEnabled:    false,
  selectedJoint: 0,

  // ── Toast notifications ───────────────────────────────────────────────────
  toasts: [],

  // ── UI actions ────────────────────────────────────────────────────────────
  setMode:          (mode)  => set({ mode }),
  enableJog:        ()      => set({ jogEnabled: true }),
  disableJog:       ()      => set({ jogEnabled: false }),
  setSelectedJoint: (j)     => set({ selectedJoint: j }),

  addToast: (message, type = 'info') => set((s) => ({
    toasts: [...s.toasts.slice(-3), { id: Date.now(), message, type }],
  })),
  dismissToast: (id) => set((s) => ({
    toasts: s.toasts.filter((t) => t.id !== id),
  })),

  // ── E-Stop shortcuts ──────────────────────────────────────────────────────
  triggerEstop: async () => {
    return get().sendCommand('estop', { active: true })
  },
  releaseEstop: async () => {
    return get().sendCommand('estop', { active: false })
  },
  homeRobot: async () => {
    return get().sendCommand('task', { command: 'home' })
  },

  // ── Generic HTTP command wrapper ──────────────────────────────────────────
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

  // ── Optimistic jog with server sync ──────────────────────────────────────
  jogJoint: async (joint, deltaRad) => {
    const positions = [...get().joints.positions]
    const [lo, hi]  = JOINT_LIMITS[joint]
    positions[joint] = Math.max(lo, Math.min(hi, positions[joint] + deltaRad))
    set((s) => ({ joints: { ...s.joints, positions } }))

    const result = await get().sendCommand('jog', { joint, delta: deltaRad })
    if (result?.ok && result.joints?.positions) {
      set((s) => ({ joints: { ...s.joints, positions: result.joints.positions } }))
    }
    return result
  },

  // ── WebSocket connection ──────────────────────────────────────────────────
  connectWS: () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws    = new WebSocket(`${proto}://${location.host}/ws/state`)

    ws.onopen  = () => set({ connected: true })
    ws.onclose = () => {
      set({ connected: false })
      setTimeout(() => get().connectWS(), 2000)
    }
    ws.onerror = () => ws.close()

    ws.onmessage = ({ data }) => {
      try {
        const d = JSON.parse(data)
        if (d.ping) return

        // tcp_pose arrives as [x,y,z,rx,ry,rz] array
        const tcp = Array.isArray(d.tcp_pose) ? d.tcp_pose : null

        set({
          safety:       d.safety      ?? get().safety,
          joints:       d.joints      ?? get().joints,
          task:         d.task        ?? get().task,
          tcp_pose:     tcp           ?? get().tcp_pose,
          tcpPose:      tcp ? { x: tcp[0], y: tcp[1], z: tcp[2], rx: tcp[3], ry: tcp[4], rz: tcp[5] }
                            : get().tcpPose,
          detections:   d.detections  ?? get().detections,
          sceneGraph:   d.scene_graph ? { objects: d.scene_graph.objects ?? [] }
                                      : get().sceneGraph,
          gripper:      d.gripper      ?? get().gripper,
          program:      d.program      ?? get().program,
          robot:        d.robot        ?? get().robot,
          saved_points: d.saved_points ?? get().saved_points,
          system:       d.system       ?? get().system,
          speed_override: d.speed_override ?? get().speed_override,
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
