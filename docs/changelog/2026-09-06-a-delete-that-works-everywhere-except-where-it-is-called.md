# A delete that works everywhere except where it is called

**2026-09-06** — branch `fix/a-channel-nobody-removed-is-a-channel-still-there`

I broke the GTO aggregation driver an hour before writing this, found it in the
engine's own log while checking something else, and the sweep afterwards found
nine more of the same shape already live. It also turned up the cause of a
platform-wide hand-rate collapse that was not mine, measured here because
nobody had measured it.

## What I broke

`20260906150328_the_realtime_poller_decodes_only_what_someone_reads` patched
`fn_aggregate_gto_v31_next` to stop churning temp-table DDL on every cron tick:

```diff
-  create temp table ... on commit drop;
-  truncate table tmp_agg31;
+  create temp table ... on commit delete rows;
+  delete from tmp_agg31;
```

The first line was right and stays. The second broke the function completely:

```
[GtoAggregationDriverV31.tick] Error: DELETE requires a WHERE clause
```

50 occurrences between 15:56 and 16:17 UTC, and continuously since the
migration applied. The driver reports and continues rather than throwing, which
is why nothing went red — and why it had to be looked for rather than waited
for.

## The mechanism, which is the part worth keeping

PostgREST connects as `authenticator`, and on this database:

```sql
select rolname, rolconfig from pg_roles where rolname = 'authenticator';
-- session_preload_libraries=safeupdate | statement_timeout=5min | lock_timeout=8s
```

`safeupdate` is loaded **per session, at connect time**, and raises on any
UPDATE or DELETE with no WHERE clause. A later `SET ROLE service_role` does not
unload it — which is why this caught the engine's service-role RPC rather than
a browser.

So the statement is:

| run as                                          | result      |
| ----------------------------------------------- | ----------- |
| `postgres`, from a migration or pg_cron         | works       |
| through PostgREST, from the engine or a browser | **refused** |

It passes every check the author runs and fails on the only path anything uses.
That asymmetry is the whole defect, and it is why ten of these were sitting in
the schema unnoticed.

## The sweep

Ten functions in `public` hold an unqualified DELETE. Reachability is
`has_function_privilege`; callers are `.rpc('<name>'` in Club Arena's `src/`
and `server/src/` and the World Hub's `pages/ src/ scripts/` on `origin/main`.

**Fixed** (`20260906161517`, `20260906161936`) — something calls them today:

| function                           | delete              | caller                                                |
| ---------------------------------- | ------------------- | ----------------------------------------------------- |
| `fn_aggregate_gto_v31_next`        | `tmp_agg31`         | the engine's GTO driver — the one I broke             |
| `fn_backfill_bomb_pot_award_units` | `zz_backfill_units` | `server/src/GameServer.ts:2087`                       |
| `generate_period_settlements`      | `_scope_clubs`      | `SettlementService.ts`, `SettlementDashboardPage.tsx` |
| `fn_aggregate_gto_flop`            | `tmp_agg`           | the same aggregation family                           |

Every one deletes a TEMPORARY table it created itself, as the first step of a
rebuild. `where true` is a no-op predicate over exactly the same rows.

**Left alone, deliberately**: `fn_rake_spec_rebuild_caps`,
`fn_rebuild_agent_commission_rollup`, `fn_rebuild_ca_club_commission_daily`,
`fn_ca_execute_epoch3_reset`, `fn_union_settle_player_pnl`,
`fn_renumber_duplicate_places`, `fn_backfill_bomb_multi_winner_units`. None has
a `.rpc()` caller in either repo; the rebuilds run from pg_cron as `postgres`,
where safeupdate is not loaded, so they work today. And the first four wipe a
**real** table, not a temp one. Adding `where true` to
`DELETE FROM public.ca_treasury_baseline;` would not fix a defect — it would
remove the accident that currently stops a treasury-wide wipe from being
callable over the API at all. Making a dangerous function reachable is not a
repair.

**What I could not tell**, said plainly: I did not prove
`generate_period_settlements` has been failing. `settlement_invoices` has had no
row since 2026-08-20 and `settlement_periods` none in seven days, which is
consistent with it failing _and_ with nobody having pressed the button. The fix
is a no-op predicate either way, so it does not need that answer — but this note
should not claim an outage it has not measured.

## The gate

`scripts/ci/check-unqualified-writes.mjs` refuses a new unqualified UPDATE or
DELETE in any migration, in CI (`Supabase Invariants — No Unqualified Writes`)
and on pre-push. Twenty cases pin it in `tests/unqualified-writes-gate.test.ts`.

Most of those cases are about **not crying wolf**, because the dangerous
direction here is blocking the repair: every migration that fixes one of these
quotes the broken statement in its header to explain it, and the in-place patch
builds the search pattern as a string literal. A checker that read comments and
literals as code would block every fix while allowing the original. So line
comments, block comments and single-quoted literals are stripped;
dollar-quoted bodies are deliberately kept, because a function body is where
the dangerous statement lives.

It also reads the statement up to its terminator rather than demanding the
semicolon follow the table name, so `DELETE FROM x USING y;` and
`DELETE FROM x RETURNING *;` are caught too — a rule that knew only the bare
form is one anybody could step around by writing one more word.

A deliberate one can be declared, naming the table and giving a reason of at
least 40 characters that may run across following comment lines. One marker
cannot cover a second table.

Run over all 2,332 migration files, it reports 33 historical occurrences. Those
are history — the files are already applied, and what matters is the live
function bodies, which the sweep above covers. The gate judges new work.

## The other thing the log showed, which was not mine

While reading the engine log I found the platform had nearly stopped dealing:

| minute (UTC) | hands                                             |
| ------------ | ------------------------------------------------- |
| 15:24–15:52  | 420–500 per minute, steady all day                |
| 16:00–16:02  | 279, 476, 444 — normal after the maintenance thaw |
| 16:05        | 119                                               |
| 16:07        | 17                                                |
| 16:08        | **6**                                             |

The engine was alive, leader, and dealing; the database was idle with no lock
waits. What the log was full of was:

```
970x  deal_step_timeout: load_seats exceeded 20s
364x  tournament context refresh timed out
 22x  deal_step_timeout: refresh_rake exceeded 20s
      elimination sweep still running after 66s
```

Every table's ordinary reads hitting a 20-second wall at once. `ca_ddl_events`
says why:

| minute    | DDL statements | reload-triggering | applied by             |
| --------- | -------------- | ----------------- | ---------------------- |
| 16:03     | 7              | 7                 | mgmt-api (a migration) |
| 16:08     | 9              | 7                 | mgmt-api               |
| 16:09     | 7              | 5                 | mgmt-api               |
| **16:14** | **249**        | **133**           | **Supavisor**          |
| 16:21     | 94             | 71                | Supavisor              |

CLAUDE.md section 2 measured one PostgREST schema-cache reload on this database
at **~28 seconds**. 133 reload-triggering statements in one minute, applied
through the pooler as one long script rather than as a single-transaction
migration, is the reload storm that rule was written about — the 16:14 burst
was a video/YouTube schema change (`social_posts` columns,
`complete_rights_cleared_youtube_transcode`, `video_library_public_catalog`).
Section 2 rule 1 exists precisely because Postgres coalesces the reload NOTIFYs
inside ONE transaction and does not across many.

For completeness about my own hands: the two migrations here went in as
`mgmt-api` inside `begin; ... ` — one transaction, one reload each — and the
timeouts were already running for eleven minutes before the first of them.

Hands were back to 199/minute and climbing by 16:24 as the DDL rate fell.

**This is the largest thing still open on the platform, and it is not code.**
Nothing measures the reload-triggering DDL rate and nothing tells anybody when
it spikes, so an agent applying a large schema change through the pooler has no
way to know it is stopping every table on the felt — and neither did anyone
watching. `ca_ddl_events.triggers_pgrst_reload` already records exactly the
right number; what is missing is a reader for it (10.86 rule 3). That belongs
in `infra/monitoring/` with a threshold derived from the live series, not
guessed, and deployed with `infra/monitoring/deploy.sh` per 10.84.

## Files

- `supabase/migrations/20260906161517_an_unqualified_delete_is_refused_where_the_engine_calls_it.sql` (applied)
- `supabase/migrations/20260906161936_the_three_rpcs_a_client_calls_do_not_wipe_a_table_unqualified.sql` (applied)
- `scripts/ci/check-unqualified-writes.mjs` (new)
- `tests/unqualified-writes-gate.test.ts` (new, 20 cases)
- `.github/workflows/ci.yml`, `.husky/pre-push` — the gate's two readers
