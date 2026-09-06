# A rabbit hunt from the replayer

2026-09-05. P5, the last item of the card presentation programme, and the one
thing the 2026-09-05 competitive research found a rival doing that we did not.

## The gap

The felt offers the Rabbit Hunt for **2250ms** on a fold and 2650ms on a
showdown. The engine holds the offer for **ninety seconds**
(`RABBIT_HUNT_OFFER_TTL_MS`). Everything between those two numbers was a
window the player could not reach - the offer was alive, purchasable and
invisible.

That is the same shape as the defect fixed on 2026-09-05 in the button itself,
where two generous guards were both measuring a clock nobody could see. This
one was measuring a clock nobody could REACH.

ClubWPT Gold lets a player rabbit hunt later from the hand replayer, and it is
the only room in the twelve surveyed
(`docs/research/2026-09-05-rabbit-hunt-industry-standards.md`) that does.

## What it does

The Hand Detail modal - the replayer already reachable from the in-table Hand
History - now offers the hunt on a hand that still qualifies, and paints the
cards it buys under the board that actually ran.

**The engine still decides everything that matters.** `revealRabbitHunt`
checks the offer's existence, its TTL, the table's `allow_rabbit_hunt`, the
board length, whether the caller was dealt into that hand, and whether they
have already bought it. None of that moved, and none of it was copied.

`replayRabbitOffer` decides only whether to SHOW the button, so the replayer
does not dangle a dead control on the thousands of hands plainly past selling.
It answers no when the board already ran out, when the hand ran more than one
board (Run It Twice and bomb pots - the engine refuses those too), and when the
hand is older than the server's own window. When it says yes and the engine
still says no, the engine's own sentence is what the player reads. That is the
right way round.

The client's copy of the ninety seconds is pinned equal to the engine's
literal by test, the same way `ALL_IN_STREET_PAUSE_MS` is - the engine builds
from its own `rootDir` and cannot share a module.

## One purchase, two surfaces

The reveal moved into `useRabbitHuntReveal`: the synchronous single-flight
mutex, the one call that charges and answers, the toasts that say what was
taken, and the counts the tile shows.

This is not tidying. This repo keeps being bitten by a second implementation
of a paid action drifting from the first - the deleted standalone rabbit
button, the duplicate keyboard listener, the parallel `handleFold`/`handleCall`
pair that skipped VPIP counting. A rabbit hunt spends real diamonds and a real
VIP allowance; there must be exactly one path that spends them, and a test now
pins that neither surface calls `requestRabbitHunt` itself.

`RabbitHunt` keeps what it actually owns: the artwork, the price badge, the
remaining counts, and the offer's own visibility. Its forty existing pins pass
unchanged, which is the evidence the refactor changed no behaviour.

**One regression caught in the extraction and fixed before it left the
branch:** the first cut took the VIP-status effect with it, which is what
fills in "N free this month" BEFORE the press. Restored, and the hook exposes
`setVipRemaining` so the pre-press count and the post-reveal count remain ONE
piece of state rather than two that can disagree.

## Where the cards go

To the buyer, and nowhere else - unchanged from the felt. Dan 2026-08-25:
"These should ONLY APPEAR TO THE PLAYER WHO CLICKED." They are rendered in
this player's own modal, from the response body of their own authenticated
request, and are in no broadcast. They are outlined apart from the board that
really ran, because they never came.

## Verified

`tests/unit/rabbitHuntFromTheReplayer.test.tsx`, 14 pins: the offer rule
across every boundary (ran out, preflop fold, re-run, bomb pot, past the
window, the last second, no hand); the client TTL pinned equal to the engine's
literal; the engine's refusals still present; one purchase path across both
surfaces with neither reimplementing the charge; and the purchase driven for
real - it buys once for the hand named, a second press after a reveal does not
reach the paid endpoint, and a refusal charges nothing and reveals nothing.

Not done: a live purchase from a real table's replayer. The charge path itself
is the one the felt has been using in production since 2026-08-25.
