# A house mint carries its reason, and stranded certification pools are retired (2026-10-02)

Launch-readiness money sweep, lane B. Migration `20261002134346`.

## What the rows said

- **Deep Stack Society mints (2a1132b9).** `system_mint -> club_treasury` 14,630.53 at 09:44:51 UTC and 34,625.00 at 11:30:59 UTC were migrations `20261002092328` and `20261002110247` calling `fn_ca_fund_club` under their own keys. The 2,029.90 `club_treasury -> player_wallet` settlement at 09:07:12 was `20261002082429` (key `pko-unclaimed-bounty:3f19bd70...`). None was a hand edit, but `fn_ca_fund_club` discarded its reason and its register row was written from the journal, so the record could not tell it from one.
- **Raw balance writes.** Probed in rolled-back DO blocks: an undeclared raw `UPDATE` of `clubs.chip_treasury` or `club_members.chip_balance` is already refused at commit (`balance_moved_against_settlement_suspense`). A raw `UPDATE` under a hand-set `system_mint` declaration committed. It is now refused (`house_issuance_without_its_door`), and any leg that issues chips into circulation without an operation key is refused (`issuance_without_an_operation_key`). Every such leg in the 30 days before carried a key.
- **Issuance reserve -> treasury 600,000 and treasury -> retirement 599,100 (09:40-10:10 UTC).** The club-create certification (`scripts/ci/certify-club-create.mjs`): six "Crest Cert" clubs each minted 100,000.00 (opening grant). Three seeded 300.00 into their Spin and BBJ pools and burned 99,700.00 + 200.00 + 100.00; three burned 100,000.00. Each club nets to zero. Correct.
- **Stranded pools.** Six certification clubs created 01:40-02:50 UTC were deleted with their Spin (200.00) and BBJ (100.00) pools still funded: 1,800.00 in twelve pools owned by nobody. Retired through the journal, one key per pool (`cert-orphan-pool-retired:<pool>`).
- **BBJ self-test.** `bbj_payout_conservation` read VIOLATED because the self-test counted a loser share the payer returned to the pool (synthetic loser, no membership) as paid out. The journal showed 800.00 out, 600.00 back, 200.00 to the winner: conserved. It now nets returned shares and asserts conservation on both hits.

Nothing was taken from any player or club.
