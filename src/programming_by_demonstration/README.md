# programming_by_demonstration

Video + voice → draft RoboAi program. The human shows and describes
the task; this package transcribes the voice locally, interprets the
demonstration through a pluggable understanding backend (currently
Anthropic Claude via API, on-Jetson local model later), and composes
a draft program that loads into the standard Program Library.

**Honest boundaries:** generated programs are drafts with placeholder
poses. Every pick/place pose carries `pose_status:
"awaiting_perception"`. They do not run until the perception stack
(MotionCam) resolves the metric poses on the real robot.

## Install

System deps (one time):
```bash
sudo apt-get install -y ffmpeg sqlite3
```

Python deps (per user — no torch beyond Whisper's CTranslate2 runtime):
```bash
pip3 install --user faster-whisper scikit-learn anthropic
```

## Config

`config/pbd_params.yaml` carries the defaults. Override per-deploy by
editing the file or setting environment variables read by the
dashboard (`ROBOAI_PBD_BACKEND`, `ROBOAI_PBD_API_MODEL`).

The Anthropic API key must come from the environment — never put it
in code or commit it. The systemd unit reads it from
`/etc/roboai/pbd.env`:

```
ANTHROPIC_API_KEY=sk-ant-XXXXXXXXXXXXXXXXXXX
ROBOAI_PBD_BACKEND=api
```

## Swapping backends

Two config knobs control the understanding model:

| Knob                              | Now     | Future  |
| --------------------------------- | ------- | ------- |
| `pbd_node.backend` (yaml)         | `api`   | `local` |
| `ROBOAI_PBD_BACKEND` (env, dash)  | `api`   | `local` |

Flipping the value swaps the entire interpreter — the rest of the
pipeline (transcription, retrieval, composition, learning store) is
untouched. The local backend is currently a stub that returns a
clearly-labelled "not yet trained" intent so callers see a well-formed
response instead of crashing.

## Data flow

```
        video.mp4 ──► /api/pbd/upload  ─► /opt/cobot/demonstrations/{demo_id}/
                                        │
                                        ▼
       ┌──────── local Whisper transcribe (faster-whisper)
       │
       ├──────── ffmpeg frame sample @ ~1 fps, capped
       │
       ├──────── retrieve_examples()  ◄── corrected past demos (TF-IDF + part/op boost)
       │
       └──────── understanding_backend.understand(frames, transcript, parts_lib,
                                                  ops, retrieved)
                                        │
                                        ▼ StructuredIntent
                          program_composer.compose_program_draft()
                                        │
                                        ▼ ProgramDraft  (placeholder poses)
                          ◄── operator review (Program tab UI)
                                        │
                                        ▼  Accept
        /opt/cobot/programs/{slug}.json   +    human_corrected.json
                                                  (training signal)
```

## Data provenance

Every demonstration directory carries `backend_used.json` recording
which model produced the interpretation and whether it transited
externally. The proprietary corpus
(`/opt/cobot/demonstrations/`) is **local only** — it is never sent
to the API. The API receives only the current demonstration's frames
and transcript, with the `anthropic-beta: zero-data-retention` header
when the account is enrolled.

## Endpoints

| Method | Path                                  | Purpose                                  |
| ------ | ------------------------------------- | ---------------------------------------- |
| POST   | `/api/pbd/upload`                     | Upload a video, mint a demo_id.          |
| POST   | `/api/pbd/generate`                   | Run the pipeline; return intent + draft. |
| GET    | `/api/pbd/list`                       | List indexed demonstrations.             |
| GET    | `/api/pbd/{demo_id}`                  | Fetch all files for one demo.            |
| POST   | `/api/pbd/{demo_id}/correct`          | Save corrected program + write back.     |
| GET    | `/api/pbd/dataset/stats`              | Corpus size, correction rate, coverage.  |
| GET    | `/api/pbd/dataset/export`             | JSONL training-bundle download.          |

## Smoke verify (no API key required)

```bash
source /opt/ros/humble/setup.bash
source /home/teddy/cobot_ws/install/setup.bash

cd src/programming_by_demonstration/test
python3 -c "
import test_compose
for n in dir(test_compose):
    if n.startswith('test_'):
        getattr(test_compose, n)(); print('PASS', n)
"
```

## Long-running service

```bash
sudo cp src/programming_by_demonstration/systemd/roboai-pbd.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now roboai-pbd
journalctl -u roboai-pbd -f
```
