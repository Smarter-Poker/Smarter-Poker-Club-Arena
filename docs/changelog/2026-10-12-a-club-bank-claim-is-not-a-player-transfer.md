# A Club Bank Claim Is Not A Player Transfer (2026-10-12)

## What Happened

On 2026-10-10 between 19:04 and 19:40 UTC the wallets of the deleted patterned house identities were closed into their club banks (Club JAQK, SHARK CLUB, Midway Union): `chip_transactions` rows of type `club_bank_claim`, metadata reason `deleted_account`, direction `into_bank`. Such a row names the closed account as `from_user_id` and the club owner as `to_user_id`, because the owner is the face of the club bank. `fn_union_integrity_sweep` read them as player-to-player chip transfers to one user and raised "Union integrity sweep raised 62 signal(s)" twice (2026-10-10 19:35 and 2026-10-11 15:35 UTC).

## Fix

Migration `20261012114304_a_club_bank_claim_is_not_a_player_transfer`: `club_bank_claim` joins the movement types the sweep already treats as not player-to-player (agent to player transfer, rakeback, buy-in, cash-out). Every other transfer is flagged as before.

## Also Closed

- `fn_ca_orphaned_checks_watch` (06:18 UTC): `fn_cashier_conservation_report(p_club_id)` is the reader behind the cashier Conservation Report, not a sweep. Exempted with its reason by data migration `20261012114040_cashier_conservation_report_is_caller_driven` (proof in `scripts/ci/migration-live-proofs.json`); `fn_ca_orphaned_checks()` now returns nothing.

## Proof

Rolled-back trial against production: the patched sweep over the last 48 hours for the Midway Union returns 0 signals and 0 direct transfers.

Law: `tests/a-club-bank-claim-is-not-a-player-transfer.law.test.ts`.
