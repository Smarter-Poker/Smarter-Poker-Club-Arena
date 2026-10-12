# 2026-09-29 - Device push never awaits a plugin, and a store build needs Firebase

## Found on the Android emulator

Tapping Enable on the notifications sheet in the app left it on
"Enabling..." forever. The log said:

    "PushNotifications.then()" is not implemented on android

The same error was logged, unhandled, on every launch.

A Capacitor plugin object is a Proxy that turns EVERY property into a native
call - `then` included. `src/lib/native/push.ts` fetched its two plugins through
small async helpers that `return`ed the plugin. Returning a value that has a
`then` makes the promise adopt it, so the runtime called
`PushNotifications.then()`, Android answered that it has no such method, and
every `await` on those helpers rejected. On a phone that meant:

- the shell's push listeners were never attached at launch (so a tap on a
  notification could not be routed);
- Enable spun forever; the OS permission dialog never appeared;
- no device token was ever stored.

The unit tests could not see it: they mocked the plugins as plain objects,
which have no `then`.

## The fix

The helpers return the plugin inside a wrapper object (`{ PushNotifications }`,
`{ Preferences }`), which has no `then`, and callers destructure it. The other
native modules already destructure the module namespace and were not affected
(checked: `purchases.ts` returns a wrapper; nothing else returns a plugin).

`tests/unit/nativePushNeverAwaitsAPlugin.test.ts` mocks the plugins the way
Capacitor builds them - any property is a method, `then` throws exactly what
Android threw - and pins that `initNativePush()` attaches its three listeners
and that the permission and stored-token reads resolve. Against the old code
both tests fail with the Android error, verbatim.

Verified on the emulator: no unhandled rejection at launch; Enable now opens
Android's own "Allow Club Arena to send you notifications?" dialog.

## What that uncovered, and the guard

With register() finally reachable, tapping Allow CRASHED the app: the push
plugin calls Firebase, and this build has no `google-services.json`
(`IllegalStateException: Default FirebaseApp is not initialized`, thrown on the
plugin thread, which takes the whole process down). Firebase is already on
Dan's list; until it exists, push cannot work at all. What must not happen is a
store bundle shipping without it, because then the first-run Enable button
crashes the app for every player who taps it.

`scripts/native/android-bundle.sh` used to WARN when the file was missing. It
now refuses to build the store bundle without it (pinned in
`tests/unit/nativeBinaryConfig.test.ts`). Debug builds are unaffected.

## And then it crashed at launch

After Allow, the permission stays granted, and every launch registers for push
again - so the same Firebase-less `register()` now crashed the app AT LAUNCH,
every launch, not only on the button (seen on the emulator: the app would not
stay open until the permission was revoked with `adb shell pm revoke`). The
script guard is not enough for that: Android Studio's own "Generate Signed
Bundle" never runs the script. So `android/app/build.gradle` now refuses any
RELEASE task when `google-services.json` is missing
(`gradle.taskGraph.whenReady`), with the reason in the message. Checked:
`./gradlew bundleRelease --dry-run` fails with it; `./gradlew assembleDebug
--dry-run` still passes, so debug builds for testing are unaffected.
