# 2026-09-01 — VIP points were awarded on the pot, and one reporting rule was never written down

Three findings, all verified read-only against production `kuklfnapbkmacvwxktbh`
on 2026-09-01. Nothing was applied and nothing was backfilled; the migrations
ship unapplied.

## 1. VIP points were awarded on the pot, not the rake — fixed forward

`fn_award_vip_points_from_rake`, the AFTER INSERT trigger on `rake_records`,
forked on `rake_method`. `WEIGHTED_CONTRIBUTED` went through
`fn_allocate_rake_credits` and awarded the player's share of the RAKE. Every
other value — including `DEALT_EQUAL`, which is the default — iterated
`player_contributions` and awarded `v::numeric`, the player's CONTRIBUTION TO
THE POT.

| rake_method            | rows      | rake taken   |
| ---------------------- | --------- | ------------ |
| `DEALT_EQUAL`          | 1,544,385 | 4,474,442.25 |
| `WEIGHTED_CONTRIBUTED` | 56,401    | 154,216.27   |

Awarded basis against correct basis: 3,672,403.82 vs 117,080.18 over two days
(31.4x); 32,615,366.54 vs 973,765.11 over nine (33.5x).

Lifetime, since accrual began 2026-07-29: 3,811,527 ledger rows, **135,761,739
points, 589 players**. Recomputed on the rake basis the same activity yields
**3,589,721** — 97.4% of every VIP point ever awarded came from the wrong
branch.

Points do not move chips. They buy themes and avatars from
`vip_reward_catalog` and they drive tier progression. This is an entitlement
and tier-integrity defect, not a treasury one.

Fixed by passing `NEW.rake_method` through to `fn_allocate_rake_credits`, which
already implements both published methods and divides the rake under both. The
fork is gone; an unrecognised method is filed and falls back to the weighted
default rather than being handed to a helper that would return no rows.

The trigger also ended every award in `EXCEPTION WHEN others THEN CONTINUE`, so
no VIP award has ever failed visibly. It stays non-fatal to the rake write it
hangs off, but failures are now filed into `ledger_reconcile_log` as
`vip_award_failed`, throttled to one per kind per hour.

**Not backfilled, and Dan's to decide.** A recompute demotes 588 of 589
players: 554 Diamond becomes 446 Gold and 108 Silver; 28 Platinum becomes
Silver; 6 Gold becomes 2 Silver and 4 Bronze. Zero players remain Diamond or
Platinum. The numbers are in the pull request.

## 2. `ca_club_tournament_daily.fee` — the rule now exists, in one place

The brief for this work reported "two contradictory attribution rules" and
+137,445.96 chips of overstatement against `rake_records`. Measured, that is
not what is happening, and the difference decides whether there is a number to
repair.

Every user-less rake row is a `spin_rake` — 28,567 rows, 123,604.12 chips — and
a `spin_rake` row is one row for the whole field. Split it equally among
entrants and give each entrant's share to that entrant's clubs and club _c_
receives `rake * club_players / total_players`, because `SUM(club_players)` over
clubs IS `SUM(clubs)` over entrants. The pro-rata branch is the member rule
written as arithmetic; the two branches agree.

The +137k is the deliberate multi-union attribution `20260831010001` already
established. Recomputing every row through the member rule gives 372,774.11
against 232,567.92 of raw rake — a factor of 1.603 that is intended.

Against the rule itself the rollup is nearly right: **108,363 of 108,507
(club, tournament, day) rows agree to the cent. 144 drift, +193.21 net,
393.81 absolute, across ten days** — 123 rows the rollup holds that the rule no
longer produces, 21 rows the rule produces that the rollup does not hold at
all. And the 14,803 "rollup rows with no matching `rake_records`" all carry
`fee = 0.00`; they are winnings-only facts, not missing fees.

So the defects were: nothing stated the rule, both writers swallowed their
failures into a `RAISE WARNING` nobody reads, and nothing ever compared the
rollup to its source. `ca_reporting_tournament_fee_split` is now the rule, both
writers call it, the insert trigger files instead of warning, and
`fn_club_tournament_fee_parity_check` compares the rollup against the rule —
not against raw rake, which cannot tell deliberate duplication from drift.

The 144 rows are repaired by `ca_refresh_reporting_rollups(d, d)` over the ten
affected days. Proposed, not run.

## 3. `calculate_cascading_commission` was executable by anon

Production ACL held `anon`, `authenticated` and `PUBLIC` on a function that
writes `agent_commissions` and `club_wallets`. Not exploitable today — it is
SECURITY INVOKER and RLS admits writes on both tables only for `service_role` —
but the grant is one ordinary policy edit from being live. Revoked per role,
following `20260826150000`, with the effect asserted in the migration.

Its one browser call site, `CommissionService.calculateCascadingCommission`,
passes `p_player_id` where the function takes `p_player_user_id`; the call has
never resolved and nothing in `src/` or `tests/` invokes the method.

## Migrations (all unapplied)

- `20260901090000_the_reconcile_log_admits_a_vip_and_a_rollup_finding.sql`
- `20260901090100_the_vip_ledger_can_be_read_by_time.sql`
- `20260901090200_vip_points_are_awarded_on_the_rake.sql`
- `20260901090300_one_attribution_rule_for_the_tournament_fee.sql`
- `20260901090400_cascading_commission_is_not_a_browser_rpc.sql`

## Law tests

- `tests/vip-points-are-awarded-on-the-rake.law.test.ts`
- `tests/one-attribution-rule-for-the-tournament-fee.law.test.ts`
- `tests/a-commission-writer-is-not-a-browser-rpc.law.test.ts`
