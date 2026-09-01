# Phase 5 of 7, item 5.5 - a sat-out seat acts on the same beat as every other seat

2026-09-01. Branch `phase5/sit-out-beat`.

## What it did

`DisconnectEngine.onPlayerTurn` folded a sitting-out player the instant the
action reached them:

```ts
// Player is sitting out — auto-fold immediately
if (state.isSittingOut) {
  this.executeAutoAction(tableId, playerId, canCheck, 'sitting_out');
  return false;
}
```

Zero milliseconds, called straight from the branch. Every other action on this
platform has a deliberate beat: a horse floors at 350 ms free and 1,250 ms
facing a bet (the HorseLogic V24 floors), a pre-action waits 900 ms, a settle
waits 650 ms.

## Why that is a bug and not a detail

Dan, 2026-08-27, binding, in CLAUDE.md section 10.5:

> TIMING IS PART OF THE TREATMENT. The tell is never one hand, it is the
> RHYTHM: a table that stops for five seconds when one seat busts and rolls
> straight on when another has just told every watching player which seats are
> horses.

The same argument runs in the opposite direction here. Heads-up against a
disconnected opponent, every hand resolved at machine speed, which tells the
player still at the table exactly what has happened to the other one - and runs
the level clock down on a player who cannot act. Two seats, two-minute levels:
a thirty-second signal drop is a lost buy-in, dealt at a speed no human table
has ever run at.

## The fix

`server/src/engine/sitOutBeat.ts` is pure and holds the two floors, matched
deliberately to HorseLogic's so a sat-out seat has no rhythm of its own, plus a
350 ms jitter so a fixed value does not become its own tell over a few hundred
hands. `DisconnectEngine.scheduleSitOutAutoAction` schedules the auto-action on
the existing `PreciseActionTimer` under the SAME key the disconnect countdown
uses (`disconnect:<playerId>`), so `cancelTimeout` and `cancelAllCountdowns`
already reach it and a beat cannot leak past a hand boundary.

Nothing else moves. The turn is still not offered (`onPlayerTurn` still returns
false, and its caller already reads that as "DisconnectEngine will handle the
auto-action via callback"), the action is still a fold with reason
`sitting_out`, and it still happens without anyone doing anything. Only the
zero is gone.

The sit-out state is re-checked at the deadline rather than trusted from the
top of the beat, so a player who sits back in during those few hundred
milliseconds gets their turn - which is the point of not folding them
instantly.

## The pin that had to move

`afkSitOutGuard.test.ts` carried `"a sat-out player's turn is auto-resolved
instantly, not timed"`, which asserted the fold had already happened when
`onPlayerTurn` returned. That test pinned the bug. It is replaced in this same
commit by three that pin the new mechanism and everything about the old one
that must not change:

- the turn is not offered, no action fires at zero, and the fold lands on the
  beat with reason `sitting_out`;
- a player who sits back in during the beat is never folded;
- the two floors still equal HorseLogic's 350 and 1,250, and no draw of the
  jitter can produce a delay below the free floor.

## Verification

- `npx tsc --noEmit` in `server/`: clean.
- `DisconnectEngine`, `afkSitOutGuard`, `DisconnectMidTurnTimeBank`,
  `SilentClientCanary`, `TableWatchdog`: 5 files, 60 tests, green.
- The full server suite runs in CI on this pull request.

## Phase 5 status

Measured live at 12:55 UTC, and two items are worse than the audit recorded:

| item                                      | state                                                                                                                                                                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 chip-dump detection                   | `anti_cheat_events` holds **6 rows all time**, newest **2026-05-01**. No SQL function anywhere WRITES `collusion_tracking`; `detect_collusion_pairs` only reads it. The detector has to be built.                                            |
| 5.2 scoring calibrated to noise           | 169,523 flags cleared at an average suspicion of **96.8**, minimum **70**. Every flag is "almost certainly collusion", so the score carries no information. 7 open.                                                                          |
| 5.3 no duel re-entry limits               | Calibration for a real threshold: over 7 days, 10,134 duels across 8,044 distinct pairs, and **the most any pair met is 5**. A repeat-pairing rule at 8+ meetings in 7 days would have raised zero false positives on the entire live board. |
| 5.4 heads-up disconnect protection        | not started                                                                                                                                                                                                                                  |
| 5.5 sit-out beat                          | **this change**                                                                                                                                                                                                                              |
| 5.6 insurance / run-it-twice at 2 players | needs Dan's ruling, not an agent's                                                                                                                                                                                                           |
