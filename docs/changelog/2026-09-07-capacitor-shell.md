# 2026-09-07 - The Capacitor shell: Club Arena boots as an app (store readiness, phase 1)

Dan: "start on all the app store work that needs to be completed before we can
go live and actually launch this as an app. you need to do everything on this
list, but can't break anything that's currently working." The list is the
Capacitor Readiness Audit (revised 2026-09-04): 11 hard blockers, 8 high, 8
medium, 7 low, in 7 phases. This is phase 1, "make it boot", plus the phase 3
source-map item and the audit's index.html cleanups, because they live in the
same files.

## Dan's phase 0 rulings (2026-09-07), recorded so nobody re-asks

- Chips at review: "Chips are club play credits. Smarter.Poker does not sell,
  redeem or pay out chips and assigns them no monetary value; any arrangement
  between a member and their club's agent is private and off-platform." The
  Terms line "cannot be exchanged for real money or prizes" is to be dropped.
  (Applied in phase 3, with the Terms modal it wires.)
- The iOS build ships email + password sign-in only. No Apple, Google or
  Facebook in the binary, so Guideline 4.8 does not apply. Web unchanged.
- OTA from launch, via Capgo. Binaries are scheduled events.
- No accounts exist yet: Apple Developer, Google Play Console, Firebase,
  RevenueCat and Capgo are all Dan's to create (10.84: an agent never sets a
  credential). Each phase that needs one says so in its changelog.

## What changed

### One seam between the two targets: `src/lib/appBase.ts`

The web bundle lives at `/hub/club-arena/`; inside the Capacitor webview the
copied bundle IS the document root, so its base is `/`. Every path that used
to be the literal `/hub/club-arena` is now derived from `import.meta.env.BASE_URL`
there, so on the web every derived value is byte-identical to the literal it
replaced and on native it resolves to the root. React Router v7 renders an
EMPTY TREE, not a 404, when the basename does not match the URL, which is why
this is the file the native build depends on first.

- `ROUTER_BASENAME` replaces `basename="/hub/club-arena"` in both entry
  points (`src/main.tsx`, `src/ClubArenaRoot.tsx`).
- `IS_NATIVE_BUILD` is the compile-time constant (`VITE_NATIVE=1`); Vite
  inlines it, so native branches are dead code in the web bundle.
- `isNativePlatform()` / `nativePlatform()` ask the Capacitor bridge at
  runtime and never throw in a browser.
- `WEB_ORIGIN`, `webAppUrl()`, `publicOrigin()` exist for phase 2: a share
  link built from `window.location.origin` is `capacitor://localhost` in the
  app, which nobody can open.

`NotificationsPage.tsx`'s `CA_BASE` stays the literal web path on purpose:
it strips the prefix the SERVER writes into a notification destination, which
is a web URL on every target. The comment now says so.

### The build has a native target: `vite.config.ts`, `package.json`, `scripts/`

`npm run build:native` sets `VITE_NATIVE=1 CA_DIST=dist-native CA_PUBLIC_BASE=/`
and runs the SAME `npm run build` (`tsc -b && build:ci`), so the native bundle
is typechecked where it ships exactly as the web one is (1.1.6). Under that
flag `base` is `/`, `outDir` is `dist-native/` (gitignored; never publishable
as the web bundle), and `sourcemap` is off - the binary has no publisher to
strip maps, so a map there is ~3 MB of source in every install (audit tier 3).
`self-host-fonts.mjs`, `optimize-dist-media.mjs` and `stamp-build-provenance.mjs`
read `CA_DIST` / `CA_PUBLIC_BASE` and default to exactly what they did.

### The shell: `capacitor.config.ts`, `ios/`, `android/`, `src/lib/nativeShell.ts`

Capacitor 8.5.1, appId `poker.smarter.clubarena`, webDir `dist-native`.
iOS uses Swift Package Manager (no CocoaPods on this Mac, and none needed).
Plugins installed now so a later phase never needs a new binary for them:
app, browser, haptics, share, filesystem, preferences, keep-awake,
screen-orientation, splash-screen, status-bar, push-notifications,
local-notifications, device, network, and `@capgo/capacitor-updater`.

`nativeShell.ts` is reached ONLY through a dynamic import behind
`IS_NATIVE_BUILD` in `main.tsx`. It hides the splash after React's first
paint (the config sets `launchAutoHide: false` so a slow cold boot shows the
logo, not a white flash), styles the status bar, wires the Android back
button, and calls `CapacitorUpdater.notifyAppReady()` - which Capgo REQUIRES
on every launch or it rolls the bundle back as broken.

The service worker is not registered in a native build (`App.tsx`): the
bundle is already on disk, and on iOS a worker under `capacitor://localhost`
is not reliably installed. Its message-driven notifications become native
ones in phase 4.

### `index.html`

- The self-heal script takes zero retries on native: there is no World Hub
  soft-navigation to heal, no cache to nuke and no worker to unregister, and
  two silent reloads would only hide a real boot failure. It goes straight to
  a visible "Loading Failed / Try Again" that does not mention browser caches.
- `apple-touch-icon` is root-relative like the manifest, so Vite rewrites it
  for whichever base the bundle is built with (web output is identical).
- The two `/src/styles/*.css` preloads STAY, and the audit's "two dead lines"
  finding is wrong: Vite treats a root-relative `/src/*.css` in index.html as
  an entry stylesheet and bundles it into the index CSS, and those tags are the
  only way `globals.css` and `design-tokens.css` reach the bundle. Deleting
  them dropped 18 kB of rules (`.btn`, `.card`, `.badge`, `.skip-link` ...)
  from the web CSS; the entry-chunk gate caught it before merge. Restored, with
  a comment saying why, and the index CSS is now byte-identical to production
  (177,902 bytes, `cmp` clean).

### ~70 hardcoded asset addresses (audit tier 1, "not broken today")

61 CSS `url('/hub/club-arena/...')` across 15 stylesheets are now
`url('/...')`. Vite rewrites a root-relative public asset in CSS to the build
base, which is how `HomePage.module.css` has always referenced `bg-vault.jpg`;
verified in this branch's web build: `url(/hub/club-arena/images/bg-vault.jpg)`
in the emitted CSS, byte-identical to before. 8 TSX `src="/hub/club-arena/..."`
now go through the existing `mediaUrl()` helper (`ClubIntegrityHeader`,
`HamburgerMenu`, `FindPlayerModal`, `JoinClubModal`, `CreateClubModal`,
`LegalDocumentLayout`, `ClubDataPage`, `HelpPage`). No artwork was touched.

## Law

`tests/the-web-bundle-does-not-know-the-app-exists.law.test.ts` pins: the web
base and `dist/` unless `VITE_NATIVE=1`; a derived basename in both entry
points; Capacitor imports only inside `src/lib/nativeShell.ts` (or
`src/lib/native/`), only dynamically; `build:native` as the sole setter of
`VITE_NATIVE`; the publisher never setting it. Two existing pins that quoted
the literal basename were updated in this commit.

## What this does NOT do yet

The app boots to the lobby and every route renders, but until phase 2 a cold
start is signed out for ever (the session lives on the shared same-origin
`smarter-poker-auth` key, which does not exist in a webview) and every
protected route bounces to a World Hub login page that is not in the bundle.
Phase 2 is next, on a fresh branch off main.

## Building it (for whoever has the machines)

- `npm run build:native && npx cap sync` copies the bundle into both shells.
- iOS needs Xcode (only the Command Line Tools are on this Mac). Android
  needs a JDK 17 or 21 on PATH - the Mac's default is Java 25, which Gradle
  refuses (`Unsupported class file major version 69`); Android Studio's
  bundled JDK works.
- Icons and splash: `npm run cap:assets` from a 1024x1024 source (phase 6).

## Entry chunk (CI's "Entry Chunk Is A Reviewed List" gate)

`src/lib/appBase.ts` enters the entry chunk, by design: it is the router
basename, which `main.tsx` needs before the first render, and the whole module
is ~1 kB with no imports. The baseline is updated in the same commit, as the
gate asks: +1 module, +1 kB gz, nothing else. Nothing else
moved into first paint: `nativeShell` and every Capacitor plugin are behind a
dynamic import that the web build eliminates.
