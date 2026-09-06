# The worklist reaches the game the repair was written for

2026-09-05. Migration `20260906011113_the_worklist_reaches_the_game_the_repair_was_written_for.sql`
(applied to production and recorded in `schema_migrations`) plus the TypeScript
that makes two of its three fixes do anything, plus one defect found beside
them in the horse fleet.

## 1. A repair that could not reach the state it existed to repair

`fn_cash_cluster_tick` gained a `lifecycle_followed_status` step on
2026-09-05 (`20260905083756`) for exactly one shape: a table left at
`lifecycle = 'live'` with `status = 'closed'`, which the census drops and the
roles step still counts.

`fn_cash_clusters_to_tick` admitted a DISABLED game only when it still had a
table whose `status` was one of `waiting` / `running` / `active`. A table in
precisely the stranded shape satisfies the lifecycle test and fails the status
one, so the game was never on the worklist, never ticked, and the repair
written for it never ran.

MEASURED before the migration: **14 such games** (NLH 0.01/0.02 Classic,
PLO5 0.05/0.10 Classic, FLH 0.50/1 Action, FLH 0.50/1 Madness, Short Deck 1/2
Classic and nine more), **every one with `last_tick_at IS NULL`** - never
ticked once since the controller was built. No seats on any of them, so no
player was affected; the rows simply never resolved.

The worklist now asks only that a disabled game has a table that is not
closed. An enabled game is unchanged (admitted on `g.enabled` alone) and a
game with nothing open is still absent.

MEASURED after: the worklist carried **124 games**, of which the first pass
**ticked 90 and rested 34**. Fourteen `lifecycle_followed_status` repairs fired
within three minutes and the `still_stranded` count went to **0**. Zero errors
in `cash_cluster_events` for that pass.

## 2. `poker_cluster_games{state}` was a gauge nothing set

The one-RPC pass (`20260905091025`) selected `l.state` for its due-rule and
then left it out of the per-game result, so `ClusterMetrics.recordPass`
never received rows and the Grafana panel in
`infra/monitoring/grafana-dashboards/cluster-controller.json` rendered an
empty series.

- SQL: every `results` entry carries `state`, and so does every entry of the
  new `rested_games` roster.
- TypeScript: `ClusterController.tick()` collects a `seen: ClusterRow[]` of
  every game the pass saw - ticked AND rested - and passes it as the second
  argument of `recordPass`. `recordPass`'s signature is unchanged, so its own
  unit tests are untouched.

## 3. A rested game was invisible to the wake

A game that rests (dormant, nobody seated, no eligible horse, ticked within
30 s) was `CONTINUE`d before its result entry was built, so it appeared in no
roster. `ClusterController` built `rowByGame` from `results` only, so
`wake(gameId)` on a rested game found no row, read `enabled` as false and
skipped the 18.4 dealer wake - for exactly the dormant game a wake exists to
serve. It self-corrected on the next 5 s pass, so the cost was bounded, but
the wake is the thing that is supposed to beat the pass.

- SQL: the pass returns `rested_games`, identity only (`game_id`,
  `main1_table_id`, `enabled`, `state`) and deliberately no `result`.
- TypeScript: `ClusterTickAllRestedEntry` is declared, `rested_games` is on
  `ClusterTickAllResult`, and the pass folds those entries into `rowByGame`
  and into `seen`. They are NOT added to `summary.ticked`, they do not run
  `afterGameTick`, and they are not added to `summary.rested` either - the SQL
  has already counted them once there.

## 4. A whole assigned stake band with no supply

Found while reading the same surface, and unrelated to the migration.

`fn_assign_horse_stake_bands` assigns merit bands by hardcoded percentiles on
bb/100 and never asks which games exist. Live on 2026-09-05: **100 horses held
`profiles.horse_profile->>'stakeBand' = 'high'` and there was not one enabled
game with `bb > 6` on the platform.** The six high games (5/10 NLH
Classic/Action/Madness, 5/10 PLO4 Classic, 10/20 NLH, 25/50 NLH) were all
closed by an operator at 16:47 on 2026-09-04. That is Dan's call and it has
not been touched.

`stakeBandAllows` in `server/src/services/HorseBehavior.ts` is a hard gate
whose comment says "NO ESCAPE HATCH, DELIBERATELY", so those 100 horses could
sit **nowhere at all** - about 10% of the fleet, silently unseatable.

Fixed in the ENGINE only. No game was enabled and the SQL assignment was not
touched:

- `effectiveStakeBandFor(horseId)` sits next to `stakeBandAllows` /
  `stakeBandForBigBlind`. A horse whose assigned band has no enabled game drops
  to the highest band BELOW it that does. **Downward only** - a micro horse is
  never promoted into a game it has not earned, which is the direction a player
  would notice.
- The horse's STORED band is not rewritten. It is a merit record, the
  operator's switch is temporary, and neither is ours to edit for a seating
  problem.
- `applyStakeBandSupply(bands)` is called once per fleet cycle in
  `HorseFleetManager.seedAllTables`, from the open-table list the cycle already
  holds (minus tables the seeding loop would refuse anyway: a breaking or
  closed lifecycle, or a table of a disabled game). **No new query.**
- It fails OPEN: an empty band set - a cycle that read no tables - publishes
  nothing and narrows nobody, exactly like the disabled-games loader beside it.
- When a fallback is in effect the cycle logs once:
  `[HorseFleet] band supply: no enabled game in band(s) X; N horse(s) seat one band down`.

## Tests

- `server/src/services/HorseStakeBands.test.ts` - a high horse with no high
  game seats in mid; the same horse with a high game open stays high; the drop
  goes past an empty rung to the highest band that has a game; a micro horse is
  never promoted; an empty table list changes nothing; the stored band is never
  rewritten; and the fleet derives the supply from its own table list.
- `server/src/cluster/ClusterController.test.ts` - a wake on a game the pass
  only RESTED finds its Main 1, its horse demand and its enabled flag (so the
  18.4 dealer wake is not skipped); a rested game is counted once, in `rested`,
  and never dealt with; a pass with no `rested_games` behaves as before.
- `server/src/cluster/theClusterPages.law.test.ts` - PIN MOVED. The comment
  saying the state gauge could not be asserted "until fn_cash_clusters_tick_all
  carries state" is replaced by the assertion itself: two live games and one
  rested dormant game, counted once each.
- `server/src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts` - PIN MOVED.
  `TICK_ALL` now reads `20260906011113`, because that migration re-declares
  BOTH functions whole and `20260905091025` is no longer the live definition of
  either. Four new pins: the disabled-game predicate, `state` and
  `rested_games` on the return, the controller's identity-only fold, and the
  gauge being fed.

## Rollback

Re-apply `20260905091025` for `fn_cash_clusters_tick_all` and `20260905010500`
(as amended) for `fn_cash_clusters_to_tick`. The TypeScript tolerates a missing
`rested_games` (it reads as an empty array) and a missing `state` (the gauge
folds it into `other`), so the engine does not need to be rolled back with it.
