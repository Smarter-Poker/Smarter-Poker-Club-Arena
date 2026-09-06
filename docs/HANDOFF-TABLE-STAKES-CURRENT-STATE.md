# Operation Table Stakes - current state and next actions (2026-09-05 20:40 CDT)

Read this before touching `fn_cash_cluster_tick`, `fn_cash_clusters_tick_all`,
`server/src/cluster/**`, `server/src/services/HorseFleetManager.ts`,
`StableHand.ts`, `HorseBehavior.ts`, `HorseSessionRotator.ts`,
`SeatMovePresence.ts` or anything under `/hub/club-arena` that draws a cash
game. The plan is `docs/OPORD-1.4-AMENDMENT.md` (section 18 is the autonomous
lifecycle). The Gate 7 recon is `docs/HANDOFF-TABLE-STAKES-GATE-7.md`.

Every number below was READ from production or from the repo between 20:30 and
20:40 CDT on 2026-09-05. Each carries the minute it was read. Nothing is
assumed, and where a number disagreed with what the previous session believed,
the number is what is written.

The previous version of this file was written at 02:45 CDT the same day. It is
superseded in full: eleven pull requests merged between then and now.

## 1. What merged today

All of these are on `main` and their migrations are applied. Verified by
`git log origin/main --grep='(#NNNN)'` at 20:34 CDT.

| PR             | What                                                                                                                                                            | Squash    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| #3090          | Gate 7: every cash table is a game. 41 games adopted, the fleet spawns and retires nothing, the database refuses a cash table with no game                     | 43a8b1070 |
| #3091          | Horses use the seat change; presence follows the move                                                                                                          | 8c681be83 |
| #3093          | The 02:45 handoff (the file you are reading, previous version)                                                                                                 | 36a41de0c |
| #3105, #3109   | The fleet: a buyer is counted once (one sit predicate for the count and for the chair), a barred horse is not a buyer (VPIP bar and rejoin floor read once per cycle), a disabled game is not seeded, no lone horse (a cluster table is seeded to two or not at all; a horse alone at a dead table for 10 minutes leaves), per-opening-feeder diagnostic line | a1dd0b5b7, dafbe05bd |
| #3119          | One tick RPC per pass (`fn_cash_clusters_tick_all`); dormant games rest at 30 s; a seat change wakes its game                                                   | 171b6b063 |
| #3120          | Cluster metrics that page, and a deploy that proves the version moved (`scripts/ci/prove-engine-version-moved.mjs` in `auto-deploy-hetzner.yml`)                | b33c35bd5 |
| #3121          | The felt says a move is coming; the must-move list has names; the mobile card says the style; the stakes menu counts styles; staff see the tick                | 06896fe0c |
| #3169, #3196   | The resume arrives in installments (8 waves across the first seconds of :00, stable-hash order, tournaments interleaved); the 10-board rolled-back probe harness (`scripts/dev/probe-cluster-boards.sql`, `npm run probe:cluster`); the `fn_cash_*` definer audit | f238217e4, 2e41bb91f |
| #3172, #3176   | The tick: orbit hysteresis, lifecycle follows status, a lone feeder becomes Main 1, a second chair goes home, Main 1 looked up on the LIVE board (this one ended a loop that opened 3,000 tables on one game), the break consolidates a thin game (the maintain-floor clause was refusing every break that mattered), `current_players` follows the seats | 4dff2ebb5, 7a0e1b10b |
| #3213          | A horse plays the stake its bankroll supports. `PHASE_MAX_BB` deleted, `STAKE_LADDER` extended to 25/50, the two band functions collapsed to one (`stakeBandForBigBlind`), `assignPreferredStakes` takes the roll as a ceiling, fleet re-tagged. Also fixed a `max_tables` CHECK that had made ANY re-tag impossible | 299cf7afb |
| #3224          | Action and Madness are one game per blind category per game type; plus the worklist fix                                                                          | 7a1d19390 |

**#3224 is MERGED**, not open. It landed at 01:31:46 UTC (20:31 CDT), about
five minutes before this file was written. Do not go looking for an open PR.

## 2. Dan's two rulings today, verbatim and binding

**On the ladder (#3224):**

> "WE NEED TO CONSOLIDATE 'ACTION' AND 'MADNESS' TO ONE GAME PER BLIND
> CATEGORY. ONE MICRO, ONE SMALL, ONE MID, AND ONE HIGH PER GAME TYPE.
> 'CLASSIC' SHOULD HAVE ALL THE GAME SAME STAKES IT HAS."

With the numbers in front of him he then chose NOT to fill the missing mid and
high rungs now. Dedupe only. Do not read "one micro, one small, one mid and one
high" as an instruction to create the missing ones.

"PER GAME TYPE" is the variant, and that is how it was built. The index is

    CREATE UNIQUE INDEX cash_games_one_per_band_action_madness
      ON public.cash_games (club_id, template_name, variant, fn_cash_stake_band(bb))
      WHERE enabled AND template_name IN ('action','madness')

so nine variants x four bands is the ceiling for each of Action and Madness,
not four games each. Read at 20:33 CDT: 20 enabled Action games over 9 variants
and 20 enabled Madness games over 9 variants, no two of them sharing a
(variant, band). If you count enabled Action games by template alone you will
get nine at micro and conclude the law is broken. It is not; you dropped
`variant`.

**On stakes (#3213):**

> "THERE ISN'T A 'CAP'. HORSES CAN ONLY PLAY ABOVE 1/2 IF THEY HAVE THE
> 'PROPER BANKROLL' TO PLAY A BIGGER STAKE."

The bankroll is the only ceiling. A rich horse is not forced UP a ladder it did
not draw into, and a poor one is never tagged into a game it cannot fund. The
affordability test is the seat gate's own: balance >= `BUYINS_TO_LICENSE` (20)
x 100 big blinds, so 2,000 x bb.

## 3. Production as read at 20:30 to 20:40 CDT

### The floor (read 20:32, table counts re-read 20:36:52)

| Measure                                        | Value                                             |
| ---------------------------------------------- | ------------------------------------------------- |
| `cash_games` rows / enabled / disabled         | 149 / 108 / 41                                    |
| Enabled games live / dormant                   | 63 / 45                                           |
| Open cluster tables (mains / feeders)          | 130 (117 / 13)                                    |
| Cash tables outside a game                     | 0                                                 |
| Seats on cluster tables                        | 275                                               |
| `cash_game_roster` live rows                   | 275                                               |
| Enabled games ticked in the last 90 s          | 108 of 108                                        |
| Newest tick                                    | 20:36:51, read at 20:36:52                        |

Roster drift is **zero**. It was 298 against 303 at 02:35; #3105 and the
`one_chair_per_player_per_game_is_reconciled_every_tick` migration closed it.

### By stake band (read 20:32)

| Band                | Games enabled | Open tables | Seats | Empty tables |
| ------------------- | ------------- | ----------- | ----- | ------------ |
| micro (bb <= 0.5)   | 59            | 76          | 190   | 31           |
| low (bb <= 2)       | 33            | 38          | 84    | 17           |
| mid (bb <= 6)       | 16            | 16          | 0     | 16           |
| high (bb > 6)       | 0             | 0           | 0     | 0            |

**No 2/5 table has a player yet.** 16 tables at bb >= 5, zero seats, read
20:33 CDT. See section 4 for why that is expected until the 20:55 cutover, and
what to check afterwards.

There is no enabled game above bb 5.00. The six that existed were closed by an
operator at 2026-09-04 16:47 CDT: NLH 5/10 Classic, NLH 10/20 Classic,
NLH 25/50 Classic, PLO4 5/10 Classic, NLH 5/10 Action, NLH 5/10 Madness. That
is Dan's call. **Do not reopen them.**

### Cluster events, last hour (read 20:33)

| Kind                       | Count |
| -------------------------- | ----- |
| move_planned               | 185   |
| seat_moved                 | 179   |
| game_woken / game_dormant  | 67 / 67 |
| feeder_opened              | 22    |
| feeder_abandoned           | 20    |
| table_opening_hold         | 15    |
| lifecycle_followed_status  | 14    |
| table_opening_hold_expired | 14    |
| table_closed_disabled      | 11    |
| main_demoted_to_feeder     | 5     |
| table_break_started / completed | 5 / 5 |
| feeder_live                | 4     |
| feeder_promoted_to_main    | 1     |
| controller_tick_error      | 1     |

`move_planned` 185 against `seat_moved` 179 is healthy: at 02:35 it was 261
against 226 over six hours with a re-plan loop underneath. Breaks now happen
(5 started, 5 completed in an hour; at 02:35 the count over a whole hour was 3
and the close rule was effectively unreachable).

**Feeders are still the weak number.** 22 opened, 4 live, 20 abandoned in the
hour. That ratio is 18 percent live, against 15 percent at 02:35. The orbit
hysteresis, the once-per-cycle buyer allocation and the opening hold all
landed today and the ratio barely moved. Whatever the remaining cause is, it is
not the one that was diagnosed at 02:45. Treat it as open and unexplained
rather than as improved, and start from the 15 `table_opening_hold` and 14
`table_opening_hold_expired` rows: the feeder is opening, holding for a second
buyer, expiring the hold and then being abandoned.

### Controller errors (read 20:34)

12 `controller_tick_error` rows on 2026-09-05 CDT. Eleven are

    {"message":"cannot find parent statement on pldbgapi2 call stack","sqlstate":"XX000"}

spread across the day (05:16, 06:01, 07:45, 09:15, 09:30, 12:46 x2, 14:16,
16:45, 17:01, 20:16). One is a real `deadlock detected` (40P01) at 17:31 with
`eligible_horses: 2`.

The previous count of "3 today" was low. It is eleven, roughly one every two
hours, and the deadlock is a separate thing that has happened once.

### The fleet (read 20:33)

Merit bands, from `profiles.horse_profile->>'stakeBand'`, and
`ca_horse_fleet_state.stake_band` agrees row for row:

| Band  | Horses |
| ----- | ------ |
| low   | 521    |
| micro | 198    |
| mid   | 181    |
| high  | 100    |

Stake tags in `stable_hand_membership_tags`: 1,580 rows over 1,000 horses,
which unnest to 2,177 (horse, stake) pairs.

| bb   | pairs | horses |
| ---- | ----- | ------ |
| 0.02 | 72    | 56     |
| 0.05 | 96    | 68     |
| 0.10 | 103   | 72     |
| 0.25 | 90    | 67     |
| 0.50 | 332   | 255    |
| 1.00 | 650   | 499    |
| 2.00 | 528   | 397    |
| 5.00 | 214   | 152    |
| 10.00| 64    | 50     |
| 20.00| 20    | 18     |
| 50.00| 8     | 8      |

Before #3213 no horse held a stake above 2.00 at all. **0 of the 2,177 pairs
names a stake the wallet cannot cover** (tested directly: `chip_balance <
2000 * bb` returns zero rows, and zero tags lack a `club_members` row).

One thing to know before you re-read these: `max(tagged_at)` is 2026-09-04
03:42 CDT, not today. The upsert does not move `tagged_at`. The distribution
above is the proof the re-tag ran, not the timestamp.

### Money (read 20:36, not this programme's backlog)

894 unresolved `financial_alerts`, 165 of them `critical`. Largest sources:
`fn_tournament_money_conservation` 246 (warning), `FeeReconciler.bbj_unlinkable`
180 (warning), `drift_incident:fn_ca_ledger_replay` 69 warning + 26 critical,
`fn_rake_bbj_audit` 19 critical.

`ServerTableEngine.settlement_barrier_abandoned`: 10 raised today, all 10 still
unresolved, latest 12:50 CDT. That one is engine-side and belongs to this
programme's neighbourhood even though the rest of the backlog does not.

## 4. The engine is behind the database until 20:55

Read at 20:35 CDT:

- `engine_leader`: instance `1-5a9a1646`, `engine_version` **9c11dc71**,
  acquired 19:55 CDT, heartbeat 20:33:47.
- `https://engine.smarter.poker/health`: `version` 9c11dc71, `uptime` 2485 s,
  `handsInFlightTotal` 231.
- `9c11dc714` is `fix(realtime): phase 4 audit ... (#3210)`, merged 00:39:12
  UTC. `main` is **15 commits ahead of it**.
- `git merge-base --is-ancestor 299cf7afb 9c11dc714` -> **NO**. The running
  engine does NOT contain #3213 (merged 00:47:17 UTC, 19:47 CDT, eight minutes
  after the build that took the 19:55 leader).
- Nor does it contain #3224 (merged 01:31:46 UTC, 20:31 CDT).

So the clamp fix and the one-game-per-band engine changes reach the fleet at
the **20:55 cutover**, not before. Zero seats at bb >= 5 is the expected
reading right now and proves nothing either way.

The client is already current: `curl -s
https://smarter.poker/hub/club-arena/build-info.json` returned `ca_sha`
`7a1d193901806182862682667c761b6450f4369d`, which is `main` HEAD, built
01:33:58 UTC by `publish-club-arena.yml`.

**After the cutover, check exactly this, in this order:**

1. `engine_leader.engine_version` has moved off `9c11dc71`, and
   `git merge-base --is-ancestor 7a1d19390 <new version>` says YES.
2. Seats on tables whose game has `bb >= 5`. Non-zero means the clamp fix is
   working. Still zero after an hour means the fleet is not routing there, and
   the first suspect is item 1 of section 5: 100 horses hold band `high`, and
   the engine fallback added by #3224 seats them one band down. Read
   `stakeBandSupply()` and the per-opening-feeder diagnostic line.
3. `feeder_live / feeder_opened` over the following hour against the 4/22 above.

## 5. What is left, in the order to take it

### 1. `fn_assign_horse_stake_bands` does not know which games exist

Read from production at 20:38 CDT, the function assigns merit bands from
`percent_rank()` over `bb100` with cut points hardcoded at **22 / 74 / 89**,
and its definition contains no reference to `cash_games` at all
(`pg_get_functiondef ILIKE '%cash_games%'` is false).

The effect: 100 horses hold band `high` and there is no enabled game above
bb 5.00. #3224 added an ENGINE-side fallback (`STAKE_BAND_LADDER`,
`bandSupply`, `applyStakeBandSupply` in `HorseBehavior.ts`) so such a horse
seats one band DOWN rather than nowhere. That is a correct floor. But the SQL
goes on minting `high` horses every time it runs, so the fallback is load
bearing forever.

The durable fix is in the assignment function: the band a horse is assigned
must be bounded by the bands that have an enabled game. Note the operator's
09-04 16:47 closure above: the shortage is a deliberate operator decision, so
the function has to READ the floor, not restore it.

### 2. Three derivations of "how many players and tables in this game"

They agree today only because the population that made them differ has been
repaired. Verified at 20:39 CDT that they read different sources:

- `get_club_home` -> `cluster_players` / `cluster_tables` (migration
  `20260905020000`). Reads `table_seats`. Does NOT read `cash_game_roster`.
- `fn_cash_game_lobby`. Reads BOTH `table_seats` and `cash_game_roster`.
- The client: `src/components/lobby/lobbyEntries.ts` lines 1014 and 1018
  (`cluster_tables ?? 1`, `cluster_players ?? current_players ?? 0`), plus
  `CashClusterHUD` and `MustMoveLobbyModal`.

Make them one definition. A fourth caller written against whichever one it
found first is how this becomes a bug again.

### 3. 25 no-op squatter migration files on `main`

`git ls-files supabase/migrations | grep squatter_holding_this_second` returns
**25** files, versions `20260905085729` through `20260905085753`. Checked
against `supabase_migrations.schema_migrations` at 20:35 CDT: **0 of the 25
versions are recorded**, not 1 as previously believed. They are the residue of
an interrupted test run and they do nothing.

`git rm` them. **Check `git status` before you do**: that test's `beforeEach`
deletes files matching the same pattern, so a test run in another worktree can
already have removed them from YOUR working tree while they are still tracked.

While you are there, two related pieces of drift found at 20:35:

- #3213's migration file on `main` is
  `20260906003931_the_tourney_tag_can_hold_the_one_table_its_own_migration_dec.sql`,
  but the version recorded in production is **20260906004017** under the same
  name. `20260906003931` is not in `schema_migrations`, so a fresh apply would
  run that file again under a version nothing has seen.
- Four versions applied to production have NO file on `main`:
  `20260905104226 the_third_seat_waits_90_to_350_seconds_for_a_human`,
  `20260905155400 main_1_is_the_live_one_and_a_closed_table_owns_no_index`,
  `20260905155937 every_horse_plays_at_least_two_tables`,
  `20260906011318 the_feeder_tables_stay_within_one_player_of_each_other`.
  Three of those four are cluster work. Find whose branch they are on before
  you write anything that touches the same functions.

### 4. The engine is one core

The 04:00 thaw killed it once (318 tables and 402 tournaments resumed
together). #3169 staggers the resume into 8 waves and that specific death has
not recurred. The sustained load of 700-plus tables on one core is Phase 8's
problem, not the break's. `handsInFlightTotal` was 231 at 20:35.

### 5. `settlement_barrier_abandoned`

10 raised today, all unresolved, latest 12:50 CDT. Engine-side, and worth its
own session. The other 884 unresolved alerts belong to the chip-accounting
programme, not this one.

### 6. The `pldbgapi2` extension

Eleven `controller_tick_error` rows today read "cannot find parent statement on
pldbgapi2 call stack" (XX000). Harmless so far - the tick retries on the next
pass - but it is a debugger extension nothing here needs. Remove the extension
and the eleven rows a day go with it. The 17:31 `deadlock detected` is a
different thing and is not addressed by removing it.

### 7. Ladder manager (still open from the 02:45 list)

Every rung is enabled by hand. Rungs should sleep and wake on demand the way
tables do. Read the 09-04 16:47 closure first: an operator closing a rung must
outrank an automatic wake, or item 1 above comes back as a fight between a
manager and a human.

## 6. Traps this programme has already paid for

- **The break rule and the open rule both fired on the same board** when Main
  was exactly full (`>=` against `>`); the feeder broke and re-opened 7 s
  later. `20260905040500`. Boundary conditions in the tick need a probe, not a
  reading. The probe harness now exists: `npm run probe:cluster`,
  `scripts/dev/probe-cluster-boards.sql`, 10 boards, rolled back.
- **Main 1 was the OLDEST row, not the live one.** That opened 3,000 tables on
  one game before it was caught. `20260905194329`. When a rule names a table by
  index, look it up on the live board.
- **The maintain-floor clause refused every break that mattered**, so games
  grew and never shrank. `20260905194840`. A floor that is checked before the
  consolidation is a floor that prevents the consolidation.
- **The fleet seated a horse on a `closed` feeder 15 s after it closed** (stale
  snapshot). `atomic_table_buyin` never checked table status. The door refuses
  `closed` and `breaking` on INSERT and on the revive UPDATE. A third way to
  occupy a seat needs the guard too.
- **The four-table limit counted a within-game move as a fifth game** and the
  executor vacated the old seat BEFORE taking the new one.
  `20260905041000` + `20260905042000`. A move is not a leave.
- **A cancelled move was re-planned every 5 s** with no back-off (17k rows/day
  per stuck player). If you see `move_planned` far above `seat_moved`, that is
  the shape.
- **An invented clamp read as a design decision.** `PHASE_MAX_BB` said nothing
  above 1/2 this phase, nobody asked for it, and it held every horse on the
  bottom two rungs. #3213. It is the same shape as the `is_horse` filter in
  CLAUDE.md 10.5: a restriction in code with nothing written behind it is a
  defect, not a rule.
- **A CHECK constraint that the repo's own creating migration never applied.**
  `stable_hand_membership_tags` was created with `CREATE TABLE IF NOT EXISTS`
  over an existing table, so production kept an older `max_tables` CHECK and
  the file read as applied while doing nothing. Every `horses:tag --force` run
  since had died on the first upsert. Look for this shape wherever a migration
  uses `IF NOT EXISTS` on a table that already existed.
- **Counting Action games by `template_name` alone** makes the one-per-band law
  look broken. The unique index includes `variant`.
- **A transaction does not span two Supabase MCP calls.** One call, one `DO`
  block ending in `RAISE EXCEPTION`; success means it committed. `execute_sql`
  DOES honour an explicit multi-statement `BEGIN ... ROLLBACK` inside one call.
- **Pushing from the shared clone is refused by a guard; a worktree without
  `node_modules` skips tsc loudly.** That is fine for a docs-only branch. For
  code, provision with `cp -Rc <clone>/node_modules <tree>/.nm.tmp && mv` (APFS
  clone, no disk cost) for root and `server/`, then push detached and poll the
  log; the hook takes about three minutes and the host tool kills the process
  group on timeout.
- **Squash-merged branches look "N ahead of main" forever.** Ask GitHub
  (`pulls?state=all&head=Smarter-Poker:<branch>`) before re-pushing one. The
  branch tip SHA is never on `main`; grep the PR number instead
  (`git log origin/main --grep='(#3213)'`).
- **`check-definer-authorization` reads COMMITTED migrations only** (it diffs
  `origin/main...HEAD`); a staged fix still reads as blocked.

## 7. Where things are

- Tick: `fn_cash_cluster_tick(p_game_id, p_eligible_horses)`,
  `fn_cash_clusters_tick_all` (the one RPC per pass, #3119),
  `fn_cash_clusters_to_tick()`, `fn_cash_cluster_census`,
  `fn_cash_cluster_open_table`, `fn_cash_stake_band(bb)`.
  49 `fn_cash_*` functions in production at 20:37 CDT; the #3196 audit counted
  54 and found zero browser-callable writers that do not bind the caller.
- Moves: `fn_cash_seat_change_plan/request/cancel/status`,
  `fn_cash_seat_move_execute`, `fn_cash_seat_swap_execute` (engine-only),
  `server/src/services/supabase/seatMoves.ts`, `seatChange.ts`,
  `SeatMovePresence.ts`.
- Controller: `server/src/cluster/**`,
  `TheTablesOpenAndCloseThemselves.law.test.ts`,
  `theClusterPages.law.test.ts`.
- Fleet and stakes: `HorseFleetManager.ts`, `HorseSessionRotator.ts`,
  `HorseBehavior.ts` (`STAKE_BAND_LADDER`, `bandSupply`), `StableHand.ts`
  (`STAKE_LADDER`, `stakeBandForBigBlind`, `assignPreferredStakes`,
  `rollSupportsStake`, `BUYINS_TO_LICENSE = 20`), `StableHandPlanBus.ts`,
  `StableHandExecutor.ts`, `server/src/scripts/horsesTag.ts`.
- Lobby: `src/components/lobby/lobbyEntries.ts`,
  `arenaGameCardActionsForEntry`, `src/services/cashGameLobby.ts`, the
  must-move lobby, `AddOnBubble.ts` + `ChatBubble` `notice` variant.
- Laws added today: `tests/actionAndMadnessAreOnePerBand.law.test.ts`
  (registered in `docs/laws.d/action-and-madness-are-one-per-band.md`),
  `server/src/services/HorseStakeBands.test.ts`,
  `server/src/services/aDisabledGameIsNotSeeded.test.ts`.
- Probes: `npm run probe:cluster` ->
  `scripts/dev/probe-cluster-boards.sh` + `.sql`, 10 boards, rolled back.
- Event log: `cash_cluster_events(game_id, table_id, kind, payload, at)`. It is
  the only witness of what the tables did.
- Deploy proof: `scripts/ci/prove-engine-version-moved.mjs`, wired into
  `.github/workflows/auto-deploy-hetzner.yml` (#3120). A green deploy that
  shipped nothing now fails.
