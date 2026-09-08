# 2026-09-08 - It feels like an app (store readiness, phase 5)

Audit tiers 2 and 3: "it works, but it feels like a website". Every change
here is gated on the native shell - `isNativePlatform()` in code, the
`html.ca-native` class in CSS (set by index.html before any stylesheet
applies) - and the plugin code stays in `src/lib/native/`, loaded only from
those gates. The web renders and behaves exactly as it did; a browser tab keeps
its pull-to-refresh, its rubber band and its long-press menus because on the
web those are the platform behaving normally.

Several audit items were already true on main and are recorded as such rather
than re-done: `BottomSheet` already had `setPointerCapture` and `touch-action:
none` on its handle; six components already capture pointers; `SoundService`
already resumes its context on `visibilitychange`; source maps were switched
off for the native build in phase 1; fonts are self-hosted into the native
bundle by `self-host-fonts.mjs` under `CA_PUBLIC_BASE=/` (phase 1).

## What changed

- **Haptics** (`src/utils/vibrationGate.ts` -> `src/lib/native/haptics.ts`):
  inside the app the phone's own engine (`@capacitor/haptics`) fires, ahead of
  both web paths. The gate's preference switches and coalescing are untouched;
  a pattern's weight picks Light / Medium / Heavy.
- **Keep-awake** (`src/hooks/useTableEnvironment.ts` ->
  `src/lib/native/keepAwake.ts`): WKWebView never got `navigator.wakeLock`,
  so on iOS the felt slept mid-hand. Same holder count, same last-table-out
  release; the plugin holds the OS idle timer.
- **Exports and share cards** (`src/utils/downloadCsv.ts`,
  `AchievementShareCard`, `StatsShareCard` -> `src/lib/native/share.ts`): a
  webview does not honour `<a download>`, and Android's has no
  `navigator.share`. The bytes are written to the app's cache and the system
  share sheet opens on the file. Eleven CSV consumers are covered by the one
  helper.
- **Document overscroll, touch-callout, felt selection**
  (`src/styles/club-engine.css`, `html.ca-native ...`): no rubber band, no
  pull-to-refresh glow, no long-press callout on the app's chrome; inputs and
  chat keep selection, because a player pastes into them.
- **Safe areas** (`Modal.css` footer and bottom drawer, `BottomSheet`
  content): `env(safe-area-inset-bottom, 0px)` - 0 where there is no inset, so
  the web is unchanged, and clear of the home indicator where there is.
- **Swipe rows** (`src/hooks/useSwipeAction.ts`): the pointer is captured
  once a drag is recognised (>10px), never on a tap, so a finger that leaves
  the row keeps driving it and a tap's click target is exactly what it was.
- **The second AudioContext** (`PremiumSFX.ts`) resumes on foreground, as
  `SoundService` already did.
- **Scratch images**: 24 `public/images/test*` files (12 JPG/PNG + their
  generated WebP) that nothing referenced are deleted from the shipped
  bundle.
- **Orientation**: the OS-level portrait lock landed in phase 2's shells
  (`Info.plist`, `AndroidManifest.xml`); `PortraitLock.tsx`'s prompt stays for
  the web.

## Deliberately not done here

- `-v6` filename suffix (audit tier 3): it is the web's cache-bust and
  removing it re-downloads every chunk for every web player for nothing the
  app needs. Left alone.
- `sw-bus.js`: not registered in the app since phase 1; its message-driven
  notifications become native local notifications in phase 4.
- The "+" hub tab on native (framing smarter.poker cross-origin): opened in
  the in-app browser instead, in phase 3b, because that edit lands on a file
  phase 2 also touches.
- Pointer capture in ClubQuickLinkTile / HomePage / TableTabBar / Carousel:
  TableTabBar already captures, HomePage has no element-bound drag, and
  capturing on pointerdown would move a tap's click target to the container
  (that is what the spec says capture does), which would break child buttons
  on the web. Not a change worth making blind.

Pinned by `tests/unit/nativeFeel.test.ts`.
