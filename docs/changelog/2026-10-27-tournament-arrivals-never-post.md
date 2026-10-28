# Tournament arrivals never post an entry blind

## Scope and ownership

Owner request: stop tournament players moved to a new table from posting on the button or other non-blind positions. Preserve natural BB, legal SB including heads-up button/SB, antes, chip conservation and cash entry rules. Inspect arrival registration through the real deal and forced-bet event. No unrelated engine or migration work.

Owned branch: fix/tournament-no-arrival-post-20261027. Checkout: /Volumes/SmarterWork/agent-work/tournament-no-arrival-post-01a180b8/source. Operation owner: chat 01a180b8. Base: 94243abc83. No prior checkpoint for this assignment.

## Current source and repair

ServerTableEngineSeating.noteTournamentArrival marks button arrivals in mustPostBB. ServerTableEngineDealing then sends those seats into HandController.bbOnlyPosts, charging a live extra BB. TournamentArrivalPosting.test.ts and two DeadButtonEveryTableSize scenarios incorrectly require this charge. Remove the entry obligation at its producer and consumer, preserve natural blind rotation and test actual forced-bet records. Clear legacy in-memory markers without billing them.

TDA source checked 2026-10-27: https://www.pokertda.com/view-poker-tda-rules/ . New and broken-table entrants may receive the button, SB or BB; balancing uses next BB to worst position. Neither permits an extra entry blind on the button. Heads-up button/SB remains valid.

## Policy reading receipt

Read canonical four policies using agent-policy.mjs read at 2026-10-28T04:15:17.947Z, plus full hardening/index reread, root AGENTS/CLAUDE/playbook/publishing/deploy paths and relevant migration references. Canonical policy 2.9 manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b. OWNER b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349; OPERATING a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5; HARDENING d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e; INDEX adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555. Fresh origin/main recovered via owned worktree; shared checkout was 377 commits stale and was not changed. Read current instruction diff: October 25 main-only migration rule and October 27 common-opponent policy.

## Acceptance and delivery

Pending: before/after reproduction; focused real-deal tests for button/other positions, legal SB/BB and HU; stale-marker protection; cash regression; compiler and normal hook checks; protected merge; exact staged/activated engine and scoped live proof. Explicit urgent owner request permits considering existing emergency route with all certified drain/freeze/thaw/rollback safeguards retained. No live financial probes.

Access: configured GitHub CLI authenticates as Smarter-Poker. SSD mounted /dev/disk5s4, 2.0 GiB free before checkout; capacity monitored, no internal fallback. Evidence archive /dev/disk5s3 has 105 GiB free.

## Local results before submission

Canonical final-validation read at 2026-10-28T04:19:15.287Z emitted unchanged version/hashes above; portable check --canonical passes. Changed source reread and git diff --check passed. Real before-fix regression: 7 failures / 38 passes, including button arrival and stale markers; retained ../regression-before.log. After fix: 128 focused server tests passed across arrival law, real dead-button deals, balancer, HU and cash reentry. Matrix covers all arrivals at table sizes 2 through 9 with antes and exact pots, plus stale tournament/cash-entry/sitout markers in every six-handed seat. Server tsc --noEmit passed. Root tournament contracts and law registry: 1197 assertions passed. Normal CI server shards run npm test and therefore enforce the law and real-deal regressions.

Readback at 04:19Z: serving bf0e33aee46a342f977cba6bc7c10da3b2b2a03b remains healthy/idle; this fix is not live. Stage route automatic emergency criteria are dead liveness, whole fleet stalled or >=100 quarantined managers, none present. Existing unrelated owner windows are not authority to create a new break for this task. Continue all eligible checks and protected source delivery; actual activation admission remains separately evidenced.

## Submitted candidate and current external dependency

PR https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/8422 is mergeable at c873bcccfd28ff214dfe66eb7c880754ca0faa96, tree 2cfa3956919eed4b8f0e328127cd95c62cec9a69. Normal pre-push passed: 950 affected root assertions, 294 related root assertions, 95 changed engine assertions, 11 server source contracts, 4009 related engine assertions. Related engine suite reports 166 existing skips (not passing evidence); new regressions all executed. Both compilers passed. Exact hook receipt: private Git agent-policy-preflight.json. Evidence/log copies retained at /Volumes/SmarterArchives/agent-evidence/tournament-no-arrival-post-01a180b8/.

At 04:23Z, a bounded read-only sample of 2000 newest hand_history records contained 1439 tournament hands and five extra forced action=post rows, all on the recorded button seat. UTC sample 04:20:30–04:23:05. Hand IDs a9c4a5ec-542f-4380-9112-5343e59b8343, 1299c906-e4ce-47fe-adaf-6a34888763c8, ace7bd3e-a175-49b8-a4da-b15fa87cdee2, 3f2fa5f7-a252-49ba-9d39-597afecf9a3b, 73a24ffe-a3fb-49c6-9548-23fbd225195e. No production writes or synthetic financial probes. Live baseline is defective; no fix-live claim.

Required CI run 40631924465 (head c873bcccfd) is queued: jobs 122630046001, 122630046269, 122630046331 and 122630046378 request ubuntu-latest, with no assigned runner. Additional required money-trigger proof is pending. No failed check was bypassed, no other task cancelled, no second publisher created. Existing independently owned deploy 40630446641 targets prior 94243abc83 and does not contain this fix; do not certify it as delivery or compete with it. Next: inspect same CI operation; resolve actual failures, protected squash merge #8422 once qualified, recover exact staging/receiver ownership, verify containing engine and natural tournament forced-bet readback. Actual source activation still pending. This status update is intentionally left in the owned checkpoint until source/CI follow-up can include it without replacing the currently qualified head.

Latest provider readback: source bindings, trusted verifier execution and required Money trigger declaration authority are SUCCESS. Main CI 40631924465 remains QUEUED with required compiler/build/client/server/browser results not yet available. PR remains MERGEABLE but BLOCKED; current head unchanged. No source failure is known. Local source-bindings verification also passed all 1114 pins across 30 files. All currently executable implementation and local validation work is complete; remaining required hosted execution, protected merge, engine activation and live affected-behavior proof are outstanding.

## Continued ownership, October 27 23:32 Chicago

Owner explicitly directs finishing #8422 through passing required checks, merge, engine publication and live tournament posting proof; do not stop on queued checks. Fresh canonical reader 2026-10-28T04:32:53.361Z emitted policy 2.9 / unchanged manifest and file hashes already recorded above. Reread root instructions, full CLAUDE, playbook, publishing, deploy paths and this checkpoint. Owned source remains c873bcccfd; only checkpoint status is locally modified. SSD own disk still mounted with 856 MiB free and archive 105 GiB. All required source access remains configured. Same CI operation 40631924465 retained, no duplicate dispatch.

### Continuation evidence

Required source/repository compilation and chip-journal preflight, stub gate, native fixture smoke, and client test shards 1 and 3 have passed in original run 40631924465. Accounting shard 1 is executing; remaining selected shards are hosted-runner queued. No new source edit or duplicate CI dispatch. Deployment secret metadata confirms HETZNER_HOST, HETZNER_HOST_KEY and HETZNER_SSH_PRIVATE_KEY exist, with Actions enabled; no secret values read. Latest comparison run 40626423421 spent 8m25s in client shard 3, 7m17s in engine shard 3 and 35m17s in accounting shard 1; current queue and execution are recorded separately.

The post-deployment natural-arrival query is prepared in archived live-tournament-posting-proof.sql. Positive control before deployment: 3348 tournament hands, 68 inferred arrivals, 4 button arrivals, 6 forced entry posts, all 6 on the button, and normal SB/BB records present. Query compares each hand to its table's prior roster, uses started_at (not commit time) to exclude old-engine hands, and bounds input to 5000 newest records. It will be rerun only after proving the containing engine is serving; this control is not fix-live proof. A draft one-off owner-ordered window for the urgent observed gameplay defect is retained only in task scratch if the protected fix needs its own existing-route admission. It is not submitted or active and does not assert automatic liveness-degradation metrics.

### Required urgent release admission in #8422

While the original hosted checks run, source inspection proved routine pushes are not admitted off cycle, and the unrelated existing receiver still targets prior 94243abc83. To complete the owner's urgent, live-verified correction in this same PR, add one bounded entry to the existing owner-maintenance-windows.json, preserving every other byte/entry. It quotes the real direct owner request and the observed ongoing forced charges; it does not fabricate automatic degraded-health metrics. Its protected minimum anchor is bf33b5c4f32e3a57ec27b9090d208fe88d0e19aa (latest main, freshly absent from serving bf0e33ae and absent from the older receiver target); actual #8422 squash inclusion is separately mandatory. Expires 08:45Z before the daily 03:58 Chicago announcement. Existing safety gates, notice, drain, freeze, 285-second reserve, rolling-hour seal, once-served refusal and v3 thaw all remain enforced. No runtime release control is changed.

Merged current protected main into the owned branch with ordinary Git merge, preserving concurrent haptic and role-credit work. No instruction file changed. Final candidate needs the required checks again because release admission is a changed runtime input; obsolete checks on the replaced head may retire only through the existing bounded supersession path. No later activation-only PR or fake urgency commit trailer is used.

Final updated-candidate policy read 2026-10-28T05:06:50.831Z: full four canonical outputs read, unchanged policy 2.9, manifest and file hashes above. Local daily-maintenance admission, tournament source contracts and law registry passed 1210 assertions; window parses, is bounded below six hours, and preserves other entries. git diff --check passes. Normal hooks and exact-head hosted results still required on the updated candidate.
