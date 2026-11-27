#!/bin/bash
# Build the AppleScript helper app used to read pages out of the user's own
# (logged-in) Chrome. macOS attributes AppleEvents to THIS applet, so the DSH
# app itself does not need an Automation permission.
#
# Usage:  ./scripts/setup-helper.sh
# After it runs, the first browser read triggers a macOS Automation prompt —
# click "允许". The helper is copied next to the plugin (.helper/run.app).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER_DIR="$ROOT/.helper"
APP="$HELPER_DIR/run.app"
mkdir -p "$HELPER_DIR"

SRC="$(mktemp -d)/runner.applescript"
cat > "$SRC" <<'APPLESCRIPT'
on run argv
	set scriptPath to "/tmp/ctrl/script.applescript"
	try
		if (count of argv) > 0 then set scriptPath to item 1 of argv
	end try
	set outPath to "/tmp/ctrl/out.txt"
	try
		set res to do shell script "osascript " & quoted form of scriptPath
		do shell script "printf '%s' " & quoted form of res & " > " & quoted form of outPath
	on error errMsg number errNum
		do shell script "printf '%s' " & quoted form of ("ERR " & errMsg & " " & errNum) & " > " & quoted form of outPath
	end try
end run
APPLESCRIPT

osacompile -o "$APP" "$SRC"
/usr/libexec/PlistBuddy -c "Set :NSAppleEventsUsageDescription '读取浏览器当前页面内容，用于把 SEO 工具里的数据整理进工作台。'" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier 'com.local.dsh.ccontrol.runner'" "$APP/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string 'com.local.dsh.ccontrol.runner'" "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1
echo "helper ready: $APP"
echo "第一次拉取页面时 macOS 会弹「自动化」授权，点允许即可。"
