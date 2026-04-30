import json
import threading
import time
import rclpy
from rclpy.node import Node
from std_msgs.msg import String, Bool, Float32
from sensor_msgs.msg import JointState
import math

try:
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect
    from fastapi.responses import HTMLResponse
    import uvicorn
    FASTAPI_AVAILABLE = True
except ImportError:
    FASTAPI_AVAILABLE = False

DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Cobot Dashboard</title>
<style>
  body { font-family: monospace; background: #1a1a2e; color: #eee; margin: 0; padding: 16px; }
  h1 { color: #e94560; margin: 0 0 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
  .panel { background: #16213e; border: 1px solid #0f3460; border-radius: 8px; padding: 14px; }
  .panel h2 { margin: 0 0 10px; font-size: 14px; color: #e94560; text-transform: uppercase; }
  .zone-green  { background: #1a4a1a; border-color: #00c851; }
  .zone-yellow { background: #4a4a1a; border-color: #ffbb33; }
  .zone-red    { background: #4a1a1a; border-color: #ff4444; }
  .big { font-size: 48px; font-weight: bold; text-align: center; padding: 10px; }
  .green  { color: #00c851; }
  .yellow { color: #ffbb33; }
  .red    { color: #ff4444; }
  .estop-active { animation: blink 0.5s step-start infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #0f3460; padding: 4px 8px; text-align: left; }
  th { background: #0f3460; }
  .bar-container { background: #333; border-radius: 4px; height: 14px; margin: 2px 0; }
  .bar { background: #e94560; height: 14px; border-radius: 4px; transition: width 0.3s; }
  .log-box { height: 160px; overflow-y: auto; font-size: 11px; background: #0d0d1a; padding: 8px; border-radius: 4px; }
  .log-info  { color: #aaa; }
  .log-warn  { color: #ffbb33; }
  .log-error { color: #ff4444; }
  #disconnected { display:none; position:fixed; top:0; left:0; right:0; background:#ff4444;
    color:#fff; text-align:center; padding:8px; font-size:18px; font-weight:bold; z-index:999; }
</style>
</head>
<body>
<div id="disconnected">⚠ DISCONNECTED — reconnecting...</div>
<h1>Cobot Dashboard</h1>
<div class="grid">

  <div class="panel" id="safety-panel">
    <h2>Safety Zone</h2>
    <div class="big" id="zone-label">—</div>
    <div>Proximity: <span id="proximity">—</span> m</div>
    <div>Speed: <span id="speed-scale">—</span></div>
    <div id="estop-label" style="font-size:20px;text-align:center;margin-top:8px">ESTOP: OFF</div>
  </div>

  <div class="panel">
    <h2>Task State</h2>
    <div class="big" id="task-state">—</div>
    <div>Target: <span id="task-target">—</span></div>
    <div>Position: <span id="task-pos">—</span></div>
    <div>Tasks: <span id="task-count">0</span> | Success: <span id="success-count">0</span></div>
  </div>

  <div class="panel">
    <h2>Scene Graph</h2>
    <table>
      <thead><tr><th>Class</th><th>Conf</th><th>X</th><th>Y</th><th>Z</th><th>Age</th></tr></thead>
      <tbody id="scene-table"></tbody>
    </table>
  </div>

  <div class="panel">
    <h2>Joint States</h2>
    <div id="joints-container"></div>
  </div>

  <div class="panel">
    <h2>System Log</h2>
    <div class="log-box" id="log-box"></div>
  </div>

</div>

<script>
let ws = null;
let logLines = [];

function connect() {
  ws = new WebSocket('ws://' + location.host + '/ws');
  ws.onopen = () => {
    document.getElementById('disconnected').style.display = 'none';
    addLog('WebSocket connected', 'info');
  };
  ws.onclose = () => {
    document.getElementById('disconnected').style.display = 'block';
    setTimeout(connect, 2000);
  };
  ws.onerror = () => {
    ws.close();
  };
  ws.onmessage = (ev) => {
    try { handleMessage(JSON.parse(ev.data)); } catch(e) {}
  };
}

function handleMessage(msg) {
  const topic = msg.topic;
  const data = msg.data;
  if (topic === '/safety/status') updateSafety(data);
  if (topic === '/task/status') updateTask(data);
  if (topic === '/perception/scene_graph') updateScene(data);
  if (topic === '/joint_states') updateJoints(data);
  addLog(topic + ': ' + JSON.stringify(data).slice(0, 80), 'info');
}

function updateSafety(d) {
  const zone = d.zone || '—';
  const el = document.getElementById('zone-label');
  el.textContent = zone;
  el.className = 'big ' + zone.toLowerCase();
  const panel = document.getElementById('safety-panel');
  panel.className = 'panel zone-' + zone.toLowerCase();
  document.getElementById('proximity').textContent = (d.proximity_m || 0).toFixed(2);
  document.getElementById('speed-scale').textContent = ((d.speed_scale || 0) * 100).toFixed(0) + '%';
  const estopEl = document.getElementById('estop-label');
  if (d.estop) {
    estopEl.textContent = 'ESTOP: ON';
    estopEl.className = 'red estop-active';
  } else {
    estopEl.textContent = 'ESTOP: OFF';
    estopEl.className = 'green';
  }
}

function updateTask(d) {
  document.getElementById('task-state').textContent = d.state || '—';
  document.getElementById('task-target').textContent = d.target_class || '—';
  const pos = d.target_position || {};
  document.getElementById('task-pos').textContent =
    pos.x !== undefined ? `(${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})` : '—';
  document.getElementById('task-count').textContent = d.task_count || 0;
  document.getElementById('success-count').textContent = d.success_count || 0;
}

function updateScene(d) {
  const tbody = document.getElementById('scene-table');
  const objects = typeof d === 'object' ? Object.values(d) : [];
  tbody.innerHTML = objects.slice(0, 20).map(obj => {
    const pos = obj.position || {};
    return `<tr>
      <td>${obj.class_id || ''}</td>
      <td>${(obj.confidence * 100 || 0).toFixed(0)}%</td>
      <td>${(pos.x || 0).toFixed(2)}</td>
      <td>${(pos.y || 0).toFixed(2)}</td>
      <td>${(pos.z || 0).toFixed(2)}</td>
      <td>${(obj.age_s || 0).toFixed(1)}s</td>
    </tr>`;
  }).join('');
}

function updateJoints(d) {
  const names = d.name || [];
  const positions = d.position || [];
  const container = document.getElementById('joints-container');
  container.innerHTML = names.map((name, i) => {
    const deg = ((positions[i] || 0) * 180 / Math.PI).toFixed(1);
    const pct = Math.min(100, Math.abs(positions[i] || 0) / Math.PI * 100);
    return `<div>${name}: ${deg}°
      <div class="bar-container"><div class="bar" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
}

function addLog(text, level) {
  logLines.push({text, level, time: new Date().toLocaleTimeString()});
  if (logLines.length > 20) logLines.shift();
  const box = document.getElementById('log-box');
  box.innerHTML = logLines.map(l =>
    `<div class="log-${l.level}">[${l.time}] ${l.text}</div>`
  ).join('');
  box.scrollTop = box.scrollHeight;
}

connect();
</script>
</body>
</html>
"""


class DashboardServer(Node):
    def __init__(self):
        super().__init__('dashboard_server')
        self._clients: list = []
        self._lock = threading.Lock()

        topics = [
            ('/safety/status', String),
            ('/task/status', String),
            ('/perception/scene_graph', String),
            ('/safety/speed_scale', Float32),
            ('/safety/estop', Bool),
        ]
        for topic, msg_type in topics:
            self.create_subscription(
                msg_type, topic,
                lambda msg, t=topic: self._broadcast(t, msg), 10)

        self.create_subscription(JointState, '/joint_states',
                                 lambda msg: self._broadcast('/joint_states', msg), 10)

    def _broadcast(self, topic: str, msg):
        if isinstance(msg, String):
            try:
                data = json.loads(msg.data)
            except Exception:
                data = msg.data
        elif isinstance(msg, Bool):
            data = msg.data
        elif isinstance(msg, Float32):
            data = msg.data
        elif isinstance(msg, JointState):
            data = {
                'name': list(msg.name),
                'position': list(msg.position),
            }
        else:
            data = str(msg)

        payload = json.dumps({
            'topic': topic,
            'data': data,
            'timestamp': time.time(),
        })
        with self._lock:
            dead = []
            for ws in self._clients:
                try:
                    ws._send_queue.append(payload)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self._clients.remove(ws)

    def register_ws(self, ws):
        with self._lock:
            self._clients.append(ws)

    def unregister_ws(self, ws):
        with self._lock:
            if ws in self._clients:
                self._clients.remove(ws)


_ros_node: DashboardServer = None

if FASTAPI_AVAILABLE:
    app = FastAPI()

    @app.get('/', response_class=HTMLResponse)
    async def index():
        return HTMLResponse(DASHBOARD_HTML)

    @app.websocket('/ws')
    async def websocket_endpoint(websocket: WebSocket):
        await websocket.accept()
        import asyncio
        queue: list = []
        websocket._send_queue = queue
        if _ros_node:
            _ros_node.register_ws(websocket)
        try:
            while True:
                while queue:
                    payload = queue.pop(0)
                    await websocket.send_text(payload)
                await asyncio.sleep(0.05)
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            if _ros_node:
                _ros_node.unregister_ws(websocket)


def _spin_ros(node):
    rclpy.spin(node)


def main(args=None):
    global _ros_node

    if not FASTAPI_AVAILABLE:
        print('FastAPI/uvicorn not installed. Install with: pip install fastapi uvicorn')
        return

    rclpy.init(args=args)
    _ros_node = DashboardServer()

    ros_thread = threading.Thread(target=_spin_ros, args=(_ros_node,), daemon=True)
    ros_thread.start()

    try:
        uvicorn.run(app, host='0.0.0.0', port=8080, log_level='warning')
    except KeyboardInterrupt:
        pass
    finally:
        _ros_node.destroy_node()
        rclpy.shutdown()
