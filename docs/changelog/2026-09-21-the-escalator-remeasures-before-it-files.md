# The escalator re-measures before it files (and six tournament criticals that were history)

2026-09-21. Two board items that looked like live money defects and were not.
One of them was a detector re-raising a defect that had already been fixed, an
hour after it was fixed. The other was five thousand alerts about events that
had all completed and paid.

## 1. The treasury drift that "came back"

### What was reported

Deep Stack Society (`2a1132b9`) had a +2,624.78 treasury drift, fixed at
01:05 UTC by migration `20260921005621` (the missing `spin_reserve ->
club_treasury` journal leg, plus the root fix making
`fn_spin_move_owner_wallet`'s ledger declaration non-destructive). Incident
`c4261d89` was resolved, basis `repair`.

At 01:52 a **new** critical incident `ee2a3395` appeared: same club, same
source, same 2,624.78.

### What was actually true

The drift was gone and stayed gone. Both formulas agree, because there is only
one formula - the difference was never arithmetic, it was **time**.

| measured | by                                                | result                                                                                                                        |
| -------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 00:55:00 | `reconcile_ledger_nightly`                        | ledger 1,289,985.20 / stored 1,292,609.98, drift +2,624.78, critical                                                          |
| 01:05:15 | migration `20260921005621`                        | the missing leg is appended                                                                                                   |
| 01:55    | by hand, live                                     | 0.00                                                                                                                          |
| 02:30    | `reconcile_ledger_nightly`'s own arithmetic, live | opening 9,981,739.70 + credited 1,016,451.74 - debited 9,706,912.46 = 1,291,278.98 vs stored 1,291,278.98, **drift 0.00, ok** |

`credited_since` rose by exactly 2,624.78 - the repair leg. The fix held.

### The defect

`fn_ca_escalate_reconcile_criticals` (cron 226, `52 * * * *`) files from the
newest `ledger_reconcile_log` row. `reconcile_ledger_nightly` (cron 157,
`55 */6 * * *`) writes those rows **every six hours**. So after any treasury
fix there is a window of up to six hours in which the newest row is a pre-fix
critical, and the escalator re-raises it every hour. Resolve it, and the next
hour files a new one.

`ee2a3395` carries the pre-fix numbers verbatim - `expected 1289985.20`,
`actual 1292609.98`, `credited_since 1013826.96` - which is the signature of a
replayed measurement rather than a new one.

**The 2026-09-08 fix could not catch this.** That fix made `DISTINCT ON` pick
the newest ROW rather than the newest CRITICAL row, which closes the case where
a later `ok` row exists. Here no later row existed at all.

This is CLAUDE.md 10.86: a detector that answers confidently when it cannot
tell. "The last measurement said critical" is not "it is critical now".

### The root fix (migration `20260921023309`)

The escalator **measures before it files**.

1. `fn_ca_reconcile_treasury_positions()` is now the one definition of the
   treasury position. `reconcile_ledger_nightly` reads it instead of carrying
   its own copy, so the recorder and the re-measure cannot drift apart. The
   migration proves the refactor equivalent row-for-row across every club
   before repointing the reconciler, and aborts if it is not.
2. `fn_ca_reconcile_remeasure(entity_type, entity_id)` answers with **three**
   outcomes, never two: measurable plus the current severity, or
   `measurable=false` meaning THIS FUNCTION CANNOT TELL. It never returns `ok`
   for an entity type it does not know how to measure - that would silence a
   real critical, the same bug pointing the other way.
3. The escalator branches on all three:
   - re-measures ok/warn: **does not file**, counted as `superseded`;
   - re-measures critical: files on the **fresh** numbers, `remeasured='critical'`;
   - cannot tell: files from the stored row, `remeasured='unavailable'`, so a
     reader can see the incident rests on history.

The return gains `superseded` and `unmeasurable` so the decision has a reader
(10.86 rule 3).

**Verified live after apply**: `fn_ca_escalate_reconcile_criticals()` returned
`considered=1, filed=0, superseded=1, unmeasurable=0`. The same call that filed
`ee2a3395` an hour earlier now files nothing.

This is not a repair job (10.12). Nothing pays, sweeps or back-fills; a
detector was changed to report the present instead of replaying the past.

## 2. Five thousand tournament criticals, nothing stuck

Six open criticals - `3ef7d1c6` (96), `9fb09868` (23), `08b74e05` (6),
`dc7e78be` (4), `b89d595f` (12,617, a storm-cap row) and
`6ecbe5f6` (`atomic_finish_outcome_unknown`).

**Every event behind them is COMPLETED and paid in full. Nothing is held.**
Measured across the whole population at 02:35 UTC:

- 992 distinct tournaments have ever raised `Tournament.atomic_finish_refused`
  or `Tournament.atomic_finish_outcome_unknown`;
- 992 of 992 are `COMPLETED`, 0 have a NULL `ended_at`;
- `SUM(prize_pool)` 90,725.90 = `SUM(tournament_payouts.amount)` 90,725.90;
- 0 events where paid does not equal pool, 0 payout rows still unpaid.

All six resolved with `closure_basis='verified_remeasured'`.

### The separate finding: the caller alerts on every refusal and never records the success

Not fixed here, and deliberately **not** silenced.

`fn_complete_tournament_terminal_pre_seat_guard` refuses a completion before
commit - correctly; it refuses rather than committing a half-settled event. The
engine then retries, and **nothing records the retry that succeeds**. So a
completion preceded by N refusals leaves N permanent criticals and no closing
record.

Quantified:

|                                                       |                                           |
| ----------------------------------------------------- | ----------------------------------------- |
| alert writes, `atomic_finish_refused`                 | 15,413                                    |
| distinct events                                       | 976                                       |
| writes per event                                      | 15.8 : 1 (max 224 for one event)          |
| distinct message shapes                               | **1** - the reason is not recorded at all |
| unresolved                                            | 15,401 of 15,413 (99.92%)                 |
| ever resolved by a mechanism (`resolved_by` not null) | **0**                                     |
| alerts created after the event ended                  | 0 - they always preceded the success      |

Because the alert context records no reason, the incident bridge hashes the
same shape for every refusal, so all four per-event incidents share one dedupe
key and the storm cap folded 12,617 findings onto a single row.
`fn_resolve_settled_financial_alerts` covers four sources and
`fn_resolve_settled_prize_alerts` one; **none of them is this one**.

The dominant underlying cause is already fixed at the root - the live guard
traps SQLSTATE P0404 for the four legacy fee reasons and parks the fee through
`fn_ca_hold_legacy_tournament_fee` instead of failing the whole completion -
and the rate collapsed accordingly:

| day   | alerts |
| ----- | ------ |
| 09-17 | 6,452  |
| 09-18 | 6,967  |
| 09-19 | 7      |
| 09-20 | 45     |
| 09-21 | 6      |

The correct remaining fix is for the refusal path to record its bounded reason
and for the successful retry to close what its own failures opened. That is
engine-side; the engine is frozen on sha `8825af51`. **Suppressing the alerts
would be the wrong fix and was not done.**
