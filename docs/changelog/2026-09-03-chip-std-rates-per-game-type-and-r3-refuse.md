# Per-game-type rakeback rates, and R3 from log to refuse

2026-09-03, on two of Dan's instructions in the same message.

## 1. The union sets a rate per game type

> "GO AHEAD AND DO THIS: the one thing they have that we don't: per-game-type
> percentages (e.g. 90% on cash, 60% on MTTs)."

`union_clubs` gains five nullable columns - `rate_cash`, `rate_mtt`, `rate_sng`,
`rate_spin`, `rate_satellite` - each bounded to 0..1 by a check constraint. The
weekly close resolves the rate per game type per club:

    union_clubs.rate_<type>  ->  union_clubs.club_commission_rate  ->  0.90

Every column is NULL on arrival, so no club's deal changes until a union sets
one. This migration adds the dial; it does not turn it.

The game type comes from the treasury credit itself: a credit whose note names a
tournament takes that tournament's `tournament_type` (MTT, SNG, SPIN, SATELLITE
in production today), and a credit that names none is cash rake. The payout is
truncated to the cent per (club, game type) before being summed, so a rounding
remainder always stays with the union and can never become an overpay.

### Rolled-back probes on the real last 24 hours

| probe | rates                                        | period rake | paid to clubs | union retained |
| ----- | -------------------------------------------- | ----------- | ------------- | -------------- |
| A     | nothing set (fallback)                       | 140,600.03  | 125,001.48    | 15,598.55      |
| B     | cash 90 / mtt 60 / sng 50 / spin 40 / sat 30 | 140,564.73  | 96,919.58     | 43,645.15      |
| C     | Club JAQK cash 50%, SHARK untouched          | 140,564.44  | 109,056.94    | 31,507.50      |

Probe A is the proof of no behaviour change: with no rate set, the close pays
what it paid before. Probe B moves 28,081.90 of a day from the clubs to the
union purely by the tournament dials. Probe C changes one club's cash rate and
leaves the other club's payout alone (SHARK 61,025.98 -> 61,014.71, the
difference being live traffic between probes, not the rate).

Per-type basis for the same day, for scale: cash 77,822.32, spins 38,055.12,
SNGs 19,827.40, MTTs 2,679.72, satellites 506.00.

The function asserted conservation on the balances in all three probes, and each
probe was rolled back.

## 2. R3 goes from log to refuse

> "THERE IS NOTHING THAT'S 'MY CALL'. THIS IS 100% ON YOU TO FIGURE OUT: the R3
> flip from log to refuse."

Flipped. R3 is the rule that a tournament-category credit is written by
`fn_settle_tournament_obligation` and by nothing else. The evidence:

- `ca_money_path_violations` has taken **zero rows since 2026-09-02 22:04:27** -
  the last legacy bounty credit - over 25 hours;
- the guard is not idle while that is true: `wallet_transactions` took **18,017
  credits in R3 scope in the last 24 hours** (16,763 prize, 1,212 bounty, 42
  refund), every one of them through the sanctioned path.

So this closes a door nothing has walked through in a day of full traffic.

The mode lives in `ca_money_path_enforcement`, not in the function body, so the
way back is one statement with no deploy:

    UPDATE public.ca_money_path_enforcement SET mode = 'log';

A missing row means `log`, so the guard can never become stricter by accident.
The migration proves both directions before it commits: an unsanctioned
tournament credit is refused, a sanctioned one is not, and both probes roll back.

## Files

- `supabase/migrations/20260903223515_r3_goes_from_log_to_refuse_and_the_switch_back_is_one_update.sql`
- `supabase/migrations/20260903224025_the_union_sets_a_rakeback_rate_per_game_type_and_the_close_pays_at_it.sql`
- `tests/the-union-sets-a-rate-per-game-type.law.test.ts`

Both applied to production and mirrored byte-exact.
