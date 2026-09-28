# A bounty paid after a movement proof is not a changed roster (2026-09-28)

## What was frozen

0733bfe8 "Sunday Funday High Roller PKO" has dealt nothing since 07:47 UTC:
9e5abf96 alone on table 60da314a, 7ffbf0aa alone on 85ec8062. 60da314a is the
park of break 528777f8 (park_requested, no manifest). Its movement admission
6cd72e76 (07:54:43.327) holds the proof, and every successor re-admission was
refused (69 times in 20 minutes):

    [Tournament.table_engine_readmission_failed] Error:
      f06_movement_admission_unproven [55000]: F06_MOVEMENT_ROSTER_CHANGED

## The line that refused

`smarter_private.f06_assert_movement` compares each roster and eliminated
entry of the stored proof with `jsonb_build_object('seat',to_jsonb(s),
'registration',to_jsonb(p))` of the live rows, i.e. the whole registration
row. The proven hand (16451614, 07:25:10) busted 8268d71c to 9e5abf96; that
PKO bounty was paid at 07:54:43.389, 62 ms after the proof, by chip_ledger
'bounty' 44.84 (prize_liability to player_wallet). It moved four columns:

| registration | column             | proof  | live   |
| ------------ | ------------------ | ------ | ------ |
| 9e5abf96     | current_bounty     | 601.58 | 646.43 |
| 9e5abf96     | bounty_winnings    | 566.56 | 611.40 |
| 9e5abf96     | bounties_collected | 12     | 13     |
| 8268d71c     | current_bounty     | 89.69  | 0      |

Seats, stacks (1,760,286 and 0), status, table, seat number, eliminated_at and
every other column are identical. No chip moved on the felt.

## The fix

`20260928170557_a_bounty_paid_after_a_movement_proof_is_not_a_changed_roster.sql`
drops exactly `current_bounty`, `bounty_winnings`, `bounties_collected` and
`mystery_bounty_value` from both registration objects in those two
comparisons. Everything else in the assert is byte-identical; restoring the two
comparisons reproduces the pre-image digest, asserted in the migration.

The function is part of `fn_f06_mixed_custody_contract`, so the post-image
digests are carried by `MIXED_CUSTODY_CONTRACT` in
`server/scripts/engine-release-database-proof.py`, by
`tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json`, and the
shared-hand lane (`historical_bank_qualification.py`) installs this migration
after 20260926043127 before comparing the catalogue, the same way #5294 did.

## Proved (read-only)

For admission 6cd72e76, the installed comparisons are DISTINCT for both the
roster entry and the eliminated entry; the new comparisons are NOT DISTINCT
for both.

## Pinned

`tests/a-bounty-paid-after-a-movement-proof-is-not-a-changed-roster.law.test.ts`
(`docs/laws.d/a-bounty-paid-after-a-movement-proof-is-not-a-changed-roster.md`).

## Not proven before install

The full re-admission (custody claim and insert under the successor's lease)
and the break then moving 9e5abf96 to 85ec8062 run only after install.
