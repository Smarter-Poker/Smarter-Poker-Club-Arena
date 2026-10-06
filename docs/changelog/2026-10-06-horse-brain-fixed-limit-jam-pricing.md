# Horse Brain: a fixed-limit all-in is built and priced as the wager the table executes

In fixed limit the HandController advertises `all_in` whenever its clamp turns the button into a legal wager, and `performAction` executes it through `clampToStructure` as a bet or raise to the street ceiling (a call where no wager is legal). The shared candidate builder `buildTournamentActionCandidates` gated a pot-limit jam on the ceiling but built a fixed-limit jam with the whole stack as its investment. Every consumer that commits `candidate.investment` and targets `hero.bet + hero.stack` therefore priced a stack shove the table never makes.

Consumers affected:

- The Phase 7 tournament utility (`HorseTournamentUtility.ts`). It is live: `HorseLogic` runs it whenever `opts.phase7Utility` is not false (no live caller sets it; the data ledger documents it as default on) and replaces the decision with its selection after the legalizer check. On deep fixed-limit tournament spots (FLH and FLO8) the jam was priced as a shove; where its phantom utility ranked first, Phase 7 selected `all_in` and the controller executed a raise to the ceiling that the correctly priced alternatives did not prefer. Live horse tournament decisions in FLH and FLO8 were affected.
- The Phase 13 joint one-response model (every preflop and flop joint decision), which proposed the mispriced jam on most deep fixed-limit decisions in the shadow and offline strength league. The round-2 tree already priced it through the controller replica.

Root fix: the builder builds a fixed-limit jam only where a wager is legal, with the investment of its executed raise-to (`executedAllInTo`: the street ceiling when the stack exceeds it). Phase 7 and the joint round-1 model target a jam at `hero.bet + investment`, and the joint legal-form step rebuilds a legalized all-in with the same rule. A no-limit jam is unchanged, a pot-limit jam keeps its existing gate, and on a capped street (all-in executes as a call) no jam is built because the call candidate already prices it.

Regression: `server/src/engine/HorseTournamentUtilityFixedLimitJam.test.ts` (real controller spots, flh and flo8, cash and tournament: the builder jam raises to the controller's executed raise-to; the Phase 7 ledger prices a clamped jam exactly as the bet or raise to the ceiling) and `server/src/engine/multiway/JointFixedLimitAllIn.test.ts` (both joint response models). Both failed on the unmodified source and pass now.

Policy digests: only the Phase 13 digest moves (it hashes `HorseTournamentUtility.ts`, `JointLivePolicy.ts` and `JointActionModel.ts`). The Phase 10, 11 and 12 digests cover none of the changed files. Phase 7 has no policy digest. No phase holds a qualification, so nothing is invalidated.

This does not explain the Phase 13 strength loss. See `docs/horse-brain-phase13-loss-diagnosis-2026-10-06.md`.
