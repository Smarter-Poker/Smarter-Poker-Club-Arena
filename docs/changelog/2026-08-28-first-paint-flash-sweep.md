# 2026-08-28 — First-paint flash sweep: name, face, and every settings toggle

Same bug class as the table-theme flash fixed this morning: state initialized
to a hard-coded default, real value arriving one tick (or one round trip)
later, painting the wrong thing on every mount.

## The player's own identity (new: src/lib/cachedIdentity.ts)

The header orb cold-opened as the monogram for the literal seed 'player'; the
hero's own seat opened as "Player" with an empty avatar for the length of
getAuthUser() plus a profiles query, on every table open. The avatar cache
that exists (ca-avatar-cache) was gated behind an async user id — a
synchronous cache behind an async key is still async.

cachedIdentity reads the user id SYNCHRONOUSLY from the persisted Supabase
session (paint hint only, never authentication) and keys the cached
name/face to it, so another account's identity can never paint on a shared
device. Consumers: GlobalHeader (orb + name), TablePage (hero seat, buy-in
modal, winner overlay). Writers: TablePage's profile fetch, HamburgerMenu's
profile fetch, the avatar-gallery USER_PROFILE_LOADED path.
useUserStore.logout() clears it. The database stays truth everywhere.

Pinned by tests/unit/cachedIdentityFirstPaint.test.ts (8 tests: both session
shapes, per-account isolation, merge semantics, logout hygiene).

## Lazy initializers for synchronous reads that ran in effects

- SettingsPage: every toggle/dropdown painted DEFAULT_SETTINGS for one frame
  on every visit — the localStorage read was synchronous but ran post-paint.
- HamburgerMenu: sounds / vibrations / stack-in-BB / real-name switches, same
  shape (the component even had the correct lazy pattern six lines below, on
  selectedCardColor).
- TableMenu: the "Real Name / Username" badge, same shape; TablePage reads
  the same key in an initializer already.

isVip stays async BY DESIGN — entitlements are not cached locally (see
useHeaderDataStore's cosmetics note). Do not "fix" that.
