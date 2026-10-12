# VIP reward points retirement

The owner explicitly removed every rewards currency based on points outside leaderboards on 2026-10-12. Paid VIP memberships, Diamonds, chips, rakeback, commissions and leaderboard scoring remain separate systems.

## Authoritative change

Production inspection found `fn_award_vip_credit` earning VIP points from the cash-rake trigger and tournament fee recognition, plus `fn_redeem_vip_points` spending them on rewards. One active wheel segment advertised VIP points even though the wheel's legacy points helper was already a no-op.

Reserved migration `20261012063724_retire_unauthorized_vip_points.sql` retires these boundaries. Existing settlement callers receive zero earned points without failing their rake transaction; redemption returns `vip_points_retired`. Historical balances cannot move even with the former writer setting. New carry, ledger and reward-claim writes are rejected. The reward catalog is deactivated and cannot be reactivated; point wheel segments are deactivated and excluded from selection. Chips and Diamonds wheel branches remain intact.

All original rows and immutable history remain. No balance backfill, financial reversal, table deletion, leaderboard change or engine replacement occurs. The two existing `add_vip_points` overloads were already no-op compatibility helpers and remain so.

## Qualification

The native PostgreSQL 17 scenario loads the inspected production function definitions and role privileges. Its original award produces ten points before the migration. After the exact migration it verifies zero new cash and tournament awards (including fractional credits), retired redemption, successful cash-rake insertion, continued Diamond segment selection, rejection of the old writer-setting bypass, carry/ledger/claim writes and catalog reactivation, and unchanged historical balance/carry/ledger snapshots. All five modified functions retain their postgres owner, SECURITY DEFINER, public search path and original runtime execute privileges.

The Diamond credit helper is a fixture stand-in; selection and invocation of the unchanged branch are qualified, not production Diamond wallet delivery. Full tournament financial qualification remains the existing required accounting suite. The historical unexecuted rake retry composer recognizes the exact retired award-body hash while retaining its prior expectation for its pinned historical earning baseline; all treasury, custody, statistics, duplicate and alert assertions remain.

`bash scripts/dev/test-retired-vip-points-postgres.sh` passed. Five focused source-contract files passed 59 tests: retirement, accounting shard execution, whole-cent policy, rake attribution, and installed-migration correspondence. Schema fragments loaded successfully; the changed-source whitespace check passed. The scenario is executed in required accounting PostgreSQL shard 2.

## Installation requirements

This is a qualified candidate, not a production installation receipt. Apply the exact migration once through the configured recorded-migration route after protected integration, outside the database DDL refusal window (:50 through :03 UTC). It asserts all five inspected predecessor definition hashes and owners/ACLs, and uses one transaction with a three-second lock timeout. Read durable history before retrying any uncertain result.

Candidate SHA256: `44b8cb5c36dafbb5ba0bc2a60cd39b6754436a430c2d7ab0a09e830fb2f4cb69`.

Expected installed `md5(pg_get_functiondef(oid))`:

| Function                                         | Post-image MD5                   |
| ------------------------------------------------ | -------------------------------- |
| claim_lucky_wheel_spin(uuid)                     | f1ff057349303130284d1b1f09dc4025 |
| fn_award_vip_credit(uuid,numeric,text,uuid,text) | e6b1cc762a1e8778badba60c3a257779 |
| fn_award_vip_points_from_rake()                  | 28bcf8326aaeaa8a827c64dcb30fde8b |
| fn_redeem_vip_points(bigint,text,text)           | 588381f010f4c59db776b4835d45adef |
| fn_vip_points_move_only_with_a_leg()             | e9a2f93fb11b98190cb44ad91459a463 |

Installation proof must include migration version/name and recorded exact bytes, these post-images and privileges, the four new retirement triggers plus existing append-only ledger guard, zero active VIP point wheel/catalog rewards, and the frontend removal. No synthetic player writes belong on production.

## Follow-up caller trace

A current production scan of every public function definition referencing `vip_points_carry` returned only `fn_award_vip_credit` (the sole writer) and the cash trigger (a comment and award call). No settlement caller inserts a zero carry row or changes one before the retired boundary. `fn_attribute_tournament_rake` is currently a STABLE read-only receipt wrapper; `fn_recognize_accounting_tournament_fees` preserves commission/statistics posting and invokes the award boundary grouped by player. Its original financial work is not replaced. No initialization exception to the carry guard is required.

The old `fn_claim_special_bonus(uuid)` has no live function and `special_bonuses` is empty. The September 7 bonus retirement already dropped its claimant and revoked browser writes; no stale points-success branch is available there.
