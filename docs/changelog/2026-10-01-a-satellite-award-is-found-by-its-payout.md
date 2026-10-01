# A satellite award is found by its payout, never by its place

Migration `20261001151646_the_conservation_delta_finds_a_seat_s_award_by_its_payout.sql` (HELD: migration, money-touching).

## What was wrong

Three installed functions joined `tournament_satellite_awards` to `tournament_payouts` ON `(tournament_id, place = position)`:

- `fn_tournament_conservation_delta` (the money-conservation detector),
- `fn_pay_backed_payout_shortfalls` (the backed top-up payer; its installed body from `20260927173127` carries an inline copy of the delta),
- `fn_satellite_conservation_audit` (its funded-seat arm).

The writer that began emitting NULL positions is the version-3 multi-qualifier satellite receipt (`20260917201651_satellite_multi_qualifier_receipt_v3.sql`, commit 30c9b20e2, PR #4818, installed as schema_migrations `20260917231519` at 2026-09-17 23:15 UTC). By design a version-3 survivor is an unranked co-qualifier: the award keeps a stable slot in `place`, and the payout keeps the finisher's real position, which is NULL. Read-only on 2026-10-01 15:15 UTC: version-2 satellites wrote 1,755 satellite payouts with no NULL position; version-3 satellites wrote 426 `satellite_ticket` and 166 `satellite_seat` payouts with a NULL position across 184 satellites, from 2026-09-18 10:10 to 2026-10-01 14:41 UTC, and are still writing them. Every one of the 592 has an award found by `payout_id`.

For those rows the place join found no award and no ticket. The detector read issued, never-redeemed tickets as seats that had arrived at their target, and raised false "retained money it never paid out" alerts: 22 are open on 2026-10-01, 20 positive (20.00 to 2,850.00, each equal to the penny to its NULL-position ticket rows). The other two, at -180.00, were house-funded bubble protection paid through a `correction` leg the delta never read. The payer read the same phantom surplus; it runs report-only (`p_apply = false`) from cron and raised no alert or payment for these events.

## The fix

- The delta joins the award ON `a.payout_id = sp.id` in both satellite terms, and counts a `correction` leg into `prize_liability` as funding when it pairs one to one, per amount, with a `bubble_protection` payout.
- The payer and the audit are patched in place from their exact installed bodies (pre and post md5 guards, owner, ACL and config preserved), moving the same joins to `payout_id`.
- `fn_ca_satellite_settlement_receipt` is unchanged: it refuses every receipt version other than 2 and already joins awards to payouts ON `p.id = a.payout_id`.

## Hardening

1. Regression tests: `tests/a-satellite-award-is-found-by-its-payout.law.test.ts` (all three readers, and every later migration) and `tests/the-conservation-delta-finds-a-seats-award-by-its-payout.law.test.ts`. Without the migration 10 of 15 cases fail; with it all 15 pass (node:test with a vitest shim, since npm is blocked in the authoring workspace). Across all 252 migration-scanning law tests, results with and without the migration differ only in these two files.
2. Invariant in the owning layer: `tournament_satellite_awards.payout_id` is NOT NULL, UNIQUE and a foreign key, so it is the link; the migration's final block refuses to commit while any installed function still joins an award by place = position.
3. Detection: `fn_tournament_money_conservation` writes `financial_alerts`, which the intake routes into `operational_alert_events` with the fleet `target_task_id`; its pass 1 resolves each alert whose delta now reads inside tolerance.
4. CI: `ci.yml` runs vitest over `tests/` on every pull request that touches migrations or tests.
