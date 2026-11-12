#!/bin/bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
profile_dir="$project_dir/.smithereens/profile"
mkdir -p "$profile_dir"
if [[ ! -f "$profile_dir/prefs.js" ]]; then
	cat > "$profile_dir/user.js" <<'PREFS'
user_pref("app.update.enabled", false);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.firstRun.skipFirefoxProfileAccessCheck", true);
user_pref("extensions.zotero.firstRunGuidance", false);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.zoteroMacWordIntegration.skipInstallation", true);
user_pref("extensions.zoteroOpenOfficeIntegration.skipInstallation", true);
PREFS
fi
exec "$project_dir/dist/Smithereens.app/Contents/MacOS/zotero" -no-remote -profile "$profile_dir" -datadir profile "$@"
