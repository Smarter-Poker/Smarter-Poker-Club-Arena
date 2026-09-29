# 2026-09-29 - The web build carries no app code

## What was wrong

The store-readiness "native feel" work (2026-09-08) reached the app-only
modules in `src/lib/native/` - the share sheet, haptics, keep-awake, the
in-app browser, device push, store purchases - from shared code behind the
RUNTIME check `isNativePlatform()` alone. On the website that check is always
false, so no player ever ran any of it. But Rollup cannot know a runtime
answer, so the web build still emitted every one of those modules and the
Capacitor plugins they load: ten chunks of app-only code in the website's
output. That contradicts the law this repository already had
(`tests/the-web-bundle-does-not-know-the-app-exists.law.test.ts`: "every
difference is gated on the one compile-time constant, so the native branches
are dead code on the web"), and it was paid for by every other change, because
the whole-app size ceiling counts every chunk the web build emits.

It surfaced when that ceiling stopped the prompt-lane fix (#5570): main
measured 2880.42kB gzipped against a 2880kB ceiling that rounds, so any change
adding more than about 80 bytes anywhere now failed Production Build.

## The fix

Each of those imports now sits behind the compile-time constant as well:
`IS_NATIVE_BUILD && isNativePlatform()` in front of the share, haptics,
keep-awake, in-app browser and push branches, and
`IS_NATIVE_BUILD ? import(...) : Promise.reject(...)` for the store-purchase
calls in the marketplace (which the web never reaches). In the app build the
constant is true and nothing changes; on the web the branches are dead code
Rollup removes.

Measured with the same dependencies (local builds, gzip level 9, the size
gate's own file set):

|             | Files | Whole app (gz)     |
| ----------- | ----- | ------------------ |
| main        | 600   | 2880.42kB          |
| this change | 590   | 2873.67kB (-6.9kB) |

## So it stays fixed

The law gains a rule: every `import()` of `src/lib/native/*` or a Capacitor,
Capgo or RevenueCat package outside the native shell must have
`IS_NATIVE_BUILD` in front of it (type positions like `import('x').T` are
exempt; `import('x').then(...)` is not). Checked by removing one guard: the
law named `src/utils/downloadCsv.ts` and failed; restored, it passes.

Three test files that pretend to be inside the app now say so completely:
`pretendNative()` sets the app build as well as the Capacitor bridge (a getter
on the mocked `IS_NATIVE_BUILD`), in `nativeStoreAndPush`, `nativeFeel` and
the one-door law. One source pin in `nativeStoreAndPush` follows the purchase
import into its guard. The 77 test files that touch the changed modules pass
(1,334 tests).

## Checked in the app

The app build is unchanged: `dist-native` still carries every one of these
modules (`share`, `haptics`, `keepAwake`, `browser`, `push`, `deepLinks`), and
on the Android emulator the gated paths still run - Settings, Export Data
opened the system share sheet with `club-arena-export-2026-09-29.json`, and
Go To The Hub opened the in-app browser (Custom Tabs).

The store-purchase code is absent from BOTH builds today, and that is not this
change: `NATIVE_MARKETPLACE_PAYMENTS_READY` is `false` (#4805), so the purchase
calls sit behind a constant hold in the app build too.
