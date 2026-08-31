# 2026-08-31 — The ceiling that can see every seat

Phase 6 of the bankroll re-land, recovered from `6eae5e2b90` (#2118).

## The defect

The per-table share is checked per table, so it answers identically for the
first table and the fourth. Four seats at five percent of the roll each is a
fifth of the bankroll in play, and no single-table check can see it.
`canOpenAnotherTable` was written for exactly this and had zero production
callers.

Latent today because every micro table is closed and horses are spread thin; it
binds the moment the micro relaunch gives the fleet somewhere cheap to sit four
at a time.

## The two details that would each have silently DISABLED it

Both are pinned, because neither would have failed anything — the gate would
simply have read zero exposure forever and enforced nothing. This is the same
class as the missing `club_id` that emptied the cash floor on 2026-08-31: a
lookup that always misses, and no error anywhere.

1. **`stack` missing from the seat select.** Every exposure lookup reads zero.
2. **A seat bought this cycle not counting until the next one.** One pass seats
   a horse at four tables while every check reads the position the cycle
   started with.

Exposure is summed from the live STACK, not the original buy-in, because the
question is "how much of my money is at risk" and a horse that bought in for 200
and ran it to 600 has 600 at risk.

## The ceiling

Three single-table shares — enough to multi-table normally, short of the point
where one bad run across four seats is the bankroll. It counts the buy-in being
committed, not only what is already down; checking `liveExposure <= ceiling`
alone would let every horse cross it by exactly one buy-in, every time.

At a 10,000 roll that is 900 for a nit, 1,500 for a standard, 3,000 for a
gambler.

## Fails open

An unreadable roll gets no aggregate opinion, exactly like the seating gate
above it. A gate that refuses on a value it could not read is the bug that
emptied the floor for forty minutes.

## Not in this PR

The handoff grouped "delete the dead helpers" (`isBroke`, `bestAffordableGame`)
with this phase, but the commit that deletes them is the stake-descent one
(`ef1f656003`) — descent is what replaces their role, and `HorseBankroll.test.ts`
still exercises both. Deleting them here would strand that PR's diff. They stay
until descent lands.

## Pins

`server/src/services/HorseAggregateExposure.test.ts`, 10 assertions. Six
mutations applied and observed failing, then reverted: `stack` dropped from the
select; exposure not updated until the next cycle; the refusal counted but the
seat still bought; the guard short-circuited behind a constant; the ceiling
ignoring the buy-in being committed; the aggregate multiple raised so the
ceiling never binds.

server 3189/284 green, client 10384 passed 2 skipped/740 green, both tsc clean.
