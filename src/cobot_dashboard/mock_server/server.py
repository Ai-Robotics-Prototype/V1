"""
RoboAi Mock Server — standalone FastAPI, no ROS2.
Produces identical API / WebSocket / MJPEG interface as the real ROS2 server.
Run: python3 server.py
"""
import asyncio
import io
import json
import math
import os
import random
import time
from contextlib import asynccontextmanager
from typing import Set

import numpy as np
import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageDraw

# ── Simulation state ───────────────────────────────────────────────────────────

class SimState:
    def __init__(self):
        self._start = time.monotonic()
        self.estop = False
        self.task_override = None   # ("STATE", target) or None
        self.voice_log: list = []

    def _t(self) -> float:
        return time.monotonic() - self._start

    # Safety
    def zone(self) -> str:
        t = self._t() % 8.0
        if t < 3.5:   return "GREEN"
        if t < 6.5:   return "YELLOW"
        return "RED"

    def speed_scale(self) -> float:
        return {"GREEN": 1.0, "YELLOW": 0.25, "RED": 0.0}[self.zone()]

    def human_proximity(self) -> float:
        return 1.4 + 1.1 * math.sin(2 * math.pi * self._t() / 16.0)

    # Joints — 6-DOF, slow sinusoid, ±0.5 rad, staggered phases
    def joint_positions(self) -> list:
        t = self._t()
        return [round(0.5 * math.sin(2 * math.pi * t / 5.0 + i * 1.1), 4)
                for i in range(6)]

    def joint_velocities(self) -> list:
        return [round(random.gauss(0, 0.005), 5) for _ in range(6)]

    # Task state — 11 s cycle
    def task_state(self) -> tuple:
        if self.task_override:
            return self.task_override
        cycle = self._t() % 11.0
        if cycle < 3.0:  return ("IDLE",     None)
        if cycle < 5.0:  return ("APPROACH", None)
        if cycle < 7.0:  return ("PICK",     "bottle_01")
        if cycle < 9.0:  return ("PLACE",    "bottle_01")
        return ("HOME", None)

    # Cluster position — slow drift
    def cluster_pos(self) -> tuple:
        t = self._t()
        return (
            0.4 + 0.05 * math.sin(2 * math.pi * t / 20.0),
            0.2 + 0.03 * math.cos(2 * math.pi * t / 15.0),
        )

    def build_state_msg(self) -> dict:
        ts, tt = self.task_state()
        cx, cy = self.cluster_pos()
        return {
            "t": int(time.time() * 1000),
            "safety": {
                "zone":             self.zone(),
                "speed_scale":      self.speed_scale(),
                "estop":            self.estop,
                "human_proximity":  round(self.human_proximity(), 3),
            },
            "joints": {
                "names": ["shoulder_pan","shoulder_lift","elbow",
                          "wrist_1","wrist_2","wrist_3"],
                "positions":  self.joint_positions(),
                "velocities": self.joint_velocities(),
            },
            "task": {"state": ts, "target": tt},
            "detections": [
                {"id": 1, "class_name": "bottle", "score": 0.94,
                 "x": round(cx, 3), "y": round(cy, 3), "z": 0.8,
                 "w": 0.08, "l": 0.08, "h": 0.22},
                {"id": 2, "class_name": "box", "score": 0.87,
                 "x": -0.3, "y": 0.1, "z": 0.6,
                 "w": 0.3, "l": 0.2, "h": 0.15},
            ],
            "scene_graph": {
                "objects": [
                    {"id": "obj_001", "class": "bottle",
                     "pos": [round(cx,3), round(cy,3), 0.8],
                     "last_seen_ms": 120, "confidence": 0.94},
                    {"id": "obj_002", "class": "box",
                     "pos": [-0.3, 0.1, 0.6],
                     "last_seen_ms": 85,  "confidence": 0.87},
                ]
            },
        }

    def build_lidar_msg(self) -> dict:
        rng = np.random.default_rng(int(self._t() * 10) & 0xFFFFFFFF)
        # Flat ground plane — 3000 pts
        xp = rng.uniform(-2, 2, 3000).astype(np.float32)
        yp = rng.uniform(-2, 2, 3000).astype(np.float32)
        zp = rng.normal(0, 0.02, 3000).astype(np.float32)
        ip = rng.uniform(0.1, 0.4, 3000).astype(np.float32)
        # Bottle cluster — 500 pts
        cx, cy = self.cluster_pos()
        xb = rng.uniform(cx - 0.04, cx + 0.04, 500).astype(np.float32)
        yb = rng.uniform(cy - 0.04, cy + 0.04, 500).astype(np.float32)
        zb = rng.uniform(0.0, 0.8, 500).astype(np.float32)
        ib = rng.uniform(0.7, 1.0, 500).astype(np.float32)

        x = np.concatenate([xp, xb])
        y = np.concatenate([yp, yb])
        z = np.concatenate([zp, zb])
        intensity = np.concatenate([ip, ib])

        return {"points": [
            {"x": float(xi), "y": float(yi),
             "z": float(zi), "intensity": float(ii)}
            for xi, yi, zi, ii in zip(x, y, z, intensity)
        ]}


sim = SimState()

# ── WebSocket client sets ──────────────────────────────────────────────────────

state_clients: Set[WebSocket] = set()
lidar_clients: Set[WebSocket] = set()

# ── Background broadcast loops ─────────────────────────────────────────────────

async def _broadcast_state():
    while True:
        if state_clients:
            msg = json.dumps(sim.build_state_msg())
            dead = set()
            for ws in list(state_clients):
                try:
                    await ws.send_text(msg)
                except Exception:
                    dead.add(ws)
            state_clients.difference_update(dead)
        await asyncio.sleep(1 / 25)


async def _broadcast_lidar():
    while True:
        if lidar_clients:
            msg = json.dumps(sim.build_lidar_msg())
            dead = set()
            for ws in list(lidar_clients):
                try:
                    await ws.send_text(msg)
                except Exception:
                    dead.add(ws)
            lidar_clients.difference_update(dead)
        await asyncio.sleep(1 / 10)


@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(_broadcast_state())
    asyncio.create_task(_broadcast_lidar())
    yield


app = FastAPI(lifespan=lifespan)

# ── WebSocket endpoints ────────────────────────────────────────────────────────

@app.websocket("/ws/state")
async def ws_state(ws: WebSocket):
    await ws.accept()
    state_clients.add(ws)
    try:
        while True:
            try:
                await asyncio.wait_for(ws.receive_text(), timeout=5.0)
            except asyncio.TimeoutError:
                pass
    except (WebSocketDisconnect, Exception):
        state_clients.discard(ws)


@app.websocket("/ws/lidar")
async def ws_lidar(ws: WebSocket):
    await ws.accept()
    lidar_clients.add(ws)
    try:
        while True:
            try:
                await asyncio.wait_for(ws.receive_text(), timeout=5.0)
            except asyncio.TimeoutError:
                pass
    except (WebSocketDisconnect, Exception):
        lidar_clients.discard(ws)

# ── MJPEG helpers ──────────────────────────────────────────────────────────────

_BLUE   = (47, 127, 255)
_GREEN  = (0, 196, 122)

def _make_frame(cam_id: int, frame_n: int) -> bytes:
    W, H = 640, 480
    img = Image.new("RGB", (W, H), (28, 28, 30))
    d = ImageDraw.Draw(img)

    # Table surface
    d.rectangle([0, 285, W, H], fill=(42, 38, 34))
    for gx in range(0, W, 40):
        d.line([(gx, 285), (gx, H)], fill=(58, 52, 46), width=1)
    for gy in range(285, H, 32):
        d.line([(0, gy), (W, gy)], fill=(58, 52, 46), width=1)

    # Bottle — position tracks cluster
    cx, _ = sim.cluster_pos()
    bx = int(cx * 190 + 320)
    d.rectangle([bx - 16, 195, bx + 16, 285], fill=(90, 130, 195))
    d.ellipse   ([bx - 16, 188, bx + 16, 210], fill=(110, 150, 215))
    d.rectangle ([bx - 8,  174, bx + 8,  192], fill=(200, 75, 55))

    # Box
    d.rectangle([155, 242, 232, 285], fill=(155, 125, 85))

    # Detection bboxes
    d.rectangle([bx - 28, 170, bx + 28, 290], outline=_BLUE,  width=2)
    d.text((bx - 28, 156), "bottle 0.94", fill=_BLUE)
    d.rectangle([150, 236, 238, 291], outline=_GREEN, width=2)
    d.text((150, 222), "box 0.87", fill=_GREEN)

    # HUD
    ts = time.strftime("%H:%M:%S")
    d.text((10, 10), f"CAM{cam_id} MOCK", fill=(240, 240, 242))
    d.text((10, 26), f"{ts}  f={frame_n}", fill=(160, 160, 168))
    zone = sim.zone()
    zone_col = {"GREEN": (0,196,122), "YELLOW": (245,166,35), "RED": (255,59,59)}[zone]
    d.ellipse([W - 22, 10, W - 8, 24], fill=zone_col)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=75)
    return buf.getvalue()


async def _mjpeg_gen(cam_id: int):
    n = 0
    while True:
        frame = await asyncio.get_event_loop().run_in_executor(
            None, _make_frame, cam_id, n)
        n += 1
        yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
        await asyncio.sleep(1 / 15)


@app.get("/stream/cam0")
async def stream_cam0():
    return StreamingResponse(_mjpeg_gen(0),
        media_type="multipart/x-mixed-replace; boundary=frame")


@app.get("/stream/cam1")
async def stream_cam1():
    return StreamingResponse(_mjpeg_gen(1),
        media_type="multipart/x-mixed-replace; boundary=frame")

# ── Command endpoints ──────────────────────────────────────────────────────────

@app.post("/cmd/estop")
async def cmd_estop(body: dict):
    sim.estop = bool(body.get("active", False))
    print(f"[ESTOP] active={sim.estop}")
    return {"ok": True}


@app.post("/cmd/task")
async def cmd_task(body: dict):
    cmd = body.get("command", "")
    if cmd in ("resume", "go"):
        sim.task_override = None
    elif cmd == "pause":
        sim.task_override = ("PAUSED", None)
    elif cmd == "home":
        sim.task_override = ("HOME", None)
    print(f"[TASK] command={cmd!r}")
    return {"ok": True, "command": cmd}


@app.post("/cmd/voice")
async def cmd_voice(body: dict):
    text = body.get("text", "")
    sim.voice_log.append(text)
    print(f"[VOICE] {text!r}")
    return {"ok": True, "echo": text}


@app.post("/cmd/jog")
async def cmd_jog(body: dict):
    joint = body.get("joint", 0)
    delta = body.get("delta", 0.0)
    print(f"[JOG] joint={joint} delta={delta:.4f} rad")
    return {"ok": True}

# ── Info endpoints ─────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "ros": False, "mock": True}


@app.get("/api/config")
async def api_config():
    return {
        "mock": True,
        "robot_brand": "generic",
        "robot_ip": "192.168.1.10",
        "gripper_brand": "fake",
        "safety": {"zone_yellow_m": 1.2, "zone_red_m": 0.6, "estop_m": 0.3},
        "camera_streams": ["/stream/cam0", "/stream/cam1"],
    }

# ── Static / SPA fallback ──────────────────────────────────────────────────────

_DIST = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")

if os.path.isdir(os.path.join(_DIST, "assets")):
    app.mount("/assets", StaticFiles(directory=os.path.join(_DIST, "assets")),
              name="assets")


@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    index = os.path.join(_DIST, "index.html")
    if os.path.isfile(index):
        return FileResponse(index)
    return {"detail": "Frontend not built. Run: cd ../frontend && npm run build"}


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8080, reload=False, log_level="info")
