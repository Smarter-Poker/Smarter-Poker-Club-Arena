#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Build the iOS archive and upload it to TestFlight - one command.
# ═══════════════════════════════════════════════════════════════════════════
#
# Needs, on the Mac (docs/APP-STORE-RUNBOOK.md):
#   - Xcode installed and signed in to the Apple Developer account (automatic
#     signing picks the team from that sign-in; CA_APPLE_TEAM_ID overrides).
#   - an App Store Connect API key for the upload step, as
#       CA_ASC_KEY_ID, CA_ASC_ISSUER_ID and CA_ASC_KEY_PATH (the .p8), or the
#     upload is skipped and the .ipa is left in ios/build/ for Transporter.
#
# Usage:  npm run ios:archive            # build web, sync, archive, export, upload
#         npm run ios:archive -- --no-upload
set -euo pipefail
cd "$(dirname "$0")/../.."

UPLOAD=1
for a in "$@"; do [ "$a" = "--no-upload" ] && UPLOAD=0; done

if ! xcode-select -p >/dev/null 2>&1 || ! xcodebuild -version >/dev/null 2>&1; then
  echo "Xcode is not installed (only the Command Line Tools are). Install it from the App Store, open it once, then re-run." >&2
  exit 1
fi

echo "[1/5] web bundle for the app (dist-native)"
npm run build:native
echo "[2/5] cap sync ios"
npx cap sync ios

BUILD_DIR="ios/build"
ARCHIVE="$BUILD_DIR/ClubArena.xcarchive"
EXPORT_DIR="$BUILD_DIR/export"
mkdir -p "$BUILD_DIR"
TEAM_FLAG=()
[ -n "${CA_APPLE_TEAM_ID:-}" ] && TEAM_FLAG=(DEVELOPMENT_TEAM="$CA_APPLE_TEAM_ID")

echo "[3/5] xcodebuild archive"
xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates "${TEAM_FLAG[@]}" archive | tail -20

echo "[4/5] export .ipa (app-store-connect method)"
cat > "$BUILD_DIR/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><true/>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$BUILD_DIR/ExportOptions.plist" -allowProvisioningUpdates | tail -5
IPA=$(ls "$EXPORT_DIR"/*.ipa | head -1)
echo "ipa: $IPA"

if [ "$UPLOAD" = 1 ]; then
  if [ -n "${CA_ASC_KEY_ID:-}" ] && [ -n "${CA_ASC_ISSUER_ID:-}" ] && [ -n "${CA_ASC_KEY_PATH:-}" ]; then
    echo "[5/5] upload to TestFlight"
    xcrun altool --upload-app -f "$IPA" -t ios \
      --apiKey "$CA_ASC_KEY_ID" --apiIssuer "$CA_ASC_ISSUER_ID" 2>&1 | tail -5
  else
    echo "[5/5] upload skipped: set CA_ASC_KEY_ID, CA_ASC_ISSUER_ID and CA_ASC_KEY_PATH (an App Store Connect API key), or open $IPA in Transporter."
  fi
else
  echo "[5/5] upload skipped (--no-upload)"
fi
