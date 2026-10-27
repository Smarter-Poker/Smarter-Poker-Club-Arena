# Tournament park grace survives manager custody changes

Scope: the original Trustmefold freeze and both tournament alerts; no unrelated gameplay or financial changes.

## Cause and maintained change

`server/src/tournament/TournamentManager.ts` kept the existing 60-second unproven-movement park grace solely in a manager-local map. A successor manager began the same park at zero elapsed time. A real manager/RPC regression reproduced that reset: the successor refused an otherwise eligible withdrawal after the original park had already existed for 60 seconds.

The private `smarter_private.f06_state(uuid)` formatter now exposes immutable `f06_operations.created_at` as optional `park_created_at`. The typed RPC decoder validates supplied timestamps. The manager measures the unchanged grace from this original timestamp. Old database contracts without the field retain their previous first-refusal grace. Malformed or future timestamps cannot accelerate withdrawal.

The timestamp grants no movement authority. The existing withdrawal transaction still re-proves the named movement refusal, unchanged lifecycle, custody, park revision, hand/roster conditions and absence of any begun move. Dealer stop/readmission still follows successful atomic withdrawal. There are no new timers, retries, sweepers or repair loops, and no chip or seat edits in the migration.

## Incident evidence and limits

Trustmefold played Lunch Rush (NLH Deep), `5eeaeeb2-575c-4993-97a4-7bafa8f52302`. At the screenshot second its tables were dealing; the exact visual symptom was not recoverable from the supplied one-pixel image. PR #8246 repaired the confirmed missed-break-end/reconnect presentation defect and has scoped live proof.

Both later alerts overlap Coffee Break Freeroll (PLO4), `bea3cc1b-6f18-4eb0-99f6-a73eacb474e0`; neither names Trustmefold's Lunch Rush. The other original cannot-deal findings were Diamond/Midway Midday FreeBuy, Sunday Deep Stack Satellite and Midday Turbo. Their retained logs show budget pressure. PR #8278 includes the earlier #8253 consolidation-admission, bounded preparation and original-park continuation corrections and is already included in serving engine bf0e33ae.

The October 27 Sunrise Bounty park `d569d659-f9ff-4849-a4eb-f9fb047b98a1` existed from 14:08 until five natural movements at 14:57 UTC. Its retained logs include two named whole-roster movement refusals and repeated bounded drain/bust pressure. This source regression proves the manager-reset defect; it does not prove that this defect alone caused the entire historical delay. The park completed naturally before this change and is not credited to it.

## Verification and delivery

The two-real-manager regression failed before the runtime correction. Afterward 46 focused cases and server TypeScript compilation passed, including old-contract compatibility, malformed/future timestamps, proven movement and unrelated refusal guards. Native PostgreSQL 17 qualification passed all 139 existing movement assertions, four exact-age/custody/admission/replay checks, atomic drift refusal and both stock concurrency cases; metadata installation left business/private rows unchanged and cleanup was confirmed. The existing CI runner enforces these assertions. Both compilers, 320 installer-contract cases and 19 maintenance-window cases passed. Exact protected installation/publication/live proof remain pending in the existing task checkpoint. No production test writes were made.

## Exact activation anchor

PR #8324 protected squash is `f398b67e4ffa1949b71d78fa60b17dc63cf0bba7`. Bind its existing one-use owner window to that actual repair, replacing the earlier minimum base anchor. Two separately owned older queued engine candidates contain the base and omit this repair; their activation must not consume this permission. The original 15:20:34 through 21:20:34 UTC interval, runtime, migration, checks and cutover safeguards are unchanged.

## Required-check binding recovery

The release-input follow-up exposed a stale workflow digest in the original-retirement source binding. Its exact previous-hash bytes were recovered from PR #8296 head `6cc1c1d3767b74cf05fe7cc0c4fdfdc2d36af611`. Protected integration preserved PR #8288's three rakeback-page qualification trigger paths and appended native check; the parsed workflow is otherwise identical. Updated only that workflow digest and recorded this provenance. All other 162 source pins, existing financial boundaries and assertions remain unchanged. The exact three-case law reproduced one failure before correction; afterward it and three connected source-contract files passed all 13 cases on Node 22. This metadata correction does not grant new financial or production qualification.
