# 2026-09-09 - What the binary declares (store readiness, the part the audit missed)

The Capacitor Readiness Audit is a web-app audit: it covers what the React
tree must stop doing to survive inside a webview. It never covers what the
BINARY has to declare. Six of those were missing, and each is a crash or a
store rejection rather than a rough edge.

## iOS

`Info.plist` had no usage strings. iOS does not fail a permission request
without one - it TERMINATES the process. Table voice chat calls
`getUserMedia` (`src/services/VoiceSignalService.ts`) and three pickers are
`<input type="file">` (avatar, club logo, join-club), so the app would have
died the first time a player turned voice on. Added microphone, camera and
photo-library strings that name the feature, because Apple reads them at
review. Also `ITSAppUsesNonExemptEncryption=false`, so no upload stops to ask.

`App.entitlements` did not exist, so push had no `aps-environment` and the
universal links built in phase 2 had no Associated Domains to verify against

- the World Hub serves the `apple-app-site-association` and nothing on the
  device was asking for it. Wired into BOTH build configurations: with it on
  Debug only, a release archive drops both capabilities silently.

`PrivacyInfo.xcprivacy` did not exist. App Store Connect rejects an upload
without a privacy manifest. Its answers are the same ones in
`docs/APP-STORE-LISTING.md`, so the manifest, the nutrition labels and the
Play data-safety form cannot drift apart. `NSPrivacyTracking` is false: no ad
SDK ships, and PostHog runs only after in-app consent. It is registered as a
build resource, or it never reaches the bundle.

## Android

The manifest declared only `INTERNET`. Voice chat needs `RECORD_AUDIO` and
`MODIFY_AUDIO_SETTINGS`, and Android 13+ needs `POST_NOTIFICATIONS` for the
push work that merged in phase 4b.

There was no release signing config at all, so `bundleRelease` produced an
unsigned bundle that Play refuses. Added one that reads the keystore path and
every password from the environment (`CA_ANDROID_KEYSTORE`,
`CA_ANDROID_KEYSTORE_PASSWORD`, `CA_ANDROID_KEY_ALIAS`,
`CA_ANDROID_KEY_PASSWORD`) - 10.84, an agent never holds a credential - and
falls back to an unsigned debug-style build when they are absent rather than
breaking a local `assembleDebug`. `android/.gitignore` now refuses `*.jks`
and `*.keystore` outright; the template had them commented out.

## One command per store

`npm run ios:archive`: build:native, cap sync, xcodebuild archive, export a
store `.ipa`, upload to TestFlight when an App Store Connect API key is in
the environment. It checks for Xcode first and says so plainly - this Mac has
only the Command Line Tools today.

`npm run android:bundle`: build:native, cap sync, `gradlew bundleRelease`. It
refuses before building if the keystore is missing (an unsigned bundle is a
wasted ten minutes) and if `java -version` is not 17 or 21, because the Mac's
default Java 25 fails with "Unsupported class file major version 69" halfway
through a Gradle run.

## Not in this branch, deliberately

Dan, 2026-09-09: **the artwork pass happens last**, once the art upgrade is
finished, so it is done once. The Play listing graphics were built and then
backed out of this branch for that reason. What is committed in `ios/` and
`android/` today is placeholder art at the correct sizes with correct
plumbing; `docs/APP-STORE-RUNBOOK.md` has the four-step regeneration
sequence, and nothing else in the programme depends on it.

## Verified

`tests/unit/nativeBinaryConfig.test.ts` (7 tests): a usage string for every
protected resource the app actually reaches and each one naming the feature,
export compliance answered, entitlements present in both configurations, the
privacy manifest a build resource with answers matching the listing, the
Android permissions, the signing config with no literal secret and a
gitignore that cannot leak a keystore, and both build scripts refusing to
produce an artifact the store would reject. `plutil -lint` clean on the
plist, the entitlements, the manifest and the Xcode project.
