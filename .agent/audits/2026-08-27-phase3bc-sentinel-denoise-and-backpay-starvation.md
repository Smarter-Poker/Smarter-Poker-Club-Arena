# Phase 3b/3c — The Sentinel Learns To Let Go, And The Back-Pay Stops Starving

Follow-up to `2026-08-27-tournament-money-conservation-phase3.md`. Phase 3 put
a conservation sentinel and a Heads-Up back-pay into production. Watching what
they actually DID over the next six hours found two defects in my own phase-3
work. Both are recorded here because both were invisible from the logs.

## 3b — the sentinel was accurate and unusable

First pass flagged 442 events. Reading the population back:

| category               | events | verdict                          |
| ---------------------- | ------ | -------------------------------- |
| Heads-Up shortfalls    | 403    | correct, genuinely owed          |
| pre-fix pool inflation | 28     | correct once, then noise forever |
| freerolls              | 11     | never a defect at all            |

Two problems:

1. **A freeroll pays prizes nobody bought in for. That is the product.**
   Flagging it as "paid out money it never collected" is the sentinel
   misreading a feature, and it would do so every single day.
2. **The alarm could not retract itself.** It only ever INSERTed. The 403
   Heads-Up alerts would stay open after the money was repaid, so the open
   count would grow forever and never measure anything.

Left alone this is precisely the FeeReconciler failure this codebase already
documents from 2026-08-22: 988 unresolved criticals, 93% noise, the nine real
ones invisible inside the pile.

**Fixed:** `fn_tournament_conservation_delta` is now the single shared
definition of what an event owes; freerolls are excluded (club-funded by
design); pre-fix pool inflation is _accounted for_ rather than re-litigated;
and every scan re-checks its own open alerts and resolves the ones that now
conserve. The sentinel is a live measure of unfixed money instead of an
archive.

**A wrong first attempt, worth recording.** My first version of the
pre-fix term computed the implied overlay as `guarantee − contributions` and
left 23 bounty/PKO events still flagged. My own migration assertion caught it
and refused to apply. The bounty half of an entry funds `bounty_pool`, not the
prize pool, so it must be excluded from contributions. The corrected term is
`GREATEST(stored_pool − (money_in − refunds − rake − bounty_pool), 0)`, which
covers the unfunded guarantee AND the fee-inclusive creation overwrite in one
expression — they are indistinguishable after the fact and identical in
effect. Verified against all three shapes (bounty, PKO, freezeout): every one
reconciles to exactly 0.00, while the Heads-Up debt stays flagged.

## 3c — the back-pay starved silently

The repayment ran 06:24–07:29, repaid 672 winners / 17,088 chips, and then
stopped dead with **8,700 events and 213,306 chips still owed**. No error, no
crash; every pass "succeeded".

**The defect: head-of-line blocking.** The scan took the 100 oldest Heads-Up
events carrying no back-pay credit, and only computed each shortfall _inside_
the loop. An event that owes nothing never receives a credit, so it stays in
the candidate set forever — and being old, stays at the front of an
oldest-first queue. Measured live: **95 of every 100 selected rows owed
nothing.** The repayment rate decayed exactly as that predicts — 80, 73, 69,
50, 23, 20, 3, 2, 2, 0 — and then it ran forever doing nothing.

This is worse than a crash. A crash is loud. This looked healthy while a
quarter-million chips owed to players stopped moving; only comparing
repaid-against-remaining revealed it.

**Fixed:** the shortfall and the unique-winner requirement both moved INTO the
query, so a batch of 100 is 100 payable rows. Events that owe money but have
no identifiable winner are counted and alerted outside the payment loop, where
they cannot block it. The shortfall now comes from the same shared
`fn_tournament_conservation_delta` the sentinel uses, so back-pay and alarm
can never disagree — each repayment closes its own alert on the next scan.

## The lesson worth keeping

Both phase-3 components were _correct_ on the day they shipped and both were
_failing_ six hours later. Neither failure was visible in logs, return values,
or error rates — only in the gap between what had been repaired and what
remained. Any self-draining repair needs a second measurement that asks "is
the backlog actually shrinking", not just "did this pass succeed".

## 3d — the back-pay was running on somebody else's clock

Fixing the starvation (3c) did NOT restart the drain. Repayments appeared
once, at 15:32, immediately after a deploy — then stopped again.

The DB side was proven healthy first, so the fault could only be the caller:
the corrected query returns 3,345 payable rows and runs in **268 ms**
(`EXPLAIN ANALYZE`; Postgres pushes the LIMIT down and evaluates the delta for
only 271 rows). Not a timeout, not a bad plan, not an empty result.

**The defect was my own engine gate:**

```js
if (Date.now() - this.lastRakeSweepAt < 60_000) {
  /* back-pay */
}
```

The repayment ran only inside a 60-second window that opened when the _rake
sweep_ had just fired — a piggyback on another job's clock. In practice that
window was only reliably hit on engine boot, so the back-pay ran once per
deploy restart and effectively never otherwise. 100 winners at 15:32, nothing
before or after, with 8,600 events and ~211,000 chips still owed.

**Fixed:** its own 5-minute interval, like every other periodic job in that
loop, at 250 per pass. **Verified by two independent passes 6 minutes apart
with no restart between them** (16:02 and 16:08, 250 credits each) — the
distinction that separates a working scheduler from a boot-time coincidence,
and the check that was missing the first two times.

## Verification at hand-off

| measure                     | value                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------ |
| Heads-Up winners repaid     | 1,272 (31,235 chips) and climbing                                                    |
| events remaining            | 8,100 — draining ~3,000/hour, ETA ~2.7h                                              |
| tournament rake settlements | 31,316, with **0** terminal events unsettled                                         |
| guarantee overlays funded   | 12 (1,146.80 chips) from club treasuries                                             |
| sentinel alerts             | 38 auto-resolved, 404 open (403 = the HU debt still being repaid, 1 genuine finding) |

**VIP points / agent commissions from tournament rake read zero, and that is
correct.** 39 tournaments have settled since the attribution went live and
none had a single human fee payer — every entrant was a horse, and horses are
excluded by design. The logic itself was proven by a rolled-back probe
(`attributed_users: 1`, 5 VIP points, stats claimed). It will produce rows the
first time a human enters a raked tournament, not before.

## Three attempts, one lesson

Phase 3 shipped a repair that starved. 3c fixed the starvation and it still
did not run. 3d found the scheduler. Each time the logs said "success" and
each time the money was not moving. **The only check that ever caught it was
comparing what had been repaid against what remained** — never a return value,
never an error rate. Any self-draining repair needs that second measurement,
and it needs to be taken twice, at different times, with no restart in between.
