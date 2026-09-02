# 2026-08-29 — Round 11: the wheel is provably fair, the money conserves, and the big hits get their stage

The spins-specific phase: three production audits nothing had ever measured,
and the next enhancement.

## Audit 1: the draw distribution matches the published ladder — PASS

All-time data (26,741 draws) shows a 2x/3x skew of about ten sigma - but it
is entirely the pre-2026-08-22 era, when three conflicting multiplier tables
existed. Since the current ladder landed (22,904 draws):

| Tier | Actual  | Spec    |
| ---- | ------- | ------- |
| 2x   | 48.179% | 47.720% |
| 3x   | 38.998% | 39.685% |
| 4x   | 9.252%  | 9.000%  |
| 5x   | 2.397%  | 2.500%  |
| 10x  | 1.105%  | 1.000%  |
| 25x  | 0.052%  | 0.075%  |
| 50x  | 0.009%  | 0.010%  |
| 100x | 0.009%  | 0.010%  |

Chi-square about 10.5 on 7 degrees of freedom, p about 0.16 - statistically
indistinguishable from the spec. Two 100x hits against an expected 2.3. The
wheel the players are sold is the wheel they get.

## Audit 2: the reserve gate has locked NOTHING — the odds sheet is honest

The draw RPC records excluded tiers per game in `spin_locked_tiers`. In the
last 7 days: 21,974 spins, ZERO with any locked tier - every game drew from
the full ladder. The reserve holds 60,284 against a worst-case gate of
15,000 (100x threshold at the highest live stake). The multiplier odds
sheet shipped in round 9 therefore needs no "when available" qualification;
if the reserve ever thins, `spin_locked_tiers` is the column a future
qualification would read.

## Audit 3: the money conserves — one extinct 274-chip anomaly, players favored

Since 2026-08-22: collected 1,595,271, drawn pools 1,463,655 - a 91.75%
payout rate against the spec's 92.13% (average multiplier 2.7601 vs 2.7638,
minus 0.35 sigma - exact). Prize ledger vs drawn pools across 22,880
completed spins: 16 games overpaid, 274 chips total, ZERO underpaid, and
every one sits between 08-22 17:01Z and 08-24 09:01Z - the paid amount
matches a DIFFERENT multiplier than the row records (2x recorded, 3x-5x
paid), the redraw-era defect, extinct since 08-24. No player was ever
shorted; no clawback per standing policy; nothing to repair in the live
system, which has run exact for five days across ~15,000 games.

## Enhancement: the Biggest Hits strip

TournamentResultsPage's Spin view now opens with the ten largest completed
draws, 10x and up: the multiplier, who won it, and what it paid at what
stake - tappable through to the full standings (with a direct row load for
hits older than the list). Winner prize reads the stamped
`tournament_players.prize` column rounds 9-10 made trustworthy, with ladder
arithmetic as the fallback. No is_horse filter anywhere (CLAUDE.md 10.5).
Reached in one tap via round 10's My Spin Results deep link.

Also verified this round: the lobby's "Win Up To 100x" / "Top Prize"
affordance already exists (spinPayoutLabel / spinPrizeLabel, Dan's
2026-08-25 spec) - nothing to add there.

## Verification

- tsc 0 errors client and server; full suites green (see PR checks)
- 4 new pins in tests/unit/mySpinResultsDeepLink.test.ts (round 11 block)
- The ratchet holds TournamentResultsPage at zero discarded reads
