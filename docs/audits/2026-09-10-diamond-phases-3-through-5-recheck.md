# Diamond Phases 3 Through 5 Recheck

Status: Scope Verified And Repair Published September 10, 2026. World Hub Lobby Image Excluded By Dan.

## Scope And Result

Rechecked Phase 3 custody, Phase 4 transfers and Phase 5 shared Arena shell against their recorded acceptance criteria, current source, production database contracts and authenticated routes. The confirmed transfer-session and lost-response identity defects are repaired and published. This is a scoped acceptance result, not a guarantee that no future defect can exist. Phase 6 gameplay is still in progress.

## Confirmed Defects And Correction

The original Phase 4 writer checked auth.uid() but omitted the existing live-session guard. Its production source MD5 was 17fbc7ff2a9176d3cca3f94d91721292. The Data API pre-request hook governs server actor/lease headers and does not validate ordinary browser sessions. The isolated negative control demonstrated that the original writer could commit with a revoked session, then rolled that transaction back.

The client discarded its saved transfer identity for any SQLSTATE 42501, 22023 or P0001 error, including a session refusal after an earlier response was lost. The repair preserves unresolved identities through session and ambiguous failures. The accepted-friend refusal remains editable because it follows the existing receipt lookup.

PR [4078](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/4078) merged source 20e9901c2fee9405cd8c04b717178ca826388d41 as 810c709de051d06a4a4b8819f787bf03e487e6a5 through agent-open-pr and autopilot. No hook, permission boundary or merge protection was bypassed.

## Test Evidence

- All 37 isolated PostgreSQL assertions passed: the existing 28 transfer/custody/concurrency assertions, the negative control and eight session/refusal/replay assertions. Missing, revoked, expired and malformed sessions leave profiles, journals and receipts unchanged. A fresh live session retrieves the original receipt without another transfer.
- The new client regression failed against the old component while five existing tests passed. All six passed after the fix, including lost response, session refusal, remount and original-receipt completion.
- CI [34426462306](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34426462306) passed 18,483 client tests, 8,533 server tests, TypeScript, structural/stub gates, production build, 145 PostgreSQL accounting cases and 150 CSS + 13 Studio + 3 mobile browser cases. 145 server tests were skipped; live-production and postdeploy jobs were skipped. Those are not counted as passes.
- The normal pre-push check initially found missing native packages in this worktree. npm ci restored the exact lockfile dependencies, without changing the manifest or lockfile. The normal push then passed, including 247 related assertions.
- Phase 3's 79 isolated custody assertions and earlier release checks remain applicable: its adapter and all five applied migration sources are unchanged. Unchanged broad suites were not manually rerun to inflate totals.

## Production Database Verification

Applied diamond_wallet_transfers_require_a_live_session as production version 20260910015108, after frontend publication. The committed reservation filename is 20260910012514_diamond_wallet_transfers_require_a_live_session.sql. The deployed and isolated tested writer bodies both hash to d1ef9862095495b98d31e6a203c89347.

A read-only production transaction with authenticated JWT role/sub claims and a nonexistent session asserted that the caller was not an engine and the session was not live. Calling the writer refused with authentication_required before recipient validation. The transaction rolled back. An earlier probe omitted the JWT role claim, so the administrative connection was treated as trusted and reached invalid_transfer_request; it was not counted as session verification. Neither probe could transfer funds.

The writer remains executable only by authenticated users, not anon or service_role. Custody reserve/release remain service-only. The balance reader remains auth-bound. Custody, movements, lot reservations and transfer receipts all have RLS enabled and no authenticated INSERT/UPDATE/DELETE grants. Their existing owner/participant SELECT policies remain intact.

All five Phase 3 migrations and the original Phase 4 migration are present. Both old Arena deposit/withdraw RPC bodies only raise their retirement exception. There is no recovery obligation table, recovery/reconciliation function or recovery cron job.

Security advisors before and after show the same scoped notices: the deliberately private lot-reservation table has RLS with no browser policy, and the intended authenticated SECURITY DEFINER entry points are reported. No new scoped finding appeared. No production player balance, seat or configuration was mutated.

## Publication And Live Acceptance

- At 01:50:21 UTC both smarter.poker/hub/club-arena/build-info.json and ca-static.smarter.poker/build-info.json served exact repair 810c709de051d06a4a4b8819f787bf03e487e6a5, built 01:49:05 UTC. Publisher [34426821543](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34426821543) completed successfully.
- Frontend ancestry contains Phase 3 repair 4c385b09, Phase 4 merge 70fd31cf and Phase 5 repair d600427d. The runtime repair is now also included.
- Engine b53ad9b212cf586ffdc6fed888ad6b738c348191 was healthy at 01:54:40 UTC: status, liveness and settlementStatus ok; zero blocked settlements. Git ancestry includes Phase 3 and Phase 4, and the custody adapter/alert source is unchanged from Phase 3. Phase 5 and this audit repair require no engine change.
- World Hub health at 01:44:22 UTC identified healthy 017b053db016c0530822875da05134cca4723ebb. Git ancestry includes Phase 5 entry 606a789e, evidence b1250716 and Phase 3 scheduler retirement 39f7d7b8.
- A new authenticated verification tab passed Diamond UUID entry, finance and agents routes, stale invite redirect to the shared Diamond slug, automatic home entry, wallet balances and transfer-form opening. Diamond shows automatic membership, games closed, available 494,465 and in-play 0, with no Join or chip management rail/footer.
- Shark's joined lobby showed live connection and running NLH games. The shared home retained joined clubs and the separately approved Diamond card/countdown. World Hub Quick Navigation led to /hub/club-arena; its Recently Visited shortcut points to that same destination. All six old /hub/diamond-arena routes returned 404.
- A clean tab loaded the published repair, opened its wallet and Send Diamonds form, and showed no application errors. Earlier control-service click timeouts recovered in the clean tab; extension metadata errors were excluded from app errors. No real transfer or seating action was performed.
- The previously accepted World Hub image work and managed-browser 3D limitation remain excluded. The earlier Phase 5 spectator-table continuity evidence is retained because the relevant table runtime did not change in this repair.

## Phase 6 Continuation

PR 4070's whole-Diamond engine and duplicate-runout payout correction is merged as 81e4c6daefa47f6b6883596f3b62d2d3498e195a. Its CI passed and a normal descendant engine deployment was already active; no duplicate dispatch, forced restart or shared-deploy cancellation was performed.

This recheck clears the scoped Phases 3 through 5 audit. Atomic funded seating, accepted-hand custody settlement, cash-out, client wiring and controlled multi-user certification remain Phase 6 work, as recorded in the Phase 6 audit. Public funded games remain subject to their existing accounting/release gates.
