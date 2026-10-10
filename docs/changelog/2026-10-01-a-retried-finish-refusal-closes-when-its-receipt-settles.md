# A Retried Finish Refusal Closes When Its Receipt Settles (2026-10-01)

## What Was Wrong

`Tournament.atomic_finish_refused` and `Tournament.atomic_finish_outcome_unknown`
are raised by the engine when one attempt at `fn_complete_tournament_terminal`
fails. The engine then retries the same idempotent authority, and the retry
normally commits within minutes. Nothing closed the alert when it did, so each
one stayed open as an unpaid winner until someone closed it by hand:

- 2026-09-25: migration 20260925142532 closed 15,426 of them on 1,003
  COMPLETED, fully paid tournaments.
- 2026-09-26 and 2026-09-27: five more manual passes.
- 2026-09-27 14:45 UTC: 79 open again (53 refused, 26 unknown). Every one was
  on a COMPLETED tournament with a terminal receipt whose payout rows equalled
  the receipt's cash payouts, all paid.

Each open row also held a "firing" receipt in `operational_alert_events`, so
the alert backlog there could only grow.

The manual passes stopped after 2026-09-27 16:47 UTC, and the backlog grew
again exactly as described: on 2026-10-01 at 15:10 UTC 374 finish alerts were
open (340 refused, 34 unknown; 108 refused raised in the previous 24 hours).
372 of them were on COMPLETED tournaments whose terminal receipt names the
alert's winner and whose payout rows equal the receipt and are all paid; the
other 2 were RUNNING events with no receipt yet, which this fix leaves open.
No outcome-unknown alert has been raised since 2026-09-27 15:41 UTC, after
#5436 gave terminal attempts a deadline that outlasts the database's own.

## The Fix

Migration `20261001151637` adds class 5 to `fn_resolve_settled_financial_alerts`,
the closer that cron `ca-resolve-settled-alerts-20m` already runs. It closes a
finish alert only when the alert's own subject is proven met at source:

- the named tournament is COMPLETED with `ended_at`;
- its immutable `tournament_terminal_settlements` receipt exists, and the
  receipt's `winner_id` is the winner the alert itself named in
  `context.winner_id`;
- its `tournament_payouts` rows match the receipt's `cash_payout_count` and
  `cash_payout_total` exactly, and every row has `paid_at`.

The proof runs again inside the UPDATE. The closed row records the receipt it
relied on (`context.terminal_receipt_v1`). These cases stay open for a person:
a RUNNING event, a missing receipt, a receipt that paid a different winner, an
alert with no or a malformed winner, an unpaid or mismatched payout, a
malformed tournament id, and the satellite finish sources. Over the 12,225
receipts of the previous two days, all 12,225 met the payout proof, and every
finish alert of those two days that had a receipt named the receipt's winner. On production the preview query read 1,076
buffers and matched the same 79 rows.

## Verification

`scripts/ci/test-finish-refusal-alert-closer-postgres.py` runs the real
production preimage and then the migration in an isolated PostgreSQL.
`--baseline` (preimage only) fails with "a retried finish whose terminal
receipt settled and paid is still open". With the migration it passes: two
proven rows close, nine unproven rows stay open (including a paid receipt for a
different winner), a second pass is a no-op, and a late payout closes its alert
on the next pass. Removing the winner check makes the run fail, so the case is
load-bearing. The dedicated workflow
`.github/workflows/finish-refusal-alert-closer.yml` runs both modes on every
pull request that touches the migration, the runner, its fixtures or the
workflow itself, with the same PostgreSQL 17 binaries the accounting job uses,
and the baseline counts only when it fails with that exact defect message, so
an infrastructure or fixture error cannot pass the gate.

The check lives in its own workflow rather than in `ci.yml`, so `ci.yml`,
`scripts/ci/classify-ci-changes.mjs` and every source binding and qualification
manifest that pins them stay byte-identical to main;
`scripts/ci/verify-source-bindings.py` passes on the branch.

The migration also names its grant explicitly (`REVOKE ALL ... FROM PUBLIC,
anon, authenticated` and `GRANT EXECUTE ... TO service_role`), which is the ACL
production already holds and which `CREATE OR REPLACE` preserves, so it changes
nothing live but lets `scripts/ci/check-definer-authorization.mjs` read the
authorization from the file. It declares
`-- @live-proof: md5(pg_get_functiondef(...)) = '472cdee8...'` (the postimage
md5 its own readback asserts), so `tests/a-merged-migration-must-be-live.law.test.ts`
and the live-migration check can tell whether production carries it.

## What This Does Not Change

The refusals themselves continue. Decided spins and heads-up events take 15 to
60 minutes to finish while the engine deals: busts queue behind the one
process-wide elimination scheduler, and every finish then serializes through
the single platform-wide finish lane in the database, where
`fn_complete_tournament_terminal` hits lock timeouts throughout the day. That
is reported separately as an owner capacity decision. This change makes the alert
lifecycle honest. It does not make finishes faster.
