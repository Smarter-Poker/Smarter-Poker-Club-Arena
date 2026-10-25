# 2026-10-24: Omaha tournament pressure (V53), measured before it goes live

Dan, 2026-10-24: "YOU'VE GOT TO MAKE THESE HORSES KILLERS ... THEY ALL NEED TO
BE WINNING PLAYERS ... INCLUDING TOURNAMENT PLAY."

## The gap

Every tournament layer since Phase 6 covers Hold'em only. The Phase 6 atlas
returns zero shifts for any family other than `nlh`. Phase 8's postflop
counterfactual refuses non-NLH. So a PLO4/5/6 tournament decision is priced by
two older pieces:

- `icmRisk`, which applies one flat survival premium per decision from a
  whole-stack bubble factor. The premium is added to every preflop bar as if
  an equity point were a strength point.
- V25, the pot-limit commitment zone, which commits through pot raises but
  prices the commitment with that same flat premium.

## What V53 adds (`server/src/engine/HorseOmahaTournamentPressure.ts`)

For every PLO4/5/6 MTT or Sit & Go preflop decision with complete tournament
context, V53 computes:

1. **What each action risks in pot limit.** For a call it is the call plus
   half of the next street's pot bet. For a pot raise it is the raise plus the
   same. If the action leaves no more than one pot bet behind, it risks the
   whole stack. The risk is capped by what the covering or covered opponent
   can actually take.
2. **The exact ICM price of that risk.** ICM required equity is
   (E_fold - E_lose) / (E_win - E_lose), compared with the chip-EV price. The
   equities come from IcmModel's own estimator: exact Malmuth-Harville up to
   ten live players, and Phase 7's deterministic Plackett-Luce Monte Carlo
   above that. In Monte Carlo fields, a premium inside 3 standard errors is
   priced as zero rather than as noise. A bust in the money pays the
   last-place prize.
3. **The opponent's price of calling hero's commitment.** This becomes fold
   equity for hero's raises. A covered stack near the money folds more.
4. **PLO equity compression.** Equity per unit of preflop strength was
   measured in the bar region (strength >= 0.45, against a top-40% range,
   1,200 holdings each). The slopes are NLH 0.655, PLO4 0.303, PLO5 0.220 and
   PLO6 0.171. So the same premium moves a PLO6 bar nearly twice as far as a
   PLO4 bar.
5. **Stack depth.** The premium fades linearly from M 7 to M 1, using the
   projected M when the next level is imminent.

HorsePreflop applies these shifts on the following bars, replacing the flat
`riskAdd` on each:

- the V25 commit and call-off bars
- the Omaha reshove
- the open, 3-bet and call bars, including the big-blind defence floor
- the 4-bet, call and committed-stack bars facing a 3-bet
- the bluff budget

V53 does not apply to:

- bounty, mystery or satellite events
- all-in-or-fold tables
- Spins
- PLO8 and FLO8
- postflop play

## Default off, measured first

`v53PloTourneyIcm` defaults to off. It goes live only by a reviewed change to
its default, after a card beats today's brain on its locked measurement.

- With the flag absent, a 4-variant real-hand tournament corpus replays the
  exact decisions of origin/main `ebe9363e`. The digests were captured there
  with the same driver, and `HorseOmahaTournamentPressure.test.ts` pins them.
- With the flag on, Omaha decisions change and NLH decisions are identical.

## Where it is measured

`HorseTournamentLeague` now plays **flag cards**: paired whole tournaments in
PLO4/5/6, flag on against flag off, over the same cards. Omaha deals by table
slot, because 18 entrants x 6 cards does not fit in a deck. The cards are:

- `plo4_v53_icm_mtt`, `plo4_v53_icm_sng`
- `plo5_v53_icm_mtt`, `plo5_v53_icm_sng`
- `plo6_v53_icm_mtt`, `plo6_v53_icm_sng`

The locked measurement for each card is three held-out seeds
(53101101, 53102203, 53103307) x 1,024 pairs, run as 48 hosted shards of 64
pairs. The default field is human-calibrated. The decision rule is
`summarizeTournamentFlagCard`: every pair must be covered exactly once, every
run must be clean and not inert, and the pooled 99% interval must sit above
zero. Each card is dispatched by hand through
`.github/workflows/horse-tournament-flag-cards.yml`. That workflow shares the
`horse-strength-hosted-capacity` queue and is pinned by
`tests/unit/horseStrengthCapacity.test.ts`.

The tournament league has no nightly lane, because the nightly `HorseLeague`
deals cash only. Adding a schedule would need its own owner instruction
(CLAUDE.md 10.85).

## Limits, stated

- The human-calibrated Omaha profile (`human-cal-v1-omaha`) is fitted on 608
  seat hands. The adequacy minimum is 10,000, so it is the best Omaha human
  field available but it is thinly calibrated. The workflow can also run the
  horse field (`field: horse`).
- With 1,024 pairs per seed, the interval resolves effects of roughly
  2 to 3 percent of the prize pool. Smaller effects will read as unresolved,
  and an unresolved card stays off.
- The variant slopes are linear fits in the bar region. The shifts are capped
  at 0.2 strength.
