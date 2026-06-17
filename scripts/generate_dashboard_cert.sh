#!/usr/bin/env bash
# generate_dashboard_cert.sh — self-signed TLS cert for the RoboAi dashboard.
#
# Why this exists: browsers require a SECURE CONTEXT (HTTPS, or
# localhost) before they'll release getUserMedia / MediaRecorder.
# The dashboard is reached from the tablet over a LAN IP, which is
# plain HTTP by default. Issuing a self-signed cert and switching the
# uvicorn invocation to TLS makes the LAN origin secure and unblocks
# the Program-from-Demonstration live recorder + any future
# camera/mic features.
#
# Outputs (default paths):
#   /opt/cobot/certs/dashboard_cert.pem   public cert, world-readable
#   /opt/cobot/certs/dashboard_key.pem    private key, chmod 600
#
# Behavior:
#   - Idempotent: if both files exist AND the cert is not within 30
#     days of expiry, nothing is regenerated. Pass --force to rebuild.
#   - Run with sudo (writes to /opt/cobot/certs and chowns to teddy).
#
# Env overrides (mainly for non-Jetson dev machines):
#   ROBOAI_CERT_CN   — Common Name on the cert (default: 192.168.1.246)
#   ROBOAI_CERT_SAN  — Subject Alternative Names
#                       (default: IP:192.168.1.246,DNS:localhost,IP:127.0.0.1)
#   ROBOAI_CERT_USER — user the files should belong to (default: teddy)
#
# After running:
#   sudo systemctl restart roboai-dashboard
#   Open https://<IP>:8080 — accept the self-signed warning ONCE
#   per device (see scripts/HTTPS_NOTES.md).

set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "[generate_dashboard_cert] must be run as root. Try:" >&2
  echo "  sudo $0 $*" >&2
  exit 1
fi

CERT_DIR="/opt/cobot/certs"
CERT="$CERT_DIR/dashboard_cert.pem"
KEY="$CERT_DIR/dashboard_key.pem"
SUBJ_CN="${ROBOAI_CERT_CN:-192.168.1.246}"
SAN="${ROBOAI_CERT_SAN:-IP:192.168.1.246,DNS:localhost,IP:127.0.0.1}"
TARGET_USER="${ROBOAI_CERT_USER:-teddy}"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    --help|-h)
      sed -n '1,/^set -euo/p' "$0" | sed -n '2,/^# /p' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

# Skip if already-fresh — under 30 days from expiry counts as "near".
if [[ -f "$CERT" && -f "$KEY" && $FORCE -eq 0 ]]; then
  if openssl x509 -checkend $((30*86400)) -noout -in "$CERT" >/dev/null 2>&1; then
    echo "[generate_dashboard_cert] $CERT exists and is valid for >30 days; nothing to do."
    echo "  Use --force to regenerate."
    exit 0
  fi
  echo "[generate_dashboard_cert] $CERT is within 30 days of expiry — regenerating."
fi

mkdir -p "$CERT_DIR"
chmod 755 "$CERT_DIR"

echo "[generate_dashboard_cert] Issuing cert"
echo "  CN  = $SUBJ_CN"
echo "  SAN = $SAN"
echo "  out = $CERT  (key: $KEY)"

# `req -x509` issues a self-signed cert directly. `-nodes` skips key
# encryption (uvicorn opens the file without a passphrase). `-addext`
# embeds the SAN so the cert matches both the LAN IP and localhost.
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$KEY" \
  -out "$CERT" \
  -days 3650 \
  -subj "/CN=$SUBJ_CN" \
  -addext "subjectAltName=$SAN" \
  >/dev/null 2>&1

# Cert public; key private. The uvicorn process runs as $TARGET_USER
# (see roboai-dashboard.service `User=teddy`), so it needs read on the
# key. Owner chmod 600 gives that and nothing else.
chmod 644 "$CERT"
chmod 600 "$KEY"
if id -u "$TARGET_USER" >/dev/null 2>&1; then
  chown -R "$TARGET_USER":"$TARGET_USER" "$CERT_DIR"
fi

echo "[generate_dashboard_cert] Done. Restart the dashboard:"
echo "  sudo systemctl restart roboai-dashboard"
echo
echo "On each device, accept the cert ONCE the first time you visit"
echo "  https://$SUBJ_CN:8080"
echo "See scripts/HTTPS_NOTES.md for per-browser instructions."
