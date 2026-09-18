# Pending busts survive a yielded tournament work cycle

Observed live on 2026-09-18 at 05:37 UTC: tournament fd04e940 had 60 zero-chip playing rows and 60 pending knockout candidates, while its original manager's registered scheduler entry was neither running, queued nor awaiting a delayed wake. No financial mutation was made for diagnosis.

The bust stage requests a bounded continuation, but later stages can consume that coalesced wake while the work cursor skips the already completed bust stage. Completing the remaining stages then resets the cursor and goes idle with unresolved busts. Existing tests stop at balancing and do not exercise this final scheduler transition.

Correction: retain whether the most recent authoritative bust read contained unresolved players across cursor yields. When the entire cycle completes, that existing causal obligation requests its next bounded pass. A fresh empty read clears it. Do not alter hand ordering, financial authorities, concurrency, or healthy-event scheduling. Extend the existing staged-sweep test through the real scheduler and assert it drains the original backlog without a new hand or external wake, then stops.

Validation: the new connected scheduler case failed on the unchanged source with five remaining busts instead of zero, without fixture errors. After the repair, 38 focused tests passed across staged fairness, interrupted stages, real scheduler concurrency and cursor behavior. Both TypeScript compilers passed. The regression also asserts 25 distinct recorded places, no premature tournament finish, no queued/pending work after drain, and no new runs over the next simulated minute. This is isolated engine-flow evidence, not a production financial certificate. Independent source review found no actionable issue. Hosted required checks and production identity/retained-cohort proof remain pending.

Real-time law: no client event change; the existing original hand/manager wake continues through the authoritative engine scheduler, with no new polling mechanism.
