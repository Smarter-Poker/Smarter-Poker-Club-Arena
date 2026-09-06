# Operation Table Stakes - current state and next actions (2026-09-06 10:45 CDT)

Read this before touching `fn_cash_cluster_tick`, `fn_cash_clusters_tick_all`,
`fn_concurrent_game_load`, `server/src/cluster/**`,
`server/src/services/HorseFleetManager.ts`, `HorseSessionRotator.ts`,
`HorseGameLoad.ts`, `HorseTournamentCommitment.ts`, `HorseBankroll.ts`,
`StableHand.ts` or anything under `/hub/club-arena` that draws a cash game.
The plan is `docs/OPORD-1.4-AMENDMENT.md` (section 18 is the lifecycle).

Every number here was READ from production or the repo between 09:29 and
10:45 CDT on 2026-09-06, with the minute it was read. Where a number disagreed
with the previous handoff (05:41 CDT), the number is what is written. The
previous version is superseded in full.

**Do not trust this document. Run section 0 first and report what disagrees.**

## 0. The audit board

```sql
with t as (select fn_cash_stake_band(g.bb) band, tb.id,
  (select count(*) from table_seats ts where ts.table_id=tb.id and ts.left_at is null) seated
  from cash_games g join tables tb on tb.cluster_id=g.id and tb.lifecycle<>'closed' and tb.status<>'closed' where g.enabled),
s as (select ts.user_id, count(*) n from table_seats ts join tables tb on tb.id=ts.table_id join profiles p on p.id=ts.user_id
  where ts.left_at is null and tb.cluster_id is not null and coalesce(p.is_horse,false) group by 1)
select (select count(*) from t) tables, (select sum(seated) from t) seated, (select count(*) from t where seated=0) empty_tables,
 (select json_object_agg(band, json_build_object('t',tables,'p',seats)) from (select band,count(*) tables,sum(seated) seats from t group by band) x) by_band,
 (select json_build_object('opened',count(*) filter (where kind='feeder_opened'),'live',count(*) filter (where kind='feeder_live'),'abandoned',count(*) filter (where kind='feeder_abandoned')) from cash_cluster_events where at > now()-interval '1 hour') feeders_1h,
 (select count(*) from cash_cluster_events where kind='controller_tick_error' and at > now()-interval '1 hour') tick_errors_1h,
 (select count(*) from s) horses_seated_cash, (select round(avg(n),2) from s) tables_per_seated_horse,
 (select json_object_agg(n, c) from (select n, count(*) c from s group by n) y) by_tables,
 (select count(*) from profiles p where coalesce(is_horse,false) and fn_concurrent_game_load(p.id) >= 4) horses_at_cap,
 (select count(*) from tournaments where status='COMPLETING') completing,
 (select count(*) from ca_seat_guard_dryrun) guard_refusals,
 (select count(*) from public.fn_unaccounted_seat_exits()) unaccounted_chip_exits,
 (select engine_version from engine_leader limit 1) engine;
```

Then: `git fetch origin && git log --oneline -40 origin/main`, the last 30
minutes of the engine log (section 2), and
`ENGINE_MONITORING_SSH=root@$HETZNER_SERVER_IP node scripts/ci/check-alert-rules-match.mjs`.

**Engine log caveat (learned 10:20):** `docker logs` holds only the CURRENT
container. The engine is recreated at every :55 cutover, so "zero of X in the
last three hours" means "zero since the last cutover" unless the container is
older than that. Check `docker ps` uptime before you conclude anything from an
absence.

## 1. What merged today (06:00 to 10:45 CDT)

| PR | What | Squash |
| --- | --- | --- |
| #3332 | The monitoring deploy deploys: workflow ships its checkout over the deploy key, `deploy.sh` checkout mode + explicit reloads, `cron_secret` mount, Caddy placeholder guard | merged |
| #3333 | A pass commits what it did: 5.5 s budget in `fn_cash_clusters_tick_all`, 2 s `lock_timeout`, oldest-ticked first, `poker_cluster_pass_deferred` (migration `20260906150956`, applied) | `6091dd5d04` |
| #3334 | A hand torn down mid-deal is not dealt: `dealHand` re-reads the controller after its one await | merged |
| #3327 | **OPEN, auto-merge armed.** Four ceilings on the cash floor (section 3). Migration `20260906144448` is ALREADY APPLIED; the engine half lands at the first :55 after merge | - |
| #3340 | **OPEN.** A finish that deadlocks is retried; a manager past the grace does not hide a COMPLETING row | - |
| (branch) | `fix/the-suspended-heads-up-is-settled-by-a-deal`: migration `20260906153943`, applied; the PR opens on push | - |

Verify a merge by the files (`git cat-file -e origin/main:<path>`), never the
tick (10.82).

## 2. Environment traps, added today

- `docker logs` is per-container; see the caveat in section 0.
- The Supabase MCP `query_logs` backend fails intermittently ("Backend
  error! Retry"). `select ... from logs where source='postgres_logs' and
  event_message='deadlock detected'` with `toString(log_attributes)` works
  when it answers, and it is the only place the OTHER side of a deadlock is
  named. Keep the window under ten minutes.
- `pg_stat_statements.track = top`: statements inside a function are
  invisible. To profile a PL/pgSQL pass, time the calls yourself in a
  rolled-back `DO` block (`/tmp/probe-tick.sql` pattern: temp table of
  per-game `clock_timestamp()` deltas, then `ROLLBACK`).
- The husky pre-commit needs `node` on PATH or `commit --amend` silently does
  nothing and the old commit is pushed. Export the nvm PATH first, every call.
- Bind-mounted files follow their inode: `tar -x` over the monitoring rule
  files leaves the running Prometheus reading the old file. `cp` in place.

## 3. The four ceilings (Dan 2026-09-06: "PROCEED")

Measured 09:29 to 09:45 CDT, before anything was changed:

| Reading | Value |
| --- | --- |
| Horses at the four-game cap | 510 of 1,000 |
| Horses seated at cash / tables each | 175 / 1.66 (83 at one, 69 at two, 21 at three, 2 at four) |
| Tournament bookings | 2,111 across 897 players; 1,377 more than 6 h out, 466 more than 24 h, max 68 h |
| Horses capped by bookings alone | 217 |
| `max_tables` in tags | 333 at 2, 576 at 3, 198 at 4, 473 tourney-only at 1 |
| Fleet cycle | `not sittable ... aggregate_exposure=277 other_club=127 sit_cap=21` |
| Opening feeders | `sittable 15, wanted 6, selected 0`, cycle after cycle (the unexposed horses were the asleep ones) |
| Feeders, 3 h | 25 opened / 14 live / 11 abandoned |

Four stacked ceilings, three of them invented. What #3327 does, and the
migration that is already live:

1. `fn_concurrent_game_load` clause (2) counts a booking only when the
   tournament starts within 60 minutes (NULL start = seat-first, always).
   `HorseGameLoad.bookingIsAGame` mirrors it; the fleet fetch carries
   `start_time`. **Never more than four LIVE seats** - that invariant is
   untouched (client has four tabs; `fn_enforce_four_table_limit` unchanged).
2. `MAX_TABLES_BY_PERSONA` is 4 for every cash persona; the 909 live tags
   below four were raised in the migration.
3. `AGGREGATE_EXPOSURE_MULTIPLE` 3 -> 4.
4. `HorseTournamentCommitment` + `HorseSessionRotator.leaveCashForTournaments`:
   a horse whose live seats plus imminent bookings exceed four stands up from
   the cash seat it has held longest (no-human table first), a hazard over
   T-60..T-15 and certain inside T-15, through `engine.leaveTable`. This is
   what closes the gap the window opens.

Lane split (30 / 30 / 40 by tag, 42% of horses tourney-only) is Dan's
2026-08-26 ruling and was not touched.

**Read at 10:44 CDT, with only the database half live:** seated 355 (from
282), horses at cash 215 at 1.65 tables (from 175), horses at the cap 13
(from 510), feeders last hour 18 / 14 / 4 (78% live, from 56%), tick errors
in the last hour 0, empty tables 52 of 132 (dormant games' Main 1; by
design, but 39% of the open floor).

**After the first :55 with #3327 in the engine, in this order:**
1. Tables per seated horse - should climb from 1.65 toward 3-4.
2. `[HorseFleet] not sittable` - `aggregate_exposure` should fall from 277.
3. `feeder_live / feeder_opened` over the hour against 14 / 18.
4. `[SessionRotator] tournamentLeaves=` in the hour before the Sunday Funday
   events (Warm-Up ~19:00 CDT, Main Event ~21:00 CDT).
5. `poker_cluster_pass_deferred` - zero is normal; a pass that defers every
   time is a controller behind its cadence, and then profile the per-game
   tick.

## 4. What else was found and done today

**The controller was down 65 minutes and nobody was paged.** 06:38-07:43
CDT, 683 `controller_tick_error` rows, every one `constraint
"managed_game_contract_version_game_kind_game_id_contract_ha_key" ... does
not exist` - a table-management migration replaced a constraint a function
the tick reaches still named; a later migration in that programme fixed it.
`ClusterPassErrors` was declared and NOT LOADED: the box ran 9 alert groups,
the repo 12; 17 rules including the whole cluster group and the canary were
missing, because the deploy workflow's first run had `curl`ed
raw.githubusercontent for a private repo (404, empty stdin, green). Synced
by hand at 10:00 CDT (89 declared, 89 running, canary alive), then #3332.

**The tick was hitting the 8 s statement timeout** (mean 1,187 ms, max
7,993 ms, nine whole-pass rollbacks in 3 h) while the work is 3.3 s for all
108 games in isolation. #3333, live.

**Five tournaments finished paid and stuck COMPLETING** on a deadlock between
the COMPLETED flip's seat-clearing trigger and `atomic_seat_cashout_locked`;
the watchdog skipped them because their managers never returned. Another
agent ordered the locks (`20260906152756`, `20260906152700`, 15:27Z);
#3340 retries the flip and un-hides the manager. All five flipped by hand
with the engine's own guarded statement, no chips moved.

**PLO4 Heads-Up 25 (3e281f5c), suspended two-handed for three days,** was
settled by a chip-proportional deal (47.50 / 23.75, ICM for two) through
`fn_ca_adjustment_under_10_9` + `fn_settle_tournament_obligation`, rake
settled, COMPLETED. Migration `20260906153943`, changelog
`2026-09-06-the-suspended-heads-up-is-settled-by-a-deal.md`.

**`dealHand` threw on a null controller** four times when a table was broken
during its one await. #3334, lands at :55.

## 5. What is NOT done, ranked

1. **Two spins are COMPLETING right now** (a91d1d51, 3474dd63, 0 alive,
   read 10:45). #3340 will recover this shape once deployed; until then the
   flip is by hand: `UPDATE tournaments SET status='COMPLETED', ended_at=now(),
   on_break=false, break_ends_at=null WHERE id=... AND status='COMPLETING' AND
   NOT EXISTS (live players)` - check `chip_ledger` shows the prize first.
2. **Why did the running engine not adopt a RUNNING tournament with no
   manager?** 3e281f5c sat RUNNING 20 minutes after revival; PostgREST
   returned it in the RUNNING list; the discovery loop never logged
   "Resuming". Either `tournamentEngines.has(id)` was true for a manager
   never logged, or something between the read and the claim skipped it. No
   debug endpoint lists the managers; adding one to `/health` (ids only) is
   the cheap way to answer this next time.
3. **The boot-time stale sweep** flips any RUNNING tournament older than 12 h
   with no hand in the last hour to COMPLETING and hands it to recovery,
   which refuses a live field. That is very likely how 3e281f5c got stuck on
   09-03, and it will do it again to any suspended event across a cutover.
4. **Deadlocks between two `syncTournamentChips`** (21 in the hour after
   14:55Z). Not the pair the 15:27Z fixes ordered. Needs the Postgres side
   (section 2 query) to name the second statement.
5. **Tournament leases:** `[tournament-lease] 208 of 213 leases were missing
   or stale, not taken - re-claiming` every cycle. Fail-open, so nothing
   breaks, but a lease nobody heartbeats is not a lease.
6. **One definition of a game's player count** (three derivations; unchanged
   from the last handoff).
7. **Migration ledger drift is one mechanism:** since 09-01, 164 files with
   no record and 256 records with no file, but 137 + 129 of those are the
   same migration under two versions because the MCP `apply_migration`
   stamps its own timestamp. 27 file names never in the ledger - six sampled,
   all six in production under another name. The durable fix is a rule that
   the recorded version equals the file's (apply with psql under the file's
   version, as every migration today was), not another mirror pass.
8. **Zero humans sat at a cash cluster table in the last 24 hours** (read
   09:42). Everything on the floor is horses playing horses.
9. **`fn_ca_guard_seat_creation` still says "It LOGS the refusal"** - false;
   fold into the next change to that function (28 s reload otherwise).
10. Already done by others, drop from any list you inherit: `pldbgapi2` is
    gone; `financial_alerts` is 264 unresolved / 99 critical (862 resolved
    in 24 h by the chip-standard programme); `settlement_barrier_abandoned` is
    0.

## 6. Laws that bit today

- 10.82: autopilot merged #3333 within minutes; the follow-up pin fix for
  #3327 went to the same OPEN branch (fine) - it would have been a new
  branch had it merged.
- 10.84: a rule is live when `/api/v1/rules` says so. The cluster group was
  not, for a day.
- 10.9: the deal, the five flips, and the revival all went through the
  platform's own functions with a rolled-back probe first. The 10.9 door for
  an agent is `fn_ca_adjustment_under_10_9` in a migration whose name the
  200-character paragraph must contain.
- 11.5: `fn_final_table_deal` could not be used (the deal flag is locked by
  the management contract after registration); the same numbers went
  through `fn_settle_tournament_obligation` under kind `final_table_deal`.
- 5.8: two pins moved with their mechanisms in the same commit
  (`theFeederKeepsItsBuyers`, `ChipContinuity.law` door count 3 -> 4).

## 7. Where things are (additions)

- `server/src/services/HorseGameLoad.ts` - `BOOKING_COUNTS_WITHIN_MS`,
  `bookingIsAGame`.
- `server/src/services/HorseTournamentCommitment.ts` - the leave-for-tournament
  verdict; wired in `HorseSessionRotator.leaveCashForTournaments`.
- `server/src/tournament/completedFlip.ts`, `completingDwell.ts`
  (`managerHasOverstayed`) - #3340.
- `supabase/migrations/20260906150956_a_pass_commits_what_it_did.sql` is the
  live `fn_cash_clusters_tick_all`; the law test pins it as `TICK_ALL_PASS`.
- `infra/monitoring/deploy.sh` checkout mode; `.github/workflows/deploy-monitoring.yml`.
- Changelogs under `docs/changelog/2026-09-06-*`.
