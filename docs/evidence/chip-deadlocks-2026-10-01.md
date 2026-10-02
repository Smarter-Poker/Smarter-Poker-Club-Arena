# Chip deadlocks, 2026-10-01: the pairs, the one order, and what it changed

**Verdict:** not a full tick. In like-for-like hours deadlocks fell by a quarter (1,429 on 30
September, 1,083 on 1 October, 01:05-12:04 UTC, with 21% more cash raked hands): about 3,600 a day
before, about 2,400 a day after. Pairs 1 and 5 are gone and pair 4 nearly so; pair 2 (PR #5542's,
which that PR would not end) and pair 3 (fixed, then reverted; no safe order yet) are 95% of what
is left, and `DatabaseDeadlocksElevated` still fires.

Production counted 3,605 deadlocks in the 24 hours to 2026-09-30 23:16 UTC, over the
`DatabaseDeadlocksElevated` line (10 in 10 minutes) in most minutes of the day. This file ranks them
by pair from production's own log, names each pair's two code paths and the order each takes its
locks, records what was fixed and how it was proved, and measures production before and after.

## How it was measured

- **Production, read only.** The Postgres log through the Supabase log query endpoint
  (`postgres_logs`, ClickHouse SQL; 24 h windows). `log_lock_waits` is on in production, so every
  deadlock writes one `process N detected deadlock while waiting for ... after 1000 ms` line with
  the victim's full call stack (`parsed.context`) and the holder's process id, **including the
  deadlocks a function catches**; an uncaught one also writes `ERROR: deadlock detected` with both
  processes' statements. The 3,605 LOG lines match `pg_stat_database.deadlocks` (the operating
  envelope read 3,577 for the 24 h to 12:41 UTC). Live definitions, md5s, grants and triggers with
  `supabase db query --linked` selects. `pg_stat_database` sampled every 5 minutes from 23:59 UTC
  (`deadlocks-work/sampler.sh`, passive). Nothing was written to production except the one
  migration below, rehearsed first.
- **Isolation.** `scripts/qualification/chip-deadlocks.py` on the Mac Studio (Apple M3 Ultra,
  28 cores, 96 GiB, macOS 26.5.2), PostgreSQL 17.11 (Homebrew), its own cluster (socket only, no
  TCP listener, `deadlock_timeout=200ms`, `log_lock_waits=on`).

## The pairs, ranked

Victims counted by the rows they were waiting for when Postgres chose them (24 h to 2026-09-30
23:16 UTC). The partner comes from the `ERROR` lines where the victim did not catch the deadlock
(they name both statements) and, for caught ones, from the holder process's own log lines in the
same seconds (sampled 22:00-23:20 UTC; for example at 22:26:51-53 the finish in pid 636117 waited
on `ca_club_commission_daily` held by a batch transaction that two hand projections were also
queued behind, and the batch in pid 644424 then deadlocked on `agent_commission_unsettled_rollup`
held by pid 636117).

| #   | rows                                                              | path A, its lock order                                                                                                                                                                                                                                                                                                                                                                                                                 | path B, its lock order                                                                                                                                                                                                                                                | victims / 24 h                                                                                                                           | status                                                         |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | `agent_commission_unsettled_rollup`, `ca_club_commission_daily`   | cash accrual batch `fn_credit_agent_commissions_batch` (engine RakebackSettler, ~31 hands per call, **one transaction**) > `fn_process_cash_accounting_source` > `fn_accrue_cash_hand_commissions` > `fn_post_accounting_commission_source`: per tier an `agent_commissions` insert whose trigger takes the agent's row, then the club's day row; tier 2's agent row after the day row; hands in hand order, every row kept to the end | tournament finish `fn_complete_tournament_terminal` > `fn_settle_tournament_rake` > `fn_recognize_accounting_tournament_fees`: per source (club, player order) the same insert: agent row, then day row                                                               | 1,111 (batch 695 on the agent row, 35 on the day row; finish 347 on the day row, 23 on the agent row, 5 on `agents`; retry 2; payouts 4) | fixed                                                          |
| 2   | `player_stats`                                                    | the same batch: `apply_rakeback_player_stats` (+1 hand) per hand in (club, player) order, across hands in hand order, kept to the end (about 9 s)                                                                                                                                                                                                                                                                                      | the hand's stats projection (`fn_project_hand_side_effects_after_post_commit_20260908`, Projection 2: one multi-row upsert, no `ORDER BY`) and its promo playthrough (`promo_apply_playthrough`)                                                                      | 961 (batch 606, projection 200, promo 123, retry 22, finish 7, refresh 3); 188 of the projection's 200 `ERROR` lines name the batch      | **PR #5542's pair, not fixed**                                 |
| 3   | `vip_points_carry`, `club_wallets`, `ca_club_rake_daily`          | tournament finish: tournament row > `club_wallets` > `union_wallets` > `clubs` (`fn_complete_tournament_terminal_pre_seat_guard`) ... rake recognition > players' VIP carry (player order)                                                                                                                                                                                                                                             | a raked hand's obligations (`fn_ca_process_hand_post_commit_obligations`, alone or inside `fn_project_hand_side_effects`) > `atomic_distribute_rake`: rake record insert, whose triggers take the players' VIP carry and the club's day rake row, then `club_wallets` | 837 (finish 432 on VIP carry; hands 238 on `club_wallets`, 131 on the day rake row, 15 on VIP carry, 21 on `club_members`)               | fixed, then **reverted** (it made finishes queue behind hands) |
| 4   | `profiles`                                                        | tournament finish: rake recognition writes `player_stats` with **+0 hands** per entrant (club, player order); the trigger `fn_sync_profile_total_hands` rewrites each entrant's profile                                                                                                                                                                                                                                                | horse claims `fn_ca_horse_claim_due` (up to 500 claims, one transaction): each claimed horse's profile in claim order (`fn_lock_daily_mission_user`, `add_diamonds_to_balance`); and the batch (+1 hand) through the same trigger                                     | 346 (finish 126, horse claims 140, batch 71, satellites 8, refresh 1); 29 `ERROR` lines name finish x horse claims                       | fixed for the finish; batch x claims remains                   |
| 5   | `horse_mind_pairs`, `horse_mind_stats`, `horse_mind_stats_scoped` | horse-mind flush (`upsert_horse_mind_*`, a row at a time in the caller's list order)                                                                                                                                                                                                                                                                                                                                                   | another flush at the same moment (every five minutes, xx:x5:44)                                                                                                                                                                                                       | 271 (pairs 161, scoped 62, stats 48) - not a chip path                                                                                   | fixed                                                          |
|     | everything else                                                   | `clubs` at tournament launch (17), `club_members` at seat and buy-in (17), BBJ pools and union wallets x `fn_sweep_bbj_promo_all` (23), horse treasury funding (3), tournaments (4), others (15)                                                                                                                                                                                                                                       |                                                                                                                                                                                                                                                                       | 79                                                                                                                                       | below the top set                                              |

Most of these never reach the `ERROR` log (919 of 3,605 did): the batch catches its deadlock per
item (the hand is refused and retried after 60 s times the attempt), the finish retries its rake
recognition up to four times with 0.1 to 0.6 s sleeps, and the horse claims catch per claim.

Three paths swallow the deadlock and drop the work: `trg_ca_club_rake_daily_insert` catches it and
the hand is missing from `ca_club_rake_daily` (the Financials per-day rake; 130 warnings in the
24 h), `fn_award_vip_points_from_rake` catches per award and the VIP points are not credited (15
warnings), and `promo_apply_playthrough` swallows its `player_stats` failure and the wager is not
added to `total_losses` (pair 2's 123). The first two are pair 3 and the third is pair 2; what is
left of each is under Production before and after.

## PR #5542

Open, draft, no review, CI green on 2026-09-28; its owner has not touched it since 2026-09-28
20:06 UTC (more than 24 hours). **Not landed and not changed here**:

- It is not ready. Its migration redefines
  `fn_project_hand_side_effects_after_post_commit_20260908` in full with the 2026-09-28 body, with
  no md5 pin. Production's body (md5 `ee06376aba27a84ac4759d8ce9f42a1e`) has gained Projection 4b
  since (migration `20260930043000`, the Diamond leaderboard totals); applying the PR would delete
  it silently.
- It does not end its pair. Its `ORDER BY s.uid::uuid` removes the inversion inside one hand, but
  the batch is one transaction over about 31 hands: it holds the rows of earlier hands while it
  takes later ones, so a projection that takes the same players in sorted order still meets it in
  the middle. The isolated case `pr5542-player-stats-across-hands` (the PR's exact statement over
  the live body) deadlocks both before and after this change. The pair needs the batch's
  transaction shortened (fewer hands per call, or the stats write moved out of it); that is an
  engine change outside this file and is left for the lead.

## The one order

Every chip door takes, from the outside in:

1. lanes and scopes (advisory): the settlement lanes, the table and hand keys, the accounting week
   keys (shared, in key order), and **the club's commission key `agent-commission:<club>`, in club
   order, before any commission rollup row of that club**;
2. the tournament row and its evidence;
3. the banks: `club_wallets`, then `union_wallets`, then `clubs` (already the finish's declared order);
4. the club-day rollups, under their club's bank or commission key;
5. the player rows in player order (VIP carry, `player_stats`, `profiles`), and the horse-mind rows in key order.

## What was fixed

Migration `supabase/migrations/20261001000000_the_chip_estate_takes_its_locks_in_one_order.sql`
(md5 `320df438cfa27eade9735c337380d31b`): eight asserted substitutions over the pinned live text,
in one transaction under `lock_timeout 2s`. Each pins the live md5, asserts its clause occurs once,
asserts the measured result md5 and that the reverse substitution reproduces the pin, and that
owner, security and grants did not move.

| function                             | live md5 -> new md5                                                      | change                                                                                                                                                                                                       | pair                               |
| ------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `atomic_distribute_rake`             | `0ef820b10c57d902b5ab2d5f9e2be8a6` -> `ea7a4a403969a0fbe69f2216d63a0436` | locks the club wallet (`FOR NO KEY UPDATE`, bare) after the accounting week key and before the rake record insert                                                                                            | 3 - **reverted by 20261001000500** |
| `trg_agent_commission_rollup_insert` | `50cb43eb54b7924b39c25b9816f450a0` -> `c7e84377219a39d955783d0feae6642b` | takes `agent-commission:<club>` for each club in the inserted rows, in club order, before the agent and day rows                                                                                             | 1                                  |
| `fn_credit_agent_commissions_batch`  | `3b9313fc37e62ca2c0b0bbbc7fdc6dc0` -> `5ebf5489eabbe478d393e2e040683fe8` | takes every club key its cash items earn in (from `rake_attributions`), in club order, before the first item; **since 20261001001000 only those free, without waiting** (`d4572f3e1efd9c85a0025cc2906c6fae`) | 1                                  |
| `fn_retry_cash_accounting_sources`   | `cf43f5cc8e7d47994025cc7682cc18bc` -> `4b62b13c70191e56fe55644070303a97` | the same for the sources it is about to retry; **since 20261001001000 without waiting** (`3788581d5e8f1953663b8929b4688d0a`)                                                                                 | 1                                  |
| `fn_sync_profile_total_hands`        | `918a9211cf484127ab5d326aea1e47b3` -> `f6ee538e4bcfc329dd0e46673b05dc30` | returns before the profile UPDATE when an UPDATE left `user_id` and `hands_played` unchanged (the sum cannot move)                                                                                           | 4                                  |
| `upsert_horse_mind_pairs`            | `c73cb456bd033f8d3f5a03e53b9934b0` -> `389109138a65a4d150b48da5ffa209bb` | walks the input in key order; repeats of one key in input order                                                                                                                                              | 5                                  |
| `upsert_horse_mind_stats`            | `84df6d650c905cedba86f2698f1fbd3d` -> `6802f13c3b1e7b94e62694d1dc1e5fb1` | the same                                                                                                                                                                                                     | 5                                  |
| `upsert_horse_mind_stats_scoped`     | `73884faf30f48913dba34053fdd33337` -> `199192476497889e659b8455c38ea631` | the same                                                                                                                                                                                                     | 5                                  |

Chip behaviour is otherwise unchanged: no amount, receipt, refusal or grant moves; the new keys are
advisory and transaction-scoped; the batch's key read is guarded (a malformed item is skipped by it,
never refused by it). Two notes. A `profiles.total_hands_played` that had drifted from its sum is
no longer re-healed by a `+0` write, only by the next real change. And none of the four functions
the MTT admission contract pins was touched (`fn_post_accounting_commission_source`,
`fn_recognize_accounting_tournament_fees`, `fn_settle_tournament_rake`,
`fn_award_vip_points_from_rake`), and no live function embeds the md5 of any function changed here.

## The wallet-first change was reverted

The first change above was right about the deadlock and wrong about the queue. A raked hand's
obligations now held the club wallet through everything the rake record's insert waits on -
including the foreign-key checks on `profiles` that the horse claims hold `FOR UPDATE`
(`fn_ca_horse_claim_due` runs up to 500 claims in one transaction; at 00:20 UTC one had been open
80 s with 24 sessions behind it). So the club's other hands queued on its wallet row instead of its
day rake row, and a tournament finish, which takes that wallet row first and holds the global
settlement lane while it waits, queued behind all of them. Production's log, read passively:

| measure (production log)                                             | 24 h before the apply (per hour) | 00:05 to 00:15 UTC after the apply |
| -------------------------------------------------------------------- | -------------------------------- | ---------------------------------- |
| finish (`fn_complete_tournament_terminal`) statement timeouts (45 s) | 0 in every hour                  | 2                                  |
| finish lock waits over 1 s on `club_wallets`                         | 0 to 15                          | 80                                 |
| hand obligations' statement timeouts inside `atomic_distribute_rake` | 38 to 2,566 (median about 450)   | about 1,300                        |
| deadlocks (all)                                                      | 34 to 340                        | 28                                 |

From the apply to the revert four finishes hit that timeout (00:09:46, 00:11:51, 00:16:11, and
00:17:55 for one begun before the revert landed); none has since, to 12:04 UTC.

Fewer deadlocks, but a failed tournament settlement is worse than a deadlock the finish retries.
`supabase/migrations/20261001000500_a_raked_hand_takes_its_club_wallet_where_it_did.sql` (md5
`0951c9e1b4dda2878c41d5d262d6a3d9`) restores `atomic_distribute_rake` byte for byte (pinned
`ea7a4a403969a0fbe69f2216d63a0436` back to `0ef820b10c57d902b5ab2d5f9e2be8a6`, reverse proved):
`REHEARSAL OK: atomic_distribute_rake restored to 0ef820b10c57d902b5ab2d5f9e2be8a6, the other
changes stand, nothing opened` (fixture `chip-deadlocks-2026-10-01/rehearsal-fixture-revert.sql`),
then `APPLIED AND RECORDED 20261001000500` at 00:17:19 UTC, twelve minutes after the first. The
other seven changes stand. Pair 3 is open again: its order has to be one in which a finish never
waits on a hand that is itself waiting on the horse claims - for example the finish taking its
entrants' VIP carry rows before the wallet, or the horse claims no longer holding profiles
`FOR UPDATE` across 500 claims. That needs its own measurement; the decision is under Production
before and after.

## The batch's up-front keys failed it whole - fixed

The second change above had the cash accrual batch and the retry WAIT for every club key before
their first item. That wait sits outside the per-item refusal blocks, and the engine's role has
`lock_timeout 8s`; a tournament finish holds a club's key for the rest of its run. At 00:07:30 UTC a
batch waited 8 s for one and failed whole (`canceling statement due to lock timeout`, at that line).
The settler holds its cursor on a failed batch: `daemon_state.rakeback_settler` stopped at
00:03:25 UTC (high-water mark 2026-09-30 22:50:49), so no cash commission accrued from then until
the fix. Before the change the same wait happened inside an item, where a timeout refuses that one
item for retry.

`supabase/migrations/20261001001000_a_cash_batch_never_waits_for_a_commission_key.sql` (md5
`cccf879ea68dccc69c5d01c6084d1749`) makes both walks non-blocking - `pg_try_advisory_xact_lock` in
club order, stopping at the first key someone holds; the rest are taken item by item in the trigger
as before. Pinned asserted substitutions: `fn_credit_agent_commissions_batch`
`5ebf5489eabbe478d393e2e040683fe8` -> `d4572f3e1efd9c85a0025cc2906c6fae`,
`fn_retry_cash_accounting_sources` `4b62b13c70191e56fe55644070303a97` ->
`3788581d5e8f1953663b8929b4688d0a`. `REHEARSAL OK: the cash batch and retry try their commission
keys and never wait for one outside an item; refusals unchanged; nothing opened` (fixture
`chip-deadlocks-2026-10-01/rehearsal-fixture-batch-keys.sql`), then `APPLIED AND RECORDED
20261001001000` at 01:05:09 UTC. The isolated case `batch-while-a-finish-holds-a-key` (a session
holds the club's key, the batch runs with `lock_timeout 1s`) shows all three states: the original
bodies complete; after 20261001000000 the batch fails whole with the lock timeout - production's
00:07:30 failure; after 20261001001000 the call succeeds and only that item is refused for retry.

The settler's cursor moved again at 01:27:00 UTC. It had already been about an hour behind when the
first migration was applied (the conservation sweep's settler-lag check fired at 23:55 UTC on 30
September); the failed batches then stopped it from about 00:04 to 01:27, and the backlog met the
night's busiest cash hours (5,800 to 6,700 cash raked hands an hour from 01:00 to 05:00 UTC).
Between about 03:00 and 05:00 it nearly stopped, with no batch error and one batch lock wait in
the database log, so that part is in the engine's loop, not on a lock; the 02:00 hour's hands
took until 05:25. It caught up at about 07:30 UTC:
hands raked from 22:50 on 30 September to about 07:00 on 1 October were accrued up to 2 h 53 min
late (hands from 02:00 waited 153 minutes on average); from 07:00 the wait is back to its usual 15
to 22 minutes on average (the settler runs every 30 minutes), and the settler-lag check resolved at
06:23. Nothing was lost: each of the 56,032 cash raked hands from 22:00 on 30 September to 12:00 on
1 October has its first accounting receipt, no cash source is waiting for a retry (the only blocked
work rows are the 35,994 legacy-unverified ones parked since 2026-09-20/21), and at 12:07:12 UTC
the cursor's high-water mark was 12:05:42.

## Proved in isolation, before and after

```sh
PG_BIN=/opt/homebrew/opt/postgresql@17/bin \
python3 scripts/qualification/chip-deadlocks.py --work <empty dir on a big disk> --out <result.json>
```

The runner loads production's 26 bodies (`chip-deadlocks-live-doors.sql`, md5s in
`chip-deadlocks.manifest.json`; it refuses to run if any differs) and the four triggers that reach
them over production's column shapes (`chip-deadlocks-schema.sql`); five read-only helpers are
stubbed (`chip-deadlocks-stubs.sql`, each with its reason). Each case drives real concurrent psql
sessions into the interleaving the log shows (a pause gate before one key's row, and `pg_locks`
to see a session wait), first on the live bodies, then after the runner has executed the three migrations' own `$subs$` blocks in order (`20261001000000`, the revert `20261001000500`, then `20261001001000`) - the text measured is the text applied. Deadlocks are counted from the cluster log, as production's are. Run 2026-10-01 00:52:52 to 2026-10-01 00:53:08 UTC, result in `chip-deadlocks-2026-10-01/isolated-run.json` (earlier runs, before the revert and the key fix existed, gave the same before numbers):

| case                                      | pair    | before: deadlocks, victim                       | after: deadlocks, outcome                                                                                                                          |
| ----------------------------------------- | ------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| commission-rollups-one-club               | 1       | 1, the finish (waiting on the day row)          | 0; the finish waits for the batch's club key, both complete                                                                                        |
| commission-rollups-two-clubs              | 1       | 1, the finish                                   | 0; both complete                                                                                                                                   |
| finish-vs-raked-hand                      | 3       | 1, the hand (waiting on `club_wallets`)         | 1 - reverted; 0 with 20261001000000 alone                                                                                                          |
| finish-vs-two-raked-hands                 | 3       | 2 (a hand on the day rake row, then the finish) | 2 - reverted; 0 with 20261001000000 alone                                                                                                          |
| finish-vs-horse-claims                    | 4       | 1, the finish (waiting on `profiles`)           | 0; the finish never waits                                                                                                                          |
| horse-mind-pairs / -stats / -stats-scoped | 5       | 1 each, the second flush                        | 0 each; the second flush waits, both complete                                                                                                      |
| pr5542-player-stats-across-hands          | 2       | 1, the projection with PR #5542's `ORDER BY`    | 1 - not changed here, see above                                                                                                                    |
| batch-while-a-finish-holds-a-key          | 1 (key) | completes (the original bodies take no key)     | after 20261001000000 alone: the whole batch fails on the lock timeout; after 20261001001000: the call succeeds, that one item is refused for retry |

Every deadlock named the relation production's victims name (`ca_club_commission_daily`,
`club_wallets`, `vip_points_carry`, `profiles`, the three horse-mind tables, `player_stats`). A
single session upserting horse-mind rows with a repeated key listed out of order left identical
rows before and after.

## Rehearsed and applied

- Rehearsal (`rehearse.sh`, migration and `chip-deadlocks-2026-10-01/rehearsal-fixture.sql` md5
  `4ee51c0d15a58b3f0d86754784f714f2` in one rolled-back transaction; single-session checks only):
  `REHEARSAL OK: eight chip bodies take their locks in one order (each md5 as measured), refusals
unchanged, horse-mind values unchanged, estate checks passed, nothing opened`. The migration's own
  final block passed in it: grants (no `anon` or `authenticated`, `service_role` kept), the
  settlement lane doctrine ok, both arena switches closed, the Diamond identity difference 0, no
  watched guard off its baseline.
- Pins re-read immediately before apply: all eight unchanged.
- `apply.sh` at 00:04:59 UTC: `APPLIED AND RECORDED 20261001000000` (finished 00:05:08 UTC); all
  eight `@live-proof` lines read true afterwards.
- Pinned by `tests/the-chip-estate-takes-its-locks-in-one-order.law.test.ts` (10 cases).

## Production before and after

Read passively: `pg_stat_database.deadlocks` every 5 minutes (`deadlocks-work/sampler.sh`) and the
log's `detected deadlock` lines by pair (the queries are under Re-running). The after window opens
8 s after the last apply (`20261001001000`, 01:05:09 UTC) and ends at the last sample before this
was written: 01:05:17 to 12:04:00 UTC on 1 October, 10.98 hours, 132 samples none more than 304 s
apart, no counter reset. The counter went from 7,318 to 8,401 - **1,083 deadlocks** - and the log
has exactly 1,083 lines in the window. The rate has a daily shape (2,176 of the 3,605 fell outside
these clock hours), so the like-for-like comparison is the same hours on 30 September, from the
log (the sampler started at 23:59 UTC on 30 September).

| deadlocks, by the rows the victim waited for | 24 h to 30 Sep 23:16 UTC | 30 Sep 01:05-12:04 UTC | 1 Oct 01:05-12:04 UTC |
| -------------------------------------------- | ------------------------ | ---------------------- | --------------------- |
| all                                          | 3,605                    | 1,429                  | **1,083**             |
| 1 commission rollups                         | 1,111                    | 443                    | **0**                 |
| 2 `player_stats` (PR #5542's pair)           | 961                      | 374                    | 630                   |
| 3 VIP carry, `club_wallets`, day rake row    | 837                      | 353                    | 401                   |
| 4 `profiles`                                 | 346                      | 113                    | **15**                |
| 5 horse-mind                                 | 271                      | 110                    | **0**                 |
| everything else                              | 79                       | 36                     | 37                    |

| the same hours (read-only counts and the alert's own rows) | 30 Sep  | 1 Oct   |
| ---------------------------------------------------------- | ------- | ------- |
| hands dealt (`hand_history`)                               | 467,540 | 479,796 |
| cash raked hands (`rake_records`)                          | 37,618  | 45,513  |
| tournaments settled with rake (`rake_records`)             | 11,202  | 10,590  |
| deadlocks per 1,000 cash raked hands                       | 38.0    | 23.8    |
| `DatabaseDeadlocksElevated` firings, minutes firing        | 23, 278 | 15, 267 |

**Per day: before 3,605; after about 2,400** (1,083 in 10.98 hours is 2,367 a day at that pace; if
the evening keeps 30 September's shape, a whole day comes to about 2,700).

What is left:

- **Pair 2 rose**, 374 to 630: the batch was the victim in 380, the hand projection in 164, the
  promo playthrough in 68, the retry in 4. Cash raked hands rose 21%, and the pair swings hard by
  the hour on both days (0 to 135 an hour on 1 October, 3 to 94 on 30 September). Batch items that
  pair 1 used to kill now go on to take their players' `player_stats` rows, but those were 277
  of 37,618 items on 30 September, so they explain little of it. A batch victim is refused and
  retried (none is waiting now); a promo victim's wager never reaches `total_losses`. PR #5542 would
  not end it (above). What would is a shorter cash batch transaction: the engine sizes each call to
  about 9 s (`server/src/services/cashAccountingBatchBudget.ts`), and the call keeps every row and
  key it takes to its end. That is an engine change, left for the lead with PR #5542's owner.
- **Pair 3 stays open**, 353 to 401: finishes waiting on VIP carry 174 to 204, hands waiting on a
  club wallet 104 to 176, VIP awards inside a hand 4 to 7, promo 11 to 14, and the day rake row 60
  to 0 (another agent's #5687 takes that row at commit since 1 October). Decided by Claude on Dan's
  delegation of 2026-09-30 ("these are all for you to decide not me ... FIX AND FINISH ALL OF
  THESE"): no second attempt from this line. The wallet-first order ended the pair and made
  finishes queue (above), and the two orders left each make one busy row wait on another: a finish
  taking every entrant's VIP carry row before the wallet would hold one row per player, across all
  clubs, for its whole run; a hand awarding VIP after its wallet would hold the club's wallet while
  it waits on a finish anywhere. Meanwhile each of these deadlocks resolves in about a second, both
  sides retry, and the only work it is known to drop is the swallowed VIP award (7 in these hours, 4 the day
  before).

Side effects in the same hours (production log):

| measure                                                               | 30 Sep        | 1 Oct           |
| --------------------------------------------------------------------- | ------------- | --------------- |
| finish statement timeouts (45 s)                                      | 0             | 0               |
| finish lock timeouts (8 s, all but one or two at the settlement lane) | 856           | 1,227           |
| finish waits over 1 s at its commission step (total time waiting)     | 855 (3,590 s) | 1,170 (5,207 s) |
| hand obligations' statement timeouts                                  | 4,559         | 3,941           |
| uncaught `deadlock detected` errors                                   | 389           | 417             |
| cash batch or retry errors                                            | 0             | 0               |

A finish now waits for a club's commission key where it used to wait for, and deadlock over, that
club's rollup rows, and the batch takes its free keys when it starts rather than at its first item
of the club. The finish's waits there grew 37% (45% in time) and its lane timeouts 43% (a timed-out
finish is retried), against 21% more cash raked hands and 5% fewer tournaments; no finish timed out
its statement. On 1 October the lane timeouts moved with the batch's own deadlocks: 12 to 43 an
hour in the three hours with almost none (03:00, 04:00 and 08:00 UTC), up to 325 in the busiest.
The passive data cannot split load from the key; the shorter batch is the lever for both.

## Re-running

The isolated run is the command above. The production ranking is the query
`select replaceRegexpAll(extract(log_attributes['parsed.context'], '^([^\n]*)'), '\\([0-9]+,[0-9]+\\)', '(*)'), extract(log_attributes['parsed.context'], 'PL/pgSQL function ([a-zA-Z0-9_]+)'), extract(log_attributes['parsed.query'], '(?:public\\.|"public"\\.")([a-zA-Z0-9_]+)'), count(*) from logs where source='postgres_logs' and event_message like 'process % detected deadlock while waiting%' group by 1,2,3`
over a 24 h window; the partner of an uncaught one is in the `ERROR` line's `parsed.detail`.

The before and after split by pair classifies the same lines (run it per window, at most 24 h):

```sql
select multiIf(rel in ('agent_commission_unsettled_rollup','ca_club_commission_daily') or (rel='agents' and inner_fn='fn_post_accounting_commission_source'), '1 commission rollups', rel='player_stats', '2 player_stats', rel in ('vip_points_carry','club_wallets','ca_club_rake_daily','ca_club_rake_daily_user') or (rel='club_members' and inner_fn='promo_apply_playthrough') or inner_fn='atomic_distribute_rake', '3 vip/wallet/day rake', rel='profiles' or inner_fn in ('fn_lock_daily_mission_user','fn_sync_profile_total_hands','claim_daily_challenge_serialized_body'), '4 profiles', rel like 'horse_mind%' or top like 'upsert_horse_mind%', '5 horse-mind', 'other') as family, count(*) as n
from (select extract(log_attributes['parsed.context'], 'relation "([a-z_0-9]+)"') as rel,
             extract(log_attributes['parsed.context'], 'PL/pgSQL function ([a-zA-Z0-9_]+)') as inner_fn,
             extract(log_attributes['parsed.query'], '(?:public\\.|"public"\\.")([a-zA-Z0-9_]+)') as top
      from logs where source='postgres_logs' and event_message like 'process % detected deadlock while waiting%')
group by family order by family
```

The counter is `select deadlocks from pg_stat_database where datname='postgres'`, read every 300 s.
