# VIP is VIP or Lifetime VIP, and the ladder it was standing on is gone

2026-09-05

Dan, 2026-09-04, verbatim: **"THERE IS NO SUCH THING AS 'PLATINUM VIP' BTW. JUST
VIP, AND LIFETIME VIP."** And: **"THERE IS NOTHING UNLIMITED LIKE THROWABLES OR
TIME BANKS."**

The dead `profiles.tier` column was corrected in PR #3082. This is the other
half: the /vip page itself, which was built end to end on a tier ladder that
does not exist.

## What was there

`src/constants/vipTiers.ts` held six rungs - **bronze, silver, gold, platinum,
diamond and an invented "royal"** - each with a rakeback percentage (5% to 30%),
a point multiplier (1x to 10x), monthly tournament tickets (0 to 10), a priority
flag and an exclusive-table flag. Three components rendered it: `VIPStatsHeader`,
`TierProgressionCard` and `VIPBenefitsGrid`.

Between them they promised: rakeback, monthly free tournament entries, 24/7
dedicated customer support, access to private high-stakes tables, exclusive
bonus multipliers, exclusive avatar frames and badges, invitations to exclusive
tournaments, and a point multiplier.

**Not one of those is implemented anywhere on the platform.** And the top rung
was reachable: the largest `vip_points.current_points` on production is
**426,490** against a 150,000 "Royal" threshold, so real members were being told
they were Royal, on 30% rakeback, with a private table waiting.

## Who was seeing it

| population                                         | rows   |
| -------------------------------------------------- | ------ |
| horses, lifetime VIP by design (`HorseOnboarding`) | 1,000  |
| **human lifetime VIPs**                            | **21** |
| **human monthly VIPs, active**                     | **11** |
| human monthly VIPs, expired                        | 19     |
| humans with no membership                          | 259    |

Thirty-two paying humans. Small, and they are the customers.

## Three more allowances with nothing behind them

Checked against `feature_pricing`, `fn_purchase_feature`, the engine and
`LeaderboardService`:

| advertised                                    | truth                                                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `leaderboardBoost: 0.06` -> "+6% Score Boost" | `LeaderboardService` applies no boost of any kind                                                                           |
| `themes: 3` -> "3 Premium Themes"             | nothing reads it; Table Studio sells themes one at a time and does not meter a member                                       |
| `clubCreation: 3` -> "Club Creation Limit 3"  | `fn_get_club_creation_eligibility` caps **everyone** at 4 club memberships, VIP or not. Not a benefit, and not the number 3 |
| "500 Free Throws Per Month"                   | `throwable` costs 1 diamond a throw and has no VIP branch in any code path                                                  |
| "Unlimited" offline protection                | it is _included_, which is a different claim. "Unlimited" is the word Dan struck                                            |
| "All Packs" emojis                            | the allowance is 1,200 a month                                                                                              |

## What a VIP actually gets, each one server-enforced

| allowance                     | enforced by                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| 100 rabbit hunts / month      | `fn_consume_rabbit_hunt` (`v_vip_monthly_cap = 100`); 5 diamonds from the 101st               |
| 120 time-bank seconds / month | `fn_time_bank_allowance` returns 120 minus the month's use; the engine seeds the bank from it |
| 1,200 emojis / month          | counted by `fn_increment_vip_usage` under `emoji_pack`                                        |
| 1,000 player tags / month     | counted by `fn_increment_vip_usage` under `tag_pack`                                          |
| Show Stack In Big Blinds      | otherwise 5 diamonds per session                                                              |
| Offline Protection            | otherwise 10 diamonds per session                                                             |
| Auto Time Bank                | otherwise 5 diamonds per activation                                                           |

VIP points stay: they are real (1,005 holders, 5,111,489 `vip_points_ledger`
rows) and they buy things in the rewards marketplace. What they are not is a
tier.

## What changed

- **Deleted**: `src/constants/vipTiers.ts`, `TierProgressionCard`,
  `VIPBenefitsGrid`, `VIPStatsHeader`, and `VIPStatusCard` (whose props declared
  `tier: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond'` and which
  nothing outside the barrel imported).
- **New**: `VIPMembershipPlate` - the membership, its term, the four metered
  allowances with what is left of each this month, the three waived charges, and
  the real points. #SmarterCasinoRealism: obsidian and gunmetal, a chamfered
  plate, Rajdhani for the grade, one brass accent for the membership, and a
  brushed-silver light mode.
- `VIP_GOLD_LIMITS` -> `VIP_MONTHLY_ALLOWANCES`, minus the three unbacked
  entries. There is no Gold.
- `VIPService.checkVIPStatus` now selects `vip_tier` and resolves through
  `utils/vipStatus`, and returns `status`. It derived the answer itself before,
  so a lifetime member whose `vip_expires_at` was ever set into the past would
  have read as expired. Production stores 2099-12-31 on 692 of those rows and
  NULL on 329, so nobody was harmed; the resolver removes the possibility rather
  than the coincidence. `expiresAt` is null for a lifetime membership - it does
  not expire, so it has no date to show.
- The page's "VIP Diamond" section, headed over a "Diamond Member" label in
  `#ffd700` on a gold-glow card, is now "Your Card" reading "VIP" or "Lifetime
  VIP". Three names for a membership that has two, in a colour outside the
  schema.
- `VIPCardsModal`: "VIP GOLD" -> "VIP", and the themes, club-creation and
  leaderboard-boost rows are gone.
- The profile's VIP plate swaps its "3 Premium Themes" and "+6% Leaderboard
  Boost" tiles for the emoji and tag allowances, which are metered.

## Enforcement

`tests/vip-is-not-a-ladder.law.test.ts` grew four cases: the constant and all
four components must stay deleted, no VIP surface may name a rung, the
allowances must be only the metered ones, and nothing may say "Unlimited",
"All Packs" or "500 Free Throws".

## Left for Dan

`public.vip_pricing` sells **bronze / silver / gold** at nine price points (100
to 4,800 diamonds). No client code, no function and no view reads it, and
`vip_subscriptions` is empty, so nobody can buy from it - but it is priced
product data and pricing is Dan's alone (CLAUDE.md 10.9). Left exactly as it is.
