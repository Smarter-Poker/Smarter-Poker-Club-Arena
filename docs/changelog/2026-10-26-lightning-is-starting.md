# 2026-10-26: "Lightning Is Starting" while a game switches into Lightning

Client only. Dan approved: "show Lightning Is Starting during the switch".

## What a player saw

While a MUST MOVE game converts into Lightning (mode `pending_on`), every one
of its tables finishes the hand in play and deals no other until the
conversion commits: 54.5 s on average over 36 conversions, p95 106 s, up to
146 s. The felt simply went quiet, with nothing to say why, and the table's
own read of its game ran every 30 s.

## What changed

- `LIGHTNING_STARTING_TEXT` ("Lightning Is Starting") and
  `lightningStartingOnTable` (src/lightning/lightningHand.ts): a physical table
  (never a Lightning room) whose game is in `pending_on`.
- `LightningStartingNotice` shows the line in the same felt band as the room's
  "Lightning Is Ending" (`.lightning-felt-notices`). Words only; nothing
  navigates (CLAUDE.md 10.6). When the conversion commits, the existing
  "Your Game Is Now Lightning" notice with VIEW GAME takes over.
- `lightningTableRefreshMs` (src/lightning/lightningLobbyFeed.ts): while the
  table's game could switch (MUST MOVE with the Lightning switch on) or is
  switching, the table re-reads its game every 5 s instead of 30, so the line
  appears and clears on time. Every other state keeps 30 s, and a Classic game
  is still asked once and never again.

## Tests

- New: `tests/lightning/lightning-is-starting.test.tsx`.
- Updated: `tests/unit/committedFoldIdentity.law.test.ts`, whose pin on the
  table's one game read gained the refresh option (the Classic settle it pins
  is unchanged).
