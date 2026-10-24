# A Lightning player between hands shows their balance, never SITTING OUT or 0.00 (2026-10-24)

## What Dan asked

"IN LIGHTNING GAMES, WHEN YOU MOVE TO A NEW TABLE AFTER FOLDING... IT SHOUDN'T
SAY SITTING OUT... AND IT SHOULD 100% ALWAYS SHOW YOUR BALANCE AT ALL TIMES, IT
SHOULD NEVER SAY 0.00"

## Root cause

A Lightning fold answers with the idle room (`LightningHandHost.idleShape`:
stage `waiting`, `players: []`). With no hero in the roster, TablePage drew the
hero chair from the cash seat-row placeholder, which hard-codes
`status: 'sitting_out'` and reads its stack from the seat row or the pending
buy-in. A pool session has neither, so every fold showed SITTING OUT over 0.00.

## The fix (client only, no engine dependency)

- `src/lightning/lightningWaitingHero.ts` decides the chair: active unless the
  player asked to sit out; balance from the last roster stack for this room,
  else the pool balance from `fn_lightning_my_session` (which also wins over a
  last-seen zero, and replaces the roster figure after chips are added between
  hands).
- The footer says nothing between Lightning hands (it said "Seat Reserved,
  You'll Be Dealt In Next Hand"); "Next Hand..." on the felt covers a long gap.
  An explicit Sit Out still gets the sitting-out bar and I'm Back.
- A room opened between hands (fresh join, reload, second device) gets a
  display chair once the database confirms the room is the caller's own pool
  session; it used to show a spectator felt with tappable seats.
- Seats are never tappable in a Lightning room, and a tap never opens the cash
  buy-in against the pool-session id.
- Leave and Add Chips read the same balance (they said 0 between hands).
- The cash bust-rebuy prompt and the cash session restore no longer run in a
  Lightning room (it has no `tables` row; Lightning rebuys through its pool).

## Pinned by

`tests/a-lightning-player-between-hands-shows-their-balance.law.test.ts`,
`tests/unit/heroPlaceholderStack.test.ts`, `tests/im-back-is-never-shadowed.law.test.ts`.
