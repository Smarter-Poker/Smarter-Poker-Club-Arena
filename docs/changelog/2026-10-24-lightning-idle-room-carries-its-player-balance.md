# 2026-10-24 - The Lightning idle room carries its player's balance

Dan: "IN LIGHTNING GAMES, WHEN YOU MOVE TO A NEW TABLE AFTER FOLDING... IT SHOULD
100% ALWAYS SHOW YOUR BALANCE AT ALL TIMES, IT SHOULD NEVER SAY 0.00".

## Cause

After a Lightning fold the engine publishes an idle shape (`stage: 'waiting'`,
`players: []`) to the folder's room. It said nothing about the folder's chips,
so the client had to rebuild the hero's balance from the last roster it saw and
a `fn_lightning_my_session` read. A room opened after the fold, a reload or a
second device had no roster, and the database read is a separate round trip.

## Fix

- Engine (`server/src/lightning/LightningHandHost.ts`): `idleShape(room, owner)`
  now adds `lightning.player_balance: { user_id, stack }` for the room's own
  player and nobody else (rooms are per player).
  - At a fold (`afterFold`): `stack` is the folder's seat stack in the
    HandController state. Nothing more can leave a stack after a fold.
  - On an abandon (`publishIdle`): `stack` is the participant's `stackBefore`,
    because the hand is voided.
  - The field is additive. An older client ignores it.
- Client (`src/lightning/lightningWaitingHero.ts`, `src/pages/TablePage.tsx`):
  `lightningIdleBalanceFor(room, user, snapshot)` adopts the figure only when it
  names this user and this room. `lightningWaitingHero` takes it as
  `engineStack`, which comes first and still rejects non-finite or negative
  values. If chips are added between hands, the figure is set aside the same
  way the last-seen roster figure is, so the pool session read decides.
  The last-seen roster and the database read stay as fallbacks.

## Activation

This is an engine change, so it activates at the next 04:00 America/Chicago
daily release (CLAUDE.md section 13). Until then the current engine sends no
`player_balance` and the client uses its existing fallbacks. The client works
with both engines.

## Tests

- `server/src/lightning/LightningHandHost.test.ts`: the folder's room gets its
  own balance after a fast fold, and no other room is sent one. Over played-out
  hands, every idle balance names only its room's owner. On an abandon, each
  room gets its owner's `stackBefore`.
- `tests/a-lightning-player-between-hands-shows-their-balance.law.test.ts`:
  `engineStack` comes first, the fallbacks apply for an older engine, the figure
  is adopted only for this room and this player, and the TablePage wiring is
  pinned.
