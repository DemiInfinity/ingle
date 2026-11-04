#!/bin/bash
# Build Ingle.app. Usage:
#   ./build.sh            build into ./build and open it
#   ./build.sh --install  build, copy to /Applications, quit the separate Ollama app if it's running, and open it
#
# Personal settings that shouldn't be published (your own bundle identifier, for example) go in
# local.env next to this script. It's git-ignored. See local.env.example.
set -euo pipefail
cd "$(dirname "$0")"
[[ -f local.env ]] && source local.env

APP="Ingle.app"
OUT="build/${APP}"

if ! command -v swift >/dev/null; then
  echo "Swift isn't installed. Run: xcode-select --install   (or install Xcode), then try again."
  exit 1
fi

echo "▸ Compiling…"
swift build -c release
BIN="$(swift build -c release --show-bin-path)/Ingle"

echo "▸ Bundling ${APP}…"
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
cp "$BIN" "$OUT/Contents/MacOS/Ingle"
cp Support/Info.plist "$OUT/Contents/Info.plist"
# Terms, privacy and licence, opened from Settings → About.
mkdir -p "$OUT/Contents/Resources/Legal"
for f in TERMS PRIVACY LICENSE LICENSING; do [[ -f "$f.md" ]] && cp "$f.md" "$OUT/Contents/Resources/Legal/"; done
# The previewer's page (Markdown, Mermaid, maths, tables…): static files, nothing fetched at runtime.
ditto Support/preview "$OUT/Contents/Resources/Preview"
if [[ -n "${INGLE_BUNDLE_ID:-}" ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ${INGLE_BUNDLE_ID}" "$OUT/Contents/Info.plist"
fi

ICONSET="build/AppIcon.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s Support/AppIcon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d Support/AppIcon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$OUT/Contents/Resources/AppIcon.icns"

# ---------------------------------------------------------------- built-in AI engine (Ollama, MIT licence)
echo "▸ Adding the built-in AI engine…"
RUNTIME="$OUT/Contents/Resources/OllamaRuntime"
mkdir -p "$RUNTIME"
if [[ -x "/Applications/Ollama.app/Contents/Resources/ollama" ]]; then
  # Copy the engine from the installed Ollama app (same version you already use).
  ditto "/Applications/Ollama.app/Contents/Resources" "$RUNTIME"
elif [[ -x "$HOME/.local/share/ingle-runtime/ollama" ]]; then
  ditto "$HOME/.local/share/ingle-runtime" "$RUNTIME"
else
  echo "  Downloading the latest Ollama engine from GitHub…"
  curl -fL --progress-bar "https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz" -o build/ollama-darwin.tgz
  tar -xzf build/ollama-darwin.tgz -C "$RUNTIME"
fi
if [[ ! -x "$RUNTIME/ollama" ]]; then
  echo "✗ Couldn't find the ollama engine inside $RUNTIME"; exit 1
fi
# Keep a copy outside the app, so rebuilding still works after the Ollama app is deleted.
mkdir -p "$HOME/.local/share/ingle-runtime"
ditto "$RUNTIME" "$HOME/.local/share/ingle-runtime"
curl -fsSL "https://raw.githubusercontent.com/ollama/ollama/main/LICENSE" -o "$RUNTIME/LICENSE-ollama.txt" 2>/dev/null || true
echo "  Engine: $("$RUNTIME/ollama" -v 2>/dev/null | tail -1)"

# ---------------------------------------------------------------- slim the engine (Apple Silicon only)
# Ollama ships one bundle for Intel and Apple Silicon Macs plus its own app's images. Ingle only runs on
# Apple Silicon, so drop what can never load there. INGLE_MLX picks the MLX GPU library to keep:
#   both (default) · v3 (macOS 14+, smallest that keeps MLX models — use for releases) · v4 (macOS 26.2+) · none
echo "▸ Slimming the engine for Apple Silicon…"
BEFORE=$(du -sm "$RUNTIME" | cut -f1)
# Ollama's own tray-app images and the quantize tool (Ollama never calls it).
rm -f "$RUNTIME"/*.png "$RUNTIME"/*.icns "$RUNTIME"/*.svg "$RUNTIME"/llama-quantize
# Every binary: delete it if it has no arm64 code, otherwise strip the Intel half.
while IFS= read -r -d '' f; do
  archs=$(lipo -archs "$f" 2>/dev/null) || continue          # not a Mach-O file (licences, metallib)
  if [[ " $archs " != *" arm64 "* ]]; then
    rm -f "$f"
  elif [[ "$archs" == *" "* ]]; then
    lipo -thin arm64 "$f" -output "$f.thin" && mv "$f.thin" "$f"
  fi
done < <(find "$RUNTIME" -type f -print0)
case "${INGLE_MLX:-both}" in
  v3) rm -rf "$RUNTIME/mlx_metal_v4" ;;
  v4) rm -rf "$RUNTIME/mlx_metal_v3" ;;
  none) rm -rf "$RUNTIME/mlx_metal_v3" "$RUNTIME/mlx_metal_v4" ;;
esac
# Thinning invalidates signatures; re-sign every binary inside (ad-hoc until there's a Developer ID).
find "$RUNTIME" -type f \( -perm -u+x -o -name "*.dylib" -o -name "*.so" \) -print0 |
  while IFS= read -r -d '' f; do lipo -archs "$f" >/dev/null 2>&1 && codesign --force --sign - "$f" >/dev/null 2>&1; done
AFTER=$(du -sm "$RUNTIME" | cut -f1)
if "$RUNTIME/ollama" -v >/dev/null 2>&1; then
  echo "  Engine slimmed: ${BEFORE} MB → ${AFTER} MB (MLX: ${INGLE_MLX:-both})"
else
  echo "✗ The slimmed engine doesn't start — restoring the full one."
  rm -rf "$RUNTIME" && ditto "$HOME/.local/share/ingle-runtime" "$RUNTIME"
fi

codesign --force --sign - "$OUT" >/dev/null 2>&1 || true

if [[ "${1:-}" == "--install" ]]; then
  echo "▸ Installing to /Applications…"
  osascript -e 'quit app "Ingle"' >/dev/null 2>&1 || true
  rm -rf "/Applications/${APP}"
  cp -R "$OUT" /Applications/

  # Ingle runs the engine itself now, so the separate Ollama app can stop.
  if pgrep -xq "Ollama"; then
    osascript -e 'quit app "Ollama"' >/dev/null 2>&1 || true
    echo "▸ Quit the Ollama app — Ingle runs the engine itself now."
  fi

  # Keep the `ollama` command working in Terminal, pointed at Ingle's engine.
  mkdir -p "$HOME/.local/bin"
  ln -sf "/Applications/${APP}/Contents/Resources/OllamaRuntime/ollama" "$HOME/.local/bin/ollama"

  open "/Applications/${APP}"
  echo "✓ Ingle installed with its own AI engine. Look for the AI icon in your menu bar."
else
  open "$OUT"
  echo "✓ Built $OUT"
fi
