# The bomb ledger's retry, measured and widened

2026-08-29, a same-day follow-up to #1724 and #1762.

#1724 gave the bomb-pot award-unit write a retry, because a single transient
failure had been losing a hand's units permanently and silently. Three
attempts, linear 250ms backoff — 750ms of cover in total.

Production has now reported the rate. Of **457 bomb hands** settled since the
ledger became complete (2026-08-28 22:38Z), **455 wrote their award units and
2 did not**, and both of those survived all three attempts.

Three independent transient failures inside 750ms is not what 0.44% looks
like. A short outage window is: one blip a couple of seconds long swallows
every attempt, because they all land inside it.

So the backoff is exponential and capped now — 250ms, 750ms, 1.75s over four
attempts, about 4.75 seconds of cover instead of 0.75 — which outlasts the
shape of blip that produced both losses. It costs nothing on a hand that
succeeds first time, which is every hand but two in 457.

The cap matters as much as the growth. This runs per settled bomb hand, so an
unbounded doubling would let a failing table hold retry timers open across
several of its own later hands.

## What this does not change

The write stays fire-and-forget and still cannot fail a hand — the money is
recorded by `logHandHistory` regardless. And the backstop stays exactly as it
was: whatever still slips through is named hand-by-hand by
`fn_bomb_pot_ledger_gaps` and filed as **critical** by
`reconcile_ledger_nightly`. Both remaining losses were found that way rather
than by anybody noticing, which is the whole point of building it.

## Verified

```
tsc --noEmit (server)                    → 0 errors
vitest tests/unit/bombPotGuards.test.ts  → 55 passed
```
