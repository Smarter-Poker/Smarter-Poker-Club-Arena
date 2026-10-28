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
