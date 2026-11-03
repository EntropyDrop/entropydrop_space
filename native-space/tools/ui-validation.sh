#!/bin/sh
set -eu
NATIVE_SPACE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
sh "$NATIVE_SPACE_ROOT/tools/cargo.sh" build --release --offline
bundle="$NATIVE_SPACE_ROOT/build/Space UI Validation.app"
mkdir -p "$bundle/Contents/MacOS"
cp "$NATIVE_SPACE_ROOT/target/release/space-native" "$bundle/Contents/MacOS/space-native"
cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>space-native</string>
<key>CFBundleIdentifier</key><string>com.entropydrop.space.ui-validation</string>
<key>CFBundleName</key><string>Space UI Validation</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$bundle"
printf '%s\n' "$bundle"
