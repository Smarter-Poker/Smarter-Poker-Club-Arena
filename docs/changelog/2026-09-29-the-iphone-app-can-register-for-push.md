# 2026-09-29 - The iPhone app can receive its push token

Found while fixing Android push on the emulator (fix/push-never-awaits-a-plugin)
and checking the iOS side of the same path by reading it, since this Mac has
no Xcode yet and the Apple account is still being verified.

## What was missing

`@capacitor/push-notifications` learns the device token on iOS only through
two `NotificationCenter` posts that the APP must make from its
`AppDelegate`: `.capacitorDidRegisterForRemoteNotifications` and
`.capacitorDidFailToRegisterForRemoteNotifications`. Club Arena's
`AppDelegate.swift` was still Capacitor's untouched template, so on an iPhone
`register()` could never complete: the app would wait out its 20-second
timeout and tell the player the device returned no token.

And a raw APNs token would not have been enough. The Hub sends through FCM
HTTP v1 (`src/lib/push/fcm.js` in the World Hub), which delivers only to FCM
registration tokens. On iOS those come from Firebase Messaging, which swaps the
APNs token for an FCM one.

## The change

- The two posts are now in `AppDelegate.swift`. When Firebase Messaging is
  linked and configured, the APNs token is exchanged for an FCM token first
  (Capacitor's documented FCM-on-iOS pattern; the plugin accepts a String token
  as well as Data), and any Firebase error is reported through the failure
  post rather than swallowed.
- Firebase is compiled in only if the package is linked
  (`#if canImport(FirebaseCore) && canImport(FirebaseMessaging)`) and
  configured only if `GoogleService-Info.plist` is in the bundle, so the app
  neither fails to compile nor traps at launch before Dan's Firebase setup
  lands (`FirebaseApp.configure()` traps on a missing plist).
- The runbook row for Firebase now names the iOS package step (Xcode, Add
  Package Dependencies, `firebase-ios-sdk`, `FirebaseMessaging` on the App
  target) beside the plist and the APNs key.

## How far this is verified

Parsed with `swiftc -parse` (clean). It cannot be compiled or run here: there
is no Xcode on this Mac and no Apple developer account yet. The first iOS
build must confirm it: Enable on the notifications sheet should raise iOS's
permission alert, and after Allow a row with `transport: 'fcm'` should appear
in the Hub's push subscriptions for that player. Pinned in
`tests/unit/nativeBinaryConfig.test.ts`.
