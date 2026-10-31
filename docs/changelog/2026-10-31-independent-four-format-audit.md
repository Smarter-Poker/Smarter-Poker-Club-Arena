# Independent four-format audit checkpoint

Owner: chat 01a193b0. Scope: MTT, SPIN, SNG, SATELLITE across client, engine, persistence, operations, settlement and connected dependencies. Fresh review, not prior certificate reuse. No guarantee of impossible future failures.

Checkout: /Volumes/SmarterWork/agent-work/shared-capacity/tournament-audit-01a193b0/ca
Branch: fix/tournament-audit-01a193b0
Baseline: 6b698c84f11e9d7ec731bac4025835c82ef0f47c. No PR or production mutation yet.

## Acceptance (all pending)

- Account for every directly relevant implementation file and line range, plus transitive callers/RPCs; inventory is discovery, not reviewed coverage.
- Verify registration/payment and duplicate/concurrent admissions, launch, seating/balancing, hand progression, levels/breaks, reconnect/restart, eliminations, bounty/deal/payout and ticket behavior for all four formats.
- Reproduce and repair confirmed causes with enforced regression tests, real isolated database/engine qualification and safe live observation.
- Complete exact-candidate checks, protected merge, approved installation/publication and affected live proof separately for each component.
- Preserve financial truth, original operation identity, current owner dispositions and concurrent work. No destructive production tests or invented refunds/cancellations/restarts.

## Startup references

Canonical four policies emitted 2026-10-31T20:39:55.254Z; version 2.9; manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b. Canonical owner b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349; operating a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5; hardening d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e; index adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555. Portable check --canonical passed. Read storage guide, root AGENTS/CLAUDE/AGENT-PLAYBOOK, current changes to CLAUDE, PUBLISHING and deploy-paths. No nested AGENTS/CLAUDE found under server/src/supabase.

## Current observations, not acceptance

- GitHub configured authenticated access works; Supabase project kuklfnapbkmacvwxktbh read access works.
- Live initial health saved in /Volumes/SmarterArchives/agent-evidence/tournament-audit-01a193b0/health-initial.json: engine eed06fe51dea622069c661a6213d5b031ff3a9e3, 190 active managers, 171 stalled tables, ongoing dealt hands. Stalls require attribution; count is not proof all are tournament freezes.
- Historical start hold is currently blocked=false. Its row records a newer owner release direction at 2026-10-31 20:20 UTC. No hold changed by this audit. Current original20 recovery/original89 operations must be recovered before any mutation.
- Current running event counts at first SQL observation: MTT45, SATELLITE6, SNG95, SPIN43. Oldest MTT/SNG/satellite started October29. First broad count used lowercase filters against uppercase statuses; corrected interpretation retained here.
- Source inventory saved in owned scratch/source-inventory.json. Three manager layers alone contain 25,810 lines; no line-by-line completion claimed.

Next: attribute live stalls and original-event dispositions; execute existing isolated tournament suite; review shared lifecycle and per-format branches with recorded ranges, fixing demonstrated causes as found.

## Finding A01: unlimited-field result order (implemented locally)

`src/utils/tournamentPayout.ts` used 999 as the missing-place sentinel in both finish order and equal-total payout ties. A null-position qualifier could precede a real rank1500. The actual Results page uses this helper for total-order qualified entrants. Reproduced before repair with the production helper: [unplaced, rank1500]. Replaced the numeric sentinel with explicit valid-place ordering; unknown places remain stable at the end of tied payouts. Existing payout/bounty math is unchanged. All17 focused tests pass, including both new >999 cases. Initial client invocation incorrectly supplied the server Vitest2-only minWorkers option to client Vitest4; corrected command executed successfully. No publication yet.

## Live freeze attribution

All89 RUNNING events older than24h belong to existing abort targets in state stop_requested (16 MTT,5 SATELLITE,68 SNG), with no tournament_abort_recoveries row. Do not mutate or duplicate their existing operation. Latest failed engine run41233374402 passed four exact-source shards and production doors, failed durable Hetzner intake: native Inspector queryObjects timed out; inspector cleanup unverified; checkpointInvoked=false and retryAllowed=false. The owning transaction retained old eed06fe5. Log retained in owned scratch/latest-engine-failure.log. This is a deployment/recovery gap, not proof new-source tournament fixes are ineffective.
