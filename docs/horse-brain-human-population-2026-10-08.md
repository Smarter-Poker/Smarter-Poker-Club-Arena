# Horse Brain Human Population Record, October 8, 2026

Horse Brain only. This record answers the owner's question with production evidence: who do horses actually play against for money, and does the brain horses use today beat those players after rake? It measures the seat mix of every horse hand, the current brain's result against human players after the rake horses pay, the human players' tendencies, and how those tendencies compare with the opponent populations the strength leagues use. All production reads were read-only `SELECT`s on project `kuklfnapbkmacvwxktbh`. No player identifier appears in this record or in the repository; every figure is an aggregate.

Status vocabulary: verified now, historical only, implemented but unverified, defective, unavailable external input, not applicable with reason. Every measured claim states its opponent population, rake model, sample size and 99% interval.

**Outcome.** Horses almost never play a human. In the seven days to October 8, 99.988% of horse seat-hands had no human at the table (24,628,513 horse seat-hands; 3,035 sat with a human). Across the whole retained record (August 21 to October 8) only five human accounts played, one of them 68.5% of all human hands. Against those five, the current brain's after-rake result is +8.82 bb per 100 horse seat-hands with a 99% interval of -15.80 to +33.44 (1,224 cash hands, 56 tables): not distinguishable from zero. In money, the humans lost 1,965.90 chips at cash tables in seven weeks, while the house took 4,590.86 chips in rake and BBJ drop from the same hands, so the horses at those tables lost 2,624.96 chips as a group. Horse-only cash play is a pure rake transfer: the horses broke even before rake (+0.03 bb/100) and lost exactly the rake (-22.22 bb/100) over 5.77 million seat-hands. The owner's statement is confirmed by the data: with no outside money the house is the only winner of horse-only play, and today there is almost no outside money.

## Window Declaration

Written to the private evidence folder before any result query (`window-declaration.md`, mtime 2026-10-08T13:56:20Z). Before it, only structural reads were made (table and column lists, rows per day, the count of `has_human` hands, `profiles.is_horse` counts, the rake schedule, tournament types, one hand's JSON shape).

| Item                     | Declared                                                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1 (seat mix, recent)    | 2026-10-01T00:00Z to 2026-10-08T00:00Z, half-open                                                                                                                                                                                                  |
| W2 (horse versus human)  | 2026-08-21T00:00Z (first `ca_hand_facts` row) to 2026-10-08T00:00Z. Human rows of `ca_hand_facts` and `has_human` rows of `hand_history` are kept forever; horse-only rows only 7 to 8 days                                                        |
| W3 (human action detail) | every retained `has_human` `hand_history` row created before 2026-10-08T00:00Z (first: 2026-07-22)                                                                                                                                                 |
| Human                    | `profiles.is_horse = false`; every such account, no exclusion chosen after reading                                                                                                                                                                 |
| Primary metric           | horse collective net per 100 horse seat-hands in big blinds, after rake and BBJ drop, on hands with at least one horse and one human                                                                                                               |
| Interval                 | two-sided 99% ratio-estimator interval clustered by table (primary) and by hand (sensitivity)                                                                                                                                                      |
| Rake model               | what production charged: `hand_history.rake_amount` and `bbj_amount`, contribution-weighted `ca_hand_facts.rake_paid`; schedule `ca_rake_schedule`, `ca_rake_schedule_caps`, `ca_rake_rules` (10%, stake caps, player-count caps, no flop no drop) |

**Method.** For a hand with horses and humans, the horses' collective net is `Y = -(sum of human nets + rake + BBJ) / big blind`, because every chip a human loses, or the house takes, came from or went to somebody at the table. Chips moving between horses cancel inside `Y`, so `Y` is exactly chips won from humans minus chips lost to humans minus the rake and BBJ horses paid. The identity was checked on the 91 hands whose horse rows are still retained: 91 of 91 agree to the cent. The rate is `100 * sum(Y) / sum(horse seats)`.

**Deviation recorded.** The horse tendency comparison was declared on W1 horse-only hands; to bound database load it reads one fixed slice of W1, 2026-10-07 00:00Z to 03:00Z (405,191 NLH and Omaha horse seat-hand rows in `ca_hand_facts`), and 2026-10-07 00:00Z to 00:15Z for action-level responses. The slice was chosen by date before reading it.

## Who Horses Play Against

W1, seven days. Horse seat-hands from `horse_daily_nets`; hands from `hand_history`.

| Format      | Hands     | Hands with a human | Horse seat-hands | Horse seat-hands with a human |
| ----------- | --------- | ------------------ | ---------------- | ----------------------------- |
| Cash        | 1,389,635 | 107 (0.008%)       | 5,767,404        | 654                           |
| Tournaments | 7,188,439 | 485 (0.007%)       | 18,861,109       | 2,381                         |
| All         | 8,578,074 | 592 (0.007%)       | 24,628,513       | 3,035 (0.012%)                |

Share of horse seat-hands with no human seated (pure horse versus horse): **99.988%**. Human-only hands: 16 cash hands in W2, none in tournaments.

The human population is five accounts. Human seat-hands in W2: 2,411, distributed 1,652 / 469 / 223 / 50 / 17 across the five (the most active account is 68.5%). Human hands per week since July: 1, 1, 1, 34, 597, 1,062, 216, 181, none, 163, 589, 3.

### Horse Versus Horse Is A Rake Transfer

W1, every horse seat-hand. Opponents: horses. Rake: production as charged.

| Format      | Horse seat-hands | Net before rake | Rake + BBJ paid             | Net after rake                |
| ----------- | ---------------- | --------------- | --------------------------- | ----------------------------- |
| Cash        | 5,767,404        | +0.03 bb/100    | 1,283,343 bb (22.25 bb/100) | -1,281,361 bb (-22.22 bb/100) |
| Tournaments | 18,861,109       | +0.00 bb/100    | entry fees, not per hand    | +684 bb (chips, zero sum)     |

## The Current Brain Against Humans

### Cash

W2. Opponents: the five human accounts (and the other horses at the table, whose transfers cancel). Rake: production as charged. Unit: horse collective net per 100 horse seat-hands, big blinds of the hand's stake.

| Scope      | Hands | Tables | Horse seat-hands | Horse bb/100 | 99% interval (table) | 99% interval (hand) | Rake horses paid, bb/100 |
| ---------- | ----- | ------ | ---------------- | ------------ | -------------------- | ------------------- | ------------------------ |
| All cash   | 1,224 | 56     | 6,004            | +8.82        | -15.80 to +33.44     | -22.64 to +40.28    | 13.87                    |
| W1 only    | 91    | 5      | 654              | -8.86        | -41.93 to +24.21     | -46.19 to +28.47    | 7.84                     |
| NLH        | 860   | 32     | 4,283            | +7.99        | -22.59 to +38.57     | -24.94 to +40.92    | 12.66                    |
| PLO4       | 172   | 9      | 973              | +11.76       | -26.66 to +50.18     | -61.53 to +85.05    | 9.06                     |
| PLO6       | 87    | 5      | 301              | +101.41      | -27.13 to +229.95    | -149.13 to +351.95  | 16.11                    |
| Short Deck | 78    | 2      | 335              | -53.01       | -115.13 to +9.11     | -252.66 to +146.64  | 40.80                    |
| PLO5       | 15    | 4      | 55               | -107.86      | -268.48 to +52.76    | -550.02 to +334.30  | 22.00                    |
| Pineapple  | 7     | 2      | 23               | +21.52       | +8.62 to +34.42      | -26.59 to +69.63    | 13.91                    |
| PLO8       | 5     | 2      | 34               | -2.21        | -11.79 to +7.37      | -13.03 to +8.61     | 5.29                     |

The humans' own result on the same hands: -141.47 bb per 100 human seat-hands (1,228 human seat-hands). In chips: humans -1,965.90; rake 4,317.93 (horses paid 3,246.47, humans 1,071.46) and BBJ 272.93; horses -2,624.96. The bb rate is positive while the chip total is negative because the horses' losses came at the higher stakes (a 10/25 table where the human won 143.18 bb/100 over 101 hands) and their wins at the lower stakes. Short Deck, Pineapple and PLO8 come from two tables each, so their table-clustered intervals rest on two clusters and mean little. Per stake, 13 of the 23 stake cells are a single table, where no between-table interval exists; they are in the evidence folder, not ranked here.

Status: **verified now** that the current brain's after-rake result against production humans cannot be distinguished from zero; the interval is wide because the sample is 1,224 hands against five people.

### Tournaments

Chips (W2, 1,151 hands, 28 tournaments, 5,196 horse seat-hands, interval clustered by tournament): +10.48 chip bb/100, 99% interval -5.42 to +26.38. MTT NLH +12.10 (-7.60 to +31.80, 664 hands, 8 tournaments); every other format and variant cell has 1 to 6 tournaments.

Money, every tournament in W2 with at least one human entrant (prize plus bounty minus buy-in, fee, rebuys and add-ons):

| Type | Tournaments | Horse entries | Human entries | Horses net | Humans net | Fees     |
| ---- | ----------- | ------------- | ------------- | ---------- | ---------- | -------- |
| MTT  | 13          | 1,345         | 14            | -3,230.89  | -350.11    | 4,007.50 |
| SNG  | 3           | 3             | 3             | +36.00     | -44.10     | 8.10     |
| Spin | 17          | 34            | 17            | -626.00    | +252.00    | 0.00     |

Humans lost 142.21 in tournaments in seven weeks. The horses' MTT loss is almost entirely the fees they paid playing each other (1,345 horse entries against 14 human).

## Human Tendencies

Aggregate over the five accounts, W2 for seat-hand statistics (`ca_hand_facts` flags), W3 for responses (`hand_history.actions`, voluntary decisions only; 519 of 4,498 human decisions, 11.5%, were clock-forced folds and are reported separately). Opportunity columns (3-bet, steal, defense) exist only on rows written since 2026-10-03, so their denominators are small.

| Statistic                      | NLH cash  | NLH tournament | Omaha cash | Omaha tournament | Other cash |
| ------------------------------ | --------- | -------------- | ---------- | ---------------- | ---------- |
| Seat-hands                     | 896       | 822            | 279        | 329              | 85         |
| VPIP                           | 43.5      | 16.7           | 45.5       | 17.0             | 64.7       |
| PFR                            | 12.4      | 10.8           | 34.8       | 13.7             | 2.4        |
| 3-bet (opportunities)          | 10.0 (10) | 20.0 (5)       | n/a        | 0.0 (2)          | n/a        |
| Fold to 3-bet                  | 20.0      | 9.1            | 25.0       | 0.0              | n/a        |
| Aggression factor, all streets | 0.30      | 1.06           | 1.12       | 0.68             | 0.33       |
| Aggression factor, postflop    | 0.61      | 1.00           | n/a        | 1.00             | n/a        |
| Saw flop                       | 40.4      | 11.9           | 33.7       | 17.9             | 63.5       |
| Went to showdown (of flops)    | 44.2      | 71.4           | 57.4       | 67.8             | 55.6       |
| Won at showdown                | 49.4      | 50.0           | 44.4       | 62.5             | 40.0       |
| Flop c-bet (opportunities)     | 58.5 (41) | 39.3 (28)      | 86.8 (38)  | 20.0 (15)        | 100 (2)    |
| All-in                         | 5.6       | 9.9            | 5.4        | 10.0             | 1.2        |

First response of a human, voluntary decisions (fold / call / raise, percent; cash and tournament pooled):

| Spot                                                                        | NLH (n)                  | Omaha (n)                | Other (n)              |
| --------------------------------------------------------------------------- | ------------------------ | ------------------------ | ---------------------- |
| Preflop, unopened, chips to call                                            | 61.3 / 19.5 / 19.2 (835) | 61.9 / 9.2 / 28.8 (423)  | 38.5 / 59.0 / 2.6 (39) |
| Preflop, raise among all unopened decisions (used for the big blind option) | 17.7 of 905              | 24.7 of 494              | 2.4 of 42              |
| Preflop, facing a raise                                                     | 52.7 / 35.7 / 11.7 (659) | 43.6 / 26.3 / 30.1 (133) | 29.9 / 68.7 / 1.5 (67) |
| Flop, facing a bet                                                          | 44.9 / 43.2 / 11.9 (185) | 50.0 / 31.0 / 19.0 (58)  | 7.1 / 92.9 / 0.0 (14)  |
| Turn, facing a bet                                                          | 38.7 / 56.3 / 5.0 (119)  | 50.0 / 31.8 / 18.2 (44)  | 27.8 / 66.7 / 5.6 (18) |
| River, facing a bet                                                         | 45.3 / 47.4 / 7.4 (95)   | 42.9 / 28.6 / 28.6 (21)  | 44.4 / 55.6 / 0.0 (18) |
| Bet when checked to: flop, turn, river                                      | 26.0, 34.8, 27.6         | 41.5, 37.6, 36.8         | 34.8, 45.2, 54.3       |

By bet size (postflop, decisions with a recorded public node, 75 in all): facing at most half pot, fold 33% / call 53% / raise 13% (30); half to one pot, 27% / 55% / 18% (33); over one pot, 58% / 25% / 17% (12). Sizes (medians): preflop raise to 3.75 times the current bet (46); flop bet 0.76 pot (19), turn 0.52 (18), river 0.51 (12); postflop raise to 1.89 times the bet on the flop (4), 3.5 on the turn and river (2 each).

In plain terms, the cash humans are loose and passive before the flop (they limp about one unopened pot in six; horses almost never limp), call down more on the river than horses do, and time out on about one decision in nine.

## League Opponents Against Real Humans

Which opponent populations the strength leagues use today:

- Phases 10 to 13 contract matrices (`Plo4StrengthContract.ts`, `OmahaVariantStrengthContract.ts`, `RemainingVariantStrengthContract.ts`, `JointStrengthContract.ts`): every seat is a production horse, style drawn uniformly from tag, lag, balanced, tricky, grinder (`PRODUCTION_HORSE_STYLES`).
- Development league profiles (`PLO4_LEAGUE_PROFILES`, `JOINT_LEAGUE_PROFILES`): one style for every opponent (tag, lag or balanced).
- Phase 8 `HorseTournamentLeague`: every entrant is a production horse playing `balanced` with no dials.

Production horses by style (2026-10-07 00:00Z to 03:00Z slice; horse versus horse):

| NLH cash   | VPIP     | PFR      | 3-bet       | Fold to 3-bet | AF postflop | WTSD     | Limp (unopened, all styles) | Fold to river bet (all styles) |
| ---------- | -------- | -------- | ----------- | ------------- | ----------- | -------- | --------------------------- | ------------------------------ |
| balanced   | 33.8     | 17.0     | 7.2         | 49.8          | 0.36        | 35.1     | 0.4%                        | 64.9%                          |
| grinder    | 31.2     | 15.3     | 5.7         | 46.2          | 0.35        | 35.2     |                             |                                |
| lag        | 39.7     | 21.7     | 10.2        | 46.7          | 0.40        | 33.3     |                             |                                |
| tag        | 34.2     | 17.4     | 8.0         | 53.3          | 0.38        | 36.4     |                             |                                |
| tricky     | 39.1     | 19.8     | 8.2         | 53.6          | 0.39        | 34.4     |                             |                                |
| **humans** | **43.5** | **12.4** | 10.0 (n=10) | 20.0 (n=5)    | **0.61**    | **44.2** | **18.0%**                   | **45.3%**                      |

Omaha cash horses: VPIP 40.8 to 43.6, PFR 21.6 to 25.3, fold to 3-bet 48 to 69, WTSD 43 to 48, limp 1.0%, fold to a river bet 56.8%. Omaha cash humans: VPIP 45.5, PFR 34.8, limp 7.9%, fold to a river bet 42.9% (n=21). NLH tournament horses: VPIP 23.0 to 29.4, PFR 17.0 to 23.1; humans 16.7 and 10.8 (n=822).

**Verdict.** No league population matches the measured humans. Every production style raises or folds unopened pots and almost never limps (0.4% NLH, 1.0% Omaha); the humans limp 18.0% (NLH) and 7.9% (Omaha) of unopened decisions, the same denominator. Every style folds to a river bet far more often (NLH 64.9%) than the humans (45.3%), and every style's VPIP-to-PFR gap is 16 to 19 points against the humans' 31. The closest single styles are lag and tricky on NLH VPIP (39 to 40 against 43.5), and none is close on limping, river calls or postflop aggression. The Phase 8 tournament league's all-`balanced` field is looser and more aggressive than the human tournament players (VPIP 25.3 against 16.7). Status: **verified now** for this sample; the sample is five people, so the comparison describes these five, not a player market.

## The Human-Calibrated Population

`server/src/benchmark/HumanCalibratedPopulation.ts` adds a separate, separately named population, `human-calibrated-v1-20261008`, with one profile per family (NLH; Omaha; other: Short Deck, Pineapple, FLH, FLO8) built from the counts above. A seat ranks its holding as a strength percentile (preflop on the engine's own preflop scales, postflop by equity against one random holding on the league's seeded random stream) and plays the measured shares as cutoffs; sizes are the measured medians; clock timeouts are excluded, so no qualification can be earned from opponents who are not there. A league profile uses it only through `withHumanCalibratedOpponents(profile)` (`Plo4PolicyLeague.ts`), which returns a new profile with its own id; no existing profile, seed or record changed.

Because a seat that faces a turn bet has already survived earlier streets, raw shares as cutoffs under-fold (first development pass: NLH flop fold 37% against 44.9%, turn 23% against 38.7%). The cutoffs are therefore fitted on the strengths the seats actually hold when they reach each node (`server/src/scripts/humanCalibratedFit.ts`; development seeds only, the current brain in the rotating hero seat, six-max 100 BB contract tables, then a check pass on fresh seeds). NLH and other: 2,000 deals per pass, six passes. Omaha: 3,000 deals per pass, twelve passes with damping 0.5, because undamped passes oscillated at the flop and turn facing-bet nodes and finished 7.3 points off. Realized shares on the check pass (percent):

| Node (fold / call / raise, or bet) | NLH target         | NLH realized                | Other target      | Other realized (Short Deck table) | Omaha target       | Omaha realized (PLO4 table)  |
| ---------------------------------- | ------------------ | --------------------------- | ----------------- | --------------------------------- | ------------------ | ---------------------------- |
| preflop/unopened                   | 61.3 / 19.5 / 19.2 | 62.7 / 17.6 / 19.7 (n=5683) | 38.5 / 59.0 / 2.6 | 36.1 / 60.6 / 3.3 (n=7065)        | 61.9 / 9.2 / 28.8  | 63.6 / 7.6 / 28.8 (n=7323)   |
| preflop/facing_raise               | 52.7 / 35.7 / 11.7 | 51.6 / 35.4 / 13.0 (n=5060) | 29.9 / 68.7 / 1.5 | 30.8 / 68.1 / 1.1 (n=3170)        | 43.6 / 26.3 / 30.1 | 44.1 / 26.4 / 29.6 (n=10401) |
| flop/facing_bet                    | 44.9 / 43.2 / 11.9 | 46.5 / 41.0 / 12.4 (n=1150) | 7.1 / 92.9 / 0.0  | 7.3 / 92.7 / 0.0 (n=3702)         | 50.0 / 31.0 / 19.0 | 55.6 / 30.1 / 14.3 (n=1660)  |
| turn/facing_bet                    | 38.7 / 56.3 / 5.0  | 43.1 / 51.5 / 5.3 (n=842)   | 27.8 / 66.7 / 5.6 | 27.5 / 66.6 / 5.9 (n=4176)        | 50.0 / 31.8 / 18.2 | 48.8 / 33.7 / 17.5 (n=676)   |
| river/facing_bet                   | 45.3 / 47.4 / 7.4  | 46.0 / 48.7 / 5.3 (n=417)   | 44.4 / 55.6 / 0.0 | 43.4 / 56.6 / 0.0 (n=2651)        | 42.9 / 28.6 / 28.6 | 41.2 / 27.5 / 31.3 (n=371)   |
| flop/checked_to                    | 26.0               | 23.2 (n=2465)               | 34.8              | 34.7 (n=3998)                     | 41.5               | 42.3 (n=2437)                |
| turn/checked_to                    | 34.8               | 31.6 (n=1756)               | 45.2              | 45.5 (n=3404)                     | 37.6               | 37.1 (n=1362)                |
| river/checked_to                   | 27.6               | 22.7 (n=1334)               | 54.3              | 55.0 (n=2494)                     | 36.8               | 36.0 (n=884)                 |

Largest gap at any node with at least 300 check decisions: NLH 4.9 points, other 2.4, Omaha 5.6 (flop facing a bet: fold 55.6 against 50.0, raise 14.3 against 19.0), so Omaha misses the contract's 5-point fidelity criterion at that one node.

Status of the population: **implemented but unverified** as a model of a human player market. It reproduces the five accounts' measured frequencies as shown, but `humanCalibrationAdequacy` reports every family inadequate for a qualifying claim (5 distinct humans against a minimum of 20, top account 68.5% against at most 25%, 1,718 / 608 / 85 seat-hands against 10,000 per family).

Development measurement, not evidence (development seeds, no held-out seed, no pack): the current brain in the hero seat against a full human-calibrated table, after the engine's published rake, on the fitting check pass: NLH +127.09 bb/100 (99% -16.62 to +270.79, 2,000 hands; house take 132.64 bb per 100 hands); Omaha on the PLO4 table +35.00 (-127.36 to +197.37, 3,000 hands; house 158.57); other on the Short Deck table +426.75 (+173.58 to +679.92, 2,000 hands; house 207.45). These rates say the fitted population is easy to beat, which is what loose-passive, call-heavy opponents are; they are not a qualification of anything, because the calibration itself is not adequate.

## Defect Found And Fixed

A whole-stack `call` whose amount was priced from two cent values (180.88 - 41.77 = 139.10999999999999 against a stack of 139.11) left a 1e-14 residue; `HandController.performAction` set `is_all_in` from `stack === 0` before `snapChips()` rounded the stack to 0, so the next street named a seat with no chips as the player to act and the hand stalled. The human-calibrated league hit it on its first fit pass. Fixed at that line (the flag is decided on the snapped stack) in PR #6505, pinned by `HandController.wholeStackCall.test.ts` (fails on main, passes with the fix). Production read-only check: no fold or check by a zero-stack actor among the horse and human decisions of the last two hours or any retained human hand (live horses promote stack-sized bets and raises to `all_in`), so no live hand is known to have been affected.

## Status

| Claim                                                                                         | Status                                                                                |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 99.988% of horse seat-hands (W1) had no human seated                                          | verified now                                                                          |
| Horse-only cash: +0.03 bb/100 before rake, -22.22 after, over 5,767,404 seat-hands (W1)       | verified now                                                                          |
| Current brain against production humans, cash, after rake: +8.82 bb/100, 99% -15.80 to +33.44 | verified now (five humans, 1,224 hands)                                               |
| Current brain beats production humans after rake with a 99% lower bound above zero            | unavailable external input: five humans, one of them 68.5% of hands                   |
| Human tendencies per family                                                                   | verified now (small samples, stated per cell)                                         |
| League populations match real humans                                                          | defective: none matches (limping, river calls, VPIP to PFR gap)                       |
| Human-calibrated population reproduces the measured frequencies within 5 points               | verified now for NLH and other; defective for Omaha at one node (5.6 points)          |
| Human-calibrated population is an adequate calibration for qualification                      | unavailable external input: needs at least 20 humans and 10,000 seat-hands per family |
| Whole-stack call stall in `HandController`                                                    | verified now in tests (PR #6505); live after the engine release that carries it       |

The evaluation contract that follows from this record is `docs/horse-brain-winning-contract-2026-10-08.md`.
