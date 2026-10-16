# Live Game Preferences: Every Choice Reaches The Row, Every Bucket Reaches The Cache

Follow-through audit of the live game preferences shipped in #7043, #7055 and #7061.
Client only. No migration, no engine dependency, no maintenance cutover.

## Lobby

- **A failed save is finished, not overwritten.** Tab, sort, Favorites and Advanced Filters
  stay marked unsynced on the device until the newest queued write is confirmed. On the next
  lobby open an unsynced choice is re-sent instead of letting the older row overwrite it.
  Before this, one dropped request (offline, a closed tab) made the next visit quietly undo
  the player's newer choice.
- **Advanced Filters follow the player from the lobby itself.** Only the open filter sheet
  ever read or wrote the row. The lobby read this browser's cache alone, and the quick chips
  (stakes, status, variants, styles, the auto-clear and Clear All) wrote the cache alone.
  Production showed 70 preference rows and only 6 carrying filters. The lobby now hydrates
  from the row on open (same refusals as the tab: an unsynced choice wins, a chip tapped
  during the round trip wins, a reply for a club already left is dropped), and every lobby
  filter change goes through `persistFilters`.
- **Filters belong to one account.** The cache was keyed by club only, so one account's
  filters survived sign-out and filtered the next account's lobby on the same browser. It is
  now keyed by account and club, adopting a pre-existing browser store for exactly one
  account, the same rule the tab cache adopted in #7043.
- **Filter writes are ordered.** Rapid taps reach the row in tap order.
- **An abandoned request is not an error.** A navigation-aborted read or save was reported
  as an error; those were the only preference errors in production this week.

## Table Studio And Table Art

- **Every saved bucket reaches the first-paint cache.** A mounted table hook merged only the
  bucket it renders, so saving PLO from an NLH table (or from Settings with no table open)
  left the PLO cache stale, and the next PLO table revealed the old felt and swapped it. One
  account-wide follower now merges every authoritative echo, recording only the server
  version while a newer local tap for that bucket is still saving.
- **No device clock in precedence.** A confirmed save was stamped with the device clock and
  compared against server times, so a fast clock let an older per-game save outrank a newer
  ALL save from another device. The confirmation stamp is now one step past the newest
  cached stamp; the server time replaces it when the echo arrives.
- **Apply To is re-read when the Studio opens.** Settings, the hamburger menu and the table
  panel keep closed Studio instances mounted; each read the scope only at mount, so one could
  save to a scope another had already moved off. It also follows a change from another tab.
- **Table art keeps retrying while the table is open.** A shared load that spent its attempts
  ended the art for the rest of the mount, contradicting the loader's own contract.

## Tests

`tests/unit/lobbyPreferenceSyncCompletes.test.ts` (new), two new cases in
`tests/hooks/themeFirstPaintCache.test.ts`, one in
`tests/unit/ThemeSettingsModalHardening.test.tsx`, and the variant-menu wiring assertion
updated to the single lobby write path.
