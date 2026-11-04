#!/bin/bash
# Build Ingle for VS Code and install it.
set -euo pipefail
cd "$(dirname "$0")"
[[ -f ../../local.env ]] && source ../../local.env

echo "▸ Installing build tools…"
npm install --no-audit --no-fund --silent
echo "▸ Compiling…"
rm -rf out
npm run --silent compile

# Terms, privacy and licence ship with the extension (Ingle: Terms of Use / Privacy Policy / About Ingle).
mkdir -p legal
for f in TERMS PRIVACY LICENSE LICENSING; do [[ -f "../../$f.md" ]] && cp "../../$f.md" legal/; done
[[ -f ../../LICENSE.md ]] && cp ../../LICENSE.md LICENSE.md

echo "▸ Packaging…"
# A personal publisher name (local.env) keeps VS Code treating it as the same extension, with the same chat history.
if [[ -n "${VSCODE_PUBLISHER:-}" ]]; then
  cp package.json package.json.release
  trap 'mv package.json.release package.json' EXIT
  node -e "const f='package.json',p=require('./'+f);p.publisher=process.argv[1];require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')" "$VSCODE_PUBLISHER"
fi
npx --yes @vscode/vsce package --allow-missing-repository --skip-license -o ingle.vsix >/dev/null

CODE="$(command -v code || true)"
[[ -z "$CODE" ]] && CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
if [[ -x "$CODE" ]]; then
  # Remove the old Ingle Bridge extension if it's still installed.
  "$CODE" --list-extensions | grep -i '\.ingle-bridge$' | while read -r old; do "$CODE" --uninstall-extension "$old" >/dev/null 2>&1 || true; done
  "$CODE" --install-extension ingle.vsix --force
  echo "✓ Installed. Reload VS Code (Cmd+Shift+P → Developer: Reload Window), then click the orange Ingle icon at the top right of any open file."
else
  echo "Couldn't find VS Code's 'code' command. In VS Code: Cmd+Shift+P → Extensions: Install from VSIX… → pick $(pwd)/ingle.vsix"
fi
