import json, time
import websockets.sync.client as ws

URL = "ws://192.168.2.136:9000/"
OUT = f"estun_posture_{time.strftime('%Y%m%d_%H%M%S')}.jsonl"
conn = ws.connect(URL, open_timeout=5, origin="http://192.168.2.136:9198")
print(f"Connected {URL} -> {OUT}")

def send(o): conn.send(json.dumps(o, separators=(",",":")))
for t in ["web","WebCommand","Error","ProjectState","RobotStatus",
          "RobotPosture","RobotCoordinate","ProjectStatus"]:
    send({"ty": f"publish/{t}"})

n=post=0; t0=time.time()
with open(OUT,"w",encoding="utf-8") as f:
    try:
        while True:
            try: m=conn.recv(timeout=5)
            except TimeoutError: conn.send("ping"); continue
            if m=="ping": conn.send("pong"); continue
            if m=="pong": continue
            f.write(m+"\n"); n+=1
            if '"publish/RobotPosture"' in m:
                post+=1
                if post<=3 or post%50==0: print(f"[posture {post}] {m[:150]}")
    except KeyboardInterrupt: pass
print(f"\n{n} frames ({post} posture) in {time.time()-t0:.0f}s -> {OUT}")
