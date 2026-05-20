#!/bin/bash
# Launch the RoboAi dashboard in a browser with WebGL enabled.
# Run this ON THE JETSON HOST (not inside Docker).
#
# Usage: bash scripts/launch_dashboard_browser.sh
#
# Tries in order:
#   1. Chromium with NVIDIA EGL (hardware WebGL on Jetson)
#   2. Chromium with SwiftShader (software WebGL, always works)
#   3. Firefox with WebGL force-enabled
#   4. Firefox with Mesa software renderer

URL="http://192.168.1.246:8080"

# Detect active display
if [ -z "$DISPLAY" ] && [ -z "$WAYLAND_DISPLAY" ]; then
  # Try common display values on Jetson
  for D in :0 :1 :2; do
    if xdpyinfo -display "$D" &>/dev/null 2>&1; then
      export DISPLAY="$D"
      echo "Found display: $DISPLAY"
      break
    fi
  done
fi

echo "DISPLAY=$DISPLAY  WAYLAND_DISPLAY=$WAYLAND_DISPLAY"
echo "Launching dashboard at $URL"
echo ""

CHROMIUM=""
for bin in chromium-browser chromium google-chrome google-chrome-stable; do
  if command -v "$bin" &>/dev/null; then
    CHROMIUM="$bin"
    break
  fi
done

FIREFOX=""
for bin in firefox firefox-esr; do
  if command -v "$bin" &>/dev/null; then
    FIREFOX="$bin"
    break
  fi
done

# ── Option 1: Chromium + NVIDIA EGL (Jetson GPU) ─────────────────────────────
if [ -n "$CHROMIUM" ]; then
  echo "Trying Chromium with NVIDIA EGL..."
  "$CHROMIUM" \
    --no-sandbox \
    --disable-gpu-sandbox \
    --ignore-gpu-blocklist \
    --ignore-gpu-blacklist \
    --enable-webgl \
    --use-gl=egl \
    --enable-features=VaapiVideoDecoder,WebGLImageChromium \
    --no-first-run \
    --disable-translate \
    --disable-infobars \
    "$URL" 2>/dev/null &
  CPID=$!
  sleep 4

  # Check if it launched ok
  if kill -0 "$CPID" 2>/dev/null; then
    echo "Chromium EGL launched (PID $CPID)"
    echo "Open http://192.168.1.246:8080/webgl_test.html to verify WebGL"
    exit 0
  fi
  echo "Chromium EGL failed, trying SwiftShader..."
fi

# ── Option 2: Chromium + SwiftShader (software, guaranteed WebGL) ─────────────
if [ -n "$CHROMIUM" ]; then
  echo "Trying Chromium with SwiftShader (software WebGL)..."
  "$CHROMIUM" \
    --no-sandbox \
    --disable-gpu-sandbox \
    --ignore-gpu-blocklist \
    --ignore-gpu-blacklist \
    --enable-webgl \
    --use-gl=swiftshader \
    --disable-software-rasterizer=false \
    --no-first-run \
    --disable-translate \
    --disable-infobars \
    "$URL" 2>/dev/null &
  echo "Chromium SwiftShader launched (PID $!)"
  echo "Open http://192.168.1.246:8080/webgl_test.html to verify WebGL"
  exit 0
fi

# ── Option 3: Firefox with WebGL force-enabled ────────────────────────────────
if [ -n "$FIREFOX" ]; then
  echo "Trying Firefox with WebGL force-enabled..."
  PROFILE_DIR=$(find ~/.mozilla/firefox -maxdepth 1 -name "*.default*" 2>/dev/null | head -1)
  if [ -n "$PROFILE_DIR" ]; then
    cat >> "$PROFILE_DIR/user.js" << 'PREFS'
user_pref("webgl.disabled", false);
user_pref("webgl.force-enabled", true);
user_pref("webgl.enable-webgl2", true);
user_pref("layers.acceleration.force-enabled", true);
user_pref("gfx.webrender.all", true);
user_pref("gfx.webrender.enabled", true);
user_pref("media.hardware-video-decoding.force-enabled", true);
PREFS
    echo "Applied WebGL prefs to: $PROFILE_DIR"
  fi
  MOZ_X11_EGL=1 MOZ_WEBRENDER=1 "$FIREFOX" "$URL" 2>/dev/null &
  echo "Firefox launched (PID $!)"
  exit 0
fi

# ── Option 4: Firefox with software Mesa ─────────────────────────────────────
if [ -n "$FIREFOX" ]; then
  echo "Trying Firefox with Mesa software rendering..."
  LIBGL_ALWAYS_SOFTWARE=1 MOZ_X11_EGL=1 "$FIREFOX" "$URL" 2>/dev/null &
  echo "Firefox (software) launched (PID $!)"
  exit 0
fi

echo "ERROR: No browser found. Install with:"
echo "  snap install chromium"
echo "  # or"
echo "  sudo apt-get install -y firefox"
exit 1
