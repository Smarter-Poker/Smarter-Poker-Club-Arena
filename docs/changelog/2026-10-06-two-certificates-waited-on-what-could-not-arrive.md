# Two production certificates waited on things that could never arrive

Post-Deploy E2E run `37477183580` (job `112316633997`, `Client browser
verification`) ended with two timeouts that named no cause:

- `tests/e2e/club-data-deep.spec.ts:208` - `Test timeout of 180000ms exceeded.`
- `tests/e2e/gameplay-customization-runtime.spec.ts:645` - `Test timeout of 1200000ms exceeded.`

Both failed the same way in every client browser run from `37427474784`
(07:05 UTC) onward. Neither was a slow production read.

## 1. Club Data: the published client required a contract the database did not serve

**What the test was waiting for.** The Playwright call log in the
`post-deploy-playwright-report` artifact shows the test parked on
`loadMoreGames.click()` (spec line 224) against
`<button disabled>Load More Games - 100 Of 147,518</button>` for the whole
180 s. The failure snapshot shows why it never enabled: after the
`Highest Fee` sort the Games list rendered the alert `Could Not Load Club
Data.`, the header read `Ledger Unavailable`, and the integrity panel reported
the ledger read itself finished in 1,631 ms.

**Classification: a page that never reached the state the test waits for,
caused by two uninstalled migrations. Not a slow read.**

- `pg_stat_statements` for `ca_club_game_page`: mean 1,464 ms, max 7,923 ms
  over 15,996 calls, all inside the page's 12 s per-attempt budget. Postgres
  logged no statement timeout between 15:08:30 and 15:11:55 UTC, the minutes
  the test ran.
- `Could Not Load Club Data.` is `CLUB_GAMES_UNAVAILABLE_COPY`. A client
  timeout renders `Club Data Took Too Long To Respond`; this copy is reached
  only by an RPC error or by a payload that fails `isVerifiedGamePage`.
- `isVerifiedGamePage` (shipped in #6276, `793f7144e`) requires
  `contract = 'ca_club_game_page.v2'`, `contract_version = 2`, `club_id` and
  every `requested_*` receipt. The installed `ca_club_game_page` was still the
  pre-#6276 body (`md5(prosrc) = 1bb73735...`) and returned none of them.
  Every ranked games sort (`fee`, `winnings`, `hands`) and every Players page
  was therefore refused by the client for every operator, not only for the
  certificate. Recent kept working because it reads `ca_club_data_snapshot`,
  which #6276 did not change.
- The migrations that add those receipts merged with #6276 at 07:50 UTC and
  were never installed: `supabase_migrations.schema_migrations` had no row for
  `20261006012714_union_player_hands_follow_shared_tables` or
  `20261006040022_club_reports_return_exact_scope_receipts`.
- `040022` asserts `ca_club_player_page` at definition hash `171060d1...`,
  which only `012714` produces; production was still at `980556d6...`. They
  must be installed in that order. Every other preimage hash in both files
  matched production exactly before anything was sent.

**What changed.** Both merged files were installed, in order, through
`apply-merged-migration.yml` from their own bytes (no transcription), outside
the :50-:03 window:

| migration                                                     | run           | result                                                  |
| ------------------------------------------------------------- | ------------- | ------------------------------------------------------- |
| `20261006012714_union_player_hands_follow_shared_tables.sql`  | `37492742980` | APPLIED, committed in 194 ms, recorded `20261006012714` |
| `20261006040022_club_reports_return_exact_scope_receipts.sql` | `37500651248` | APPLIED, committed in 385 ms, recorded `20261006040022` |

Readback after `012714`: `ca_club_player_breakdown` = `121a7189...`,
`ca_club_player_page` = `171060d1...`, `ca_club_player_export_start` =
`ce83a312...`, exactly the file's three `@live-proof` hashes.

Readback after `040022`: the file's `@live-proof` (owner `postgres`, security
definer, `search_path=public`, no `anon` execute, `authenticated` and
`service_role` execute, body carries `contract_version`) is `true` for all six
public RPCs, and the five `*_core_20261006` functions are closed to `anon` and
`authenticated`.

Two operational notes. Hosted runners were badly backlogged (76 queued runs,
one or two jobs running account-wide), so each dispatch queued for about 30
minutes. The first `040022` attempt (`37497135565`) started at :57 and the
applier refused it before connecting (break window); it was dispatched once
more at 17:04 UTC, not looped.

No client or spec code changed for this cause. The harness change in #6298
(wait for `aria-busy="false"` and an enabled Load More before clicking) makes
the same defect fail in 60 s with its cause on screen instead of 180 s with
none; it complements this, it does not replace it.

## 2. Gameplay customization: the persistence gate never saw its request

**What the test was waiting for.** `chooseAppearance` armed a
`OneShotRequestGate`, tapped `Carbon Red`, then awaited
`gate.waitForRequest()`, a bare promise with no deadline, for the
`fn_patch_table_appearance` POST. The failure snapshot shows the writer with
`Carbon Red` pressed and the second browser already painting the red rail, so
the write reached the database. The gate simply never observed it. The report
carries no error location because nothing with a timeout was pending.

**Classification: harness defect.** Playwright runs the most recently
registered matching route first. `installRuntimeDataProjection` registered the
broad `**/rest/v1/rpc/**` handler after the exact
`fn_patch_table_appearance` handler, and the broad handler ended with
`route.continue()`, which sends the request to the network and skips every
earlier handler. The gate never saw the request, `waitForRequest` never
resolved, and the test ran to its 20-minute ceiling.

**What changed.** #6296 (`48877ce0d`, merged 15:29:57 UTC) replaced that
`route.continue()` with `route.fallback()`, so the exact persistence route
observes and holds the request. #6305 bounds `waitForRequest` by the
certificate's response timeout and releases the gate in `finally`, so a
future miss names its cause ("The expected customization persistence request
never began.") instead of spending 20 minutes; its unit tests
`oneShotRequestGate.test.ts` and `postDeployE2EConcurrency.test.ts` pass
(16/16) on its head `fe5648bd7`.

## Verification

- Club Data: Post-Deploy E2E run `37488617678` (job `112367624106`) ran
  `club-data-deep.spec.ts:208` at 17:30:10 UTC, ten minutes after `040022`
  committed, and it **passed in 28.5 s**, as did all seven Club Data cases,
  including the 60-second recovery heartbeat (79.8 s) and axe (9.7 s).
- Gameplay customization: the same run still timed out, but it does not test
  the fix. Its `LIVE_SHA` was `4c064de92`, and the job takes its specs from
  the commit production is serving; `4c064de92` predates #6296 and its spec
  still ends the broad route with `route.continue()` (line 424). The first run
  whose serving commit contains `48877ce0d` is the one that certifies it.

## Open, owned elsewhere

The same #6276 delivery left five more merged migrations uninstalled:
`012010` (refused fail-closed at run `37475772200`; corrected in #6298),
`024259`, `032934`, `035424` and `040331`. None is in either certificate's
path and none was touched here.
