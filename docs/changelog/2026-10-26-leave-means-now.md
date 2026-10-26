# Leave means now, and the avatar finishes its action first

Dan, 2026-10-25, verbatim:

> AVATARS SHOULD NOT LEAVE THE TABLE UNTIL AFTER THEIR ACTION IS COMPLETED.
> ALSO IF A USER CLICKS LEAVE GAME, IT NEEDS TO LEAVE GAME RIGHT AWAY, NOT THE
> NEXT HAND OR IN A COUPLE HANDS, LEAVE NOW, EVEN IF ITS IN THE MIDDLE OF A HAND.

## What was wrong (engine, `ServerTableEngineSeating.leaveTable`)

1. **Off-turn leavers were not folded.** `performAction(fold)` returns false
   when it is not the player's turn, so the engine queued an `auto_fold`
   pre-action and then sat the player out on the spot. The live snapshot then
   carried `is_folded: false, is_sitting_out: true`, which the client maps to
   `sitting_out` (`src/utils/mapEngineSnapshot.ts`): every watcher saw the
   seat grey out, lose its cards and wear SITTING OUT with no fold ever shown,
   while the player stayed live in the hand until action came round. Horses
   reach this door through the rotator, so it happened to horses constantly.
2. **All-in leavers were refused** (the 2026-08-26 rule). The client still
   went to the lobby, but the seat stayed live and was dealt the next hand and
   the one after.

## What it does now

- A leaver whose turn it is folds through the ordinary turn door, as before.
- A leaver whose turn it is NOT folds at once through the controller's early
  fold (`HandController.performImmediateFold`, the door Lightning already
  uses). A real FOLD is recorded and broadcast immediately, and the player on
  the clock keeps their clock.
- An all-in leaver's request is accepted and recorded durably like any other
  mid-hand leave. The seat cannot fold, so it plays its hand out without being
  shown as sitting out, is taken out of the next deal through `pendingSitOut`
  (drained at settlement), and settlement cashes it out the moment the hand
  ends. This keeps the purpose of the 08-26 rule (the chips play out the hand
  they are in) while the player leaves now.
- The tournament branch uses the same two helpers (`foldLeaverNow`,
  `sitOutLeaver`).

The client already put the player in the lobby the instant they confirm the
leave; no client change was needed.

## Not changed

The chip-continuity stay clock (a cash player ahead of their buy-in with stay
time left gets "Leave Available In M:SS") is a separate rule and is untouched.

## Tests

- `server/src/engine/LeaveMeansNow.behaviour.test.ts` (human and horse twins):
  off-turn fold now, on-turn fold, all-in accepted and not greyed. Four of its
  six specs fail on the previous code.
- `server/src/engine/HandController.leaveFold.test.ts`: the early fold on an
  ordinary cash configuration through the real HandController, with chip
  conservation.
- `tests/all-in-cannot-leave-and-the-hud-slot.test.ts`: the all-in refusal pin
  replaced by the new rule.
