# Phase 2 Continuation: Pot-Limit Short Blinds

Status: correction verified locally; normal publication and runtime adoption pending. Phase 2 of 12 is not complete.

## Recovered Checkpoint

The frozen audit had reached Phase 2. Its source evidence is in the September 8 poker-rules, partial-antes, card-visibility and limit-completion reports. The Phase 1 programme marker was reconciled separately in PR #3907. This continuation starts from ce74e5bb04325d2aa28bffecbd24b2c8ec165927.

Previously merged work: fixed-limit reopening #3868; indivisible high/low awards #3869; independent evaluator oracle and BX01 fixture #3873; individual antes/inactive blinds #3885; reveal resync #3894; fixed-limit completion #3899.

C01 action-context PR #3879 is still open at 55374e3cdb6aa632c0873e018ff91ca0f32f0211. Its latest CI 34286646323 and silent-revert guard 34286646309 succeeded, but GitHub reports merge conflicts. Recovering that original change is the next unfinished publication task.

## Confirmed C04 / W08 Defect

Primary comparator checked September 9, 2026: Poker TDA 2024 rules 54B-C, https://www.pokertda.com/view-poker-tda-rules/ . Preflop pot-limit calculations assume full normal blinds; postflop calculations use actual chips. This is a named rules comparison, not external or jurisdictional certification.

With 1/2 blinds and a BB all-in for 0.50, the actual pot is 1.50, but the opening pot-limit maximum is 7.00. HandController validation, deep-shove normalization, the HTTP action clamp and the published legal-action ceiling used the actual pot directly, producing 5.50. The client repeated that calculation.

Before correction: 25 new cases failed and four postflop controls passed across plo4, plo5, plo6 and plo8. Failures include short SB, short BB, both short, a limper, a deep shove and an ante exhausting a blind.

## Source Correction And Callers

HandController records the normal SB/BB shortfall when posting blinds, before extra posts and straddles. BettingStructure.potLimitBettingPot adds that shortfall only preflop. Shared HandController validation/structure clamps, ServerTableEngineTurns HTTP normalization/action bounds, and HTTP/live snapshots consume the same calculation.

The snapshot publishes pot_limit_pot as the wagering basis. The pot, contributions, side-pot eligibility, awards and displayed pot remain actual chips. mapEngineSnapshot carries the field to both TablePage sizing paths, including tile raise bounds. The preflop POT preset uses the supplied legal ceiling; pot odds still use actual chips. Older-engine snapshots retain their existing actual-pot fallback.

React review: the new primitive is included in the existing memo dependency list. No effect, request, render loop, component definition or layout change was introduced.

ServerTableEngineBase.saveSnapshot serializes state except the private deck, so it retains this field. checkCrashRecovery does not resume an old betting hand or old turn deadlines. No new replay, recovery payment, cron, database function or historical balance mutation was introduced.

## Executed Evidence

- 29 short-blind cases pass after correction. The real public engine action method clamps a raise of 99 to 7; the resulting actual pot is 8.50.
- 81 server tests pass across PotLimitShortBlinds, PotLimitCeilingAudit, FixedLimitCompletion, ChipConservation.property and EngineRecordsWhatItDealt. This includes 10,000 fixed-corpus and 1,000 fresh randomized hands.
- 41 client tests pass across snapshot mapping, the short-blind POT preset and existing raise presets.
- Both server and client TypeScript checks pass.
- Initial Vite compilation completed, but provenance identified two newer main commits. Refresh and rebuild are required before accepting the release build.

Complete-hand fixtures verify that postflop uses the actual 6.50 pot, rejects a cent above it and conserves all 300.50 starting chips at showdown. The wagering ceiling never creates missing blind chips.

## Prior Correction Runtime Adoption

At 2026-09-09T01:13:19.445942+00:00, engine health reported 9ef973e9, resolving to 9ef973e9657f051ef114ddb52006abeb6801d2fd. Git ancestry confirms these prior merges are contained:

| Correction          | Merge                                    |
| ------------------- | ---------------------------------------- |
| Reopening #3868     | 7dc9863f615d884759381343021e1bf80aef769c |
| High/low #3869      | b0dff82dd768e3c80c4dade7e24e327c15f8944e |
| Partial antes #3885 | db6613ac288193d294356d80532b210465902b54 |
| Reveal resync #3894 | cd9ed00f817dd91d915964bf416e057e82ed5a18 |
| Completion #3899    | 13188cd5522f6eb3c0fb2a3553024f7ed5417924 |

Health was ok, running true, maintenance idle, zero stalled tables and zero blocked settlements. All 570 tables and eight resume waves completed.

Both https://ca-static.smarter.poker/build-info.json and https://smarter.poker/hub/club-arena/build-info.json served e17dc392cc8f134bc033cd6fa6c2ceda50595a2d, built 01:09:13 UTC by publisher 34297865875. This verifies prior rollout lineage and health only. The new short-blind correction and open C01 PR are not claimed deployed.

## Remaining Phase Gates

Publish through ordinary hooks, CI, automatic merge and scheduled engine adoption. Resolve and verify #3879. Complete the remaining rules register, including malformed Omaha caller handling, published cash blind rotation, showdown display/history parity, runout consent and independent certification status. All 18 Phase 2 requirements retain their full coverage obligation. No partial case closes this phase or the 216-requirement programme.
