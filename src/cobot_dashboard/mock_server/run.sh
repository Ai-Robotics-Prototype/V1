#!/bin/bash
set -e
cd "$(dirname "$0")"
python3 -m venv .venv 2>/dev/null || true
source .venv/bin/activate
pip install -r requirements.txt -q
echo "RoboAi mock server starting on http://0.0.0.0:8080"
echo "Dashboard: http://$(hostname -I | awk '{print $1}'):8080"
python3 server.py
