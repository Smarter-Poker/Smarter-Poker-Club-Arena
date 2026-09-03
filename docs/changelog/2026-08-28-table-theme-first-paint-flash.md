# 2026-08-28 — Table opens no longer flash the wrong table (theme first-paint cache)

## Symptom (Dan)

Opening any table showed the previous or default table art for a split second
before snapping to the saved selection. It looked broken on every table open,
every navigation, every refresh.

## Root cause

`useUserThemeSettings` initialised state to `DEFAULT_THEME` on every mount and
only applied the saved theme after a Supabase round trip. The first frames of
every table were therefore the default felt/background/buttons/deck, replaced
visibly when the query returned. A second flash source: the theme bucket
re-resolves when the table's game type arrives from the server, repainting
again mid-open.

## Fix

`src/hooks/useUserThemeSettings.ts` now caches the user's theme ROWS in
localStorage (`ca_user_theme_rows:<userId>`), and:

- the first render resolves synchronously from that cache through the same
  `pickThemeRow` precedence the network path uses — the opening frame already
  wears the saved theme;
- a bucket change (game type arriving, NLH -> PLO navigation without remount)
  re-resolves synchronously from the cache instead of waiting on the network;
- the database stays the source of truth: every successful load overwrites the
  cache, and an empty result evicts a stale cache back to defaults;
- every live `UI_THEME_CHANGED` application is merged into the cache, so a
  page change or refresh immediately after a change still first-paints it;
- the cache is per user id — one account's art never paints another's or a
  guest's; a failed load keeps the cached theme rather than lying defaults.

A cold cache (first visit on a device) shows the defaults exactly once.

## Pinned by

`tests/hooks/themeFirstPaintCache.test.ts` — 7 tests: synchronous first paint,
cold-cache fallback, DB refresh, stale-cache eviction, failed-load behaviour,
live-change persistence across remount, and cross-account isolation.
`tests/unit/useUserThemeSettings.live.test.ts` and
`tests/hooks/userThemeSettingsPersistence.test.ts` still pass unchanged (32
tests across the three files).
