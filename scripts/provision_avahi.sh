#!/bin/bash
# scripts/provision_avahi.sh — advertise the robot on the LAN.
#
# Idempotent. Reads /opt/cobot/identity.json for the serial + model +
# friendly_name, writes /etc/avahi/services/neurobots.service with
# _neurobots._tcp SRV + TXT records. avahi-daemon picks up the file
# without a restart (it watches the services dir).
#
# TXT records: serial, model, name, api_version.
# The friendly host name (mDNS) becomes `<friendly_name>.local`.
#
# The dashboard's _https._tcp advertisement (browser discovery) is
# published in the same file so both discovery paths — "any HTTPS on
# the LAN" and "the NeuRobots-specific service" — resolve to the same
# host + port.

set -euo pipefail

IDENT_FILE=${COBOT_IDENTITY_PATH:-/opt/cobot/identity.json}
OUT_FILE=${AVAHI_SERVICE_FILE:-/etc/avahi/services/neurobots.service}
DASH_PORT=${COBOT_DASHBOARD_PORT:-8080}
API_VERSION=${COBOT_API_VERSION:-1}

if [ ! -f "$IDENT_FILE" ]; then
  echo "[provision_avahi] $IDENT_FILE missing — run the dashboard once to mint it" >&2
  exit 3
fi

SERIAL=$(python3 -c "import json; print(json.load(open('$IDENT_FILE')).get('serial',''))")
MODEL=$(python3 -c "import json; print(json.load(open('$IDENT_FILE')).get('model',''))")
NAME=$(python3 -c "import json; print(json.load(open('$IDENT_FILE')).get('friendly_name',''))")

if [ -z "$SERIAL" ] || [ -z "$MODEL" ] || [ -z "$NAME" ]; then
  echo "[provision_avahi] identity.json missing serial/model/friendly_name" >&2
  exit 4
fi

esc() {
  # XML entity escape.
  python3 -c "import html,sys; print(html.escape(sys.argv[1]))" "$1"
}
ES=$(esc "$SERIAL"); EM=$(esc "$MODEL"); EN=$(esc "$NAME"); EA=$(esc "$API_VERSION")

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
cat > "$TMP" <<XML
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">NeuRobots ${EN} (${ES})</name>

  <service>
    <type>_neurobots._tcp</type>
    <port>${DASH_PORT}</port>
    <txt-record>serial=${ES}</txt-record>
    <txt-record>model=${EM}</txt-record>
    <txt-record>name=${EN}</txt-record>
    <txt-record>api_version=${EA}</txt-record>
  </service>

  <service>
    <type>_https._tcp</type>
    <port>${DASH_PORT}</port>
    <txt-record>path=/</txt-record>
    <txt-record>role=neurobots-dashboard</txt-record>
    <txt-record>serial=${ES}</txt-record>
  </service>
</service-group>
XML

if [ -f "$OUT_FILE" ] && cmp -s "$TMP" "$OUT_FILE"; then
  echo "[provision_avahi] no change ($OUT_FILE)"
  exit 0
fi

install -m 644 "$TMP" "$OUT_FILE"
echo "[provision_avahi] wrote $OUT_FILE"
echo "[provision_avahi] TXT: serial=$SERIAL model=$MODEL name=$NAME api=$API_VERSION port=$DASH_PORT"
echo "[provision_avahi] avahi-daemon auto-reloads within a few seconds"
