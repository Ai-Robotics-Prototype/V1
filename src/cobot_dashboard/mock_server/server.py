"""RoboAi mock server — zero ROS2, identical API to production."""
import asyncio
import copy
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
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
STATE = {
    "safety": {"zone": "GREEN", "speed_scale": 1.0, "estop": False, "human_proximity": 2.4},
    "joints": {
        "names": ["J1", "J2", "J3", "J4", "J5", "J6"],
        "positions": [0.0, -1.571, 0.785, -0.785, 0.0, 0.209],
        "velocities": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    },
    "task": {
        "state": "IDLE",
        "target": None,
        "program_step": 0,
        "program_total": 5,
        "running": False,
        "paused": False,
    },
    "detections": [
        {"id": 1, "class_name": "bottle", "score": 0.94, "x": 0.4, "y": 0.2, "z": 0.8, "w": 0.08, "l": 0.08, "h": 0.22},
        {"id": 2, "class_name": "box", "score": 0.87, "x": -0.3, "y": 0.1, "z": 0.6, "w": 0.3, "l": 0.2, "h": 0.15},
    ],
    "scene_graph": {
        "objects": [
            {"id": "obj_001", "class_name": "bottle", "position": [0.4, 0.2, 0.8], "last_seen_ms": 120, "score": 0.94},
            {"id": "obj_002", "class_name": "box",    "position": [-0.3, 0.1, 0.6], "last_seen_ms": 85,  "score": 0.87},
        ]
    },
    "gripper": {"state": "open", "position_mm": 85.0},
    "program": {
        "steps": [
            {"id": 1, "type": "home", "label": "Move to home", "detail": "J: [0,−90,0,−90,0,0]°", "status": "done"},
            {"id": 2, "type": "gripper", "label": "Open gripper", "detail": "Width: 85 mm · Speed: 80%", "status": "active"},
            {"id": 3, "type": "move", "label": "Approach object", "detail": "Target: bottle · offset +150 mm Z", "status": "pending"},
            {"id": 4, "type": "gripper", "label": "Pick — descend & close", "detail": "Descend 130 mm · Close gripper", "status": "pending"},
            {"id": 5, "type": "move", "label": "Place at target", "detail": "X: 0.30 · Y: −0.20 · Z: 0.40 m", "status": "pending"},
        ]
    },
}

# Internal simulation variables
_start_time = time.time()
_step_start_time: float = 0.0
_step_durations = {"home": 2.0, "gripper": 1.0, "move": 2.5, "wait": 1.5}
_HOME_JOINTS = [0.0, -1.571, 0.0, -1.571, 0.0, 0.0]
_random_target_joints: list = [0.3, -1.2, 0.6, -0.9, 0.4, 0.5]
_going_home: bool = False

# WebSocket client registries
state_clients: dict = {}   # WebSocket -> asyncio.Queue
lidar_clients: dict = {}   # WebSocket -> asyncio.Queue


# ---------------------------------------------------------------------------
# Simulation helpers
# ---------------------------------------------------------------------------

def _lerp_joints(current: list, target: list, factor: float) -> list:
    return [c + (t - c) * factor for c, t in zip(current, target)]


def _clamp_joints(positions: list) -> list:
    limits = [
        (-3.14, 3.14),
        (-3.14, 0.0),
        (-2.35, 2.35),
        (-3.14, 3.14),
        (-2.09, 2.09),
        (-6.28, 6.28),
    ]
    return [max(lo, min(hi, p)) for p, (lo, hi) in zip(positions, limits)]


# ---------------------------------------------------------------------------
# Simulation loop (25 Hz)
# ---------------------------------------------------------------------------

async def simulation_loop():
    global _step_start_time, _random_target_joints, _going_home

    while True:
        await asyncio.sleep(1 / 25)
        t = time.time() - _start_time
        joints = list(STATE["joints"]["positions"])

        # --- Proximity + zone ---
        # Stays in GREEN (1.6–2.4 m) — simulates no person nearby.
        # E-Stop can still be triggered manually via the toolbar button.
        proximity = 2.0 + 0.4 * math.sin(t / 10.0)
        STATE["safety"]["human_proximity"] = round(proximity, 3)

        # Zone always reflects actual proximity (informational, independent of estop latch)
        if proximity > 1.2:
            STATE["safety"]["zone"] = "GREEN"
        elif proximity >= 0.6:
            STATE["safety"]["zone"] = "YELLOW"
        else:
            STATE["safety"]["zone"] = "RED"

        if not STATE["safety"]["estop"]:
            # Speed scale tracks zone when estop is not active
            if proximity > 1.2:
                STATE["safety"]["speed_scale"] = 1.0
            elif proximity >= 0.6:
                STATE["safety"]["speed_scale"] = 0.25
            else:
                STATE["safety"]["speed_scale"] = 0.0
                # Auto-latch estop only when not already active
                if proximity < 0.3:
                    STATE["safety"]["estop"] = True
                    STATE["task"]["running"] = False
                    if STATE["task"]["state"] not in ("IDLE", "PAUSED"):
                        STATE["task"]["state"] = "PAUSED"

        # --- Person detection ---
        if proximity < 1.0:
            if not any(d["id"] == 3 for d in STATE["detections"]):
                STATE["detections"].append({
                    "id": 3, "class_name": "person", "score": 0.91,
                    "x": 0.0, "y": proximity * 0.5, "z": 1.0,
                    "w": 0.5, "l": 0.3, "h": 1.7,
                })
        else:
            STATE["detections"] = [d for d in STATE["detections"] if d["id"] != 3]

        # --- Joint animation ---
        new_pos = list(joints)

        if STATE["safety"]["estop"] or STATE["task"]["paused"]:
            STATE["joints"]["velocities"] = [0.0] * 6

        elif _going_home:
            new_pos = _lerp_joints(joints, _HOME_JOINTS, 0.06)
            STATE["joints"]["velocities"] = [(new_pos[i] - joints[i]) * 25 for i in range(6)]
            STATE["joints"]["positions"] = new_pos
            if all(abs(new_pos[i] - _HOME_JOINTS[i]) < 0.005 for i in range(6)):
                STATE["joints"]["positions"] = list(_HOME_JOINTS)
                STATE["joints"]["velocities"] = [0.0] * 6
                _going_home = False
                STATE["task"]["state"] = "IDLE"
            continue  # skip rest of loop body for joints

        elif STATE["task"]["running"]:
            steps = STATE["program"]["steps"]
            step_idx = STATE["task"]["program_step"]
            if step_idx < len(steps):
                step = steps[step_idx]
                elapsed = t - _step_start_time
                step_type = step["type"]
                duration = _step_durations.get(step_type, 2.0)

                if step_type == "home":
                    new_pos = _lerp_joints(joints, _HOME_JOINTS, 0.06)
                elif step_type == "move":
                    new_pos = _lerp_joints(joints, _random_target_joints, 0.04)
                elif step_type == "gripper":
                    if "close" in step["label"].lower() or "pick" in step["label"].lower():
                        STATE["gripper"]["position_mm"] = max(0.0, STATE["gripper"]["position_mm"] - 2.5)
                        if STATE["gripper"]["position_mm"] <= 0.0:
                            STATE["gripper"]["state"] = "closed"
                    else:
                        STATE["gripper"]["position_mm"] = min(85.0, STATE["gripper"]["position_mm"] + 2.5)
                        if STATE["gripper"]["position_mm"] >= 85.0:
                            STATE["gripper"]["state"] = "open"
                    new_pos = joints

                STATE["joints"]["velocities"] = [(new_pos[i] - joints[i]) * 25 for i in range(6)]
                STATE["joints"]["positions"] = _clamp_joints(new_pos)

                if elapsed >= duration:
                    steps[step_idx]["status"] = "done"
                    next_idx = step_idx + 1
                    if next_idx < len(steps):
                        steps[next_idx]["status"] = "active"
                        STATE["task"]["program_step"] = next_idx
                        _step_start_time = t
                        if steps[next_idx]["type"] == "move":
                            _random_target_joints = [
                                random.uniform(-0.8, 0.8),
                                random.uniform(-2.2, -0.8),
                                random.uniform(-1.0, 1.0),
                                random.uniform(-2.0, -0.5),
                                random.uniform(-0.8, 0.8),
                                random.uniform(-1.0, 1.0),
                            ]
                    else:
                        STATE["task"]["running"] = False
                        STATE["task"]["state"] = "IDLE"
                        STATE["task"]["program_step"] = 0
                        for s in steps:
                            s["status"] = "pending"
                        if steps:
                            steps[0]["status"] = "done"
                        if len(steps) > 1:
                            steps[1]["status"] = "active"

        else:
            # Idle oscillation
            offsets = [0.0, -1.571, 0.785, -0.785, 0.0, 0.209]
            new_pos = [offsets[i] + 0.4 * math.sin(t * 0.3 + i * 0.9) for i in range(6)]
            new_pos = _clamp_joints(new_pos)
            STATE["joints"]["velocities"] = [(new_pos[i] - joints[i]) * 25 for i in range(6)]
            STATE["joints"]["positions"] = new_pos

        # --- Scene graph drift ---
        for obj in STATE["scene_graph"]["objects"]:
            obj["position"][0] += random.uniform(-0.002, 0.002)
            obj["position"][1] += random.uniform(-0.002, 0.002)
            obj["position"][2] += random.uniform(-0.001, 0.001)
            obj["last_seen_ms"] += int(1000 / 25)

        # --- Broadcast state ---
        msg = {**copy.deepcopy(STATE), "t": time.time() * 1000}
        for ws, q in list(state_clients.items()):
            if q.qsize() < 2:
                try:
                    await q.put(msg)
                except Exception:
                    pass

        # --- Broadcast LiDAR ---
        if lidar_clients:
            lidar_msg = _generate_lidar_frame(t)
            for ws, q in list(lidar_clients.items()):
                if q.qsize() < 2:
                    try:
                        await q.put(lidar_msg)
                    except Exception:
                        pass


def _generate_lidar_frame(t: float) -> dict:
    """Generate a simulated LiDAR point cloud."""
    points = []
    # Floor plane
    for _ in range(200):
        points.append({"x": round(random.uniform(-3, 3), 3),
                        "y": round(random.uniform(-3, 3), 3),
                        "z": round(random.uniform(-0.05, 0.05), 3)})
    # Walls / objects
    for _ in range(80):
        angle = random.uniform(0, 2 * math.pi)
        r = random.uniform(0.8, 2.5)
        points.append({"x": round(r * math.cos(angle), 3),
                        "y": round(r * math.sin(angle), 3),
                        "z": round(random.uniform(0.0, 1.5), 3)})
    # Moving person blob
    px = 1.5 * math.cos(t * 0.4)
    py = 1.5 * math.sin(t * 0.4)
    for _ in range(30):
        points.append({"x": round(px + random.gauss(0, 0.05), 3),
                        "y": round(py + random.gauss(0, 0.05), 3),
                        "z": round(random.uniform(0.0, 1.7), 3)})
    return {"points": points, "live": False, "t": time.time() * 1000}


# ---------------------------------------------------------------------------
# MJPEG frame generation
# ---------------------------------------------------------------------------

def _generate_camera_frame(cam: int) -> bytes:
    """Generate a simulated camera frame using Pillow."""
    width, height = 640, 480
    img = Image.new("RGB", (width, height), color=(10, 13, 18))
    draw = ImageDraw.Draw(img)

    # Table trapezoid
    table_poly = [(80, 380), (560, 380), (480, 240), (160, 240)]
    draw.polygon(table_poly, fill=(26, 26, 30))
    draw.line(table_poly + [table_poly[0]], fill=(50, 50, 60), width=1)

    # Cam1 uses slight x offset to simulate different angle
    x_scale = 0.85 if cam == 1 else 1.0

    fx, fy = 615, 615
    cx_center, cy_center = 320, 240

    for det in STATE["detections"]:
        if det["z"] <= 0:
            continue
        u = int((det["x"] * x_scale / det["z"]) * fx + cx_center)
        v = int((-det["y"] / det["z"]) * fy + cy_center)
        bw = max(int((det["w"] / det["z"]) * fx), 8)
        bh = max(int((det["h"] / det["z"]) * fy), 8)

        x0, y0 = u - bw // 2, v - bh // 2
        x1, y1 = u + bw // 2, v + bh // 2

        cls = det["class_name"]
        if cls == "bottle":
            fill = (30, 58, 95)
            outline = (59, 130, 246)
        elif cls == "box":
            fill = (26, 58, 26)
            outline = (34, 197, 94)
        elif cls == "person":
            fill = (58, 26, 26)
            outline = (239, 68, 68)
            draw.ellipse([x0, y0, x1, y1], fill=fill, outline=outline, width=2)
            draw.text((x0, max(y0 - 14, 0)), f"person {det['score']:.2f}", fill=(239, 68, 68))
            continue
        else:
            fill = (30, 30, 40)
            outline = (154, 154, 158)

        draw.rectangle([x0, y0, x1, y1], fill=fill, outline=outline, width=2)
        draw.text((x0, max(y0 - 14, 0)), f"{cls} {det['score']:.2f}", fill=outline)

    # Bottom-left label
    draw.text((8, height - 20), f"CAM{cam} MOCK · 15fps", fill=(200, 200, 200))

    # Zone dot top-right
    zone = STATE["safety"]["zone"]
    dot_color = {"GREEN": (34, 197, 94), "YELLOW": (234, 179, 8), "RED": (239, 68, 68)}.get(zone, (154, 154, 158))
    draw.ellipse([width - 20, 8, width - 8, 20], fill=dot_color)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=75)
    return buf.getvalue()


async def _mjpeg_generator(cam: int):
    """Async generator that yields MJPEG frames at ~15 fps."""
    while True:
        try:
            frame = _generate_camera_frame(cam)
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n"
                b"Content-Length: " + str(len(frame)).encode() + b"\r\n\r\n"
                + frame + b"\r\n"
            )
            await asyncio.sleep(1 / 15)
        except Exception:
            break


# ---------------------------------------------------------------------------
# FastAPI lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(simulation_loop())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="RoboAi Mock Server", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# WebSocket endpoints
# ---------------------------------------------------------------------------

@app.websocket("/ws/state")
async def ws_state(websocket: WebSocket):
    await websocket.accept()
    q: asyncio.Queue = asyncio.Queue(maxsize=2)
    state_clients[websocket] = q
    try:
        while True:
            msg = await q.get()
            await websocket.send_text(json.dumps(msg))
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        state_clients.pop(websocket, None)


@app.websocket("/ws/lidar")
async def ws_lidar(websocket: WebSocket):
    await websocket.accept()
    q: asyncio.Queue = asyncio.Queue(maxsize=2)
    lidar_clients[websocket] = q
    try:
        while True:
            msg = await q.get()
            await websocket.send_text(json.dumps(msg))
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        lidar_clients.pop(websocket, None)


# ---------------------------------------------------------------------------
# MJPEG stream endpoints
# ---------------------------------------------------------------------------

@app.get("/stream/cam0")
async def stream_cam0():
    return StreamingResponse(
        _mjpeg_generator(0),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@app.get("/stream/cam1")
async def stream_cam1():
    return StreamingResponse(
        _mjpeg_generator(1),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


# ---------------------------------------------------------------------------
# Command endpoints
# ---------------------------------------------------------------------------

@app.post("/cmd/estop")
async def cmd_estop(request: Request):
    body = await request.json()
    active   = bool(body.get("active", True))
    override = bool(body.get("override", False))   # red-zone override flag
    if active:
        was_running = STATE["task"]["running"]
        STATE["safety"]["estop"] = True
        STATE["safety"]["speed_scale"] = 0.0
        STATE["task"]["running"] = False
        if was_running:
            STATE["task"]["state"] = "PAUSED"
        return {"ok": True, "safety": STATE["safety"]}
    # Release path
    zone = STATE["safety"]["zone"]
    if zone != "GREEN" and not override:
        return JSONResponse(
            {"error": f"Cannot release estop: zone is {zone}. Use override=true to force."},
            status_code=400,
        )
    if override and zone != "GREEN":
        # Log clearly — override in non-green zone
        print(f"[ESTOP OVERRIDE] Released in {zone} zone ({STATE['safety']['human_proximity']:.2f} m)")
        STATE["safety"]["estop"] = False
        STATE["safety"]["speed_scale"] = 0.0   # keep speed at 0 — zone logic restores it
        return {"ok": True, "override": True, "zone": zone, "safety": STATE["safety"]}
    STATE["safety"]["estop"] = False
    STATE["safety"]["speed_scale"] = 1.0
    return {"ok": True, "safety": STATE["safety"]}


@app.post("/cmd/task")
async def cmd_task(request: Request):
    global _step_start_time, _going_home
    body = await request.json()
    command = body.get("command", "")
    t = time.time() - _start_time

    if command == "run":
        if STATE["safety"]["estop"]:
            return JSONResponse({"error": "Cannot run: estop active"}, status_code=400)
        if STATE["task"]["running"]:
            return JSONResponse({"error": "Already running"}, status_code=400)
        STATE["task"]["running"] = True
        STATE["task"]["paused"] = False
        STATE["task"]["state"] = "APPROACH"
        STATE["task"]["program_step"] = 0
        for s in STATE["program"]["steps"]:
            s["status"] = "pending"
        if STATE["program"]["steps"]:
            STATE["program"]["steps"][0]["status"] = "active"
        _step_start_time = t

    elif command == "pause":
        STATE["task"]["paused"] = True
        STATE["task"]["state"] = "PAUSED"

    elif command == "resume":
        if STATE["safety"]["estop"]:
            return JSONResponse({"error": "Cannot resume: estop active"}, status_code=400)
        STATE["task"]["paused"] = False
        STATE["task"]["state"] = "APPROACH"

    elif command == "home":
        STATE["task"]["running"] = False
        STATE["task"]["paused"] = False
        STATE["task"]["state"] = "HOME"
        _going_home = True

    elif command in ("cancel", "stop"):
        STATE["task"]["running"] = False
        STATE["task"]["paused"] = False
        STATE["task"]["state"] = "IDLE"
        _going_home = False
        for s in STATE["program"]["steps"]:
            s["status"] = "pending"

    return {"ok": True, "task": STATE["task"]}


@app.post("/cmd/jog")
async def cmd_jog(request: Request):
    body = await request.json()
    if STATE["safety"]["estop"]:
        return JSONResponse({"error": "Cannot jog: estop active"}, status_code=400)
    if STATE["safety"]["zone"] != "GREEN":
        return JSONResponse({"error": "Cannot jog: zone is not GREEN"}, status_code=400)
    joint = int(body.get("joint", 0))
    delta = float(body.get("delta", 0.0))
    if abs(delta) > 0.175:
        return JSONResponse({"error": "Delta too large (max 10°)"}, status_code=400)
    if not (0 <= joint <= 5):
        return JSONResponse({"error": "Invalid joint index"}, status_code=400)
    STATE["joints"]["positions"][joint] += delta
    STATE["joints"]["positions"] = _clamp_joints(STATE["joints"]["positions"])
    return {"ok": True, "joints": STATE["joints"]}


@app.post("/cmd/gripper")
async def cmd_gripper(request: Request):
    body = await request.json()
    if STATE["safety"]["estop"]:
        return JSONResponse({"error": "Cannot move gripper: estop active"}, status_code=400)
    action = body.get("action", "open")
    width_mm = body.get("width_mm", None)
    STATE["gripper"]["state"] = "moving"
    if width_mm is not None:
        STATE["gripper"]["position_mm"] = float(width_mm)

    async def _finish():
        await asyncio.sleep(0.8)
        if action == "open":
            STATE["gripper"]["state"] = "open"
            if width_mm is None:
                STATE["gripper"]["position_mm"] = 85.0
        else:
            STATE["gripper"]["state"] = "closed"
            if width_mm is None:
                STATE["gripper"]["position_mm"] = 0.0

    asyncio.create_task(_finish())
    return {"ok": True, "gripper": STATE["gripper"]}


@app.post("/cmd/voice")
async def cmd_voice(request: Request):
    global _going_home, _step_start_time
    body = await request.json()
    text = body.get("text", "").lower().strip()
    action_taken = f"Unrecognized command: {text}"

    if "estop" in text or "e-stop" in text or "emergency" in text:
        was_running = STATE["task"]["running"]
        STATE["safety"]["estop"] = True
        STATE["safety"]["speed_scale"] = 0.0
        STATE["task"]["running"] = False
        if was_running:
            STATE["task"]["state"] = "PAUSED"
        action_taken = "Emergency stop triggered"
    elif "open gripper" in text:
        if not STATE["safety"]["estop"]:
            STATE["gripper"]["state"] = "moving"
            asyncio.create_task(_delayed_gripper_open())
            action_taken = "Gripper opening"
        else:
            action_taken = "Cannot open gripper: estop active"
    elif "close gripper" in text:
        if not STATE["safety"]["estop"]:
            STATE["gripper"]["state"] = "moving"
            asyncio.create_task(_delayed_gripper_close())
            action_taken = "Gripper closing"
        else:
            action_taken = "Cannot close gripper: estop active"
    elif "home" in text:
        STATE["task"]["running"] = False
        STATE["task"]["paused"] = False
        STATE["task"]["state"] = "HOME"
        _going_home = True
        action_taken = "Moving to home position"
    elif "pause" in text:
        STATE["task"]["paused"] = True
        STATE["task"]["state"] = "PAUSED"
        action_taken = "Program paused"
    elif "run" in text or "start" in text:
        if STATE["safety"]["estop"]:
            action_taken = "Cannot start: estop active"
        elif STATE["task"]["running"]:
            action_taken = "Already running"
        else:
            STATE["task"]["running"] = True
            STATE["task"]["paused"] = False
            STATE["task"]["state"] = "APPROACH"
            STATE["task"]["program_step"] = 0
            for s in STATE["program"]["steps"]:
                s["status"] = "pending"
            if STATE["program"]["steps"]:
                STATE["program"]["steps"][0]["status"] = "active"
            _step_start_time = time.time() - _start_time
            action_taken = "Program started"
    elif "stop" in text or "cancel" in text:
        STATE["task"]["running"] = False
        STATE["task"]["paused"] = False
        STATE["task"]["state"] = "IDLE"
        for s in STATE["program"]["steps"]:
            s["status"] = "pending"
        action_taken = "Program stopped"

    return {"ok": True, "response": action_taken}


async def _delayed_gripper_open():
    await asyncio.sleep(0.8)
    STATE["gripper"]["state"] = "open"
    STATE["gripper"]["position_mm"] = 85.0


async def _delayed_gripper_close():
    await asyncio.sleep(0.8)
    STATE["gripper"]["state"] = "closed"
    STATE["gripper"]["position_mm"] = 0.0


@app.post("/cmd/program/add")
async def cmd_program_add(request: Request):
    body = await request.json()
    steps = STATE["program"]["steps"]
    next_id = max((s["id"] for s in steps), default=0) + 1
    steps.append({
        "id": next_id,
        "type": body.get("type", "move"),
        "label": body.get("label", "New step"),
        "detail": body.get("detail", ""),
        "status": "pending",
    })
    return {"ok": True, "program": STATE["program"]}


@app.post("/cmd/program/remove")
async def cmd_program_remove(request: Request):
    body = await request.json()
    step_id = int(body.get("id", -1))
    steps = STATE["program"]["steps"]
    target = next((s for s in steps if s["id"] == step_id), None)
    if target is None:
        return JSONResponse({"error": f"Step {step_id} not found"}, status_code=404)
    if target["status"] == "active":
        return JSONResponse({"error": "Cannot remove active step"}, status_code=400)
    STATE["program"]["steps"] = [s for s in steps if s["id"] != step_id]
    return {"ok": True, "program": STATE["program"]}


@app.post("/cmd/program/reorder")
async def cmd_program_reorder(request: Request):
    body = await request.json()
    ids = body.get("ids", [])
    id_map = {s["id"]: s for s in STATE["program"]["steps"]}
    reordered = [id_map[i] for i in ids if i in id_map]
    included = set(ids)
    for s in STATE["program"]["steps"]:
        if s["id"] not in included:
            reordered.append(s)
    STATE["program"]["steps"] = reordered
    return {"ok": True, "program": STATE["program"]}


# ---------------------------------------------------------------------------
# Info endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "ros": False,
        "mock": True,
        "uptime_s": round(time.time() - _start_time, 1),
        "clients_state": len(state_clients),
        "clients_lidar": len(lidar_clients),
    }


@app.get("/api/config")
async def api_config():
    return {
        "robot": {
            "brand": "generic",
            "ip": "192.168.1.246",
            "port": 502,
            "dof": 6,
            "payload_kg": 5.0,
            "reach_mm": 850,
        },
        "cameras": [
            {"id": 0, "topic": "/camera/cam0/image_raw", "fps": 15},
            {"id": 1, "topic": "/camera/cam1/image_raw", "fps": 15},
        ],
        "safety": {
            "zone_red_m": 0.6,
            "zone_yellow_m": 1.2,
            "zone_green_m": 2.0,
        },
        "version": "1.0.0-mock",
    }


@app.get("/api/state")
async def api_state():
    return copy.deepcopy(STATE)


# ---------------------------------------------------------------------------
# Static file serving (SPA fallback)
# ---------------------------------------------------------------------------

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_static_dir = os.path.join(_THIS_DIR, "static")
_frontend_dist = os.path.join(_THIS_DIR, "..", "frontend", "dist")

_serve_dir = None
if os.path.isdir(_static_dir):
    _serve_dir = _static_dir
elif os.path.isdir(_frontend_dist):
    _serve_dir = _frontend_dist

if _serve_dir:
    _assets = os.path.join(_serve_dir, "assets")
    if os.path.isdir(_assets):
        app.mount("/assets", StaticFiles(directory=_assets), name="assets")

    @app.get("/")
    async def serve_index():
        idx = os.path.join(_serve_dir, "index.html")
        if os.path.isfile(idx):
            return FileResponse(idx)
        return JSONResponse({"detail": "Frontend not built"}, status_code=404)

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        if full_path.startswith(("api/", "cmd/", "ws/", "stream/", "health")):
            return JSONResponse({"detail": "Not found"}, status_code=404)
        candidate = os.path.join(_serve_dir, full_path)
        if os.path.isfile(candidate):
            return FileResponse(candidate)
        idx = os.path.join(_serve_dir, "index.html")
        if os.path.isfile(idx):
            return FileResponse(idx)
        return JSONResponse({"detail": "Frontend not built"}, status_code=404)
else:
    @app.get("/")
    async def serve_index_fallback():
        return JSONResponse(
            {"detail": "Frontend not built. Run: cd frontend && npm run build"}
        )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8080, reload=False)
