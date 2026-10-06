# Horse Brain Phase 13: why the joint candidate loses to the reference (October 6, 2026)

Scope: the locked held-out FLH matrix of origin/main (candidate `phase13Joint: 'candidate'` with response `joint-action-response-round2-v1` at the hero seat against `phase13Joint: 'off'`) measured the candidate at about minus 108 bb/100, worst in the bomb profiles. This record diagnoses that loss on development seeds only (13101101, 13102203, 13103307 of JOINT_LEAGUE_SEEDS). No held-out seed was run. The source changes are committed on branch `agent/claude-horse-brain/phase13-loss-diagnosis-20261006` for the next round; it is not pushed, and the held-out matrices running now measure origin/main bytes.

## Method

A harness wrapped `HorseLogic.decide` around the real league (`playPlo4PolicyHand`, the real HandController, the contract profile from `jointStrengthLeagueProfile`, the same deal seeds, buttons and hero seats as `runJointStrengthShard`). For every hero decision of the candidate arm it recorded the joint receipt (baseline action, proposal, every priced candidate row with its expected net chips, all-fold probability and per-opponent call probability), and for every opponent decision the action taken and the price faced. Each pair was attributed to its first applied change, which is where the two arms diverge. Calibration compared, for that first change, the model's expected net chips of the baseline action and of the proposal with the realized net chips from that decision to the end of the hand in the reference arm and in the candidate arm.

## What the candidate changes

Of the applied changes, almost all turn a passive baseline action into a wager. Seed 13102203, 360 pairs per profile: bomb1 applied 982 changes, of which check to bet or raise 680, call to raise 173, fold to raise 77, and only 24 went the other way; 9max-100bb applied 452, of which fold to raise 171, check to bet 157, call to raise 66. Preflop the typical change is a raise with a hand the baseline folds; postflop it is a bet or raise where the baseline checks or calls.

Attribution of the paired difference to the first change (seed 13102203, bb/100): bomb1 minus 298 in total, of which postflop check to wager minus 150, fold to wager minus 71, call to wager minus 58; bomb3 minus 173, of which check to wager minus 98, call to wager minus 43, fold to wager minus 27; 9max-100bb minus 43, of which preflop fold to raise minus 39.

## Defective, fixed on the branch: a fixed-limit all-in priced as a stack shove

In fixed limit the controller advertises `all_in` whenever its clamp turns the button into a legal wager, and `performAction` executes it through `clampToStructure` as a bet or raise to the street ceiling (or a call on a capped street). The shared candidate builder still emits a `jam` there with the whole stack as its investment. The round-2 tree (turn and river) prices that jam through `clampJointAllIn`, the controller replica. The one-response model, which prices every preflop and flop decision, committed the whole stack and asked each opponent to call a 100 big blind shove into a few big blinds, so almost every opponent folded in the model and the jam collected the pot. On seed 13102203 the candidate proposed `all_in` on 260 bomb1 decisions and 172 9max decisions, with a predicted edge of 19 to 51 chips over the baseline where the realized edge was negative.

Reproduced on the unmodified source by `server/src/engine/multiway/JointFixedLimitAllIn.test.ts` (real HandController spots, flh and flo8 cash): both cases failed, every mismatch on the one-response model, for example preflop jam priced at 8.36 chips with all-fold 0.875 where the executed raise:20 is priced at 22.68 with all-fold 0.5625.

The defect is in the shared candidate builder, not in the joint layer. `buildTournamentActionCandidates` gated a pot-limit jam on the ceiling but built a fixed-limit jam with the whole stack as its investment, and the Phase 7 tournament utility priced it the same way. Phase 7 is live by default for horse tournament decisions (`opts.phase7Utility` defaults on and no live caller turns it off, and its selection replaces the decision), so live FLH and FLO8 tournament decisions were affected: `server/src/engine/HorseTournamentUtilityFixedLimitJam.test.ts` failed on the unmodified source with, for example, a Phase 7 jam priced at investment 3867 and chip EV minus 97.07 where the executed raise:40 is minus 6.5, and on another spot a jam at chip EV 48.43 ranked above the executed raise:60 at 45.35.

Fixed at the root: the builder builds a fixed-limit jam only where a wager is legal, at the investment of its executed raise-to (`executedAllInTo`, the street ceiling when the stack exceeds it), and Phase 7 and the joint round-1 model target a jam at `hero.bet + investment`; the joint legal-form step rebuilds a legalized all-in with the same rule. A first, Phase 13 only patch in `JointActionModel.ts` was replaced by this fix. Both tests pass. Only the Phase 13 policy digest moves; the Phase 10, 11 and 12 digests cover none of the changed files, and Phase 7 has none. Changelog: `docs/changelog/2026-10-06-horse-brain-fixed-limit-jam-pricing.md`.

Paired development-seed difference before and after (seed 13102203, the same 360 pairs per profile, bb/100, 99 intervals): bomb1 minus 298.1 before, minus 297.5 after, paired change plus 0.6 plus or minus 3.7; bomb3 minus 173.2, minus 170.7, change plus 2.5 plus or minus 5.1; 6max-100bb minus 0.7, minus 0.7, change minus 0.1 plus or minus 10.8; 9max-100bb minus 42.6, minus 42.1, change plus 0.5 plus or minus 17.2. Applied `all_in` proposals fell to zero. The loss did not move, because the executed action was already the one-unit wager: after the fix the model picks that same wager at the ceiling almost every time. The defect is real but it is not the cause of the loss.

## The cause of the loss: a modeling weakness in the opponent response model

The response probability `jointCallProbability` is `0.12 + 0.88 x signal + ... - 0.62 x potPrice - 0.025 per extra live player + 0.035 if covering`, clamped to [0.02, 0.98]. Its signal is the present-board decision strength, which postflop is `0.25 x shape + 0.6 x category / 8 + 0.15 x low`. A made hand therefore reads very low: one pair about 0.17, two pair about 0.25, a set about 0.32. Fed into a response function written as though the signal were an equity, a pair facing a one-unit fixed-limit bet at thirteen to one continues about one time in six, and a set less than one time in three. The model has no calibration (`calibratedConfidence: null`) and nothing anchors it to the population it plays against.

Measured on seed 13103307 after the fix (300 pairs per profile), predicted against realized response to the candidate's applied wagers:

- bomb1 flop: predicted continue per opponent 0.24, realized 0.67; predicted all-fold 0.38, realized 0.00. Turn 0.29 against 0.81, all-fold 0.44 against 0.00. River 0.36 against 0.76, all-fold 0.43 against 0.03.
- 9max-100bb: preflop 0.30 against 0.37, all-fold 0.38 against 0.05; flop 0.29 against 0.84, all-fold 0.55 against 0.01.
- 6max-100bb: preflop all-fold 0.46 against 0.10; flop 0.28 against 0.78, all-fold 0.59 against 0.04.

The settlement side is not where the error is. On the first changed decision (seed 13102203, bomb1 and bomb3) the model's expected net chips of a baseline check were 2.84 against 2.38 realized, while the proposal was priced at 21.67 against minus 0.83 (jam, before the fix) and 10.86 against minus 3.63 (bet). The baseline is priced close to what happens; the wager is priced with fold equity that does not exist. In a fixed-limit pot a one-unit bet risks a twelfth of the pot, so any phantom fold equity makes a bet with any holding look profitable, and the candidate bets every street. Round 1 and round 2 agree: over 383 bomb1 turn and river spots the two models chose the same action family almost every time (mean predicted edge 13.3 chips against 13.6, chosen all-fold 0.42 against 0.41), because the tree reuses the same response probability for its fold and call split.

Two further weaknesses compound it: a check is priced as a free showdown (nobody behind may bet), while a wager is priced as one response then showdown, so the comparison omits every later street; and the ranking subtracts only half a standard error from 32 shared samples, which leaves a winner's curse on whichever wager the noise favors.

No coding defect was found in the pot, price, seat, board, bomb or rake paths: conservation, paired replay and settlement checks hold, and the baseline action is priced close to its realized value. The response model is uncalibrated, not miswired.

## What the next round must change

- Anchor opponent responses to the population. The opponents are horses running HorseLogic. Calibrate continue and raise frequencies by variant, street, price and a strength measured as a percentile of the opponent's range (not `category / 8`), from development-seed league play, or price responses with the population policy itself.
- Add a calibration gate before any held-out run: on development seeds, predicted against realized per-opponent continue and all-fold frequencies by street must agree within a declared tolerance, and the predicted edge of applied changes must agree with the realized paired difference.
- Price the check and the wager on the same horizon (both continue to showdown under the same later-street model), and correct the ranking for selection among noisy candidates.
- Do not tune any of this on the held-out seeds.

## Gate status

- Fixed-limit jam priced as the executed wager: defective on origin/main in the shared builder (Phase 7 live tournament decisions and the Phase 13 joint model), fixed at the builder on the branch; verified now by the two reproducing tests and the paired development runs above.
- Opponent response model: implemented but unverified (uncalibrated by declaration), and measured here as the cause of the loss.
- Settlement, seat, board and deduction paths: verified now as not the cause, by baseline-action calibration on development seeds.
