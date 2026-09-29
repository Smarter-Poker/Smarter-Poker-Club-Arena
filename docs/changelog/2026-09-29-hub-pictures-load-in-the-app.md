# 2026-09-29 - Hub pictures load in the app

Walking the Android build for store review: the Avatar Gallery - the first
thing a new player opens, from the Complete Your Profile card - showed
twenty-five question marks, and once one was chosen the card showed a broken
image.

## Why

Player pictures are stored as root-relative paths on the World Hub's origin.
Measured on production: `profiles.arena_avatar_url` holds `/avatars/table/...`
for 1,243 players and `avatar_url` for 283; the Hub's `/api/avatars` catalog
answers `/avatars/free/rockstar.webp`; two club logos are `/hub/...`, one
avatar `/smarter-poker-logo.png`. On the web the Hub is the origin, so they
load. Inside the app the origin is the bundle (`https://localhost`,
`capacitor://localhost` on iOS), which holds none of them. Table seats were
spared only because `getAvatarWithFallback` already builds absolute addresses;
every other picture that rendered a stored path directly failed.

## What changed

`src/lib/native/hubPictureShim.ts`, installed from `main.tsx`'s native boot
path before React renders, like the fetch shim beside it: an `<img>` or
`<source>` address (`src`, `srcset`, set by React's `setAttribute` or by code's
`img.src = ...`) that is root-relative and whose first path segment is not in
the bundle loads from `https://smarter.poker`. The native build hands it the
bundle's own top-level entries (`scripts/native/bundle-roots.mjs`, defined as
`__NATIVE_BUNDLE_ROOTS__` for native builds only), so `/images/...`,
`/cards/...` and `/default-avatar.png` stay local; without that list the shim
does nothing rather than guess. The web build is unchanged: nothing new is
defined for it and the shim is never imported there. Stored values are not
touched.

`tests/unit/hubPicturesLoadInTheApp.test.ts` (28 cases) pins which addresses go
to the Hub and which stay, the installed shim on both setAttribute and
property assignment, the boot wiring, and that only the native build gets the
list.
