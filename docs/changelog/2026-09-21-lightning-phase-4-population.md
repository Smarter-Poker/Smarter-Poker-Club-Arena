# Lightning 2.0 Phase 4: one live eligible population, and the thresholds it is judged by

2026-09-21. Migration `20260921064717_lightning_phase_4_one_live_eligible_population_and_the_thres`.
Branch `agent/claude-lightning-p4/lightning/phase4-population`.

> "Create one authoritative function: `getLiveEligiblePopulation(cluster, now)`.
> ... The exact population predicate must be centralized and unit tested. Do not
> copy slightly different player-count logic into multiple services."

Nothing in this estate counted that. What exists is a **board count** - how many
players are in this game - pinned by
`tests/one-definition-of-a-games-players.law.test.ts` across
`fn_cash_cluster_census`, `get_club_home` and `fn_cash_game_lobby`, and it
deliberately counts every occupied seat.

## This is a second number, and it is not the first one

That law exists because three readers gave three answers to **one** question.
This adds a different question with one answer, and the distinction had to be
written down or the next reconciliation pass would helpfully merge them:

- **The board count** answers *how many players are in this game*. It counts a
  sitting-out player, a busted player in their rebuy window and a player on
  their way out, because all three are in the game and the lobby must say so.
- **The live eligible population** answers *how many players could Lightning
  deal to right now*. It is the input to a threshold, so it counts only players
  who are economically active and currently able to be dealt in.

`fn_cash_cluster_live_eligible` uses the census's own **table** predicate byte
for byte - same tables, same exclusions - and narrows only the **seat**
predicate, so the two can never disagree about which tables belong to the game.
A seat is ineligible when it is sitting out, leaving, busted, or empty; each of
those four is a rule the estate already applies somewhere else, and the header
names where.

**A horse counts exactly like a human.** Law 10.5, pinned twice in
`server/src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts` - once against
the tick's worklist and once against the balancer, both asserting the SQL does
not mention `is_horse`. The chips are real, the seat is real, the hand is real.
The population reports the count in its breakdown so an operator can see the
composition of a threshold crossing, and never excludes them.

## What this function cannot see, said out loud

The specification names thirteen categories. Four have no representation in
PostgreSQL at all - **disconnected**, **expired disconnect**, **ghost BB** and
**watching** - and the function says so in every answer rather than quietly
counting as though it knew. The authority for disconnect is `DisconnectEngine`'s
in-memory FSM, per table, in the leader process, with its timeouts as TypeScript
constants; it reaches Postgres only as a per-hand jsonb blob that is not current
between hands.

So every answer carries `unknown` and `confidence`, and `confidence` reads
`partial` while that list is not empty. The seam for closing it is cut:
`p_disconnected` defaults to NULL, and spec Phase 14 (F16, "live eligible
population recalculated using authoritative disconnect rules") supplies it
without this signature changing meaning.

## One predicate, two readers

`fn_cash_cluster_live_eligible` is the predicate: a scalar, two statements.
`fn_cash_cluster_population` is the breakdown, nine statements, and it does not
recompute the number - it calls the scalar.
`fn_cash_cluster_lightning_state`, which `fn_cash_game_lobby` embeds, reads the
scalar, so a lobby open pays two extra statements and not nine. An earlier cut
had the lobby paying all nine, which is the same class of regression the Phase 3
remediation went back for (6.13 ms to 13.97 ms on a five-second path).

**One `count(DISTINCT)` over a `UNION`**, not the sum of two counts. The seated
and pooled halves are disjoint while a Cluster is cleanly in one regime, and
they are **not** disjoint in the window a Phase 5 conversion opens - a player
seated with chips whose pool session already exists is in both relations at
once, and that window is precisely when the threshold is read. The guard is
doubled on purpose: mutation testing established that the `UNION` and the
`count(DISTINCT)` are each sufficient alone, so neither is load-bearing and no
single edit can get halfway there unnoticed.

**The breakdown is categories, not terms.** `sit_out`, `leaving` and `busted`
overlap; an empty chair is in none of them; `seated_main + seated_feeder` can
fall short of `seated_total` because `tables.role` is nullable. The answer
carries `breakdown_is_not_arithmetic: true` rather than leaving a reader to
discover it by subtracting. The one identity that does hold exactly, on both
disconnect paths, is

```
GREATEST(0, seated_eligible + lightning_eligible - seated_and_pooled - counted.disconnected) = live_eligible
```

and it is asserted twice in the migration's own proofs.

## The thresholds are configuration, and the defaults live in one place

> "6-max: `lightning_on_threshold` = 18, `lightning_off_threshold` = 12.
> 9-max/full-ring: 27 and 18. ... No magic numbers in business logic."

`fn_cash_cluster_lightning_thresholds` is that one place. It reads
`cash_games.ruleset_snapshot -> 'lightning'` - the jsonb every other cash rule
already lives in - and falls back to the mandated defaults keyed off
handedness. Every caller asks it; no caller carries a number, and
`tests/lightning-phase-4-population.test.ts` makes "no magic numbers" checkable
by counting the literals: `18` four times, `12` twice, `27` twice, all inside
that function, and zero outside it.

The hysteresis rule is **enforced**, not trusted: an ON at or below the OFF
would convert a Cluster every tick in both directions forever, so a
configuration that says so is refused in favour of the defaults and `source`
says which answered. It is refused rather than **raised**, because this is read
on the path a tick takes and a reader that raises takes the tick with it.

## What this does not do

It converts nothing. `cluster_mode` is not written, no epoch moves, no player is
seated or unseated. The verdict is descriptive - `would_turn_on`,
`would_turn_off` - and spec Phase 5 acts on it. ON is `>=` and OFF is `<=`,
which is the specification's own asymmetry and what makes 12 pending-off on a
six-max game while 13 is not. `would_turn_on` is gated on `enabled` and
`would_turn_off` is not, deliberately: a disabled Cluster must not be allowed
**into** Lightning and must always be allowed to drain **out**.

## Qualification

`scripts/dev/test-lightning-phase4-population.sh` builds a throwaway PostgreSQL
17 cluster, applies the four real Lightning migrations on top of the Phase 3
remediation fixture, and exercises 23 sections against real boards - including
the conversion window, where one human is seated with chips **and** holds an
active pool session at the same cluster and epoch.

**Twenty-five mutations of a copy, twenty-four killed and one provably
equivalent.** The equivalent one is stated rather than tested past: with
`in_instance` joined to the active pool session it counts a subset of the
eligible players, and `lightning_pool_session_one_open` makes the direct count
and the subtraction the same number.

Section 22 is the one that earned its keep. It extracts every `@live-proof`
line from the migration under test and evaluates it against the database that
migration just produced. It caught three proofs that were false purely because
`pg_get_functiondef` returns comments, and a comment that quotes the string a
proof forbids makes the proof false without anything being wrong with the code.
All six text proofs now read the body with its comments stripped, and both the
harness and `tests/lightning-phase-4-population.test.ts` pin that rule, because
the same defect appeared three times in one file.

Acceptance: **F02** (6-max 17 remains MUST-MOVE), **F03** (18 is pending
conversion), **F09** (9-max 26 remains), **F10** (27 is pending), and the Phase
10 ladder at 13 / 12 / 11.

## Rollback

Three new functions and one re-created one. Dropping
`fn_cash_cluster_live_eligible`, `fn_cash_cluster_population`,
`fn_cash_cluster_lightning_thresholds` and `fn_cash_cluster_pool_health`, and
restoring `fn_cash_cluster_lightning_state` from the `pg_get_functiondef` output
taken before the apply, returns the prior behaviour exactly. No table, no
column, no row. No money moved. Nothing reads the new numbers yet except the
lobby, which gains two fields it can ignore.
