# Diamond Phase 11, Line 7: An Old Client Lands Somewhere True

> "Test old bookmarks, expired/revoked sessions, stale storage, service workers
> and mobile rotation." (docs/POKER-ARENA-DIAMOND-BUILD-PROGRAMME.md, Phase 11)

**Verdict: tick.** Every cell of the matrix below was exercised and holds on
this branch. The matrix found four defects (ten Diamond staff doors obeyed a
revoked session; the money screens told a dead session to retry; a Diamond
figure with no owner was painted as the player's; a stored pinned-clubs value
of the wrong shape broke the Poker Arena home). All four are fixed in PR
**PR** and the database half is applied and recorded. Three observations are
left for Dan (end of file); none blocks the line.

Date: 2026-09-30. Branch `agent/claude-diamond-phase-11/test/an-old-client-lands-somewhere-true`
off main `52addc2502`.

## How it was tested, and how to run it again

Nothing here signed in as a person or moved a balance. Production was only
read: passive page and HTTP loads signed out, read-only catalog selects, and
single-session rolled-back rehearsals of door refusals.

| Layer                            | What                                                                                                     | Command                                                                                                                                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production, signed out           | Every URL the Diamond Arena has had                                                                      | `BASE_URL=https://smarter.poker/hub/club-arena npx playwright test tests/e2e/an-old-bookmark-lands-somewhere-true.spec.ts --project=chromium` (also runs daily in ci.yml `live-e2e`)                                                          |
| Local browser, two real builds   | Service workers across a deploy; a signed-in Diamond player through rotation, sessions and stale storage | `sh tests/stale-client/build-two-deploys.sh <dir>` (or any earlier build as A and the build under test as B), then `STALE_CLIENT_DIST_A=<dir>/distA STALE_CLIENT_DIST_B=<dir>/distB npx playwright test -c playwright.stale-client.config.ts` |
| Unit and law (CI)                | Session refusal logic, stored values, the staff-door law                                                 | `npx vitest run tests/unit/aDeadSessionIsASignInNotARetry.test.ts tests/unit/staleStorageIsReadSafelyOrDiscarded.test.ts tests/components/DiamondWalletTransfer.test.tsx tests/every-diamond-staff-door-needs-a-live-session.law.test.ts`     |
| Production database, rolled back | A revoked session at every Diamond staff door                                                            | `rehearse.sh <migration> docs/evidence/diamond-phase-11/stale-clients-rehearsal-fixture.sql stale-client` (and with `/dev/null` for the negative control)                                                                                     |

The local origin (`tests/stale-client/deploy-server.mjs`) copies production as
read on 2026-09-30: atomic activation, an append-only asset pool (old chunks
stay; a URL never changes bytes), a real 404 for a missing chunk,
`immutable` hashed assets, `no-cache` shell and `sw-bus.js` with
`Service-Worker-Allowed: /hub/club-arena`, and the 308 from the slash form.
The signed-in player (`tests/stale-client/mock-backend.ts`) is a local session
for a fixture id; every Supabase call is answered in the browser, every
WebSocket is answered locally, the engine's `/health` and `/heartbeat` are
answered locally when a case needs them, and every other host is aborted, so
no request from these suites left the machine.

Builds measured for the final local run: A = main `52addc2502` (entry
`index-D7il8c-P-v6.js`, `DEPLOY_TS 20260930113510`), B = this branch (entry
`index-JYC4R6gg-v6.js`), Chromium (Playwright 1.58), Node 24.

## The matrix

### 1. Old bookmarks

Inventory: Phase 2 legacy audit (docs/audits/2026-09-08-diamond-phase-2-access-and-legacy-inventory.md)
and Phase 5 (World Hub PR 1701, `606a789e`): the standalone arena was six World
Hub pages around an iframe of `https://diamond.smarter.poker`. Club Arena never
had a standalone Diamond route (190 commits of `src/App.tsx` searched); its
Diamond URLs are the arena club by slug and id, its invite, its doors, the
Diamond tables, Stats, the Staff Desk and the wallet.

| URL                                                                                                                                                                                                          | Lands on                                                                                                                                                                                                                                         | Result                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `/hub/diamond-arena`, `/history`, `/leaderboard`, `/schedule`, `/stats`, `/table-settings`                                                                                                                   | HTTP 404, no `Location`, no iframe markup; a browser shows the Hub's 404 page                                                                                                                                                                    | pass                                        |
| `/hub/diamond-arena/`                                                                                                                                                                                        | 308 to `/hub/diamond-arena`, then the same 404                                                                                                                                                                                                   | pass                                        |
| `/hub/Diamond-Arena`, `/hub/DIAMOND-ARENA`, `/diamond-arena`, `/hub/diamond`, `/hub/diamonds`, `/diamonds`                                                                                                   | HTTP 404 (no alias exists)                                                                                                                                                                                                                       | pass                                        |
| `https://diamond.smarter.poker/` (old iframe)                                                                                                                                                                | 404 `DEPLOYMENT_NOT_FOUND`; nothing served                                                                                                                                                                                                       | pass (DNS record remains, see observations) |
| `/hub/club-arena/diamond-arena` (a guessed alias inside the app)                                                                                                                                             | the app's own "Route Not Found / This Arena Door Is Closed" page, URL unchanged                                                                                                                                                                  | pass                                        |
| `clubs/diamond-arena`, `/lobby`, `/tournaments`, `/members` (Players), `clubs/<Diamond id>`, `/finance`, `/agents`, `invite/diamond-arena`, `table/<Diamond table>`, `stats`, `diamond-staff-desk`, `wallet` | signed out: the World Hub sign-in door with the route in `redirect` (the bare Diamond id arrives as its slug)                                                                                                                                    | pass, 12 of 12                              |
| A Diamond id on an operator door, signed in                                                                                                                                                                  | the arena's safe shell, never a chip screen: tests/components/ArenaAccessBoundary (12), tests/unit/diamondArenaIsOneOpenClub (33), tests/poker-arena-access (11), tests/unit/clubWorkspaceGuards (12), tests/the-route-and-the-client-agree (29) | pass, 97 of 97                              |

Production run: 17 of 17 passed in 3.7 s. The World Hub's root worker
(production `/sw.js`, read 2026-09-30) routes every same-origin document
`NetworkOnly` (only `/` itself is `NetworkFirst`) and holds no Diamond route, so
no cached copy of a retired page can be served.

### 2. Expired and revoked sessions

| Case                                                                                         | Where                   | What the client does                                                                                                                                                                                           | Result                                        |
| -------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Expired access token, refresh succeeds                                                       | lobby                   | refreshes (`POST /auth/v1/token`) and stays on the arena                                                                                                                                                       | pass                                          |
| Expired token, refresh refused (`refresh_token_not_found`)                                   | lobby                   | the sign-in door with the route; no Diamond figure or wallet cache left in storage                                                                                                                             | pass                                          |
| Expired token, network down                                                                  | lobby                   | the sign-in door with the route; the stored session and refresh token are kept for when the network returns (5 bounded attempts, all lost)                                                                     | pass                                          |
| Signed out in another app on this origin (the World Hub's shared-key `SIGNED_OUT` broadcast) | lobby                   | follows to the sign-in door with the route; money caches cleared                                                                                                                                               | pass                                          |
| Revoked session id, at boot                                                                  | lobby                   | GoTrue is asked (`/auth/v1/user`), then the sign-in door with the route; nothing left                                                                                                                          | pass                                          |
| Revoked while seated at an open Diamond table                                                | table                   | the next heartbeat is refused (401), the engine client's one refresh fails, the player reaches the sign-in door back to the table                                                                              | pass (see observation 2)                      |
| Revoked between review and confirm                                                           | cashier (Send Diamonds) | "Your Session Has Ended. Sign In Again, Then Retry This Transfer To Retrieve Its Receipt."; exactly one send; the saved request (same key) kept for the retry; then the sign-in door                           | pass (fixed here)                             |
| Revoked, buy-in                                                                              | table buy-in            | unknown outcome, one send and one receipt read, the saved request kept; "Your Session Has Ended. Sign In Again To Finish This Buy-In."; a retry after signing in is the same request under the same key (unit) | pass (fixed here)                             |
| Revoked                                                                                      | Staff Desk (browser)    | the door refuses by name; the desk says "Your Session Has Ended. Sign In Again."; one call                                                                                                                     | pass (fixed here)                             |
| Revoked                                                                                      | Staff Desk (database)   | all 14 desk doors that write (the other 3 are reads) refuse a revoked session and a token with no session claim by name                                                                                        | pass (fixed here, migration `20260930131500`) |

Never a blind money retry: the buy-in journal replays only on a reviewed click
and only its own key (unit); Send Diamonds sends once and keeps its key
(browser, unit); the Staff Desk acts once per click (browser); the engine
client replays a request only after a 401, only under the same session id, and
only once; an older build's queued buy-in or rebuy in IndexedDB is drained and
refused, never replayed (tests/unit/OfflineQueueService, existing).

**The staff-door rehearsal.** Rolled back, single session, fixture
`stale-clients-rehearsal-fixture.sql` (md5 `a11df26ec837791ae165c4dadcbd1b73`),
synthetic account `00000000-0000-0000-0000-000000000098` made staff inside the
transaction only:

- Negative control, no migration: `REHEARSAL FAILED (41 checks)` with exactly
  20 failures, the ten doors below times the two dead-session shapes (a
  revoked session id, and a token with no session claim), each reaching its
  door's next check; the five already-guarded doors and the transfer door
  passed; nothing written.
- With migration `20260930131500_every_diamond_staff_door_needs_a_live_session.sql`
  (md5 `5445aec23f217eed58c5693083743eb4`): `REHEARSAL OK: 41 checks`. Every
  door refuses both shapes by name; a live session passes each door to its next
  check (stakes, table lookup, target, adjustment lookup, incident lookup,
  reason); the rows the doors write, counted for the fixture account, are
  unchanged and the supply identity difference is 0.
- `apply.sh`: `APPLIED AND RECORDED 20260930131500`; recorded text md5 equals
  the file's (`d3f21c39ad13118164a88db2bc8bc424`, trailing newline excluded);
  all ten `@live-proof` expressions true on production afterwards.

The ten doors: `fn_poker_diamond_open_cash_table`,
`fn_poker_diamond_set_table_straddle`, `fn_poker_diamond_set_table_run_it_twice`,
`fn_poker_diamond_set_table_bomb_pot`, `fn_ca_diamond_adjustment_propose`,
`fn_ca_diamond_adjustment_approve`, `fn_ca_diamond_adjustment_reject`,
`fn_ca_diamond_adjustment_settle`, `fn_ca_diamond_incident_review`,
`fn_ca_diamond_incident_resolve_family`.

### 3. Stale storage

| Stored by an older build                                                                               | Current build                                                                                                      | Result            |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------- |
| `wallet-store` Diamond figure with no owner (store version 0)                                          | discarded on load, never painted, even when the real read fails (unit; browser: 494,465 never appears)             | pass (fixed here) |
| `wallet-store` figure owned by another account                                                         | cleared before the read, never painted, not after a failed read (unit)                                             | pass (fixed here) |
| the same account's own last figure                                                                     | kept through a failed read, per the 2026-08-24 rule (unit)                                                         | pass              |
| `club_arena_pinned_clubs` as `null`, `{}`, a number, a string, mixed arrays                            | read as an array of ids or discarded; the pre-fix reader threw in the home sort for a player with two joined clubs | pass (fixed here) |
| `club_arena_last_club` / saved order as a retired, numeric, malformed or foreign value                 | a real arena (Diamond by id or slug, else Shark), never blank or retired                                           | pass              |
| World Hub `sp-diamond-arena-prefs`, `world-store-v1` (retired standalone), `diamond_arena_preferences` | no reader in this app (unit); the World Hub migrates its own `activeOrb: 'diamond-arena'` away (Phase 5)           | pass              |
| queued money mutations in IndexedDB                                                                    | drained and refused (existing unit)                                                                                | pass              |
| saved Send Diamonds request, cash buy-in journal, wallet cache, lobby figure cache, workspace cache    | each validated on read (shape, owner, version, age) and discarded otherwise (source read)                          | pass              |
| arena asset and labels                                                                                 | never read from storage: fresh server context only (`ArenaContextService`)                                         | pass              |

### 4. Service workers

Two real builds, one deployed over the other with a device already holding
the old worker and its precached shell (Chromium):

| Case                                                                 | Result                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next visit after a deploy                                            | the old worker's 300 ms race is won by the network: the new build runs from the first paint, every chunk the page loaded belongs to it, and by the visit after the new worker controls the page and the old versioned cache is gone |
| Boot that lost the freshness race (shell slowed to 2 s)              | the whole old build boots (148 assets, none foreign), the gate verifies the deployed entry differs and reloads once, the new build runs, no further reload in 12 s                                                                  |
| An old chunk has vanished (pool pruned, which production never does) | the lazy route fails, `lazyWithRetry` recovers onto the new build at the same route, no dead screen                                                                                                                                 |
| A retired Diamond page, with the Club Arena worker installed         | served 404 from the network; inside the app's scope the router answers "Route Not Found"                                                                                                                                            |

Across repeated runs: 12 of 12 (4 cases, 3 repeats) with two builds of main;
4 of 4 in the final run with main as A and this branch as B (a real deploy
of this change): the next visit ran `index-JYC4R6gg-v6.js` (148 assets, none
foreign) and the visit after held only `club-arena-20260930121746`; the lost
race booted `index-D7il8c-P-v6.js` whole and adopted the branch build with one
reload; the pruned pool recovered onto the branch build at `/health`.

### 5. Mobile rotation

| Surface                                             | Portrait -> landscape -> portrait                                                                         | Result |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| Diamond lobby                                       | the same page (no remount), nothing sideways at 390x844 or 844x390, the light scheme kept, the route kept | pass   |
| Diamond wallet (cashier) with a transfer half typed | both fields keep their values, the form is not rebuilt, nothing sideways, Review still enabled            | pass   |
| Diamond table                                       | covered by the portrait prompt while sideways (CSS only), never rebuilt, uncovered when upright           | pass   |

The signed-in local suite: 11 of 12 in the final run. The one failure was the
test's own path-dependent assertion in the mid-table case (GoTrue answered
through the refresh endpoint before the probe asked `/user`); with the
assertion corrected to accept either, that case passed 3 of 3. Every other
cell passed in the final run and in the runs before it.

## Defects found and fixed (PR **PR**)

1. Ten Diamond Staff Desk writers obeyed a revoked session (database; migration
   `20260930131500`; law test `tests/every-diamond-staff-door-needs-a-live-session.law.test.ts`).
2. The buy-in sheet and Send Diamonds told a dead session to retry
   (`src/lib/deadSessionRefusal.ts`, `TablePage`, `DiamondWalletTransfer`,
   Staff Desk copy).
3. `wallet-store` painted an ownerless or foreign Diamond figure
   (`useWalletStore` persists owner and time, discards version 0, clears a
   foreign figure; GlobalHeader stamps the owner).
4. A wrong-shaped `club_arena_pinned_clubs` broke the Poker Arena home
   (`savedPinnedClubIds`).

Bundle: initial load 314/320 kB gz unchanged; whole app 2874 -> 2875/2880 kB
gz; the entry-chunk gate reports nothing new before first paint.

## Observations for Dan (not defects, not fixed)

1. `diamond.smarter.poker` still resolves to Vercel and answers
   `DEPLOYMENT_NOT_FOUND`. Nothing is served, so no old bookmark reaches a
   Diamond screen, but the DNS record is leftover Phase 12 infrastructure
   ("delete deployment targets").
2. When a session is revoked mid-table, the engine client's own refresh
   attempt makes the SDK sign out first, so the guard sends the player to the
   sign-in door (with the table route) without the "Your Session Has Ended"
   explanation the socket path shows. The line's requirement holds (the client
   asks to sign in). Whether every forced sign-out should also carry a reason on
   the World Hub sign-in page is a copy decision.
3. Chromium keeps the old service worker active while an open tab still has
   work in flight on it (measured: a tab on `/legal` held it until it
   navigated; `/health` released it at once). The tab already runs the new
   build and the next visit retires the old worker, so nothing stale is shown.
