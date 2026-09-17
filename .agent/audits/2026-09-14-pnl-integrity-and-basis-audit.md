# P&L integrity and accounting failure identity

This lane prepared `20260914132918_union_pnl_requires_full_funding_and_stable_failure_receipts.sql`. It has not applied production DDL, called a production money function, repaired history, committed, or pushed. The lead owner handles integration, installation and release proof.

The existing P&L function collected only available club treasuries, prorated winners when the union lacked funds, and marked both the claim and periods settled while `total_unpaid` could remain positive. It also treated any conflicting claim as a successful replay, including in-progress claims and different period ends. Its explicit invoice duplicated the central invoice now created by each posted ledger transfer.

The forward migration preserves the existing P&L calculation and includes every player, including horses. It locks the exact accounting window and union, requires complete finite funding from all club treasuries and the union, verifies final balances and full obligations, and requires exactly one paid, delivered source-ledger invoice per transfer. Missing or failing receipt delivery rolls back the transfers, transaction logs and period rows. Failed claims/incidents survive. Exact completed replays move nothing. Overlapping windows, unfinished claims and historical partial/unknown claims are refused without rewriting evidence or repaying chips. The clean historical floor and server-only authority are explicit.

The coordinator change removes `elapsed_seconds` and `clock_ran_out` from both standalone error details. Repeated identical financial failures deduplicate despite different runtime measurements; different substantive failure reasons still generate a new alert.

## Native verification

`bash scripts/dev/test-settlement-integrity.sh` passed **30 PostgreSQL assertions**. It runs the actual guarded P&L and coordinator migrations and current production treasury autoledger definition. Accounting basis inputs and central delivery are controlled fixture dependencies. Coverage includes one-cent shortfalls on both sides, unknown/missing/nonfinite balances, receipt absence, delivery exceptions, complete funding, restored caller journal settings, one invoice per source transfer, exact replay, overlaps, unknown/partial/in-progress historical claims, floor/authority, changing runtime, changed financial failure reason, and two competing transactions settling the same window exactly once.

The native test is implementation/transaction evidence. It does not certify production delivery audiences or the P&L basis described below.

Expected reviewed production preimages:

| Function                                                           | Before MD5                         | Native post-migration MD5          |
| ------------------------------------------------------------------ | ---------------------------------- | ---------------------------------- |
| `fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean)` | `e21b68786fba4b6ef2982071b86479ee` | `a7eb35f0906ad77fd5eb0975d90023b7` |
| `fn_process_weekly_accounting(uuid)`                               | `f8bd737e49e174430ba95ada5118340b` | `13d00646ebf85d989ef1465c3933973c` |

## P&L basis remains unsuitable for a historical weekly close

Read-only production definitions and bounded aggregate reads on September 14 show unresolved defects. Do not wire this basis into the weekly coordinator as certified accounting.

1. `fn_union_pnl_all_clubs` and `fn_union_pnl_cash_by_club` assign every historical user flow to the earliest **current** `club_members` row among union clubs. They do not use the source transaction's earning club or historical membership interval. **584** union users currently have multiple club memberships.
2. Both readers sum **current open seat stacks**, without an as-of cutoff. At the audit snapshot, **58** open union cash seats that joined after the September 14 07:00 UTC close held **21,819.85 chips**. Their current stacks are eligible for a query of the already closed week. These amounts are evidence of a time-boundary defect, not a proposed correction or certified liability.
3. The all-club reader selects tournaments whose status is **currently** `REGISTERING` or `RUNNING`, then computes their equity without `p_start` or `p_end` bounds. Later activity/status changes can alter an earlier period's apparent ending equity.
4. `fn_union_pnl_baseline` uses `period_start < p_at`, ordered by start, without requiring `period_end <= p_at` or an exact opening snapshot. For the September 7 07:00 UTC opening, the selected live baseline ends **September 7 04:47:37.750823 UTC**, more than two hours before the requested window.
5. The recognized wallet categories are cash `buyin`/`cashout` and tournament `tournament_buyin`/`prize`/`bounty`. Other current earning/funding doors need an explicit category reconciliation before completeness can be claimed. The repository's addon writer emits `addon`, which this reader does not include. A broad live category aggregate proved too slow and only that owned read was canceled; no category totals from it are claimed.

The service-role-only wrappers `fn_union_settle_player_pnl_guarded` and `fn_union_settle_player_pnl_weekly` delegate to the same core writer. The weekly wrapper closes from the last baseline/settled end to **now**, not the fixed weekly accounting boundary. No production cron command referenced any P&L settlement function at audit time. The inspected history held one settled claim, seven baselines and two superseded records; none reported nonzero/unknown `total_unpaid`. This does not establish historical basis accuracy.

Reviewed basis MD5s: all-club reader `f01c3c66265fddd7ce88962ad0bb13f9`; cash reader `e8d46ba1a3753c34818860ddfe57e242`; baseline `45ad9f400f7ba63a1e788ccdab55cc81`; rake-paid wrapper `ef263f429567b91c6dd13c79397054df`.
