# Poker Arena Access, Phase 2 Work In Progress

Status: database rollout applied and verified on September 8, 2026; application publication is being verified. Phase 2 is not yet claimed complete. Earlier sections below preserve the investigation history.

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

Dan explicitly authorized pushing and publishing Phase 2 in the continuation chat. The production migration authorization blocker is resolved. Phase 3 remains on hold until publication verification completes.

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

Behavioral checks passed: 40 route/invite/access tests, followed by 26 service/access/guard checks after moving arena imports off the global startup path. Frontend TypeScript passed. The first PR production build compiled but its entry-module gate correctly rejected eager ArenaContext imports; these are now dynamically loaded. Publication is still pending the corrected commit and release verification. Phase 3 remains blocked until that succeeds.
