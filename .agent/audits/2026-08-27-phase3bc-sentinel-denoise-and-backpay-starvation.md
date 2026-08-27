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
