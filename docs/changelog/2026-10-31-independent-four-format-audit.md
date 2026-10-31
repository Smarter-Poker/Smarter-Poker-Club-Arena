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

## Resumption and A02: schedule occurrence acknowledgements

Policies freshly emitted/read 2026-10-31T20:45:06.080Z with the unchanged version 2.9 hashes above; repository AGENTS, CLAUDE, playbook, publishing and deploy paths reread. SSD shared-capacity verified on its own disk. A01 source 36680aa3ae0ada2d9892ef16104665544040f11b pushed through passing normal pre-push guards (57 files / 738 related tests); PR8957 created by the configured branch proposal workflow. Hosted checks pending; no publication claim. Updating its description through configured gh GraphQL and REST was refused403; no credential substitution attempted.

A02 owned branch fix/tournament-occurrence-ack-01a193b0 starts from current origin/main. The actual conform method renamed a spawn after a zero-row conditional tournament update. Behavioral regression failed before repair, observing both writes and false success. The source now requires the exact returned moved event/start and renamed spawn/event before advancing claimed keys. The move also fences the read prize-finalization state; the rename fences event identity. Interrupted moves preserve the existing old-key recovery path. No migration or production mutation.

Broader results: 4368/4369 tournament tests passed on the first run; the remaining native PostgreSQL fixture could not start due to the long TMPDIR socket path. With the shorter owned SSD path, its three tests passed, exercising 15 format/purchase combinations. Related server services passed265/265. Client format suite passed3536/3537; one Python subprocess exceeded its7-second harness deadline under concurrent suites. Its isolated diagnostic run completed in276ms; this does not yet resolve the load-sensitive failure. A01's focused17 tests and compiler passed.

Audit remains open: no complete line-by-line coverage or live freeze-resolution certification. Preserve existing original89 recovery ownership and the current released start hold.

A02 pre-push correctly refused a nullable-return TypeScript error; explicit null checks now compile successfully. The original failure is retained in scratch/push-a02.log. Focused behavioral tests cover zero-row move, zero-row rename, successful move and previously moved recovery; 27 service/contract tests passed. A further normal candidate check remains required.

Live Morning Free Buy d5decc98-cd0f-417f-aa28-6df009a74c76: nine playing entrants, eight active seats/87000 chips on table21870f63 and one active seat/3396000 chips on de2f1c82; latest recorded hands respectively14:25:34Z and19:08:57Z. F06 park6c0cf564 created19:09:02Z is park_requested revision0 with no custody. Protected main #8868 removes the unowned-park withdrawal deadlock; serving EED lacks that revision. Attribution remains pending actual runtime diagnostic41240628385. Configured environment token refused workflow dispatch403; native gh credential-store route with those environment overrides removed identifies the same Smarter-Poker account and successfully dispatched the existing read-only diagnostic. No secret read or credential replacement.

## Independent readback, 20:57 UTC

Resumption policies emitted/read 2026-10-31T20:53:19.509Z, version2.9 and unchanged hashes above. Full root instructions, CLAUDE, publishing, deploy paths and storage guide reread; shared-capacity is /dev/disk5s1 with available capacity. A02 head0829e5c9e033b4c3ed095b112796ec07a97a003e passed normal pre-push and is PR8958; hosted qualification pending. A01 PR8957 remains pending hosted checks. Native configured gh credential-store route works for the same Smarter-Poker identity; prior403 was specific to environment-token routing.

Morning Free Buy diagnostic41240628385 succeeded with stable EED runtime, complete bounded scan and no raw logs exported. Park probes repeatedly miss. Original hand52897657 retains all eight matching chair identities; four stacks differ by exactly10000 with subsequent funded addon receipts. Serving EED requires original stack equality, whereas protected PR8621 admits precisely proven funded changes. Existing OriginalControllerRuntime and chair-admission regression suites passed98 tests. This is a concrete deployment-dependent recovery acceptance case, not a claim that the event resumed. The active recovery owner remains chat01a190a0; no duplicate release or financial mutation.

The coercion defect reproduced in spinSettlementReceipt.ts is in an unused helper (only test imports). Active TournamentManagerBase calls readFundedSpinDraw in SpinDrawReceipt.ts, which requires strict numeric shortfall0 and exact stored contract. Do not describe the obsolete helper as a live settlement vulnerability. Further active-path inspection remains pending.

## A03: multi-day uncertain bag outcomes

Active multiDayStages.callStageRpc classified every five-character SQLSTATE as a definite failure. The real manager's attemptStageBag stops and re-reads durable state for unknown outcomes, but held a failed outcome indefinitely. Connection/intervention/resource/internal errors therefore bypassed that existing recovery. Extended real-prototype lifecycle tests reproduce seven failures before correction (08006,08007,53300,57014,57P01,58000,XX000); the shared isRolledBackStatementError classifier now preserves uncertainty. All58 lifecycle tests pass afterward, including four known-rollback controls and existing resume/bag boundaries. No currently BAGGED/DAY_ENDING/RESUMING production events were returned by the bounded read; no claim this caused the observed single-day freeze. Compilation and protected delivery pending.

A01 protected squash merged as b3c36f5ac96521f972bd009fe693de09de5a8210 after all hosted checks passed. Client publisher41241201125 queued; both endpoints and affected behavior pending.
