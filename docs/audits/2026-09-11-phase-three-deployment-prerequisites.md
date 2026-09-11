# Phase Three Deployment Prerequisites

Tracked-source review for the 109-item accounting programme, CA-03-01 through CA-03-12. This note identifies release gates and dated adoption observations. It is not migration-application or browser proof.

## Current adoption update — September 11, 07:43–07:59 UTC

**The old timer-fix adoption prerequisite is closed. Overall engine HTTP readiness remains open.** Cache-busted public health and the approved database leader witness both identify `c58dfafd`, resolved to `c58dfafdc6902fb46b56441e9d20bd754a3eceb6`. At 07:45:46 UTC the leader heartbeat was 5.75 seconds old. Git ancestry proves this engine contains timer repair `999b57756ea68b6c243a909771add9a74a212ea7` and final-deal compatibility `52883bfde240a5790f31680bfef70b7cbd4f4bf0`. Both canonical frontend build-info URLs return `53edbd4d102206d5fa36e54d4d58090d9dffedd0`, built 07:30:53 UTC by run `34574538946`; GitHub compare proves that frontend is 13 commits ahead of, and contains, the observed engine source.

| Independent current witness              | Result                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Public health, 07:43:53 and 07:45:35 UTC | Same instance `1-941a631f`, HTTP 503, liveness `ok`, running true                                     |
| Per-table progression between samples    | 77 cash tables and 16 tournament tables advanced their hand identifiers                               |
| Public settlement / dealer fields        | Zero blocked settlements, stalled tables and dead stalls; settlement `ok`; dealer prerequisites ready |
| Public lease / cluster counters          | Zero claim errors, heartbeat errors, conflicts and latest cluster-pass errors                         |
| Equity worker pool                       | `failed`, zero ready workers, last error: operation timed out after 2500 ms                           |
| Live horse decision worker               | `ready`; separate from the failed equity pool                                                         |

The deployed source gives an exact explanation for HTTP 503: `server/src/GameServer.ts:3050–3056` requires the equity pool to be ready for top-level `status=ok`; `server/src/handlers/health.ts` uses that status for routing readiness. This failure is material and is not waived by hand progression. The pool's consumers are all-in equity and insurance in `ServerTableEngineRunout.ts`. Its failure paths omit optional equity and, for insurance, continue canonical paced runout only after current lifecycle/controller/hand checks (lines 2608–2620 and 2804–2822). It does not replace financial settlement or compute an invented payment.

No equity dependency was found in the inspected Stage B SQL, versioned consent activation or exact terminal RPC/review path. Thus the isolated equity service failure does not by itself prevent strengthening the database boundary once **all** Stage B native and live preflight, source pins, protocol-lease exclusions, active old-deal exclusions and quiet-window locks pass. This observation is not Stage B application evidence, and consent/browser and overall health verification remain separate.

The subsequent normal rollout `34571396262` / job `103176629394` targeting `3ab179ac220fefe643a6e75a29a9d00eb803307d` changed from in progress to completed/failure in the current read. Cutover steps 19–27 were skipped; “DID NOT DEPLOY” succeeded and the final verdict failed. Step summaries do not expose the exact refusal reason. GitHub compare shows only root-context/retention and blind-escalation server changes relative to c58; it contains no identified equity-pool repair. Do not claim a queued repair or duplicate its dispatch.

### Actual 06:56 cutover and remaining incident impact

Workflow `34567969674` succeeded after a **separately documented owner-approved frozen404 exception**, not a normal zero-unparked certificate. At 06:56:13.885 UTC it recorded 638 unparked tables, `readyForRestart=false`, and a durable countdown with 226 seconds left. It prepared the seal at 06:56:14.800 UTC and recorded target c58 shipped at 06:58:13.841 UTC (attempt 389). The tracked changelog `docs/changelog/2026-09-11-the-frozen-build-can-be-replaced.md` at frontend 53ed records Dan's 05:22 UTC one-time decision and subsequent removal of that spent exception. This agent did not execute the exception or directly witness that consent.

The current public progression independently establishes resumed dealing. It does **not** establish the durable receipt or reconciliation outcome of those 638 old frozen hands. Historic changelog claims of 1,927 tournament hands and zero callback/rebind/zombie errors were not independently remeasured here. The public `totalHandsDealt` wire field is not interpreted as a count of completed hands.

Automatic approval review rejected two further checks: retrieval of unknown production Docker logs, and a read-only hand-history/atomic-receipt aggregate query. Neither executed; neither was rerouted. Consequently exact recent private error counts and newly persisted atomic receipts remain unverified by this task. Existing exposed public counters above are the narrower evidence actually available.

The local recovery artifact is now historical. No hotpatch/native-recovery experiment is needed to establish adoption. The native financial bridge was **never executed** and its prepared inner stack/core composition does not match the 07:41 live pins supplied by the coordinator: public stack `e67e89b3aec325f8038e0507a1511eec`, pre-seat-exit alias absent, exact-before-obligations `457ad8f1e1528ad205f7bd43488f3e14`, lane `006d78a441e65d000d1d78929649bb44`. Seven local JS tests and captured RPC arguments remain explicitly non-durable evidence.

Machine observations and selected cutover lines are saved in `2026-09-11-phase-three-engine-adoption-current.json`. All sections below are dated historical observations unless expressly stated otherwise.

## Ordered Boundaries

1. Verify and apply the tested entry and terminal-v2 expansions through their reserved migrations. Preserve their exact source and metadata gates.
2. Prove compatible frontend and engine adoption. Read fresh public build-info and the database engine leader, resolve each observed version to a full commit, and verify required implementation commits are ancestors.
3. Run the complete `scripts/deploy/phase-three-strict-tournament-cutover.sql` only after its native acceptance and current production prerequisites pass. Reserve a new migration through `node scripts/new-migration.mjs "description"`. Production DDL remains one transaction and respects the current database break-window exclusion. No forced restart or lock retry loop.
4. Activate versioned final-deal consent separately with `scripts/deploy/phase-three-activate-versioned-final-deal.sql` after its expansion, native acceptance, and compatible frontend/engine adoption. Stage B does not install this proposal trigger.
5. Publish through normal hooks, CI, automatic PR merge, and the existing publisher. Verify both `https://ca-static.smarter.poker/build-info.json` and `https://smarter.poker/hub/club-arena/build-info.json` contain the accepted merge. Source, database, frontend, and engine evidence are separate.

## Stage B Prerequisites

| Authority                               | Accepted Body MD5 In Current Prepared Script                            |
| --------------------------------------- | ----------------------------------------------------------------------- |
| Stage A private request hook            | `ab227471f29f2944ebd64909622b6af7`                                      |
| Already contracted private request hook | `d21a055b448febe83c1637371b150100`                                      |
| `claim_tournament_lease_v2`             | `d1b5100c2b9f92bec5fd1680b0b4f230`                                      |
| `heartbeat_tournament_leases_v4`        | `5e6c99545e07c21efcb50e5cb3441c14`                                      |
| Mystery reveal                          | `5578ec53c8a531eeba47d448ae9af1b1`                                      |
| Terminal public wrapper                 | `96a61ea5e16560735bcb70b355aa79ab`                                      |
| Terminal private core                   | `90f7506df2f1a94fe22952714fcd9f85`                                      |
| Terminal receipt reader                 | `bb4b0e1d1c758943fca29f9a83d064e4`                                      |
| Place writer, before / contracted       | `d0262f4928b12eea1cc5e9175cbf2737` / `2fb9eb9761e248315f36df617e519512` |

The script additionally requires exact owner, security-definer, search-path and ACL contracts; complete final-deal-v2 functions; the atomic seat-first creator; absence of both legacy seat-first repair doors; all exact protocol-2 lease/launch/hand authorities; and exact-seat expansion markers. Its relation locks serialize the retirement boundary.

It refuses a fresh protocol-1 tournament lease (heartbeat within 30 seconds), any capacity origin without a canonical receipt, and active final-deal settlement/payment evidence in RUNNING or COMPLETING events. The protocol-1 lease check does not independently prove engine source ancestry. Do not treat it as an adoption substitute.

The transaction activates all seven financial guards, contracts the public obligation payer, installs the private PostgREST hook and four row-scope guards, and retires the legacy payout repair functions, dispatch rows, cron paths, lease doors, and nine/eleven-argument hand doors. Its postflight checks these boundaries before commit. Historical financial findings remain unchanged.

## Engine Dispatch And Evidence

The current `.github/workflows/auto-deploy-hetzner.yml` accepts `ref_sha`; it has no `force` input. A normal GitHub Actions dispatch uses this body:

```json
{ "ref": "main", "inputs": { "ref_sha": "<accepted merged full SHA>" } }
```

Submit to the repository Actions endpoint for `auto-deploy-hetzner.yml/dispatches` only when an equivalent active deployment does not already cover the target. It stages immediately and waits for the normal maintenance certificate. Do not send the older `force:false` input.

The authoritative adoption witness is a fresh `public.engine_leader.engine_version` heartbeat, matched to public engine health and source ancestry. The workflow's strict proof requires the database witness; a green workflow or staged image alone proves no adoption. `scripts/ci/prove-engine-version-moved.mjs` can send in-app notifications on failure, so it is not a read-only diagnostic command.

## Separate Consent Activation

The consent activation installs `require_exact_final_deal_proposal`, removes direct app-role vote writes, and retires the one-argument vote RPC. Its current bare `CREATE TRIGGER` is fresh-install-only. For any repeat-application rehearsal, first add exact, gated idempotence; do not skip or weaken the proposal requirement. The current engine calls the terminal/proposal RPCs and heartbeat v4, but only observed deployed ancestry certifies production compatibility.

## Live Adoption Observation, September 11 05:04 UTC

Read-only observation on the bound canonical endpoints, using cache-busting query parameters and no-cache request headers:

| Witness                               | Observed Result                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Static origin, 05:04:16 UTC           | HTTP 200; `ca_sha=a04495f6621e55af59fd7f10e90848415bd6bab4`; built `2026-09-11T04:49:26Z`                                          |
| Public Club Arena route, 05:04:14 UTC | HTTP 200; the same SHA and build timestamp                                                                                         |
| Public engine, 05:04:16 UTC           | HTTP 200; version `404948b3`; status, liveness and settlementStatus `ok`; running true; blockedSettlementCount 0; maintenance idle |
| Database leader                       | Boolean-only query confirmed `engine_version='404948b3'` and heartbeat within 60 seconds                                           |
| Tournament leases                     | Boolean-only query confirmed no protocol-1 heartbeat within 30 seconds and at least one protocol-2 heartbeat within 30 seconds     |

Local Git resolved the engine prefix to `404948b35478e18b81bd8633ebc88d69512b0aa8`. Both deployed source commits contain compatible deal review `52883bfde240a5790f31680bfef70b7cbd4f4bf0` (#4176), and overdue-clock correction `9762b5d164b866edd22b12ecac0fa766c4ba59b6` (#4203). At local HEAD `79ae87eb56b4f40312bdf9d01be7b7e12d826206`, the observed engine has byte-identical Git blobs for `terminalSettlementRpc.ts`, `tournamentLease.ts`, `TournamentManager.ts`, `tournamentSeatMoveRpc.ts`, and the client `TournamentService.ts`.

**At this 05:04 historical observation, strict-cutover adoption remained open.** The observed engine does not contain `999b57756ea68b6c243a909771add9a74a212ea7` (#4225, “the deadline clock belongs to no tournament”), merged at 04:26:43 UTC. Published frontend source `a04495f6` contains that commit, but this does not deploy its engine code. The repair changes these four files:

- `server/src/services/supabase/dataActorContext.ts`: creates the process-root AsyncResource and `bindToProcessRoot`.
- `server/src/engine/DeadlineScheduler.ts`: starts the common deadline timer in process-root context.
- `server/src/services/HorseHandReview.ts`: starts the common review-flush timer in process-root context.
- `server/src/engine/theDeadlineClockBelongsToNoTournament.test.ts`: covers isolation from the initiating tournament authority.

The source records the prior failure: lazily created process-wide timers inherited one manager's AsyncLocalStorage context, causing authority-rebind errors and incorrect tournament headers on unrelated callbacks. This historical source finding is not a fresh count of affected live tables. A normal engine deployment containing #4225, followed by fresh database/public health and ancestry evidence, is required before treating the current strict manager boundary as adopted.

The local Phase 3 commits `be58026c0d8f8fab554ffc88ead90c99d542fcea`, `fc6172626360f581d4e70df6cfa7c376d410c741`, and `c699f297cc1ba4b394b60a392b07e12595aba10a` are absent from both observed deployed source commits. They change no files under `server/` or `src/`; their publication remains necessary, while database application is verified independently. Their absent ancestry alone does not imply an additional engine binary change.

## Earlier Direct Credential Read Was Blocked

Automatic approval review rejected the requested read of GitHub Actions workflow runs using the configured credential from the canonical repository `.env`. The command did not execute. The stated reason was that direct private credential access followed by an external API request was not sufficiently specifically authorized. No token was exposed, alternate authentication attempted, dispatch submitted, or production state changed.

At that point active deployment status was unknown. The standard GitHub connector later established the active compatible rollout below without accessing the private credential file. No duplicate dispatch was submitted. The required target must include #4225; staging alone does not close engine adoption.

## Active Compatible Engine Deployment, September 11 05:21 UTC

The standard GitHub connector confirms workflow run `34564131192`, job `103152656633` (Deploy to Hetzner), remains in progress. The release coordinator observed its target `a04495f6621e55af59fd7f10e90848415bd6bab4`, containing timer authority repair #4225. No duplicate dispatch is needed.

| Gate                                                              | Observed Job State |
| ----------------------------------------------------------------- | ------------------ |
| Server tests                                                      | Succeeded          |
| Preflight and exact target checkout                               | Succeeded          |
| Immutable image build or staged-image adoption                    | Succeeded          |
| Supervisor refresh and single-engine check                        | Succeeded          |
| Step 18, wait for maintenance to park every table                 | In Progress        |
| Sealed cutover, new-image start and liveness/version verification | Pending            |
| Fresh database version proof and release-seal commit              | Pending            |

At 05:14 UTC, the job-log endpoint returned `404 BlobNotFound` while the job was running. Step status directly establishes its maintenance wait; unavailable logs prove neither failure nor adoption.

The current tracked workflow gives the job 130 minutes and reserves 540 seconds for cutover, verification and proof. Its normal gate derives the deadline from the next UTC minute :56 plus 90 seconds, polling every 15 seconds. The full restart certificate requires active maintenance, `phase=counting_down`, durable confirmation, `readyForRestart=true`, zero unparked tables, and at least 180 seconds remaining. With the observed 04:57:37 UTC start, the 05:55 window fits comfortably within the normal job budget. This is a calculation from the tracked gate and reported start, not evidence that the tables have already parked. The one-use sealed authority and cutover steps remain pending. Recheck completion and fresh database/public witnesses after the normal gate opens; do not bypass it.

## The 05:55 Window Did Not Deploy

The completed GitHub Actions log supersedes the earlier in-progress observation. Run `34564131192`, job `103152656633`, targeting `a04495f6621e55af59fd7f10e90848415bd6bab4`, completed with failure at 05:57:48 UTC. Server tests, preflight, immutable image staging, supervisor and single-engine checks passed. The maintenance gate never received a complete certificate. Sealed authority, cutover, version verification, database proof and release-seal steps were skipped. Attempt 388 recorded `shipped=false`; no engine adoption occurred.

| UTC      | Gate observation                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------- |
| 05:53:07 | 644 unparked tables                                                                               |
| 05:54:08 | Count settled at 620                                                                              |
| 05:55:10 | Active counting-down maintenance, durable confirmation, 289 seconds left, 620 unparked, not ready |
| 05:56:58 | 181 seconds left, still 620 unparked                                                              |
| 05:57:29 | 150 seconds left, still 620 unparked                                                              |
| 05:57:44 | Normal gate deadline expired without certificate                                                  |

Public no-cache health independently observed 620 unparked at 05:55:51, 05:56:49 and 05:59:15, still on `404948b3`. Maintenance ended normally by 06:00:25, with all eight resume waves and 930 tables resumed. The original rollout automatically dispatched successor `34567969674`, job `103163889357`; its latest observed state was server tests, step 9, in progress. No manual duplicate dispatch was submitted.

A zero `handsInFlightTotal` value during this break is **not** proof of zero real hands. The live source computes this heuristic from recently progressing, dealable, non-paused liveness entries. Maintenance marks tables paused, excluding them from that heuristic. The actual restart gate uses `isBetweenHands()`, whose predicate is exactly `handController === null`; its 620 non-null controllers must be honored.

The 05:55 boolean-only production preflight reported: target `a04495f6` fresh database leader false; previous `404948b3` fresh leader true; no fresh protocol-1 tournament lease true; no active RUNNING/COMPLETING tournament final-deal batch, receipt, obligation or payout evidence true; exact Stage A hook true; exact Stage B hook false. These are timestamped readiness observations, not substitutes for engine adoption or Stage B application.

The missing #4225 repair is a source-supported explanation for controllers failing to finish, still requiring live runtime evidence. The shared scheduler starts inside the first tournament manager's context. All tournament engine methods are authority-bound, so callbacks for another manager can throw before a hand action or heartbeat rearm completes. The normal table watchdog itself runs from that same scheduler and cannot be assumed to repair a lost heartbeat. The router exposes no maintenance-request or scheduler-repair endpoint. Reannouncing maintenance during an active break returns without effect; admin pause/resume only changes dealing holds. `DeadlineScheduler.tickNow()` is used only by tests. No fault injection, debugger mutation, hand-gate override, restart or release-seal bypass was performed.

## Live Timer-Authority Failure Confirmed at 06:09 UTC

The tracked runbook's normal SSH host, `root@engine.smarter.poker`, was reachable using existing configured SSH authentication without opening credential files. A read-only aggregate of `docker logs --since 30m --timestamps club-arena-engine` completed successfully at 06:09:43 UTC. Only aggregate counts and first/last timestamps were returned; no raw player, credential or hand data was exported.

| Log text                                            | Occurrences in the preceding 30 minutes |
| --------------------------------------------------- | --------------------------------------: |
| Exact cross-manager authority-rebind error          |                                  49,308 |
| `DeadlineScheduler.callback_threw`                  |                                   4,048 |
| `PreciseActionTimer.Expiry_callback_error_for_dlta` |                                   4,684 |
| `heartbeat_tick_threw`                              |                                   4,063 |
| `tournament_table_zombie`                           |                                   4,114 |
| `zombie_engine_rebuilt`                             |                                   4,109 |
| `watchdog_turn_stalled`                             |                                       0 |

The authority and scheduler exceptions occurred from 05:39:37 through 06:09:35 UTC, including after maintenance resumed. These are text occurrences, not counts of distinct incidents or tables. They confirm the precise live exception described by the missing #4225 source repair. The process-wide timer remains bound to a tournament manager despite table rebuilds. The table watchdog depends on that timer, and repeated generation rebuilds therefore do not establish recovery. No existing routed operation was found that repairs this process timer while retaining the real controllers and their deadline heap. A second unchanged maintenance window cannot be assumed to succeed. The normal successor rollout remains the only deployment attempt; no production mutation or cutover override was performed by this investigation.

## Supported Recovery Controls Were Enumerated

The following inspected control implementations have byte-identical Git blobs on the observed live engine `404948b3` and local source: `router.ts`, `handlers/action.ts`, `handlers/admin.ts`, `handlers/heartbeat.ts`, `transport/EngineWebSocketServer.ts`, `engine/ServerTableEngineTurns.ts`, and `index.ts`.

| Existing interface                   | Actual behavior relevant to this failure                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /action`                       | Sole action ingress. Actor comes only from the verified caller JWT. No admin or internal-key action-on-behalf path exists. An operator cannot act as the current horse.          |
| `POST /heartbeat`                    | Updates the authenticated player's connection, rendered-turn and rebuy-prompt signals. Does not tick the scheduler or invoke a canonical timeout. Spectators do not gain a seat. |
| `POST /admin/pause`, `/admin/resume` | Changes next-hand holds. Does not advance the current controller or repair its timer.                                                                                            |
| `POST /admin/kick`                   | Departure control, explicitly refuses tournament entries. Not a timeout or recovery primitive.                                                                                   |
| Table WebSocket messages             | Subscribe, unsubscribe, resync and pong; action submissions are not accepted.                                                                                                    |
| `POST /admin/inject-fault`           | Requires an already-between-hands boundary. It cannot rescue an active controller.                                                                                               |
| Ten-minute hand safety timeout       | Raw per-hand timer detaches and releases a timed-out hand without canonical settlement. It cannot be treated as successful hand completion.                                      |
| `SIGINT` / `SIGTERM`                 | Begins process shutdown and ownership release, exits on success, and exits fatally after a 40-second deadline. Not a separate non-exiting hand-drain operation.                  |

No supported routed command was found that can execute the stalled horse hands' canonical timeout/action handling outside the broken shared scheduler while preserving the current hand, break and release-seal requirements. No production action was attempted. Recovery cannot honestly be represented as a matter of waiting for the next unchanged window. Introducing a new recovery interface, runtime mutation, restart override, or table cancellation is outside this investigation's authorization.

The successor run `34567969674` subsequently passed server tests, preflight and staging, and entered the same step 18 maintenance wait. Its sealed cutover and adoption proofs remain pending.

## Recovery Decision and Minimum Preconditions

**Decision: preserve the real hand boundary and release seal. Recovery is not complete and no production recovery operation is presently authorized or execution-ready.** The already queued deployment does not repair the running process. There is no supported administrative operation in the observed live build that supplies the missing timer execution context.

A finite recovery direction, subject to a separate reviewed implementation and explicit incident authorization, is a narrowly scoped **in-process scheduler-context repair before the freeze**, followed by the existing canonical timers/watchdog completing the actual hands and the existing queued deployment obtaining its genuine maintenance certificate. This changes the way the process-wide clock enters callbacks, preserving each tournament method's own authority check. It must not grant one manager another manager's authority, clear controllers, edit chips, synthesize receipts, terminate the process, replace the image or modify the release seal. This is a proposed incident direction, not a tested command or an available admin endpoint.

The required exception is to the workflow-only live-engine mutation rule in `docs/laws.d/tests-engine-release-seal.md` and to this session's explicit prohibition on hotpatch/inspector intervention. The exception would need to identify the exact reviewed repair artifact and narrowly allow only its live process control intervention. **No exception to protecting horse and human hands, the freeze, the six-part restart certificate, immutable cutover authority or database adoption proof is proposed.** No such exception has been requested or exercised by this investigation.

Minimum prerequisites for an executable repair are:

1. Pin the running image, build and fresh leader to the observed `404948b3` generation, and compare the exact three affected runtime modules against repair commit `999b57756ea68b6c243a909771add9a74a212ea7`. A changed process or version invalidates the intervention plan. Keep the existing release seal and queued run unchanged.
2. Reproduce the actual failure in a disposable engine using the old source: one tournament creates the shared timer, callbacks for other managers fail, a deadline is popped, and a heartbeat fails to rearm. Prove the proposed repair on that state, including multiple tournament authorities and cash callbacks. A test in which every timer is still queued does not reproduce this incident.
3. Preserve the existing scheduler heap and per-controller ownership. `DeadlineScheduler.stop()` clears the heap and is therefore not a valid repair operation. Binding future ticks alone is insufficient: failed callbacks have already been removed from the heap, and `PreciseActionTimer.onExpired()` deletes its deadline before invoking a failing expiry callback. Lost heartbeat/clock ownership must be recovered through the engine's canonical current-generation logic, with stale owners and duplicate work rejected.
4. Prove canonical timer/watchdog completion without voiding a hand, changing its actor, extending or burning protected deadlines, spending a time bank twice, repeating a runout payout, or advancing a stale controller. Any condition needing a destructive watchdog tier or lacking reconstructable canonical timeout state must remain blocked; it is not covered by the proposed exception.
5. Preserve all pause owners independently and do no recovery money/seat work inside the database freeze. `CLAUDE.md` section 13 requires freeze-aware clocks and owner-specific resume. A table row's `status='paused'` is not a valid recovery fence. The normal maintenance coordinator must produce its own real parked certificate.
6. Before allowing the queued workflow to cut over, prove actual `HAND_COMPLETE`/canonical accepted settlement and all owned writers drained. `ServerTableEngineBase.performStop()` joins the captured dealing-loop generation, drains settlement/post-hand/move writers to a fixed point, and joins accepted seat-boundary work. An elapsed timeout, a health heuristic or `running=false` cannot replace that proof. The existing six-part certificate and one-use authority remain mandatory.
7. After the ordinary cutover, require the immutable target image and clean release seal, public version witness, fresh database leader version, compatible ancestry and disappearance of the cross-manager timer exceptions. An image merely staged on the host or an Actions step marked successful is not adoption.

A restart with promised snapshot recovery is not an equivalent safe alternative. The inspected live source says snapshots omit the deck, `rehydrate()` is not called, and `checkCrashRecovery()` abandons in-flight hands (`ServerTableEngineBase.ts`, crash recovery helpers). Likewise, the ten-minute safety timeout detaches a hand without canonical settlement. Neither can support a claim that all real hands were completed.

Until the exact incident repair exists, passes these proofs and receives the specifically scoped exception, the truthful state is **live recovery blocked by a missing supported control**, with compatible immutable code already staged and the ordinary deployment gate correctly refusing an unsafe cutover.

## Local incident recovery review prepared

The exact-old regression suite now reaches the real HAND_COMPLETE native RPC payload with 7 passing local tests, preserving the pending durable barrier. The current native bridge and optional actual-receipt consumption mode are described in [timer recovery review](2026-09-11-phase-three-timer-recovery-review.md). This is local evidence only; live recovery and engine adoption remain blocked until the stated prerequisites are met.
