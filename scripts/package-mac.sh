#!/bin/bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"
scripts/build-branding.sh
npm run build
app/scripts/dir_build -p m
mkdir -p dist
ditto app/staging/Zotero.app dist/Smithereens.app
mkdir -p dist/Smithereens.app/Contents/Resources/distribution
cat > dist/Smithereens.app/Contents/Resources/distribution/policies.json <<'JSON'
{"policies":{"DisableAppUpdate":true}}
JSON
/usr/bin/codesign --force --deep --sign - dist/Smithereens.app
/usr/bin/codesign --verify --deep --strict dist/Smithereens.app
echo "Built $project_dir/dist/Smithereens.app"
