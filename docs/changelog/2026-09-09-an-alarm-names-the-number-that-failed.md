# 2026-09-09 — An alarm names the number that actually failed

Two signals that answered confidently with something nobody asked them.

## 1. The treasury breach pointed at a phantom

`fn_union_treasury_selftest` files a CRITICAL alert reading:

```
UNION TREASURY CONSERVATION BREACH:
  [{"check":"bbj_pool_conservation_drift","drift_from_baseline":"70795.11"}]
```

70,795.11 is **not what failed**, and it is not missing chips. It is a closed
historical figure that `fn_bbj_conservation_check` explains in its own payload:
two ledgers with different start dates — `bbj_contributions` from 2026-03-03,
`bbj_payouts` from 2026-07-22 — with forty jackpots paid in between (71,749.31)
and 1,000.00 of opening seed. `lifetime_healthy` is **true**, and both live
signals, `paid_without_a_payout_row_since` and `moved_since_resolution`, are
**0.00**.

What actually failed is the epoch check:

```sql
'healthy', v_epoch_at IS NOT NULL AND abs(v_epoch_unexp) <= v_tol
```

`unexplained_since_opening` is **3.15** against a tolerance of **1.00**, measured
from an epoch opened 2026-09-04. That is a real 3.15-chip drift and it deserves
attention — but nobody reading the alert would ever reach it, because the alert
hands them a 70,795.11 phantom first. The first investigation ends in "that
figure is explained", and the second one never gets opened.

I nearly made that mistake myself: I read the breach, concluded it was a constant
alarm on closed history, and was about to relax the check. Reading the `healthy`
expression is what showed the check was right and the _report_ was wrong.

The breach now carries the numbers that decided it — `unexplained_since_opening`,
`tolerance`, `epoch_opened_at`, `lifetime_healthy`, and both live signals — and
keeps the lifetime drift beside them as `context_lifetime_drift_from_baseline`,
labelled as context rather than cause.

## 2. A finish dropped inside the maintenance break, silently

`finishTournament` opened with:

```ts
if (isMaintenanceFrozen()) return;
```

No log. No retry re-armed. Nothing. The break holds the platform for five
minutes of every hour, so roughly one finish in twelve arrived inside one and
was simply discarded. For a **decided** event that is worse than it sounds: with
one player left there are no more hands and no more eliminations, so nothing
naturally calls `finishTournament` again — it waits for whatever sweep happens
along.

CLAUDE.md 13 rule 4 is explicit: a deadline is thawed, not burned. The gate now
says what it did and re-arms the sweep. This is not a repair job (10.12) —
nothing is back-filled or compensated; the finish has simply not happened yet,
and this is the same work resuming the moment it is allowed to.

## Verification

- `npx tsc --noEmit` in `server/`: clean.
- `src/tournament/` + `src/services/`: **269 files, 3,423 tests, 0 failures.**
- `CommittedSettlementCleanup.guard.test.ts` pinned the freeze gate by its exact
  bare-`return` text. What it guards is the **order** — gate before claim, second
  gate before atomic settlement — and that is unchanged, so the pin moved onto
  the new shape in the same commit (CLAUDE.md rule 8). 27 tests pass.
- The migration asserts three sibling checks are still present in the rewritten
  body and aborts if any went missing. Applied to production 03:11 UTC.
