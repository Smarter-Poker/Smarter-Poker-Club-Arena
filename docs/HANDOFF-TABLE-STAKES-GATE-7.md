# Operation Table Stakes - Gate 7 (cutover) recon, 2026-09-05 04:10 UTC

Gates 0-6 are shipped (5 and 6 in `feat/gate-5-the-snapshot-is-the-rule`).
Gate 7 is "the cutover migration applied; zero cash tables outside a
cluster" (OPORD 1.4 s2.3, 18.6). This file is the recon that has to come
first, because the cutover collides with a second written programme and
that is Dan's call (CLAUDE.md 10.8: two laws, stop and ask, options with
costs).

## What is outside a cluster tonight (read, not assumed)

| where                                             | tables | seated | keys (club, variant, sb, bb) |
| ------------------------------------------------- | ------ | ------ | ---------------------------- |
| Cluster tables (the union ladder, 78 games)       | 81     | 120    | 78                           |
| Outside a cluster, `created_by IS NULL`, all cash | 105    | 193    | 43                           |

Of the 105: **104 are Deep Stack Society** (a standalone club, no union)
and 1 is a Midway Union NLH 0.05/0.10 9-max table whose game already
exists as a cluster (`has_game = true`) - the single stray. Of the 43 keys:
10 have more than two tables (up to 9 at PLO6 0.50/1), 6 carry straddles
(R2 forbids them on any cash game), 14 mix rule shapes inside one key
(ante on some tables and not others, bombs on some, 6-max beside 9-max).

## Who creates them - and this is the collision

Three writers still open cash tables with no `cluster_id`, all in
`server/src/services/HorseFleetManager.ts`:

1. `ensureAllTablesExist` (line ~763) - the union's DEFAULT_TABLES. Every
   one of those keys now exists as a cluster game, so this writer is
   producing nothing new; its output is the 1 stray.
2. `spawnOverflowTables` / `retireSurplusTables` / `MAX_TABLES_PER_CONFIG`
   (line ~318, ~2727) - the `#2 / #3` clones. OPORD s2.11 names all three
   for deletion. Zero `#N` tables exist tonight; it is dormant, not gone.
3. **`openPlannedTables` (line ~2855) - Operation Stable Hand.** The
   StableHandController / Planner (`docs/changelog/2026-09-04-operation-
stable-hand-*.md`, Dan's club programme) issues "open a table on the
   host club" orders every cycle and this method executes them. That is
   where the 104 Deep Stack Society tables come from, with their bespoke
   rule mixes, and it will keep opening them.

OPORD 1.4 ROE 18: "No human in the lifecycle loop. There is no button,
switch, column, admin action, cron or agent instruction that opens or
closes a cash table." Operation Stable Hand is exactly an agent
instruction that opens and closes cash tables, on the host club, by plan.
Both are written down; neither is a stale filter. A cutover that forbids a
cash table without a `cluster_id` (the CHECK in 18.6) makes the Stable
Hand's next open order fail loudly, and a cutover that leaves the Stable
Hand alone leaves 104 tables outside every rule in Gates 0-6.

## The three ways out, with costs

**A. The Stable Hand plans GAMES, the controller runs the tables
(recommended).** The planner's open order becomes "ensure a `cash_games`
row for (host club, variant, sb, bb) exists and is enabled"; the cluster
controller opens Main 1, feeds, promotes, breaks and closes exactly as it
does for the union ladder; the Stable Hand's park / close / cap machinery
stops touching `tables` and drives `cash_games.enabled` and `cap_mains`
instead. The cutover migration then: one `cash_games` row per key (43),
snapshot built FROM the key's oldest table (its ante / VPIP / bomb columns
become the snapshot, so Gate 5's applier changes nothing on day one -
except straddles, which R2 turns off on 6 keys), oldest table Main 1, the
rest Main 2..N by age, the newest the feeder, empty ones `breaking` (the
tick closes them, nobody is cashed out), and the CHECK constraint. Cost:
the Stable Hand engine work (a day), 6 keys lose straddles, 14 mixed keys
converge on their oldest table's rules within one tick. Players see one
game per stakes on the DSS board, with the counter, the lobby and the
seat change - what the union has tonight.

**B. Cut over the union ladder only; exempt host-club tables.** The CHECK
allows `cluster_id IS NULL` where `clubs.union_id IS NULL`. Cost: two cash
architectures for ever, every rule in Gates 0-6 absent from the flagship
club, and ROE 18 stays violated. Not recommended.

**C. Freeze the Stable Hand's cash side and let the controller take the
host clubs as A, without retargeting the planner.** Fastest; the club
programme's cash tables stop growing until the planner is rewritten. Not
recommended: it turns off a programme Dan asked for in order to finish a
different one.

## What is already true and does not wait

- R2 (no straddles) and the snapshot-as-rule (Gate 5) hold on every
  cluster table tonight and are re-asserted every tick.
- The 1 union stray is safe to fold into its game in the cutover
  migration; it needs no ruling.
- Writers 1 and 2 can be deleted with the cutover in every option.

## What I did not do on my own authority

Write the cutover migration or touch the Stable Hand. CLAUDE.md 10.9
covers money; this is two of Dan's programmes disagreeing about who opens
a table, and 10.8 says that goes to him as options. Option A is the
recommendation; one word picks it and the migration, the planner change
and the fleet deletions ship as one PR with a rolled-back probe over the
43 keys.
