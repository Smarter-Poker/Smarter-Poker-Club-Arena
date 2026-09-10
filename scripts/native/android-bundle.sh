#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Build the signed Android App Bundle for Play - one command.
# ═══════════════════════════════════════════════════════════════════════════
#
# Needs (docs/APP-STORE-RUNBOOK.md):
#   - a JDK 17 or 21 on PATH or as JAVA_HOME (the Mac's default Java 25 is
#     refused by Gradle: "Unsupported class file major version 69").
#   - the release keystore, as CA_ANDROID_KEYSTORE (path) and
#     CA_ANDROID_KEYSTORE_PASSWORD (+ CA_ANDROID_KEY_ALIAS, CA_ANDROID_KEY_PASSWORD
#     if they differ from 'clubarena' / the keystore password). Dan's, never
#     in the repo. Without them Play refuses the bundle, so this stops first.
#   - android/app/google-services.json for push (warned about, not required).
#
# Usage:  npm run android:bundle          # -> android/app/build/outputs/bundle/release/app-release.aab
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ -z "${CA_ANDROID_KEYSTORE:-}" ] || [ -z "${CA_ANDROID_KEYSTORE_PASSWORD:-}" ]; then
  echo "Set CA_ANDROID_KEYSTORE (path to the release keystore) and CA_ANDROID_KEYSTORE_PASSWORD first; Play refuses an unsigned bundle." >&2
  exit 1
fi
[ -f "$CA_ANDROID_KEYSTORE" ] || { echo "Keystore not found: $CA_ANDROID_KEYSTORE" >&2; exit 1; }

JAVA_BIN="${JAVA_HOME:+$JAVA_HOME/bin/}java"
MAJOR=$("$JAVA_BIN" -version 2>&1 | head -1 | sed -E 's/.*"([0-9]+).*/\1/')
if [ "$MAJOR" != "17" ] && [ "$MAJOR" != "21" ]; then
  echo "Java $MAJOR found; Gradle needs 17 or 21. Point JAVA_HOME at Android Studio's JDK, e.g. /Applications/Android Studio.app/Contents/jbr/Contents/Home" >&2
  exit 1
fi

[ -f android/app/google-services.json ] || echo "warning: android/app/google-services.json is missing - push will not work in this build (Firebase, runbook step 5)."

echo "[1/3] web bundle for the app (dist-native)"
npm run build:native
echo "[2/3] cap sync android"
npx cap sync android
echo "[3/3] gradle bundleRelease (signed)"
( cd android && ./gradlew bundleRelease --console=plain | tail -15 )
AAB=android/app/build/outputs/bundle/release/app-release.aab
[ -f "$AAB" ] && echo "bundle: $AAB ($(du -h "$AAB" | cut -f1))" || { echo "bundle not produced" >&2; exit 1; }
