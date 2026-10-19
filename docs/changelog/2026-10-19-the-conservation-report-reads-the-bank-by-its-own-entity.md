# The conservation report reads a club bank by its own entity (issue #7321)

**Date:** 2026-10-19
**Migration:** `supabase/migrations/20261019093951_the_cashier_conservation_bank_side_reads_the_bank_entity.sql`
**Status:** merged, not yet installed in production (installation is a separate, owner-approved step)

## What the owner saw

Cashier "Reconcile Now" showed two club banks out of balance:

| Club                                | Bank drift shown | Legs missed | Chips actually missing |
| ----------------------------------- | ---------------- | ----------- | ---------------------- |
| Midway Union (`fade0000-...-0001`)  | -3,038.33        | 20          | none                   |
| Deep Stack Society (`2a1132b9-...`) | -81.14           | 59          | none                   |

Every other bank read 0.00.

## Why

`fn_cashier_conservation_report` checked a club bank by adding up every
`chip_ledger` leg into and out of the club treasury since the bank baseline.
It found those legs with two conditions: the treasury entity is this club, and
`chip_ledger.club_id` is this club.

The second condition is wrong for a bank. On a bank leg, `club_id` names the
club of the wallet on the other side, not the bank. On 2026-10-03 the
owner-authorized overdue agent commission (`20261003092151`, operation
`c419b506-79a3-465a-99ba-adca6e0e5c2e`, 10:25:23 UTC) paid 79 agents who had
no wallet in the paying club into their wallet in another club. Its header
says why. Each of those legs names the paying bank (`from_type
club_treasury`, `from_entity_id` = the paying club) and is filed under the
payee's club. The bank was debited correctly, but the report skipped the leg,
so the bank's expected balance stayed 3,119.47 too high across the two banks
(3,038.33 + 81.14).

The nightly reconcile (`fn_ca_treasury_positions`) never had this problem
because it selects bank legs by the treasury entity alone. By that definition
both banks have always been exact.

## The fix

The bank side of the report now selects bank movement by the bank entity only:

- credits: `to_type = 'club_treasury' AND to_entity_id = club`
- debits: `from_type = 'club_treasury' AND from_entity_id = club`

It does this whatever `club_id` the leg is filed under. The player side is
unchanged. A player-wallet leg's `club_id` is the wallet's club, so the same
79 credits still count for the wallets where they landed. Every other part of
the report stays the same: the sealed-day read, the inventory, the access
guards, the grants, and the STABLE / SECURITY DEFINER / search_path settings.

The two bank sums now run as index-only scans of
`idx_chip_ledger_treasury_in/_out`, which are keyed on (entity, created_at).
In production that took 3.5 ms for Club JAQK and 179 ms for all seven
baselined banks together.

## Verified against production (read-only, 2026-10-19 09:37 UTC)

The new bank sums were run by hand for every baselined bank:

| Bank                                   | Actual        | Old expected  | New expected  | New drift |
| -------------------------------------- | ------------- | ------------- | ------------- | --------- |
| Midway Union                           | 22,006,017.62 | 22,009,055.95 | 22,006,017.62 | 0.00      |
| Deep Stack Society                     | 2,170,829.27  | 2,170,910.41  | 2,170,829.27  | 0.00      |
| Club JAQK                              | 79,353,041.32 | 79,353,041.32 | 79,353,041.32 | 0.00      |
| SHARK CLUB                             | 54,592,008.79 | 54,592,008.79 | 54,592,008.79 | 0.00      |
| Lightning Internal Pilot               | 84,573.10     | 84,573.10     | 84,573.10     | 0.00      |
| Crest Cert Template                    | 0.00          | 0.00          | 0.00          | 0.00      |
| Diamond Arena (diamonds, not reported) | 0.00          | 0.00          | 0.00          | 0.00      |

## Nothing was paid, moved or rewritten

No player was affected and no chip is missing. No ledger row, balance,
settlement or invoice was touched. There is no repair job and no compensating
leg (CLAUDE.md 10.11 / 10.12): the defect was in the reader, so the fix is in
the reader.

## Proof

- `scripts/ci/test-cashier-conservation-bank-entity-postgres.py` installs the
  exact production predecessor. CI runs it from the required Cashier native lane
  (`test-cashier-conservation-sealed-days-postgres.py`, accounting shard 2),
  so `ci.yml` is unchanged. It first proves that the
  predecessor misreads a bank whose payout is filed under another club. It then
  installs the fix through its guards and proves:
  - a payout from bank A filed under club B now counts against bank A;
  - a debit of bank B filed under club A counts against bank B;
  - the player side and inventory are exactly what the predecessor reported,
    before and after sealing;
  - a real, unledgered shortfall still shows as attention;
  - a replay, a drifted preimage and a drifted ACL are all refused.

  Run with `--predecessor-only`, the harness fails, which shows the defect.

- `tests/cashier-conservation-reads-the-bank-by-entity.test.ts` checks the shape
  of the newest report definition: no `club_id` on the bank side, `club_id`
  still on the player legs.
- `scripts/verification-harness/cashier-release-contract.sql` now accepts the
  installed definition (`884cbcbf...`) and this replacement (`8b13c8ee...`).

## Follow-ups (not changed here; none is a bank-balance reader)

- `fn_ca_chip_statement` / `fn_ca_chip_statement_page` with scope
  `club_treasury`: the listed legs filter on `l.club_id = p_club_id`, so a
  bank's statement page leaves out bank legs filed under another club (the same
  20 + 59 legs). Its balance audit already reads by entity and reconciles.
- `fn_club_weekly_accounting_summary`: it selects a week's legs by
  `l.club_id = period.club_id`, so a bank's payouts filed under another club
  fall outside the paying club's weekly summary.
