# Diamond Phase 6 Shared Cash Integration

Status: Published, Adopted And Accepted. Public Funded Diamond Games Remain Closed.

The dated sections below keep their original wording as history, including their statements that publication or acceptance was still open at the time they were written. The closing section records the authenticated live acceptance, the one defect it found, that defect's repair and publication, and the Phase 6 closure.

## What Changed

The existing Club Arena buy-in, accepted-hand, occupancy cash-out and shared table UI now have an authoritative Diamond branch. Seat funding reserves existing Diamond custody and binds the database-stamped seat generation. The accepted-hand transaction retains the shared lease, history, time-bank, projection and immutable replay protocol while moving whole Diamond custody balances and consuming only actual purchased-lot losses. Cash-out releases the settled balance, including zero, without a fabricated wallet journal.

The engine refuses unsupported configurations and deductions. Chip add-ons, continuity, promo, jackpots, mission events and horse funding do not process Diamond games. Pending leave keeps the shared exact-occupancy path. Admission and engine validation agree on whole monetary table settings and the shared running status.

The client uses the shared table route and immutable buy-in recovery door, reads Diamond available balances, carries the actual arena asset through result/history views and recovers a deferred result from an authenticated exact-occupancy Diamond receipt. Unknown history assets do not enter monetary totals. No new dealer or wallet writer was introduced.

## Approved Database Changes

The following source migrations were applied once in order, after exact user approval and a fresh prerequisite check. Their actual production versions are recorded below; do not reapply them:

1. `20260910022036_diamond_cash_custody_settles_exact_seat_generations.sql`
2. `20260910023541_diamond_cash_admission_binds_existing_purchase_receipts.sql`
3. `20260910030442_diamond_accepted_hands_retain_history_without_chip_obligatio.sql`

The first adds seat identity, consumed purchase-lot holds and append-only hand receipts, and updates custody settlement/release. The second connects the existing buy-in/cash-out doors, enforces seat/custody consistency, adds the default-false admission setting and authenticated read-only access/result responses. The third connects Diamond acceptance and projection to the existing protocol without chip or hierarchy obligations.

These migrations change production financial functions. The earlier attempt was rejected pending exact approval; no alternate write path was used. The user subsequently approved all three named migrations, and the normal Supabase migration tool applied them successfully. The fresh production preflight found no custody rows and all twelve prerequisites matched the tested source.

## Verification And Remaining Gates

Isolated admission certification passed 74 assertions, including its 38 custody prerequisites. It covers concurrent authenticated purchase replay, revoked/wrong-user sessions, maintenance, fractional table configuration refusal before funding, final occupancy binding, failure rollback, partial-pot conservation, exact cash-out replay, and authenticated own-receipt recovery.

The separate accepted-hand database passed 48 assertions, including 27 accepted-protocol checks and 21 inherited custody bootstrap checks. These cover concurrent replay, exact lease/generation fencing, custody/history/time-bank rollback, projection rollback/recovery, canonical history/index retention and refusal of chip, mission and special-award obligations. Counts from separate suites overlap and must not be added as distinct assertions.

Engine/client test and build evidence is finalized below after the integrated checks. The earlier foundation PR 4088 CI 34430999353 failed at the unapplied-migration gate. Its client/server checks passed; that does not turn the failed gate into success. Do not rerun until the actual migration and schema evidence have been updated.

No public funded game was enabled. `cash_games_enabled` defaults false. The existing accounting release condition is unchanged. Production application is verified below. Required CI, normal merge/publication, actual frontend/engine ancestry and permitted live acceptance remain open. Phase 6 is not declared complete and Phase 7 is not declared ready.

## Integrated Local Evidence

- Client funding/access/financial-event cases: 22 passed. History/result cases: 85 passed. Existing chip-continuity and unknown-balance compatibility cases: 17 passed.
- Initial focused engine cases: 172 passed without skips. Latest integrated run: 59 passed across Diamond accepted-hand pipeline, Diamond config, horse funding boundary, restart behavior and occupancy leave behavior. Eight cases overlap the earlier run; do not add these runs as distinct totals.
- Final server TypeScript passed. The client production build passed TypeScript, bundling and media/font processing. Its provenance correctly warned that the development branch was behind main and dirty, so this local artifact is not publication evidence. Main integration and normal pipeline checks follow.
- No generated production artifact was uploaded manually. Git operations target this exact isolated worktree; the shared repository's bare setting was not changed.

## Main Integration Proof

The completed implementation is commit `26c006880c`, consolidated into the existing Phase 6 foundation branch for PR 4088. Latest main and the normal autopilot branch update merged without conflicts as `dad35dfeeb`. The subsequent complete client build passed on that clean source, with build provenance `behind-main=0`. Final server TypeScript passed after integration. The 14 merge-specific next-hand, tournament-blind and Diamond accepted-hand cases passed. The earlier dirty development build was not used as release proof.

Production application is now authorized and verified as recorded below. The earlier failed migration gate remains historical evidence; a new source push with a production-backed schema fragment must pass the normal gates. No engine/container/tag/host checkout changes or Stage-B tournament DDL were performed by this Diamond task.

## Required Push Regression Repairs

The first full integration push was refused by the normal regression hook; it was not published. The engine table SELECT now preserves the existing contract parser prefix without removing any loaded field, and its 48 focused contract cases passed. The shared client cash-out door no longer performs a second occupancy read before submitting leave. Instead, SeatLeaveIntent returns the original occupancy already verified against the engine protocol, and both normal and forced departure summaries retain it. The chip-only buy-in floor RPC and error reporting remain explicit, and callback fixtures supply the authoritative chip identity required by the new funding boundary.

The repaired client run passed 72 cases across cashBuyInCallbackRecovery (19), SeatLeaveIntent (18), seatFirstAuditRound7 (15), theDoorIsNeverLocked (15), and diamondTableFunding (5). Exact receipt cases include deferred leave, response loss followed by reseating, and confirmed zero cash-out. The removed helper's test was replaced by receipt-boundary coverage, rather than retaining a redundant network query. Re-read and diff whitespace checks passed. Integrated TypeScript/build and the required normal push checks follow; these focused results do not claim publication.

The final lobby wiring adds a registered, per-instance, club-filtered database subscription. Remote table updates, reconnection and visibility/focus reconciliation refresh the authoritative inventory, coalescing event bursts. No interval polling was added. Three rendered-component cases passed for remote occupancy updates, reconnection/visibility and cleanup. The shared hook retains subscription ownership and recovery.

## Final Repair Integration

The leave-flow, engine SELECT and cross-device lobby repairs are committed as `5290cac1c9`. Current main's lobby inventory repair merged as `71f57c9585`, preserving the other release's shared lobby behavior. `npm run build` completed on this clean source with `behind-main=0`, and server TypeScript passed. Media processing reported 480 optimized and zero failures. No manual upload or engine restart was performed.

A fresh read-only production prerequisite check found that the shared 12-argument accepted-hand wrapper now uses the table-aware settlement lane. Its source fingerprint differs from the earlier fixture. The Phase 6 migration must preserve that current lane behavior before application; simply changing the expected fingerprint is insufficient. The other inspected migration prerequisites still match. Controlled multi-user play connected through the actual engine and local database is being completed separately from the earlier component checks. Production application and final live acceptance remain open.

## Connected Isolated Play Certification

`python3 tests/sql/run-diamond-controlled-play.py` passed with exit code zero using only the fixed local socket and dedicated `poker_diamond_phase6_play_test` database. Two authenticated immutable purchases reserved 100 Diamonds each. The actual shared HandController performed legal all-in actions and produced stacks `[200, 0]`. Those exact output facts entered the real twelve-argument SQL accepted-hand transaction, projected both players' histories, then used the actual occupancy cash-out functions.

The final wallets were `[1100, 900]`, preserving the initial 2000 Diamonds, with zero remaining custody and no live seats. Purchase, accepted-hand and cash-out response-loss retries did not duplicate funding, settlement or payment. The zero-balance player's authenticated own-receipt returned zero. No chip membership or mint writes occurred, and Diamond movement journals netted to zero. Existing side-pot, tie, disconnect and restart cases are reused from the focused suites; this connected case does not repeat them. The driver mocks only external alert/report delivery, not gameplay, database acceptance or custody writers.

This closes the connected local play evidence gap. It is not a browser/WebSocket transport certificate or proof of production application and publication. Public `cash_games_enabled` remains false in production; it was enabled only inside this isolated fixture.

The settlement-lane compatibility repair is now complete: the pending migration preserves the inspected production helper, its exact body preflight, and current private execution grants. The accepted-hand runner passed 50 assertions (the previous 48 plus two actual lock-ownership checks). See [the settlement-lane evidence](2026-09-10-diamond-phase-6-settlement-lane-compatibility.md). The connected-play run above used these updated prerequisites. This closes the local source-compatibility gate. Subsequent approved production application is recorded below.

The normal integration push then exposed four exact-return expectations in TableService.cashoutReceipt that had not included the newly returned verified occupancy ID. All four now assert that identity while retaining their original amounts, deferred state, logging-failure and tournament protections. All 18 TableService receipt cases passed. No runtime change was needed. The normal push hook is rerun because it is a required gate, not an optional duplicate test pass.

## Approved Production Application And Schema Evidence

On September 10, 2026 at 05:01-05:02 UTC the user-approved source from commit c73b2ce871b32909908fa68600c943571bb39ccb was applied through the normal Supabase migration tool to kuklfnapbkmacvwxktbh, once per migration.

| Source Version | Actual Production Version | Name                                                         |
| -------------- | ------------------------- | ------------------------------------------------------------ |
| 20260910022036 | 20260910050142            | diamond_cash_custody_settles_exact_seat_generations          |
| 20260910023541 | 20260910050156            | diamond_cash_admission_binds_existing_purchase_receipts      |
| 20260910030442 | 20260910050209            | diamond_accepted_hands_retain_history_without_chip_obligatio |

The source files remain byte-identical to the approved SQL. The repository records applied migrations by exact name as well as version, so their original filenames are retained. Do not reapply them.

Read-only post-application verification matched all 18 affected public function body MD5s to the approved source. The seat-binding and append-only hand-receipt triggers are enabled; the seat/custody constraint is enabled and initially deferred. The new hand-receipt table has RLS enabled. The own cash-out receipt is executable by authenticated users, not anon or service_role; the internal whole-hand settlement function is owner-only. New custody identity, consumed-lot, receipt and admission columns exist. No custody rows existed, and cash_games_enabled remains false. No player balance, seat or public admission setting was modified during verification.

The production-backed schema declaration is scripts/ci/schema-manifest.d/codex-diamond-phase-6.json, following the repository's fragment policy. No shared snapshot, missing-RPC allowlist or CI protection was edited.

CI 34438319928 on c73b2ce871 passed 18,590 client tests, 8,560 server tests with 145 skipped, PostgreSQL accounting, server TypeScript, production build/performance and browser suites of 150 CSS, 13 Studio and 3 mobile cases. Client TypeScript compilation passed; the subsequent phantom-RPC gate failed because fn_poker_diamond_cashout_receipt had not yet been applied or declared. Later schema checks and live/postdeploy checks were skipped, not passed. The approved application and schema declaration address that concrete failed gate; required CI must pass on the subsequent pushed head.

Phase 6 release remains open until required CI, normal merge/publication, actual frontend and engine adoption, and permitted authenticated live acceptance are verified. Public funded games remain closed, and the seven-clean-day public accounting prerequisite is unchanged.

## Required CI And Normal Release Dispatch

PR [4088](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/4088) auto-merged September 10, 2026 at 05:40:25 UTC as 85da6479df7286673a2ace057a6988b7e4c18111, from 2ea518146b0f5c05493533d3895d39227df63b9f. Final required [CI 34440835759](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34440835759) completed successfully.

- Client: 18,616 passed across four shards (5,567 + 4,542 + 4,400 + 4,107).
- Server: 8,626 passed, 145 skipped. The separate 99 freeze/watchdog cases overlap and are not added.
- Client/server TypeScript, schema/invariant gates, PostgreSQL accounting and production build/performance passed.
- Browser: 150 CSS, 13 Studio and 3 mobile cases passed.
- Live Production E2E and Post-Deploy Verification were skipped, not passed.

The intermediate 2bda391a8d run 34440735496 lost a PostgreSQL shared-memory segment (58P01) in its unchanged agent-context probe. Its failing probe and caller had identical Git blobs to the passing prior run. A targeted retry was initially held by automatic review, then the API refused it while the workflow was still running. No retry executed. Autopilot advanced the branch instead; the final head passed the same 82 agent-context assertions at 05:27:20 UTC and all required gates. The superseded failure was not hidden, allowlisted or called a pass.

The normal Club Arena frontend publisher [34442016349](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34442016349) was queued automatically for the merge. The engine still served healthy c4163531 with zero blocked settlements at the 05:30 UTC read; this predates the full Phase 6 integration.

After verifying that no engine run targeted a Phase 6-containing commit, the normal auto-deploy-hetzner.yml workflow was dispatched once on main with ref_sha=85da6479df7286673a2ace057a6988b7e4c18111. [Run 34442107723](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34442107723) was created at 05:41:53 UTC and is pending behind the existing shared deployment. No shared run was canceled, and no engine restart, host checkout, container or tag was changed manually. Dispatch and staging do not establish production adoption.

The managed authenticated browser could create a verification tab but repeatedly timed out while refreshing tab state, navigating, reading the visible DOM and requesting a screenshot. The same documented browser binding was preserved; no external control workaround or player mutation was attempted. This is an unverified live-acceptance gate, not proof of an application regression.

Only actual publisher/engine adoption and permitted authenticated live acceptance remain open after the verified database application, source integration and required CI. The public admission setting remains false. Do not mark Phase 6 complete or begin Phase 7 until deployment and live verification pass.

## Frontend Adoption And Replacement Engine Deployment

At September 10, 2026, 06:55:30 UTC the static origin and at 06:55:33 UTC the World Hub rewrite returned HTTP 200 with the same ca_sha, 5b7469a5cedcb7ca80f83a637189508b8f88a2b7, built at 06:47:57 UTC by [publisher 34446674865](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34446674865). GitHub comparison proves this served commit is ahead 16, behind zero from implementation 85da6479, and ahead 10, behind zero from documentation merge 871e491a; each merge base is the named required commit. Both source and previously merged release documentation are published.

The original engine run 34442107723 failed at 05:57:53 UTC before staging: its deployment-control revision no longer equaled current main after queueing. It did not deploy Phase 6. A subsequent Mac dispatch request timed out, so its outcome was not assumed and no blind duplicate was sent. [Replacement run 34445622542](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34445622542), created 06:32:01 UTC, passed current control staging, server tests, preflight and immutable image build. The production deploy-start record independently identifies its target as 06887cc30efabd12b6611c6ca9649ee7cbb2535c, recorded at 06:32:54 UTC. GitHub ancestry proves that target is ahead 13, behind zero from Phase 6 merge 85da6479. This is target and staging evidence, not adoption.

At 06:56:05 UTC production health still identified 56962e04, with HTTP 200, status/liveness/settlementStatus ok and zero blocked settlements. At 06:57:46 UTC the replacement finished without deploying: all 57 maintenance polls saw inactive/idle state and no durable restart certificate. Cutover, runtime verification, promotion and release sealing were skipped. The workflow's nominal success is not deployment success. Read-only production inspection found no current engine_maintenance_break row and no 06:55 break log. The last recorded break was 05:55-06:00, with thaw_ok true but ready_for_restart_at null. These facts establish the missing certificate, not its underlying cause. No shared deployment was canceled and no maintenance protection was bypassed.

Desktop Commander resumed responding after reconnect, but the separate managed browser still returned `CDP operation refresh tabs timed out after 20000ms` before usable page state. Its existing binding was preserved and its advertised browser recovery capabilities were empty. Required authenticated route acceptance remains unverified, with no application defect inferred from that service failure. No production player, seat, balance or admission setting was changed. No completed implementation test was rerun solely to repeat prior evidence. Phase 6 remains open and Phase 7 has not started.

## Maintenance Compatibility Dependency

Narrow read-only engine logs establish the failed declaration: September 10 at 06:53:00.028 UTC announcement began for 493 tables; at 06:53:05.803 the canceled declaration resumed 492 tables; at 06:53:11.049 clearing the boundary reported a lock timeout, followed by the announcement persistence reporting the same failure. Both ownership-fenced RPCs acquire the exclusive admission boundary at advisory key (530090, 1). No transaction was canceled or modified during this investigation.

Production fn_save_engine_maintenance_break and fn_clear_engine_maintenance_break have statement_timeout 6s and lock_timeout 5s. Stored statements for already-applied migration 20260909180615, maintenance_ownership_fits_process_lifetime, explicitly require these limits to keep mutations within the owning process and its eight-second transport lifetime. Its comment expects declaration retries until the original fixed :55 boundary. The older main source's 45s/40s configuration must not be restored: it could outlive process ownership.

The matching source is already present in [draft PR 3908](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/3908), agent/codex-live-realtime/stage-b-v2, inspected head 3eed8d571180d93c7d371baba46f5035000b7d30. Its persistLastHandUntilBoundary retries the same declaration and lifecycle generation with a bounded delay until announcedAt plus 120 seconds. It integrates ambiguous-write recovery, lifecycle fencing and the dedicated eight-second maintenance transport. The retry is not an independent snippet that can safely be transplanted without those protections. The applied migration and matching engine work originated together in that existing owner branch.

At the historical inspection PR 3908 was draft, open and mergeable false. Its reconciliation belongs to the existing shared maintenance work. No copy of its migration, second retry implementation, relaxed timeout, manual release seal or forced restart was introduced. The later successful normal cutover below proves that this draft PR is not an absolute blocker to Phase 6 engine adoption. The prior missing-certificate observations remain historical evidence.

## Verified Engine Adoption

Normal [deployment 34449341468](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34449341468), job 102781237201, completed September 10, 2026 at 07:57:09 UTC. Its exact target was 86aab0e645b1842e83fca808cf956c9733af66ba. GitHub comparison from implementation merge 85da6479 reports ahead 24, behind zero and that exact merge base.

- A valid maintenance certificate appeared at the normal 07:55 boundary.
- Actual image replacement occurred at 07:55:59.196 UTC.
- Container version and liveness verification passed at 07:56:52 UTC; the public hostname served 86aab0e6 at 07:56:53.315 UTC.
- At 07:56:55.221 UTC engine_leader proved movement from 56962e04 to 86aab0e6, with a five-second heartbeat age.
- The durable release seal was committed at 07:56:56.799 UTC. Deployment attempt 354 recorded shipped=true at 07:57:02.344 UTC.
- Cutover, runtime verification, promotion, database movement and sealing passed. Rollback and DID NOT DEPLOY were skipped.

Fresh read-only production checks at 12:31:09-12:31:11 UTC show both frontend endpoints serving f1992eeb825918d6614d72a10c66988d0cdd292c, built 12:24:27 UTC by publisher 34476335321. Engine health serves f1992eeb with status, liveness and settlementStatus ok and blockedSettlementCount zero. GitHub comparisons prove the served full commit includes implementation 85da6479 (ahead 33, behind zero) and release-document merge 1434f002 (ahead 10, behind zero), with the required commits as exact merge bases.

Actual frontend and engine adoption are complete. Authenticated live acceptance remains unverified: the supported bound browser still times out refreshing tabs after 20 seconds and advertises no browser recovery capability. Desktop Commander connectivity does not establish browser connectivity. No application regression, route pass or phase completion is inferred from this tool failure. No production player mutation, repeated migration, forced restart, redundant implementation test or shared deployment cancellation was performed. Phase 6 remains open solely for permitted authenticated live acceptance and its final evidence; Phase 7 has not started and public funded games remain closed.

## Authenticated Live Acceptance And Phase 6 Closure

September 11, 2026. The last open gate, permitted authenticated live acceptance, passed. Dan signed in to the Claude desktop app's built-in browser pane on his Mac with his own joined Shark Club account, and Claude then drove the six permitted routes and the wallet open and close in that isolated pane, handling no credential and touching no tab in Dan's own Chrome. Served frontend during the checks: 7fca2266 at 13:57:58 UTC and bd524776 by 14:23:32 UTC, both descendants of implementation 85da6479 and release documentation 87f7c6dd.

All six routes passed. The Poker Arena home carried the automatic Diamond Arena card; the UUID, finance, agents and stale-invitation routes all canonicalized to the `diamond-arena` routes and rendered the safe Diamond shell with "You Are Already A Member.", "Diamond Games Are Not Open For Play Yet.", Available Diamonds 494,590 and Diamonds In Play 0, with no Join control, no chip footer, no operations rail and no funded-play action; a reload returned the same screen; the joined Shark Club lobby rendered its normal chip-club game list with no error boundary, no indefinite loading, no seat-query ambiguity error and no Diamond policy text. The Diamond Wallet opened and closed with no action submitted. The console carried 80 pre-existing warnings and zero errors. Per-route timestamps and DOM observations are in [the Phase 6 audit](../audits/2026-09-10-diamond-phase-6-cash.md).

The acceptance found one real defect: the Diamond shell inherited `.club-home`'s chip-lobby geometry, so it rendered four pixels off canvas with no side gutter at mobile widths and was auto-placed across the chip lobby's two-column grid on desktop. PR 4313 repaired it with a scoped double-class rule plus a stylesheet pin, merged as 29b6ae08 at 14:54:00 UTC, published by run 34612890316 at 15:00:16 UTC, and rechecked live at 15:06:28 UTC: the shell now lays out as one padded column with the heading at x = 12 and nothing clipped.

The managed-browser timeouts recorded in the earlier sections were a tooling failure and are retained as history only. No transfer, purchase, deposit, buy-in, cash-out, seat, balance, admission or table change was made during acceptance; the three production migrations were not reapplied; no completed implementation suite was rerun to repeat prior evidence.

Phase 6 Of 12 Is Done. It delivered the first fully playable shared NLH Diamond cash game: whole-Diamond engine precision with a reproduced duplicate-runout defect fixed, atomic custody-bound seat funding, accepted-hand settlement that carries no chip obligation, occupancy-bound cash-out including busted zero-balance exits and receipt replay, client funding, leave, history, result and wallet-refresh integration, controlled isolated multi-user certification, three approved production migrations applied once, required CI 34440835759, implementation merge 85da6479, verified engine adoption, verified frontend publication, and this authenticated live acceptance with its one repair. Material limitation: public funded Diamond games remain closed behind the existing accounting release gate of seven consecutive clean accounting days, zero suspense and no open critical Diamond incident, and `cash_games_enabled` stays false in production. Ready For Phase 7 Of 12.
