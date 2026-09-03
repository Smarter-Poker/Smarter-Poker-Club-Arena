# 2026-09-02 — horse brain audit, phase 4: ICM, satellites, bounties, exploits, blockers (V37)

Dan: "A FULL UNDERSTANDING OF ICM AND CHIP EV VALUE, AS WELL AS THE PLAY
DIFFERENCE BETWEEN A SATELLITE WHERE ALL WINNERS GET THE SAME PRIZE AND A
MTT WITH PRIZES PROGRESSIVELY PAYING MORE. AS WELL AS EXPLOITATIVE PLAY
THAT'S AVAILABLE FOR THEM AT ALL STAGES, AND ANTI EXPLOIT LOGIC TOO." Then:
bounties / PKO / mystery bounties with the top prizes in or out, and blocker
logic preflop.

## ICM and chip EV — what was there

Verified line by line: `IcmModel` (Malmuth-Harville equity with an 8-stack
bucketed field, bubble factor by chip transfer against the largest covering
stack, premium = (BF - 1) x 0.04 capped at 0.14), `icmRisk` (real path from
live stacks + payout curve, legacy path from counts, spin = chip EV, HU of an
MTT = chip EV, final-table ladder, PKO trim), the V24 rule that the premium
scales with the share of stack at risk, the blind clock, M-zones, push/fold
charts. Chip EV vs ICM is explicit: `format === 'spin'` and winner-take-all
curves price at BF 1.

## What was wrong

### A satellite was an MTT with a top-heavy ladder

A satellite's stored `payout_structure` is the ordinary curve
(40/25/18/10/7); settlement ignores it and hands out `seats` identical
tickets (`satelliteAwardPlan`). The brain read the stored curve. And
`icmEquity` truncates at four places and spreads the rest chip-
proportionally, so even a flat curve was priced as if a big stack's extra
chips bought something. In a satellite they buy nothing.

- `TournamentBrainContext` detects a satellite (`satellite_seats` or a target),
  reads the target's buy-in + fee, and REBUILDS the curve flat:
  max(guaranteed, floor(pool / ticket)) equal places, plus one small place for
  a cash remainder. `spotsPaid` is the seat count. Exposed as `satellite`,
  `satelliteSeats`.
- `IcmModel.icmEquity` recognises a flat curve and prices it as survival:
  P(hero is not among the P - K eliminated) x one seat, from an elimination
  simulation with hazard proportional to 1/stack^2 (the textbook 1/stack gave
  a 50,000 stack a 5% chance of busting before a 4,000 stack). A covering
  stack's survival barely moves with chips, so its bubble factor saturates;
  a short stack's moves with every chip.
- `HorseLogic.satelliteRead`: LOCKED (ranked inside the seats with the blinds
  covered until the required busts happen) folds everything — aces to a
  covering all-in included — and keeps only the free aggression, an open-jam
  into a table it covers by a margin, because nobody who wants a seat can
  call. URGENT (below the seat line) widens every jam and reshove and open-
  jams anything it would have opened at 30bb or less. Postflop a locked seat
  calls only cheap bets with an edge or near-locks, bets only near-locks.

### The bubble captain was never told to attack

The V12 model halved the covering stack's own premium near the bubble; nothing
widened its ranges. `bubblePressure` (1 = hero covers every live opponent by
30%, 0.6 = covers the raiser) widens opens by 0.06, multiplies 3-bet bluffs
against covered raisers by 1.5, and lifts postflop bluff volume 20%. That is
the exploit written into the payout table. Satellites use their own, stronger
version and are excluded here.

### Bounties were priced by the mean, and only preflop

The V24/V26 pull knew the pool ratio and the chest inventory; it did not know
WHOSE head was in the pot, and the inventory read never reached the postflop
call-off. `TournamentBrainContext.bountyByUser` carries every live bounty by
user id; `headBountyScale` (this player's bounty over the field mean, clamped
0.4x-3x) and `prizeLandscapeScale` (top chest live x1.35, fat tail x1.15,
three or fewer chests x0.6, exhausted x0.35) now multiply the pull preflop
AND the V23 covered call-off postflop (cap raised 0.04 -> 0.08 for a big
head). A horse whose own head is worth more than 1.5x the mean trims its
bluffs — it gets called wider, preflop and postflop.

### Preflop had no blocker logic

Postflop the brain has had nut-flush and top-straight blockers since V3, the
V16 unblocker, the V17 catch-blocker and PLO nut status. Preflop it picked its
3-bet and 4-bet bluffs by strength alone. An ace in the hand removes half of
AA and a quarter of AK from the raiser's continuing range; `holdsAce` (x1.3)
and `holdsKing` (x1.12) now weight the 3-bet, squeeze and 4-bet bluff draws.

## Exploit and anti-exploit, as audited

Exploit: fold-to-aggression and postflop AF profiles with confidence weights
and change-point recency blending; fold-to-c-bet, fold-to-3-bet, river fold
rate and big-bet showdown tells (all persisted since phase 1); bubble
pressure and satellite pressure (this phase). Anti-exploit: the pair-targeting
counters (who 3-bets whose opens, who raises whose bets; hunted horses defend
wider and re-raise more; persisted), the self-image throttle, per-horse timing
tempo and time-bank use, sizing families with a per-horse bias, hourly mood.

## Tests

`HorseV37Satellites.test.ts` (23 pins). Full horse / GTO / tournament suites
green.
