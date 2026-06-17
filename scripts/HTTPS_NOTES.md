# HTTPS for the RoboAi dashboard

The dashboard is served as HTTPS so browsers grant `getUserMedia` /
`MediaRecorder` permissions. Without HTTPS the live recorder in the
Program-from-Demonstration wizard cannot access camera or microphone
when the page is reached over a LAN IP.

## One-time setup (Jetson)

```bash
sudo scripts/generate_dashboard_cert.sh
sudo systemctl restart roboai-dashboard
```

This writes:

```
/opt/cobot/certs/dashboard_cert.pem   # public cert, 644
/opt/cobot/certs/dashboard_key.pem    # private key, 600 root:teddy
```

The cert is valid for 10 years and the SAN includes
`IP:192.168.1.246`, `IP:127.0.0.1`, and `DNS:localhost`. To re-issue
(different IP, key rotation, etc.):

```bash
sudo scripts/generate_dashboard_cert.sh --force                                # default values
sudo ROBOAI_CERT_CN=10.0.0.5 ROBOAI_CERT_SAN='IP:10.0.0.5,DNS:localhost' \
     scripts/generate_dashboard_cert.sh --force                                # different host
```

The dashboard server checks for the cert files at startup. If they
exist, uvicorn binds with TLS on `:8080` (`https://…`). If either is
missing, the dashboard falls back to plain HTTP on `:8080` and logs a
warning — the UI loads, but the live recorder will refuse to release
the camera. Restoring HTTPS is a `generate → restart` away.

## One-time browser acceptance (every device)

Because the cert is self-signed, every browser shows a "Your
connection is not private" warning **once per device**. Tap through
it to mark the cert trusted.

### Chrome / Edge on Android (tablet)

1. Open `https://192.168.1.246:8080`.
2. Big red warning page → tap **Advanced** → **Proceed to
   192.168.1.246 (unsafe)**.
3. Done. Future visits skip the warning. Camera + mic prompts now
   appear from the wizard.

### Chrome on desktop

Same path: **Advanced → Proceed to <host> (unsafe)**.

### Firefox

**Advanced… → Accept the Risk and Continue**.

### Safari (iPad)

iOS Safari is stricter — visit the URL, tap **Show Details → visit
this website** and confirm the warning. iOS installs the cert into
the user profile; trust it under
**Settings → General → About → Certificate Trust Settings**.

### Kiosk browsers (auto-launch)

If the tablet runs a kiosk shell (Fully Kiosk Browser, Lightning
Browser, Chromium in `--kiosk` mode, etc.), set the equivalent of
"ignore certificate errors" / "accept self-signed certificates" in
the kiosk app's settings so it doesn't prompt at boot. The exact
toggle name varies per app.

For Chromium-based kiosks you can also launch with
`--ignore-certificate-errors` (Android Chrome doesn't accept this
flag from the launcher).

## Verifying HTTPS is live

```bash
curl -kI https://localhost:8080/ | head -3        # 200 over HTTPS
curl -k https://localhost:8080/ \
  | grep -oE 'index-[A-Za-z0-9_]+\.js'             # served bundle
journalctl -u roboai-dashboard -n 5 --no-pager \
  | grep HTTPS                                     # "HTTPS enabled" line
```

If the WebSocket pill in the dashboard still says "Disconnected" after
HTTPS goes live, that's a mixed-content slip — every WebSocket in the
frontend derives `wss://` from `window.location.protocol`, so this
should be automatic. Open DevTools → Network and confirm
`wss://192.168.1.246:8080/ws/state` is upgrading cleanly.
