# Horse Brain Phase 13 Round 3: Responses The Population Actually Makes (October 8, 2026)

Horse Brain only. This record covers round 3 of the Phase 13 joint multiway owner (`server/src/engine/multiway/*`): the response model rebuilt on the response the horse population actually makes, the decision rule that turned a modeled edge into a wager, the development-seed evidence, the predeclared held-out matrix and the human-population check. Statuses use the maintained vocabulary: verified now, historical only, implemented but unverified, defective, unavailable external input, not applicable with reason.

**Target.** The owner switches on no strategy that loses. A round-3 variant is a candidate for selection only if it beats the brain horses use today on the unchanged P13.2 held-out matrix (cash, after the published rake, the horse population) and, once the human-population contract is merged, wins after rake against human opponents. Horse-versus-horse results alone never select anything. Every number below states its opponent population, rake model, sample size and 99% interval.

## Identities

| Item                       | Round 2 (October 6 matrices)                                                                 | Round 3                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Response pack              | `joint-action-response-round2-v1` (kept as a comparison identity, `responseModel: 'round2'`) | `joint-action-response-round3-v1`                                                                                                                             |
| Response calibration       | none (`present_board_strength_price_public_line_uncalibrated`)                               | `joint-response-calibration-round3-v1`                                                                                                                        |
| Bounded raise tree streets | turn, river                                                                                  | flop, turn, river                                                                                                                                             |
| Selection                  | highest `expectedNetChips - 0.5 x standardError`                                             | `paired_edge_over_baseline_lower_bound`, z 2, 0.1 big blind, nothing to call                                                                                  |
| Domain, range pack         | `joint-multiway-round1-v4`, `joint-public-range-round1-v1`                                   | unchanged                                                                                                                                                     |
| P13.2 contract digest      | `a036e702...b57bb754`                                                                        | `1d0dd99b...6dc5dd96`: only the candidate pack identity moved; population, rake model, profiles, held-out seeds, pairs per shard and thresholds are unchanged |

## 1. The diagnosis, reproduced on development seeds

Harness: `server/src/scripts/jointResponseCalibration.ts`, the P13.2 paired league itself (`playPlo4PolicyHand`, the real HandController, each contract profile with its published 1/2 pricing and BBJ row, the contract deal seeds, buttons and hero seats), development seeds 13101101 and 13102203 only (the harness refuses every held-out seed of Phases 10 to 13), 1,200 pairs per profile, the round-2 source of `origin/main` 68fa6072. Opponents: the five production horse styles. Rake: the published cash pricing of each variant.

Paired candidate minus reference, cash after rake (bb/100, 99% interval). The held-out October 6 numbers are beside them:

| Variant         | Pairs  | Development seeds           | Held-out matrix (Oct 6) |
| --------------- | ------ | --------------------------- | ----------------------- |
| NLH             | 19,200 | -663.01 [-734.03, -592.00]  | -682.93                 |
| PLO4            | 19,200 | -516.11 [-584.23, -448.00]  | -547.42                 |
| PLO5            | 19,200 | -544.41 [-611.44, -477.38]  | -531.05                 |
| PLO6            | 19,200 | -465.37 [-529.46, -401.28]  | -487.70                 |
| PLO8            | 19,200 | -283.55 [-341.20, -225.89]  | -305.12                 |
| FLO8            | 21,600 | -92.29 [-101.26, -83.31]    | -98.53                  |
| FLH             | 21,600 | -98.00 [-106.40, -89.60]    | -108.10                 |
| Short Deck      | 19,200 | -642.33 [-744.28, -540.37]  | -560.81                 |
| Crazy Pineapple | 19,200 | -952.58 [-1058.68, -846.48] | -973.83                 |

Predicted against realized response to the candidate's applied wagers (first responses to each applied hero wager; per-opponent continue, then the share of wagers every opponent folded to):

| Variant         | Street  | Wagers | Continue predicted / realized | All-fold predicted / realized |
| --------------- | ------- | ------ | ----------------------------- | ----------------------------- |
| NLH             | preflop | 6,924  | 0.22 / 0.25                   | 0.65 / 0.47                   |
| NLH             | flop    | 7,975  | 0.10 / 0.23                   | 0.88 / 0.38                   |
| NLH             | turn    | 3,185  | 0.24 / 0.83                   | 0.85 / 0.12                   |
| NLH             | river   | 1,297  | 0.30 / 0.74                   | 0.81 / 0.23                   |
| PLO4            | flop    | 10,575 | 0.16 / 0.37                   | 0.73 / 0.24                   |
| PLO4            | turn    | 5,407  | 0.27 / 0.84                   | 0.74 / 0.07                   |
| PLO8            | flop    | 10,725 | 0.17 / 0.37                   | 0.72 / 0.25                   |
| FLH             | flop    | 8,701  | 0.25 / 0.75                   | 0.41 / 0.01                   |
| FLO8            | flop    | 11,555 | 0.28 / 0.86                   | 0.38 / 0.00                   |
| Short Deck      | flop    | 8,187  | 0.14 / 0.26                   | 0.77 / 0.37                   |
| Crazy Pineapple | flop    | 7,779  | 0.13 / 0.33                   | 0.80 / 0.24                   |

Every variant, street, bet-size band (a third of the pot, two thirds, the pot, over the pot) and opponent count (one to four or more) is in `round2-dev-reproduction.json` in the evidence directory below. The error is the same everywhere: the model priced fold equity that the population does not give, worst at turn and river and in fixed limit. The first applied change of each pair was priced at a large edge and realized a loss (NLH flop, check to bet: predicted +16.9 chips, realized -15.7 over 3,085 pairs; fold to raise: +29.9 against -91.8 over 1,055).

## 2. The root fixes

### 2.1 Responses measured on the population (`JointResponseCalibration.ts`)

For every variant and street, two frequencies are a logistic fit of every horse response that faced a price in the same paired league on development seeds 13101101 and 13102203 (296 runs, 1,200 pairs per profile, both arms; 12,000 to 125,000 responses per cell):

- continue frequency: the share of responders that call or raise;
- raise share: the share of continuing responders that raise (zero when calling puts the responder all in).

The features are public and the responder's own: the pot price, the live players beside it, whether the street already holds a raise, whether its own line holds a wager, a bomb hand, and whether calling puts it all in. The coefficients are frozen in the source with their sample counts.

Which sampled hands continue: the strongest continue-frequency share of the responder's own sampled range, and the strongest continue x raise share of those raise. The order is the strength each sampled hand reaches on its sample's runout (high, or the better of high and low in split games). The present-board read round 2 used misorders the population: on the NLH bomb flops only 41 to 49 percent of the responders that continued sat in its top share, and a jam priced with that order met callers far weaker than the table produced (predicted edge +15.9 chips, realized 0.0 over 298 jams, while the all-fold frequency itself was measured exactly, 0.75 against 0.76). The runout order errs the other way: a called wager meets the strongest continuing range the sample allows, so its error can only make a wager look worse. It never changes how often a responder continues.

### 2.2 The decision rule

- **Paired edge, not a noisy maximum.** Round 2 acted on the highest `expectedNetChips - 0.5 x standardError` among up to twelve rows priced on 8 to 16 shared samples, a winner's curse on whichever wager the noise favored. Round 3 pairs every row with the baseline row on the same samples and keeps the baseline unless a row's paired edge clears two paired standard errors by more than 0.1 big blind (`jointSelectedRow`).
- **Nothing to call.** Facing a wager, every candidate's price rests on hero's equity against the wagerer's sampled range, and the public-range prior barely narrows a range for its own aggression. On the development seeds every family that answered a wager with a raise, a jam or a call the baseline folds was priced at a large edge and realized a loss (NLH bomb flop fold to raise: predicted +79 chips, realized -183). That prior is shared with the live Phase 7 tournament owner, so it is not changed here; the joint owner keeps the baseline whenever something is owed.
- **Same horizon on the flop.** The bounded raise tree (one legal raise, hero's answer, the river continuation from the turn) now prices the flop too, where round 2 applied most of its wagers with one response and no raise.

### 2.3 The four-millisecond budget

The rule cannot act facing a wager, so a cash decision facing a wager is decided without pricing any candidate (reason `joint_cash_facing_wager_baseline`, `fired: true`); the samples are still acquired and bound. That removes the response model from every such decision inside the live budget, which is where 31 percent of decisions were refused on October 6. The completion definition is unchanged. Whether the remaining nothing-to-call decisions meet the P13.3 floor on the engine host is measured only by a natural window after an engine release.

## 3. Development iterations

All on development seeds, never a held-out seed. Paired candidate minus reference, cash after rake (bb/100, 99% interval), equal pairs per profile, horse population, published rake.

| Iteration                                                | Seed (pairs per profile)    | NLH                          |
| -------------------------------------------------------- | --------------------------- | ---------------------------- |
| Round 2                                                  | 13101101 + 13102203 (1,200) | -663.01 ± 71.02              |
| Calibrated frequencies, present-board order, paired rule | 13103307 (400)              | -58.94 ± 66.21               |
| plus nothing to call                                     | 13103307 (2,000 to 2,400)   | -3.52 ± 21.66 (18,700 pairs) |
| plus runout order (round 3 as committed)                 | 13103307 (600)              | +10.63 [-26.54, +47.81]      |

Round 3 as committed, every variant, two independent development seeds (600 pairs per profile each):

| Variant         | Seed 13103307            | Seed 13104409            |
| --------------- | ------------------------ | ------------------------ |
| NLH             | +10.63 [-26.54, +47.81]  | +39.31 [+4.86, +73.76]   |
| PLO4            | +7.67 [-34.47, +49.81]   | +28.80 [-4.20, +61.80]   |
| PLO5            | +3.48 [-31.53, +38.50]   | +25.04 [-6.49, +56.57]   |
| PLO6            | +31.59 [-10.94, +74.13]  | +27.36 [-8.48, +63.20]   |
| PLO8            | +60.95 [+18.58, +103.32] | +78.79 [+38.29, +119.29] |
| FLO8            | +3.05 [+1.51, +4.60]     | +2.91 [+0.75, +5.08]     |
| FLH             | +0.29 [-1.36, +1.93]     | +0.29 [-0.88, +1.46]     |
| Short Deck      | +16.67 [-28.78, +62.13]  | +12.62 [-27.97, +53.21]  |
| Crazy Pineapple | -7.33 [-39.77, +25.11]   | +18.72 [-11.72, +49.16]  |

Seed 13104409 was run once, after the source was final, as a confirmation. Response calibration on it (predicted / realized per-opponent continue, then all-fold, for applied wagers): NLH flop 0.12 / 0.13 and 0.56 / 0.54; PLO8 flop 0.14 / 0.15 and 0.49 / 0.46; Short Deck flop 0.14 / 0.13 and 0.54 / 0.54; FLO8 river 0.71 / 0.72 and 0.03 / 0.00. The applied changes are now almost all checks turned into a bet on bomb-pot flops, priced at about +12 chips and realizing +7 to +14 (PLO8 three-board flop: predicted +12.02, realized +10.49 ± 7.19 over 323 changes).

What this does not show. The development edge is concentrated in bomb-pot flops; FLH barely changes a decision (+0.29); the ordinary multiway profiles change little. No development seed is a qualification. The held-out matrix decides.

## 4. The predeclared held-out matrix

Written and committed before any run it governs: the unchanged P13.2 contract (`JOINT_STRENGTH_CONTRACT`, digest `1d0dd99be2fedd7ec50e502cf4241611818dd30aec794714808888616dc5dd96`, which differs from the October 6 digest only in the candidate pack identity), its nine variants, profiles, held-out seeds, pairs per shard, primary gate (cash after rake 99% lower bound above 0 bb/100), seed replication (each held-out seed block above 0), non-regression (every gating cell 99% lower bound at or above -10 bb/100, -4 for FLH and FLO8), the horse population and the published rake. It is dispatched once per variant on the merge commit of this change through `.github/workflows/horse-phase13-strength-league.yml` and assembled with `server/scripts/phase13-strength-assemble.mjs`. Unfavorable runs are kept. Results are recorded in a dated section appended to this record.

## 5. The human-population check

The owner's target is beating the human players horses face for money. The winning contract (`docs/horse-brain-winning-contract-2026-10-08.md`, merged in #6515 while round 3 was in review) adds condition (b): a pack qualifies only if its after-rake win rate against the human-calibrated population `human-calibrated-v1-20261008` has a 99% lower bound above zero on the contract's held-out seeds, **and** that population's calibration is adequate (at least 20 human accounts, no account above 25%, 10,000 human seat-hands per family). On the calibration committed today every family fails adequacy (5 accounts, the most active 68.5%, 1,718 / 608 / 85 seat-hands), so condition (b) is unavailable external input for every pack, Phase 13 included. No round-3 variant can qualify until production has an adequate human population and a new population is committed.

Development measurement, not qualification (the contract allows development-seed runs to steer development). Harness `jointResponseCalibration.ts --human`: the same paired league with every non-hero seat on the human-calibrated profile of its family (`withHumanCalibratedOpponents`), the contract profiles and their published rake, development seed 13104409 (never a held-out seed of Phases 10 to 13 or of the human-calibrated contract), 600 pairs per profile, the round-3 source as merged. Hero net after rake, bb/100, equal weight per profile, 99% interval:

| Variant         | Round 3 (candidate)         | Current brain (reference)   | Paired difference        |
| --------------- | --------------------------- | --------------------------- | ------------------------ |
| NLH             | +181.13 [+56.64, +305.61]   | +209.37 [+102.48, +316.26]  | -28.24 [-89.73, +33.25]  |
| PLO4            | +30.75 [-104.47, +165.97]   | +44.82 [-88.85, +178.50]    | -14.08 [-42.95, +14.80]  |
| PLO5            | +56.60 [-65.66, +178.86]    | +60.73 [-60.11, +181.57]    | -4.13 [-35.10, +26.84]   |
| PLO6            | +50.18 [-63.19, +163.54]    | +42.46 [-67.39, +152.32]    | +7.71 [-28.12, +43.55]   |
| PLO8            | +58.12 [-53.55, +169.79]    | +40.66 [-64.91, +146.23]    | +17.46 [-24.39, +59.31]  |
| FLO8            | +15.51 [-3.86, +34.88]      | +13.80 [-5.54, +33.13]      | +1.72 [-0.00, +3.44]     |
| FLH             | +35.01 [+12.62, +57.40]     | +34.00 [+11.53, +56.48]     | +1.01 [-0.43, +2.45]     |
| Short Deck      | +449.26 [+243.95, +654.58]  | +425.59 [+242.94, +608.23]  | +23.67 [-76.96, +124.31] |
| Crazy Pineapple | +856.92 [+586.19, +1127.66] | +870.33 [+599.62, +1141.05] | -13.41 [-88.16, +61.34]  |

Against the human-calibrated tables both brains win after rake in several variants (the fitted population is loose and passive and easy to beat, as its own record says), and round 3 is not distinguishable from the current brain in any variant. Its development edge is specific to the horse population: it bets where horses fold, and the human-calibrated seats call. The next root cause for the human objective is therefore the response model's population, not its mechanics: a responder that is a human should answer with human frequencies (the human-calibrated fit), which needs both an adequate human calibration and a way for the league and the live state to tell a human seat from a horse seat (every league seat is `is_horse: true` today). Neither is available, so this is recorded and not built. Evidence: `round3-dev-human-calibrated-13104409.json`.

## 6. Held-Out Matrix Dispatch

Dispatched on 2026-10-08 at 16:38Z for the merge commit `5adefba4ac868bf138bee41bda24ae4b1754e456` (#6520), one run per variant, through `.github/workflows/horse-phase13-strength-league.yml` with the unchanged contract above: NLH [37810344257](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37810344257), Short Deck [37810347912](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37810347912), FLH [37810351762](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37810351762), Crazy Pineapple [37810355657](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37810355657), PLO4 [37810359405](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37810359405), PLO5 [37810363332](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37810363332), PLO6 [37810367050](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37810367050), PLO8 [37810370548](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37810370548), FLO8 [37810374138](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37810374138). The contract's hosted estimate is about 504 runner-hours for the nine variants (2.2 to 3 wall hours each at twenty concurrent jobs); the organization's shared runner pool was carrying 69 queued runs and the Phase 8 strength league at dispatch. A round-3 shard costs about 1.1 times a round-2 shard on the same machine (PLO8 three-board bomb, 100 development pairs: 37.3 s against 33.7 s), inside the 120-minute job limit. Each variant is assembled with `server/scripts/phase13-strength-assemble.mjs` on a clean checkout of `5adefba4` and recorded in a dated section appended here, favorable or not. Whatever condition (a) returns, no variant is selected while condition (b) is unavailable external input.

## Gate status

- Round-2 response model: defective (uncalibrated; measured above as the cause of the loss on every variant).
- Round-3 responses: verified now on development seeds (frequencies agree within a few points per street; JointResponseCalibration.test.ts pins coverage, monotone price response, the ranked responder order and the measured share).
- Selection rule (paired edge, nothing to call): verified now (JointResponseCalibration.test.ts, JointLegalForm.test.ts, the worker and client boundary suites).
- Strength, condition (a): implemented but unverified until the held-out matrix (section 6) is assembled.
- Human population, condition (b): unavailable external input (calibration inadequate on every family); development measurement above: round 3 not distinguishable from the current brain against the human-calibrated tables.
- Selection: every `PHASE13_PROTECTED_RELEASE_SELECTIONS` entry stays `null`.

Evidence: `/Volumes/SmarterArchives/agent-evidence/horse-brain-finish-20261008/win-p13/` (`round2-dev-reproduction.json`, `round3-dev-evalD.json`, `round3-dev-evalE.json`, `round3-dev-evalF.json`, `round3-dev-human-calibrated-13104409.json`, `response-fit.json`).
