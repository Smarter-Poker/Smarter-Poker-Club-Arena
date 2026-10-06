# A clear with no hand is done (2026-10-04)

Engine change: activates in a :55 window. The engine half of
`2026-10-04-a-turn-handed-back-is-a-turn.md`, cause 2. No database change.

## What happened

At a heads-up sit-and-go on 2026-10-04 (table `a84e44e8`, 19:39 to 19:42 UTC)
one armed pre-action folded thirteen hands for the player who armed it, ten of
them within half a second of the deal, while each of three open tabs of the
account sent 68 to 98 refused `/preaction` requests a minute.

The browser clears a pre-action at every hand boundary. `setPreAction` handled
`clear` BELOW the two refusals meant for an arm, so a clear that arrived
between hands, or from a player not dealt into the hand, was answered
`No active hand` or `Player not found at this table` with HTTP 400. Both
describe a state in which that player holds nothing that could run, which is
what a clear asks for. The browser read the refusal as "the engine still holds
it", put the control back, and (until the client change of the same day)
putting it back sent the arm again, into the next hand, where an arm that
arrives on the player's own turn runs at once.

## The fix

`ServerTableEngine.setPreAction`:

- `clear` is answered first, and is `success` whether or not a hand is
  running and whether or not the player is in it. A seat in the running hand
  is cleared exactly as before. Outside that, only an entry that exists is
  removed, so a clear from somebody who holds nothing creates no per-player
  state.
- The two refusals an ARM can meet now carry a code beside the sentence:
  `NO_ACTIVE_HAND` and `NOT_IN_HAND`. The page reads either (the sentences
  are what the engine live before this release sends).

Nothing else about arming, the recorded price, immediate execution or the
push to the player's sockets changes. Lightning rooms are untouched: the page
never restores a pre-action there, so they had no loop.

## Why both halves

The page now reads `No active hand` correctly and no longer sends what it only
means to show (`src/lib/preActionSync.ts`). A tab keeps the bundle it loaded
until it leaves the table route, so a seated player on the older bundle would
still loop against an engine that answers a clear with a refusal. With this
release the older bundle's clear succeeds and it has nothing to restore.

## Tests

`server/src/engine/AClearWithNoHandIsDone.test.ts`: the engine's own
`setPreAction` with no hand, with a hand the player is not in, and in a
running hand; the real `/preaction` door for the HTTP status; and that an arm
is still refused where there is nothing to arm it in. Run against the unfixed
source, 8 of its 11 cases fail.

## Not verified

No engine was deployed and no production table was touched by this change.
The loop itself is reproduced in the client test
(`tests/unit/preActionSync.test.ts`), not against a live engine.
