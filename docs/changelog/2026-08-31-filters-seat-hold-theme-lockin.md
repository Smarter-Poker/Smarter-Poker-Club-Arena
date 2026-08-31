# 2026-08-31 - Filters Save On Click, 60s Exclusive Seat Hold, Theme Lock-In

Dan 2026-08-30, three requests in one message.

## 1. Filters save when clicked (PR #2007, merged)

AdvancedFilters persists the store to `ca_advanced_filters_<clubId>` on every
interaction, not only on Apply; closing the sheet without Apply re-reads the
saved store into the lobby (ClubHomePage onClose).

## 2. 60-second exclusive waitlist seat hold (PR #2014 + prod migration `sixty_second_exclusive_seat_hold`)

- `fn_offer_open_seat`: offer TTL 60s (was 3m), writes `table_waitlist.hold_expires_at`,
  and never issues more holds than open seats.
- `atomic_table_buyin`: an unexpired hold owned by someone else counts as an
  occupied seat (`SEAT_RESERVED`); horses buy in through the same RPC, so the
  rule binds every player identically (10.5). Sitting settles the sitter's own
  waitlist rows, releasing the hold when used.
- Client: seat-offer toast lives 60s and deep-links `/table/:id?buyin=1`;
  `waitlist_seat_open` bell deep link carries `?buyin=1`; TablePage auto-opens
  the buy-in flow on the first open seat when it sees the param (cash only).

## 3. Theme lock-in on World Hub surfaces (WH PR #1053)

Arena already persists + caches the theme (`user_theme_settings` +
`ca_user_theme_rows:<uid>`) and applies it on every Arena table. WH gains
`src/lib/clubArenaTheme.js` reading that same-origin cache; the training game
tables, TrainingGameTable, TableThemes.getActiveTheme and the
personal-assistant sandbox (page + table) now paint the saved Arena theme,
falling back to their previous looks when no theme is saved. Skin/background
artwork copied to `public/hub/table-theme` (bundle asset URLs are hashed).
