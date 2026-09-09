# 2026-09-09 - Audio comes back after a phone call, and the worker's banners exist in the app (store readiness, tier 3)

The last two tier-3 audit items that were not already true on main, found by
re-reading the audit against `origin/main` after phases 1-6 merged.

## "Resume both AudioContexts on app foreground"

All three sound engines (SoundService, PremiumSFX, ThrowableSoundService)
already resume on `visibilitychange`. That is not the whole story on iOS: a
phone call, a Siri prompt or a FaceTime ring moves a context to
'interrupted' and, because the app never left the screen, `visibilitychange`
does not always fire when the call ends. The next card flip is silent until
the player taps something.

`src/lib/audioContexts.ts` is a registry: each engine hands its context over
in the one place it creates it (`trackAudioContext`), and the native shell
calls `resumeTrackedAudioContexts()` on Capacitor's `appStateChange` when
`isActive` turns true. On the web nothing calls it, so registering changes
nothing there (the module is 40 lines with no imports; it entered the entry
chunk because SoundService is already there - `scripts/ci/entry-chunk.d/
feat-native-foreground-and-local-notifications.json` says why).

## "Decide what happens to sw-bus.js"

Decided in phase 1: the app registers no service worker (App.tsx,
`IS_NATIVE_BUILD`), so the worker's cache layer is gone and the FCM path
carries server pushes. What was still missing is the worker's OTHER job: the
`BUS_EVENT` banners it showed for `CRITICAL_EVENTS` (balance updated, seated,
club joined...) when no tab was visible. MasterBus now branches at that one
forwarding point: in the app the event goes to
`src/lib/native/localNotifications.ts`, which shows a
`@capacitor/local-notifications` banner with the worker's exact title and
body rules (minus the emoji the worker prefixed, 10.7), only while the app is
NOT active (`App.getState().isActive`, the same rule as the worker's
"no tab visible"), and only if the OS permission is already granted - it
never asks; push does that when the player turns notifications on. The
branch is a compile-time constant: the web bundle keeps the worker path and
does not contain the plugin path; the app the reverse.

## What was already true (checked, not changed)

- Source maps off the binary: `sourcemap: !NATIVE` (phase 1).
- Fonts offline: `dist-native/index.html` links `/fonts/fonts-<hash>.css`,
  no googleapis (scripts/self-host-fonts.mjs rewrites the tag).
- Boot self-heal neutralised on native: `MAX_RETRIES 0` (phase 1).
- Scratch files: `public/images/test*.jpg` are gone from main.
- The WebGL profiling item: `HandReplay3D.tsx` no longer exists and nothing
  in `src/` imports `three`; every canvas animation already caps
  `devicePixelRatio` at 2. `three` remains in package.json as an unused
  dependency - removing it is a package.json change unrelated to the app and
  is left for its own commit.
- `-v6` filename suffix: left. It is the web CDN's cache key; dropping it is
  a web caching change, which this programme promised not to make.

## Verified

- `tests/unit/nativeForegroundAndLocalNotifications.test.ts`: the registry
  behaviourally (suspended and interrupted resumed, running and closed
  skipped), the three engines registering, the shell listener, the body and
  title rules, the MasterBus branch shape, no permission request, no banner
  while active.
- `tsc --noEmit` clean; the web-bundle law and nativeFeel green; the
  production web build passes the entry-chunk gate with the fragment above.
