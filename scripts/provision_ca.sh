#!/bin/bash
# scripts/provision_ca.sh — device-local root CA + dashboard cert.
#
# Idempotent. Safe to re-run. Never overwrites an existing valid file
# without --regenerate-server (which requires a dashboard restart).
#
# Files:
#   /opt/cobot/certs/ca.pem            — self-signed root CA, 20 y.
#   /opt/cobot/certs/ca.key            — root CA private key, 0600.
#   /opt/cobot/certs/dashboard_cert.pem — CA-signed server cert (SANs).
#   /opt/cobot/certs/dashboard_key.pem — server key, 0600.
#
# The pairing wizard's /api/pair/confirm returns ca.pem in its
# response so the tablet operator can install it as a trusted root
# and get rid of the browser's "Not secure" bar. Inside the PWA the
# CA is stored in localStorage as a note for the future Capacitor
# native shell (which will install it into the system trust store).
#
# The dashboard's serving cert stays where it is unless --regenerate-server
# is passed — replacing the running cert without operator intent would
# break every open browser session on the next restart.
set -euo pipefail

CERTS_DIR=${COBOT_CERTS_DIR:-/opt/cobot/certs}
IDENT_FILE=${COBOT_IDENTITY_PATH:-/opt/cobot/identity.json}
REGEN_SERVER=0
QUIET=0

for a in "$@"; do
  case "$a" in
    --regenerate-server) REGEN_SERVER=1 ;;
    --quiet)             QUIET=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

say() { [ "$QUIET" -eq 1 ] || echo "[provision_ca] $*"; }

mkdir -p "$CERTS_DIR"

# Serial + friendly-name from identity.json so the cert names the robot.
SERIAL=""; FRIENDLY=""
if [ -f "$IDENT_FILE" ]; then
  SERIAL=$(python3 -c "import json; print(json.load(open('$IDENT_FILE')).get('serial',''))" 2>/dev/null || true)
  FRIENDLY=$(python3 -c "import json; print(json.load(open('$IDENT_FILE')).get('friendly_name',''))" 2>/dev/null || true)
fi
[ -z "$SERIAL" ] && SERIAL="NR-UNKNOWN"
[ -z "$FRIENDLY" ] && FRIENDLY="$(hostname -s)"

CA_KEY="$CERTS_DIR/ca.key"
CA_PEM="$CERTS_DIR/ca.pem"

# ── Root CA (idempotent) ─────────────────────────────────────────
if [ -s "$CA_PEM" ] && [ -s "$CA_KEY" ]; then
  say "root CA exists: $CA_PEM (skipping)"
else
  say "minting root CA at $CA_PEM"
  openssl genrsa -out "$CA_KEY" 4096 >/dev/null 2>&1
  chmod 600 "$CA_KEY"
  openssl req -x509 -new -nodes -sha256 -days 7300 \
    -key "$CA_KEY" -out "$CA_PEM" \
    -subj "/CN=NeuRobots Root CA ${SERIAL}/O=NeuRobots/OU=${FRIENDLY}" \
    >/dev/null 2>&1
  chmod 644 "$CA_PEM"
  say "root CA created (20 y validity)"
fi

# ── Server cert (only if asked) ──────────────────────────────────
SRV_CERT="$CERTS_DIR/dashboard_cert.pem"
SRV_KEY="$CERTS_DIR/dashboard_key.pem"

if [ "$REGEN_SERVER" -eq 1 ]; then
  say "regenerating server cert (dashboard restart required after)"
  IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$' | head -8)
  SAN_ENTRIES="DNS:localhost,DNS:${FRIENDLY},DNS:${FRIENDLY}.local,IP:127.0.0.1"
  for ip in $IPS; do SAN_ENTRIES="${SAN_ENTRIES},IP:${ip}"; done
  SAN_ENTRIES="${SAN_ENTRIES},DNS:${SERIAL}.local"
  say "SANs: $SAN_ENTRIES"

  SRV_KEY_NEW=$(mktemp)
  SRV_CSR=$(mktemp)
  SRV_CRT_NEW=$(mktemp)
  EXT_FILE=$(mktemp)
  trap 'rm -f "$SRV_KEY_NEW" "$SRV_CSR" "$SRV_CRT_NEW" "$EXT_FILE"' EXIT

  openssl genrsa -out "$SRV_KEY_NEW" 2048 >/dev/null 2>&1
  openssl req -new -key "$SRV_KEY_NEW" -out "$SRV_CSR" \
    -subj "/CN=${FRIENDLY}/O=NeuRobots/OU=${SERIAL}" \
    >/dev/null 2>&1
  {
    echo "subjectAltName = ${SAN_ENTRIES}"
    echo "keyUsage = critical, digitalSignature, keyEncipherment"
    echo "extendedKeyUsage = serverAuth"
    echo "basicConstraints = critical, CA:FALSE"
  } > "$EXT_FILE"
  openssl x509 -req -in "$SRV_CSR" -CA "$CA_PEM" -CAkey "$CA_KEY" \
    -CAcreateserial -out "$SRV_CRT_NEW" -days 3650 -sha256 \
    -extfile "$EXT_FILE" >/dev/null 2>&1
  install -m 644 "$SRV_CRT_NEW" "$SRV_CERT"
  install -m 600 "$SRV_KEY_NEW" "$SRV_KEY"
  say "server cert installed: $SRV_CERT (10 y validity)"
  say "NEXT: sudo systemctl restart roboai-dashboard"
else
  if [ -s "$SRV_CERT" ] && [ -s "$SRV_KEY" ]; then
    say "server cert exists: $SRV_CERT (pass --regenerate-server to replace)"
  else
    say "server cert missing — pass --regenerate-server to mint one"
    exit 3
  fi
fi

say "done"
