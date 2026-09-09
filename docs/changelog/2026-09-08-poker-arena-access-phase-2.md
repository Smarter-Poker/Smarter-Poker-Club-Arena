# Poker Arena Access, Phase 2 Work In Progress

Status as of September 8, 2026, 18:08 UTC: database rollout and frontend/engine adoption are verified. The publication monitor remains open for the UI acceptance discrepancy recorded below. Phase 3 is explicitly authorized to proceed concurrently. Earlier sections preserve historical checkpoints and their superseded blockers.

The Diamond identity is a player-only platform entitlement, independent of club membership rows. Chip clubs retain their join/approval requirement. The new migration adds caller-bound access RPCs, restrictive game-read policies, immutable asset identity, and rejection of Diamond chip wallets, hierarchy, and generic chip seats. It preserves the zero-balance historical membership row as player/automatic. Existing chip engine loading explicitly rejects Diamond funding until dedicated custody exists.

Callers: ClubJoinService calls ArenaContextService before joining; Diamond returns navigation metadata without a join/referral mutation or CLUB_JOINED event. Public previews retain the existing unauthenticated RPC. ClubsService excludes Diamond records from the chip membership directory. TableViewerAccess supplies the common HTTP/WebSocket observer boundary; loadTable validates the authoritative embedded arena before chip settlement can start. SQL triggers and RLS invoke the new guards directly.

Local verification: the isolated PostgreSQL 17 fixture uses a Unix socket only, a dedicated database, and an environment guard before fixture DDL. It executes the actual migration and tests entitlement, chip join gating, anonymous denial, management, financial/hierarchy rejection and chip seating. It is a representative fixture, not a copy of every production trigger or proof of production behavior. The first live rollback rehearsal exposed pending trigger events from data-before-DDL ordering. The migration now performs its data transition after all DDL. That rehearsal rolled back.

Automatic approval review rejected a second live rehearsal because broad policy, trigger and membership changes could lock production despite intended rollback. No alternative live mutation or publication was attempted. Production migration application and live verification require explicit approval of those operations. Do not publish frontend callers before the RPC exists.

Remaining phase exit work: finish direct lobby/staff authorization and legacy dependency inventory; test against the complete production trigger chain in an approved environment; apply migration; pass repository gates; push, merge, publish and verify the served commit. No existing Diamond runtime earns completion credit. No funded games are enabled by this phase. Custody remains Phase 3, transfers Phase 4, shared skin/artwork and World Hub card/legacy route removal Phase 5.

The original Diamond Arena card image remains required for the Diamond club selector. Nothing in this patch changes or removes the shared platform wallet or authorizes chip-backed Diamond play.

## Recorded Local Evidence

- Frontend: 102 tests passed across eight focused files after merging the current baseline.
- Server: 40 tests passed across five files, including idle add-on and engine start/reconnect regressions. Server TypeScript passed.
- Database: 23 assertions passed by running the actual migration against the isolated PostgreSQL fixture. No production schema change is claimed.
- Frontend TypeScript and Vite compilation completed. The full build printed a freshness refusal after another main commit landed, despite returning exit code zero; this is not a passed publication gate.
- Read-only production inventory: one Diamond identity, no union, zero chip treasury/pool/promo/insurance amounts, zero tables, one historical membership, zero agents, player-agent assignments and agent commissions. This does not certify all financial obligations.
- Work is saved in isolated branch agent/codex-diamond-phase-2/feature/diamond-arena-access. No hooks were bypassed. The orphan-protection hook refused rebase; abort restored the committed branch and a normal merge preserved both histories.

Final local build: npm run build completed with TypeScript, Vite, fonts, media optimization and provenance at 0b4682152c, behind-main=0, clean source. The earlier freshness refusal was resolved by merging main without bypassing guards. The isolated PostgreSQL server was stopped after verification. Publication and production migration remain blocked, and phase exit work above remains open.

## Phase 2 Continuation

The previous open lobby and ordinary management paths now have implementation and focused coverage. ArenaAccessBoundary is wired into ClubHomePage, including embedded table-tab entry. It checks fresh entitlement before cached chip content mounts; stale club responses and sign-out cannot expose the prior club. Diamond entry recognizes automatic membership and shows the current pre-release state without a Join control, chip wallets or hierarchy. It does not claim the Phase 5 skin is delivered.

The aggregate get_club_home RPC now authorizes before returning member content. Chip members retain its existing implementation. Diamond returns only access context until its skin exists. Ordinary is_club_admin(uuid,uuid) ownership does not grant Diamond control; verified platform staff retain the separate fn_is_platform_admin path. Live mutations are still not applied.

The updated isolated SQL fixture passes 32 assertions, including direct aggregate RPC access and platform-staff versus club-owner permissions. Eight component behavior tests cover entry, required joins, Diamond recognition, stale responses, sign-out, unknown identity, retries and revalidation failure. The legacy dependency inventory is docs/audits/2026-09-08-diamond-phase-2-access-and-legacy-inventory.md.

Automatic approval review rejected apply_migration(poker_arena_identity_and_access): the concrete live RLS, trigger, access-function, lobby and historical membership changes could deny production service. General permission to proceed with Phase 2 was not accepted as explicit approval for that exact mutation. No workaround, alternate mutation tool or push/publication was attempted. The prepared migration is 20260908135547_poker_arena_identity_and_access.sql, with lock_timeout 5 seconds and statement_timeout 30 seconds. Application, full live trigger-chain verification and release gates remain open. Phase 2 is not complete.

## Recovered In Continuation Chat

Recovered the Phase 2 worktree during an unfinished merge with main. Resolved TableViewerAccess and its tests by preserving authoritative Diamond identity checks together with union-aware observer authorization and seat-first reconnect access. Retained the pending explicit union-only chip scope in the table loader and the migration's cross-asset reassignment guard. Added seven table-scope regressions covering valid union-only chips, missing identity, mismatched clubs, and Diamond/union contamination.

Continuation verification: 35 server tests and 18 frontend tests passed. Both server and frontend TypeScript completed with exit 0. No conflict markers or diff whitespace errors remain. These checks certify the recovered code paths, not the complete production schema or a deployed Diamond game.

The recorded automatic approval rejection still blocks production application of 20260908135547_poker_arena_identity_and_access.sql. No production mutation or publication has been attempted in this continuation. Phase 2 remains incomplete pending approved schema application, complete trigger-chain/live verification, and release gates.

## Production Database Rollout And Deep Audit

Dan explicitly authorized pushing and publishing Phase 2 in the continuation chat. The production migration authorization blocker is resolved. The later user override authorizes Phase 3 during publication verification.

The audit found and fixed three concrete defects: duplicate Diamond identities were not prevented; union-only game rows bypassed membership restrictions; and the shared trigger tried to resolve union_id on membership rows. A fresh isolated PostgreSQL 17 run executes all six actual migration files and passes 39 assertions. Union membership uses the same fn_club_scope_ids scope as the observer boundary.

The original combined production migration deadlocked and rolled back completely. Two bounded lock preflights refused busy tables without changes. Splitting the rollout into six ordered transactions eliminated the cross-table lock accumulation. All six applied successfully, with no disabled triggers, role bypass flags, hook bypasses or player fund movements:

- 20260908152822_poker_arena_identity_and_access.sql
- 20260908152855_poker_arena_identity_guards.sql
- 20260908152923_poker_arena_table_access.sql
- 20260908152947_poker_arena_tournament_access.sql
- 20260908153025_poker_arena_seat_guard.sql
- 20260908153052_poker_arena_hierarchy_guards.sql

The repository filenames match the actual Supabase migration ledger. The earlier 20260908135547 file was never applied and has been replaced by these records.

Live verification confirms exactly one Diamond identity, the historical membership as player/automatic with zero chips and no agent, six new policies and seventeen new triggers. The production table foreign key used by the engine embed is present. Bounded production SQL assertions verified automatic Diamond context and the Diamond access-only aggregate; actual authenticated-role tests verified joined chip-table visibility, outsider table denial, nonmember context, and aggregate membership denial. An initial broad probe timed out at the MCP transport and is not counted as evidence. Anonymous direct table reads are denied by the existing fn_union_oversees_club privilege boundary; no anonymous grant was added.

Final focused checks: 27 frontend tests across four files; 70 server tests across five files, including WebSocket multiplexing, reconnect and engine-start regressions. Frontend and server TypeScript pass. Supabase security advisors were reviewed separately; existing estate-wide findings are not claimed resolved by this access phase.

Wiring: ClubHomePage mounts ArenaAccessBoundary before member content; ClubJoinService calls getArenaContext before mutation; ClubsService excludes Diamond rows from chip membership listings; HTTP state and WebSocket authorization call authorizeTableViewer; loadTable calls parseTableArenaIdentity and assertChipFundingArena. SQL policies and triggers call the new database guards. No funded Diamond games are enabled. Custody, wallet transfers, the complete shared skin, original card placement and World Hub legacy-card removal remain their planned later phases.

### Outer Route And Stale Invite Audit

Live browser verification exposed a remaining outer ClubMemberGuard redirect to the private-club invitation page before the inner Diamond boundary could run. The outer guard now checks authoritative arena context before mounting private-club capabilities. Diamond lobby, finance, and agent deep links all stop at the access-only screen. Routed ClubHome avoids duplicate context checks; embedded ClubHome keeps its own boundary. Stale Diamond invitation links replace the current history entry with the guarded arena destination without membership queries or referral writes, for both signed-in and signed-out visitors.

Behavioral checks passed: 40 route/invite/access tests, followed by 26 service/access/guard checks after moving arena imports off the global startup path. Frontend TypeScript passed. The first PR production build compiled but its entry-module gate correctly rejected eager ArenaContext imports; these are now dynamically loaded. Publication is still pending the corrected commit and release verification. Phase 3 may proceed under the later explicit user override.

### Final CI And Merge Evidence (16:47 UTC)

PR #3814 merged as ea30980397158749d0d91c1726c9f8e004e83e56. Corrected source head: 26714d2a0337a4c910e4a2fa92ec2bf2633596fe. CI run 34248685356 passed production build, entry-module review, route performance budgets, both typechecks, 17,063 client tests and 7,575 server tests. Browser job 102146609430 passed 150 CSS/browser cases, 13 Table Studio cases and three mobile financial-decision cases. The first attempt had one 60-second Crimson Club visual timeout; its isolated retry passed without changing code, baselines, assertions or timeouts.

The final committed six-file SQL fixture was executed again through the isolated Unix-socket PostgreSQL instance and passed all 39 assertions. A bounded production identity census found all 199,430 table records (178 active-status rows) classified as valid chip-club identities; no existing table falls outside the new identity parser. The joined Shark Club live lobby continued to load games after migration.

At the historical 16:47 UTC checkpoint, the release gate remained OPEN. Production at that checkpoint still served 79b1c71433d3ebf15d4e5fcdba4d4ee106e2dc2a. Publisher run 34251926329 is processing an older release; latest queued descendants include the Phase 2 merge. The active engine deploy run 34251020300 targets an earlier commit and waits for the announced maintenance break. Neither an older successful deployment nor a branch/main merge is proof that Phase 2 server code is active. Verify frontend build-info ancestry and live Diamond lobby/invite/finance/agent routes, then engine health version ancestry, before closing this gate. This historical rollout checkpoint does not block Phase 3 under the later explicit user override.

## Live Publication Evidence, September 8, 2026, 18:00 To 18:08 UTC

Both https://smarter.poker/hub/club-arena/build-info.json and https://ca-static.smarter.poker/build-info.json returned ca_sha 4932f6f91ad9b08300cf20afbeb9576b6559770f, built_at 2026-09-08T17:39:49Z, run_id 34257700085, built_by publish-club-arena.yml. https://engine.smarter.poker/health returned status ok and version 4932f6f9. Git resolves that version to the same full commit. git merge-base --is-ancestor ea30980397158749d0d91c1726c9f8e004e83e56 4932f6f91ad9b08300cf20afbeb9576b6559770f succeeded. This proves frontend and engine adoption, not merely HTTP availability. Earlier engine deployment checkpoints are superseded.

The original audit documentation PR #3836 merged as 9445e02d611e32790b02d25b9704299e51e98756; its ancestry into fetched origin/main was verified.

A new authenticated verification tab preserved existing table tabs. The Diamond UUID lobby, /finance and /agents main regions each displayed You Are Already A Member. and Diamond Games Are Not Open For Play Yet. No Join control, chip balances, financial forms or agent-management content mounted inside those main regions. The stale /hub/club-arena/invite/diamond-arena route automatically redirected to /hub/club-arena/clubs/diamond-arena and showed the same access-only screen. Joined /hub/club-arena/clubs/shark-club rendered its live game lobby and game rows. Browser error logs contained extension metadata errors only, with no application-origin errors in this verification tab. No funding, seating or player-balance mutations were performed.

The home-entry check did NOT pass: /hub/club-arena displayed joined chip clubs and a union, with no Diamond automatic-entry card. Diamond routes also retain outer club-management navigation, even though their main content is guarded. The programme assigns selector placement and shared skin to Phase 5, while the publication monitor requests these UI conditions now. These are recorded as unresolved acceptance discrepancies, not passing tests or completed later phases. Runtime publication is verified; the monitor remains open. This does not block authorized Phase 3 work.

## Publication Acceptance Repair

The 18:08 UTC browser audit found two concrete outer-shell gaps after the Phase 2 runtime had adopted the implementation: the Club Arena home had no automatic Diamond entry, and Diamond deep links retained chip-club operations/footer navigation around the guarded main region.

The repair defines the Diamond UUID and slug once, injects a non-mutable automatic-entry card into the existing home carousel only after the authenticated club-directory request succeeds, and disables membership context-menu actions for that card. Both the Club Operations rail and global chip-club footer now refuse Diamond UUID and slug routes. The complete Diamond selector artwork and shared skin remain Phase 5.

Local repair gates pass: 58 focused access/navigation tests, 214 dependency-related tests, frontend TypeScript, the production build, Club Entry budgets and mobile/tablet/desktop public-route performance. The following publication checkpoint supersedes the earlier pending-publication status. The authenticated production browser recheck remains open.

## Repair Publication Evidence, September 8, 2026

Repair PR #3858 merged at 20:29:11 UTC as 671b3d6f2f3b479e34b472fb4625ddaf0d3436ca, source head 5f6ef84716c6dacaec2da7f401c74ac350baee3b. CI 34273288263 completed successfully: frontend TypeScript, stub gate, all four client test shards, CSS/browser gate and production build passed. Server, Live Production E2E and Post-Deploy Verification jobs were skipped for this run and are not counted as passing checks. The original Phase 2 server and SQL evidence remains recorded above.

Both production build-info endpoints returned ca_sha def6fbfe54c3ac7f7f5da651780dbc9de101e4b0, built_at 2026-09-08T22:02:11Z, publisher run 34283593024. Engine health returned version 54ed5bc1, status/liveness/settlementStatus ok, and blockedSettlementCount 0. Git resolved the engine to 54ed5bc1eb25dd5f1da213bb2cd0c99cb164eb37. Both ancestry commands exited successfully: repair merge 671b3d6f is an ancestor of served frontend def6fbfe; original Phase 2 merge ea309803 is an ancestor of engine 54ed5bc1. The five repaired runtime files also remain unchanged between the repair merge and fetched main.

The repair is merged and published, but final authenticated UI acceptance is NOT yet certified. Browser tab refresh, navigation, alternate DOM inspection and manual handoff returned connection timeouts before usable page state was available. These are verification-infrastructure failures, not a proven application regression. No service restart, shared deployment cancellation, player mutation, protection bypass or Phase 3 edit was performed for this audit. Keep the Phase 2 acceptance gate open until the home entry, Diamond lobby/finance/agents, stale invite redirect and Shark lobby are observed on the repaired live release. Phase 3 remains independently authorized.
