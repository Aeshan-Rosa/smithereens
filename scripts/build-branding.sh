#!/bin/bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
source_icon="$project_dir/app/branding/smithereens-icon.png"
iconset_dir="$project_dir/build/branding/Smithereens.iconset"
mkdir -p "$iconset_dir"
for size in 16 32 128 256 512; do
	/usr/bin/sips -z "$size" "$size" "$source_icon" --out "$iconset_dir/icon_${size}x${size}.png" >/dev/null
	retina_size=$((size * 2))
	/usr/bin/sips -z "$retina_size" "$retina_size" "$source_icon" --out "$iconset_dir/icon_${size}x${size}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$iconset_dir" --output "$project_dir/app/mac/Contents/Resources/Smithereens.icns"
# Also used by About and the assistant header, packaged with the normal chrome files.
/usr/bin/sips -z 128 128 "$source_icon" --out "$project_dir/chrome/skin/default/zotero/smithereens-icon.png" >/dev/null
echo 'Built Smithereens icon family (16–1024 px)'
