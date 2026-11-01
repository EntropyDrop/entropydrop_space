#!/bin/sh
set -eu
NATIVE_SPACE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
sh "$NATIVE_SPACE_ROOT/tools/cargo.sh" build --release --offline
bundle="$NATIVE_SPACE_ROOT/build/Space Native.app"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
cp "$NATIVE_SPACE_ROOT/target/release/space-native" "$bundle/Contents/MacOS/space-native"
cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>space-native</string>
<key>CFBundleIdentifier</key><string>com.entropydrop.space.native</string>
<key>CFBundleName</key><string>Space Native</string>
<key>CFBundleDisplayName</key><string>Space Native</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>NSHighResolutionCapable</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
PLIST
codesign --force --sign - "$bundle"
printf '%s\n' "$bundle"
