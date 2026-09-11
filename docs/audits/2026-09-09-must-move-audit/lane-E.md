# Lane E - does the felt actually PLAY Classic, Action and Madness differently?

Scope: the engine side of the three templates. Ante collection, bomb pots, the
VPIP floor, run-it-N-times, straddle, seven-deuce, the ruleset -> table ->
ENGINE projection path, and the client-facing vocabulary. Lane C owns the SQL
that WRITES the rules; I own the code that READS them and the felt that
executes them.

Everything below was read from the worktree at `origin/main` 98ef24c6a1 and
from PRODUCTION (`kuklfnapbkmacvwxktbh`) between 17:40 and 20:10 UTC on
2026-09-09. Nothing was applied. Probes are rolled back.

---

## 0. THE PROMISE, AND WHETHER THE FELT KEEPS IT

The three blurbs a player is sold (`fn_cash_template_defaults`, and the picker
copy quoted in `docs/changelog/2026-09-09-a-classic-game-has-no-antes-and-no-bombs.md`):

| template | promised | does the felt do it |
| --- | --- | --- |
| classic | No Antes, No Bombs, No VPIP Floor | **YES** - verified on 24,000 live hands |
| action | Small Blind Ante, VPIP Floor 30/10, Double Board Bomb Every 15 Minutes | **YES** on all four, with one caveat (E1) |
| madness | Big Blind Ante, VPIP Floor 50/10, Double Board Bomb Every Orbit | **YES** on all four, with one caveat (E1) |

Read from `hand_history` joined to `cash_games`, 2026-09-09 03:00-06:00 UTC:

```
template  hour   hands   bomb_hands  ante_hands
action    03:00   1386      45          1386
action    04:00    803      34           803
action    05:00    412      18           412
classic   03:00   8855     130          1535     <- BEFORE the 03:53 realignment
classic   04:00   8399       0             0     <- after
classic   05:00   7746       0             0
madness   03:00    784     206           784
madness   04:00    654     168           653
madness   05:00    563     140           563
```

Action's 45 bombs/hour over ~20 tables is the 15-minute cadence. Madness's
206/784 is ~1 in 3.8 hands at two- and three-handed tables, which is one per
orbit plus the deliberate `anchorAdvancePending` extra hand. Classic went to
exactly zero on both axes at the realignment and has stayed there.

A second, tighter read (last 45 minutes to 20:05 UTC, 7,652 cash hands):
**zero** hands carried an ante on a table whose `ante_enabled` is false, and
**zero** bomb hands on a table whose `bomb_pot_enabled` is false. The one
apparent mismatch - 206 madness hands with no regular ante on an ante table -
is exactly its 206 bomb hands, and is correct: `HandController.dealHand` calls
`postBombPotAntes` and returns before `postBlinds`, so a bomb hand posts a
`bomb_ante` and never the regular one.

**So the headline answer is that the three games really are three games on the
felt today.** The findings below are the ways that is not yet guaranteed.

---

## 1. FINDINGS

### E1 (P1) - THE ENGINE CACHES THE TEMPLATED RULES UNTIL RESTART. **FIX: DONE (engine)**

This is my lane's central question and it has a definite answer: **the engine
re-reads the BOMB rules and nothing else. Ante, VPIP floor, run-it-N-times,
seven-deuce, buy-in band and action clock are sampled once at boot.**

Proved from the code path, which is decisive here because there are only three
writers to `this.tableInfo` in the whole engine:

1. `ServerTableEngineBase.start()` line 2312 - `this.tableInfo = tableData as TableInfo`,
   from `loadTable()`. **Once per engine process.**
2. `ServerTableEngineDealing.refreshBlinds()` line 1543 - gated
   `if (!this.tableInfo || !this.isTournamentTable()) return`. **Tournaments only.**
3. `ServerTableEngineBase.refreshRakeConfig()` line 4894 - throttled to
   `RAKE_CONFIG_TTL_MS = 60_000`, called from `readNextHandInputs()` at every
   hand boundary. Its `select` list is rake plus **thirteen bomb columns and
   nothing else**:

```
rake_percent, rake_cap_bb, bomb_pot_enabled, bomb_pot_frequency,
bomb_pot_ante_multiplier, bomb_pot_double_board, bomb_pot_board_count,
bomb_pot_trigger_mode, bomb_pot_interval_seconds, bomb_pot_min_players,
bomb_pot_ante_fixed, bomb_pot_variant, bomb_pot_button_policy,
bomb_pot_announce_seconds, bomb_pot_manual_pending
```

Every other templated column is read off the cached row for the life of the
process:

| column | who reads it | refreshed? |
| --- | --- | --- |
| `ante_enabled`, `ante` | `ServerTableEngineDealing` HandConfig line 2438 | **NO** |
| `big_blind_ante_enabled` | HandConfig line 2444; `anteSnapshotFields()` | **NO** |
| `nit_game`, `maintain_percent_min` | `vpipFloor()` line 4755; the eviction gate line 5301 | **NO** |
| `run_it_twice`, `allow_run_it_twice`, `run_it_twice_enabled`, `run_it_mode` | `applyRunItTwiceConfig()` line 2186-2215 | **NO** (its own comment says so) |
| `insurance_enabled` | same | **NO** |
| `seven_deuce_enabled`, `seven_deuce_amount` | `ServerTableEngineSettlement` line 855 | **NO** |
| `straddle_enabled`, `auto_utg_straddle` | Dealing line 1966 | **NO** |
| `max_buy_in` | Base line 4416, Settlement line 3170 | **NO** |
| `action_time_seconds` | turn timer | **NO** |

`applyRunItTwiceConfig`'s own doc comment states the caveat exactly and calls
adding a per-hand read "a separate decision ... deliberately NOT taken here".
That decision was correct when a table's rules were set once by a host at
creation. It stopped being correct at Gate 5, when `fn_cash_apply_ruleset`
began rewriting those same columns on **every cluster tick**, and it became a
player-visible defect on 2026-09-09, when the realignment migration turned the
ante off on 19 live Classic tables and the bombs off on 24.

**Consequence, stated plainly:** a Classic table realigned while its engine was
running would have STOPPED dealing bombs within 60 seconds (they are in the
re-read) and KEPT CHARGING AN ANTE until its next restart. Forced money out of
a stack in a game advertised as having none is exactly what the 09-09 changelog
called "not a cosmetic mismatch".

**What production can and cannot show, precisely (CLAUDE.md 10.86 - "I could
not tell" is its own answer):**

* It cannot settle the 09-09 event. The apply ran at **03:54:45**, the
  maintenance announce is at **:53** and the hourly engine restart at **:55**.
  Only 3 hands were dealt on any classic table between the apply and the 04:00
  thaw. So the observed "antes go to zero at 04:00" is equally consistent with
  the re-read working and with the restart fixing it. I am not claiming the
  measurement proves my case; the code does.
* It does show there is **no divergence live right now** (the 45-minute read in
  section 0), which is what the hourly restart guarantees: the blast radius of
  this defect is bounded at one hour, which is why it did not show up as a
  flood of complaints.
* The hourly restart is also why this must be fixed at the root rather than
  detected. Under CLAUDE.md 10.11/10.12 a restart that happens to wash the
  problem away is not a fix; it is the platform getting lucky on a clock.

**THE FIX (root, hard-coded, in the engine):** `refreshRakeConfig` is renamed
in intent - it already runs at every hand boundary on a 60-second throttle and
already exists to make an owner's change take effect without a restart. It now
re-reads the whole templated rule set: the three ante columns, the three VPIP
columns, the four run-it columns, insurance, the two seven-deuce columns, the
three straddle columns, the buy-in band and the action clock. `applyRunItTwiceConfig()`
is invoked after the re-read so the RIT engine is reconfigured from the fresh
row rather than the boot row, and its stale doc comment is corrected.

**SHARED FILE, FLAGGED FOR THE INTEGRATOR:**
`server/src/engine/ServerTableEngineBase.ts`. Three edits, all inside two
methods, no behaviour moved:

1. `refreshRakeConfig`'s `select` list gains 19 columns (the ante three, the
   VPIP four, the run-it four, insurance, the seven-deuce two, the straddle
   three, the buy-in two, the action clock).
2. `refreshRakeConfig`'s assignment block gains the matching writes onto
   `this.tableInfo`, then calls `this.applyRunItTwiceConfig()` so the RIT
   engine is compiled from the fresh row rather than the boot row. Insurance is
   deliberately NOT re-configured (start() sets only `enabled` on that engine
   while other call sites also set `houseMargin` and `offerTimeoutSeconds`, so
   a partial re-configure mid-flow would drop them; `applyRunItTwiceConfig`
   only READS `insurance_enabled`).
3. The doc comments on both methods are corrected - the old ones asserted the
   opposite ("a value that changes perhaps twice a year", and the "ONE CAVEAT"
   paragraph that said a per-hand read was "deliberately NOT taken here"). A
   comment that tells the next agent the stale thing is how this survived.

`server/src/services/supabase/tables.ts` needed no change: its `TABLE_COLUMNS`
select already carries every one of these columns, which is why `start()` had
them and only the refresh did not.

Test: `server/src/engine/TemplatedRulesAreReRead.test.ts` (new, 7 pins).
**Negative control run, because a pin that passes either way is worthless:**
with the assignment block deleted and everything else intact, 3 of the 7 fail -
the ante pin, the VPIP-floor pin and the RIT-recompile pin - and the other 4
(select list, bombs, read-failure tolerance, tournament skip) correctly still
pass. Restored and green.

---

### E2 (P1) - THE VPIP FLOOR RESET ITSELF EVERY TIME THE GAME MOVED YOU. **FIX: DONE (migration 20260909181230)**

Dan 2026-09-04: "IF ANYONE FALLS UNDER THE SET THRESHOLD FOR THE GAME AFTER 10
HANDS, OR ANYTIME AFTER THE 10 HANDS, THEY GET BOOTED."

`fn_nit_check` judged the MAINTAIN sample as "facts on THIS table since THIS
seat's `joined_at`". A must-move game moves a player between its own tables and
every move opens a fresh chair with a fresh `joined_at`, so the ten-hand window
restarted at zero on every move. Measured over the 24 hours to 18:00 UTC from
`cash_cluster_events(seat_moved)` joined to `ca_hand_facts` at the origin table:

```
action    1,492 moves    536 (36%) moved before 10 hands   median 15 hands
madness     550 moves    387 (70%) moved before 10 hands   median  6 hands
```

**On Madness the median sitting at one table was six hands against a ten-hand
window.** The floor the card sells as "High VPIP Floor" could not judge a
player that the game itself kept moving. The hero tracker
(`fn_cash_vpip_status`) and the horse brain's board (`fn_nit_status`) read the
same per-table sample, so all three agreed on a number that reset on every move
- a rule, a warning and a steering signal that were consistently wrong together.

This is not a stale-snapshot problem (that was `20260907190515`, and the floor
VALUES are correct today: action 30, madness 50, classic 0, window 10, on every
game and every table - verified, 0 disagreements). It is a scope problem.

**THE FIX:** on a cluster table the sample is the player's sitting in the GAME
- every `ca_hand_facts` row on any table of the cluster since
`cash_game_roster.joined_at`. That roster row is the right anchor because a move
does not close it (`fn_cash_game_roster_track` declares the move via
`app.cash_seat_move` and skips the close) while a real leave does, so a player
who comes back after a break still starts a fresh count. Verified before
choosing it: 302 of 302 players seated on cluster tables hold a live roster row,
and none has a roster `joined_at` later than their chair. A table with no
cluster keeps the per-table rule unchanged.

All three readers change together, so what a player is stood up on, what the
tracker prints, and what a horse steers by remain one number.

Horses are players (10.5): this widens the sample for horses and humans
identically; `fn_nit_evictions` still has no `is_horse` predicate.

---

### E3 (P1) - RUN IT TWICE WAS ON ONE TABLE OF A GAME AND OFF ANOTHER. **FIX: DONE (same migration)**

`fn_cash_cluster_open_table` projects the snapshot's `run_it_n_times: 'opt_in'`
as `run_it_mode='player_choice'` plus all three RIT booleans true.
`fn_cash_apply_ruleset` - the function whose own comment calls itself the one
place allowed to map a snapshot onto a cluster - **never projected RIT at all**,
so the 42 tables adopted at the Gate 7 cutover kept whatever the old creation
form had written. Read 18:00 UTC over the live cluster tables:

```
classic  run_it_mode 'none' + all three booleans false    33 tables (23 seated)
classic  run_it_mode 'none' + mixed booleans               9 tables ( 7 seated)
classic  player_choice / true / true / true               55 tables
```

`NLH 0.50/1 Classic` ran five tables: four offered Run It Twice and one did not.
A must-move takes a player from one to the other, mid-session, with no message.
Two of those five had players on them at the time of reading.

The engine half is real, not cosmetic: `applyRunItTwiceConfig` computes
`ritEnabled = (run_it_twice && allow_run_it_twice) || run_it_twice_enabled`, so
`false/false/false` genuinely switches the all-in offer off, and `run_it_mode`
`'none'` additionally removes the question in `RunItTwiceEngine`.

**THE FIX:** the projection and its drift predicate carry all four columns.
`'opt_in'` maps to `player_choice`; `mandatory_twice` / `mandatory_three` are
mapped rather than defaulted so a future snapshot writer cannot land `'none'` by
accident. Lane C confirms this half is mine (their C3) and their `20260909191454`
composes with it by anchored edit rather than a retype.

---

### E4 (P2) - THREE MORE COLUMNS THE RECONCILER SET BUT NEVER COMPARED. **FIX: DONE (same migration)**

Inside the same `fn_cash_apply_ruleset`, three columns were in the `SET` list
but missing from the `WHERE` drift predicate, so a row that differed only on
one of them was never selected for repair and stayed wrong until something else
moved:

* `bomb_pot_min_players` - 4 live tables sat at 3 where the opener writes 2. On
  a two-handed table that is the difference between a due bomb firing and
  sitting pending for ever.
* `ante_bb` - the felt's ante-in-big-blinds readout.
* `seven_deuce_amount` - 4 tables carried 2 with the bounty switched off.

Also added: `seven_deuce_enabled` is now guarded `AND g.variant = 'nlh'` in the
projection, matching the guard the create path already has
(`fn_cash_override_bool(...) AND v_v = 'nlh'`). 0 rows are affected today; it is
there so no other snapshot writer can put a seven-deuce bounty on an Omaha
table.

---

### E5 (P2) - `bombPotSettingsFromTable` SILENTLY DOWNGRADES AN UNKNOWN TRIGGER TO `every_n_hands`. **FIX: NOT STARTED - deliberately, see below**

```ts
const triggerMode: BombPotTriggerMode =
  mode === 'once_per_orbit' || mode === 'timed' || mode === 'bomb_pot_only'
    ? mode : 'every_n_hands';
```

A misspelled or future trigger mode becomes `every_n_hands`, and since the
templates write `bomb_pot_frequency = 0`, `modeViable` is then false and the
table plays **with bomb pots silently off** on a game sold as having them.

I did not change this. The DB CHECK `tables_bomb_pot_trigger_mode_check` admits
exactly the four values the engine knows, so the branch is unreachable from any
real row today, and making it throw would turn a typo into a table that cannot
deal. The correct treatment is a warn-and-fall-back, which touches the same
shared file as E1 and belongs with whoever adds a fifth mode (Lightning Poker is
the likely next one). **Named here so it is not re-found as new.**

---

### E6 (P3) - `KNOWN_VARIANTS` IS EXPORTED TWICE AND THE VOCABULARY TEST PINS THE MIGRATION FILE. **FIX: NOT STARTED - not a defect today**

Two different `KNOWN_VARIANTS` exist: `server/src/engine/VariantRules.ts`
(`Object.keys(HOLE_CARDS)`, the one `tests/unit/cashGamesVocabulary.test.ts`
pins) and `server/src/engine/HorseVariantProfile.ts` (`Object.keys(PRE)`). They
happen to agree. The vocabulary is currently in lockstep across all four
places, verified live:

* `src/config/cashGames.ts` `CASH_VARIANT_IDS` = 9 ids;
* `VariantRules.KNOWN_VARIANTS` = the same 9;
* `cash_games_variant_check` CHECK on production = the same 9;
* `fn_cash_game_create_impl_20260905`'s `VARIANT_UNAVAILABLE` gate = the same 9;
* `cash_games_template_name_check` = classic, action, madness.

The one fragility: the test reads the vocabulary out of the **migration file**
`20260904160500_cash_games_slice_1.sql`, not out of production, so a later
migration that widened the list would leave the test green and wrong. Lane C
owns the SQL; I am recording it rather than changing a test another lane may be
moving.

---

### E7 (P2, NOT A DEFECT - recorded so it is not "found" again)

Things that look wrong and are correct. Each cost me a read, so they are written
down.

1. **A bomb hand has no regular ante.** 206 of madness's 637 recent hands show
   no `ante` action on an `ante_enabled` table. `postBombPotAntes` runs and
   returns before `postBlinds`, so the bomb ante replaces it. Chips conserve.
2. **A bomb hand has no straddle and does not move the big-blind anchor.** Both
   are explicit, both are commented at `ServerTableEngineDealing` 2337-2360 and
   2469, and both are right: `config.straddles` is forced `undefined` on a bomb
   hand and `lastBigBlindSeat` is only recorded when a blind is actually posted.
3. **Classic tables carry `bomb_pot_ante_multiplier=2` and `board_count=1`.**
   Inert defaults on a disabled feature, never read while `bomb_pot_enabled` is
   false.
4. **`bomb_pot_trigger_mode='every_n_hands'` on Classic.** Same: inert, and
   `modeViable` is false at `frequency=0`, so the scheduler is off.
5. **Madness fires slightly less often than once per orbit.**
   `anchorAdvancePending` deliberately costs one extra hand per orbit so the
   bomb button walks the table instead of parking on one seat. Documented at
   `BombPotScheduler.ts` in the consume branch. It is a feature.
6. **The timed clock disappears in the last three minutes.** `nextBombDueAt`
   returns null once `armedHands` is set, by Dan's 2026-09-05 ruling so nobody
   can tank for the bomb. Not a broken countdown.
7. **The all-in-for-less-than-the-ante case is handled.** `postBombPotAntes`
   takes `Math.round(Math.min(anteAmount, player.stack) * 100) / 100` and marks
   all-in; the regular ante in `postBlinds` does the same. Side pots come from
   the normal contribution layer.
8. **`ante` is dead money.** Both ante paths add to `deadInvested`, and
   `returnUncalledBet` compares live-only investment, so the big blind who
   fronts a big-blind ante is never refunded the table's ante.

---

## 2. THE ANTE, LINE BY LINE (the part that moves money)

`HandController.postBlinds()` lines 396-408 and 544-558.

* **Individual ante** (`config.ante && !config.bigBlindAnte`): every non-sitting-out
  player pays `min(ante, stack)` BEFORE the live blinds, into `deadInvested`,
  all-in at zero. Action's `sb`-sized ante takes this path.
* **Big blind ante** (`config.ante && config.bigBlindAnte`): the big blind
  fronts `bigBlindAnteTotal(ante, seats, bigBlind)` AFTER posting the blind,
  also dead money. Madness's `bb`-sized ante takes this path, and
  `AnteMath.bigBlindAnteTotal` reads `ante >= bigBlind` as "the structure
  authored a TOTAL", which is exactly the madness case (`ante = g.bb`), so a
  6-max madness table collects ONE big blind, not six. The `BBA_CEILING_BB = 2`
  backstop caps any structure that is neither.
* **Heads-up:** `activePlayers.length === 2` puts the small blind on the button;
  the ante loop is independent of position, so both players ante. Correct.
* **Short-handed / all-in for less than the ante:** `min(ante, stack)` and the
  all-in flag; the pot-cap arithmetic uses `individualAnteInvested` so the
  history buckets stay blinds-then-antes.
* **The cash toggle is honoured, the tournament one is not:** HandConfig line
  2438 gives a tournament the level's ante unconditionally and a cash table the
  ante only when `ante_enabled`. Deliberate, commented, and correct for us:
  Classic's `ante_enabled=false` is what makes "No Antes" true even if `ante`
  were non-zero.

Verified against the felt: `fn_cash_apply_ruleset` and
`fn_cash_cluster_open_table` both write `big_blind_ante_enabled = (v_ante='bb')`,
and production shows `bba_on` = 20/20 on madness tables, 0/20 on action, 0/97 on
classic. `ante_amt_mismatch` (table `ante` <> the snapshot's chips) = 0 across
every open cluster table.

---

## 3. THE BOMB, LINE BY LINE

`BombPotScheduler.ts` read in full (595 lines) plus its decision site at
`ServerTableEngineDealing.ts` 2037-2310.

* **Action = `timed`, 900s, 2x BB, 2 boards.** `bombPotSettingsFromTable` maps
  the row; `noteHandStart` sets one pending token when `now >= nextDueAtMs`,
  never a backlog; the token is consumed only at `dealtInCount >= minPlayers`
  and the interval restarts **from the consuming hand**, not the old due time.
  Production: 45/34/18 bombs per hour across ~20 action tables, and the four
  sampled tables' inter-bomb gaps were 15:04, 15:31, 15:02.
* **Madness = `once_per_orbit`, 3x BB, 2 boards.** The orbit is tracked by the
  button CROSSING an anchor seat (`buttonCrossedAnchor`, a clockwise arc test
  needing no table-size modulus), not by counting hands, so a seat joining or
  leaving mid-orbit neither adds nor skips a bomb. `from === to` correctly
  returns false (the 2026-08-29 runaway fix).
* **The timer across a restart / table break / promotion.** `exportState()` is
  written to `tables.bomb_pot_sched_state` after the decision (so a bomb hand
  persists ITS own button seat, not the previous one), guarded by a JSON diff so
  it is one row write only when something moved, and a disabled schedule clears
  the row so a stale `{p:true}` cannot detonate on re-enable. `restoreState`
  fills a FRESH scheduler only and validates every field independently.
  `seedNextDueAt` fills an empty clock from the legacy
  `bomb_pot_next_due_at` column. **A table break or promotion is a different
  table id and therefore a different scheduler**, which is correct: a feeder
  promoted to a main keeps its own bomb clock, and a player moved between them
  is subject to the destination's.
* **A bomb hand at the must-move boundary.** The move executes at a hand
  boundary (`fn_cash_seat_move_execute` and the engine's settlement branch), and
  the bomb decision is taken at the hand boundary too, BEFORE `HandConfig` is
  built - `ServerTableEngineDealing` line 2044 comment: "a hand already in
  progress can never become a bomb pot". A player moved out before the deal is
  simply not in `players`, so they neither ante nor are dealt in. No overlap.
* **A new arrival during a bomb.** An arrival is registered into `waitingForBB`
  at the top of the loop and is held out of the deal until the big blind reaches
  them or they post; `entry_hold='moved'` (a must-move arrival) is dealt in
  free, which is Dan's 2026-09-05 ruling ("NO POST ... THEY ALREADY POSTED AT THE
  PREVIOUS TABLE"). Either way they are in or out of the whole hand, bomb or
  not, and a bomb charges only `state.players.filter(p => !p.is_sitting_out)`.
  I found no path by which an arrival pays a bomb ante for a hand they are not
  dealt into.
* **Board count.** `bomb_pot_board_count` wins; the legacy `double_board`
  boolean maps to 2; `HandController` downgrades stepwise only if the deck
  cannot cover `players x holeCards + 5 x boards`. Both templates request 2 and
  every live table is at 2.
* **Variant override.** Null on every cluster table, so `resolveBombPotVariant`
  returns the table's own variant. The whitelist plus the fixed-limit-line and
  `maxSeatsForVariant` checks were read and are correct.

---

## 4. THE VPIP FLOOR, LINE BY LINE

* `tables.nit_game / maintain_percent_min / maintain_hands` are the columns;
  `career_percent_min` is always 0 on a templated game and the career branch is
  therefore dead there.
* The rule is a QUERY, not engine state: `fn_nit_evictions` -> `fn_nit_check`
  over `ca_hand_facts`, called at every hand boundary from the shared eviction
  pass at `ServerTableEngineBase` 5301. Failure returns an empty list, so a
  stats query that cannot answer never removes anyone.
* `collectNitStatus` (`fn_nit_status`) is read beside it and handed to the horse
  brain as `vpipFloor` + `ownVpip`, so a horse widens toward the floor instead of
  being stood up by it (10.5). The floor it is handed comes from `vpipFloor()`,
  which is cached - that is E1's fourth row.
* The eviction cashes out with `leaveMode: 'vpip_evicted'`, which is what makes
  the two-hour bar fire; every other eviction stays a plain system exit.
* Horses: no `is_horse` predicate anywhere in `fn_nit_evictions`,
  `fn_nit_check`, `fn_nit_status` or the engine gate. Verified on the live
  bodies.
* The floor VALUES are the template's, not a stale snapshot: 0 games and 0 open
  tables disagree with `fn_cash_template_defaults` on `vpip_floor`,
  `vpip_window`, `regular_ante` or the whole `bombs` object (one query, 109
  enabled games). `20260907190515`'s trigger `zz_cash_game_floor_from_template`
  is live and holds.
* **The scope was wrong, and that is E2.**

---

## 5. STRADDLE, SEVEN-DEUCE, RUN-IT

* **Straddle is off (R2)** on all 137 open cluster tables, all three spellings
  (`straddle_enabled`, `auto_utg_straddle`, `voluntary_straddle`), and both the
  opener and the reconciler force all three false unconditionally. The engine's
  straddle block is gated on `tableInfo.straddle_enabled` so it never runs.
* **Seven-deuce only on NLH:** the create path guards
  `... AND v_v = 'nlh'`; production has 0 non-NLH games and 0 non-NLH tables
  with it on. The reconciler now carries the same guard (E4).
* **Run-it:** `run_it_n_times: 'opt_in'` on every template, RIT is cash-only
  (`ritIsTournament` gate), the mode is read additively so an unrecognised value
  can only ever remove the QUESTION and never the feature, and the three
  booleans are OR-ed the way owner intent demands. The drift was E3.

---

## 6. THE VOCABULARY

`src/config/cashGames.ts` (9 variants, 3 templates), `VariantRules.KNOWN_VARIANTS`
(9), the `cash_games` CHECKs (9 variants, 3 templates) and the create function's
refusal list (9) all agree, verified against production, not against the
migration file. `tests/unit/cashGamesVocabulary.test.ts` pins all four but reads
the SQL out of the slice-1 migration (E6).

---

## 7. FILES AND FUNCTIONS READ LINE BY LINE

Engine:

* `server/src/engine/BombPotScheduler.ts` - all 595 lines.
* `server/src/engine/AnteMath.ts` - all 85 lines.
* `server/src/engine/ServerTableEngineDealing.ts` - 260-560 (arrival, entry
  hold, wait-for-BB, post-to-enter), 1500-1560 (`readNextHandInputs`,
  `refreshBlinds`), 1955-2480 (straddle, bomb decision, scheduler persistence,
  away-blind cap, `HandConfig`), 2610-2630 (`mustPostBB`).
* `server/src/engine/ServerTableEngineBase.ts` - 2085-2250
  (`applyRunItTwiceConfig`), 2290-2400 (`start()` config block), 4745-4770
  (`vpipFloor`, `nitStatus`), 4780-4820 (manual bomb push), 4860-4960
  (`refreshRakeConfig`), 5275-5400 (the shared eviction pass).
* `server/src/engine/HandController.ts` - 360-560 (`postBlinds`, ante, dead
  blinds, snapshots), 672-800 (`postBombPotAntes`), 2050-2100
  (`returnUncalledBet`).
* `server/src/engine/ServerTableEngine.ts` - 160-180 (`anteSnapshotFields`).
* `server/src/engine/RunItTwiceEngine.ts` - 20-80 (`RunItMode`, `RITConfig`).
* `server/src/engine/VariantRules.ts` - 100-135.
* `server/src/services/supabase/nitGame.ts` - all 133 lines.
* `server/src/services/supabase/tables.ts` - the `TABLE_COLUMNS` select.
* `server/src/types.ts` - the `TableInfo` and `HandConfig` ante/bomb/RIT fields.

Client / config:

* `src/config/cashGames.ts`, `tests/unit/cashGamesVocabulary.test.ts`,
  `src/components/table/HeroVpipTracker.tsx`.

Production function bodies (`pg_get_functiondef`, live):

* `fn_cash_template_defaults`, `fn_cash_apply_ruleset`,
  `fn_cash_cluster_open_table`, `fn_cash_game_create_impl_20260905` (the options
  and snapshot block), `fn_nit_check`, `fn_nit_evictions`, `fn_nit_status`,
  `fn_cash_vpip_status`, `fn_cash_game_roster_track`, `fn_tables_sync_rit`, and
  every CHECK constraint and trigger on `tables` and `cash_games`.

---

## 8. MIGRATION

`supabase/migrations/20260909181230_the_floor_follows_the_player_and_the_ruleset_projects_every_promise.sql`
- one `BEGIN`/`COMMIT`, reasoning in the header, assertions at the foot that
abort the transaction if the board moved. Version reserved with
`scripts/reserve-migration-version.sh` (never hand-picked, 4.5). Carries E2, E3
and E4. Lane C's `20260909191454` sorts after it and edits the same function by
anchored literal replacement, and the anchors it needs (`min_buy_in` /
`max_buy_in` in both the SET list and the predicate) are preserved verbatim in
my body.

Probe, rolled back against production, one `execute_sql` call, `pg_temp` copies
of all four bodies, ending in `RAISE EXCEPTION`:

```
PROBE (rolled back):
  bad_rit before=42 after=0 | applied_rows=42 events_with_rit=42
  second apply touched 0 rows (idempotent)
  min_players_bad before=4 after=0
  nit_status rows=13 changed=0 evict old=0 new=0 hands_gained=0
  nit_check ok-disagreements=0
  floorless table still answers nit_game_off
```

Read that scoreboard as: the RIT drift is real and the fix closes all 42 of it;
applying twice is a no-op; and **nobody is stood up by the VPIP change** - the
13 seats currently on floored tables are all inside one table's sitting already,
so the widened sample returns the same numbers today and only starts to differ
once a player is moved.

---

## 9. WHAT I COULD NOT DO, AND WHY

1. **I could not settle E1 from production data.** The only ruleset apply that
   changed antes on live Classic tables (03:54:45 on 09-09) sits inside the
   maintenance freeze and three minutes before the hourly engine restart, so
   only 3 hands were dealt between the apply and the restart. The code path is
   decisive and I have relied on it; I am not dressing an absent measurement up
   as a confirmation.
2. **E5 (unknown bomb trigger falls back to bombs-off) is left unfixed** on
   purpose: unreachable behind the DB CHECK today, and the right treatment
   (warn and fall back loudly) belongs in the same edit as the fifth trigger
   mode, which Lightning Poker will bring.
3. **E6 (the vocabulary test reads a migration file rather than production)** is
   left to lane C, who owns that SQL and may be moving the file the test pins.
4. **I did not change `fn_cash_cluster_open_table`.** Its projection and mine
   now agree column for column, but it is lane C's file and the divergence that
   mattered was in the reconciler.
5. **Nothing was committed, pushed or applied.** Both probes were rolled back.



---

## 10. COMMANDS AND THEIR TAILS

All run on the host terminal in the worktree, `nohup` + poll.

**Typecheck** (`cd server && npx tsc --noEmit -p .`):

```
TSC_SERVER_EXIT=0
```

Clean, no output. Run twice: once after the engine edit, once after restoring
the file from the negative control.

**Server tests covering ante / bomb / vpip / nit / templated re-read**
(`cd server && npx vitest run src/engine/TemplatedRulesAreReRead.test.ts
src/engine/BombPotScheduler.test.ts src/engine/AnteMath.test.ts
src/engine/HandController.bigblindante.test.ts
src/engine/HandController.doubleboard.test.ts
src/engine/HandController.forcedbets.test.ts src/engine/HorseVpipFloor.test.ts`):

```
 ✓ src/engine/AnteMath.test.ts (13 tests) 2ms
 ✓ src/engine/BombPotScheduler.test.ts (36 tests) 5ms
 ✓ src/engine/HorseVpipFloor.test.ts (11 tests) 3ms
 ✓ src/engine/HandController.forcedbets.test.ts (16 tests) 3ms
 ✓ src/engine/HandController.bigblindante.test.ts (2 tests) 8ms
 ✓ src/engine/TemplatedRulesAreReRead.test.ts (7 tests) 9ms
 ✓ src/engine/HandController.doubleboard.test.ts (8 tests) 223ms

 Test Files  7 passed (7)
      Tests  93 passed (93)
VITEST_SERVER_EXIT=0
```

**Negative control on the new pin** (fix temporarily removed):

```
 × ... an Action table realigned to Classic stops charging an ante without a restart
 × ... and stops running the VPIP floor, and the felt floor follows
 × ... recompiles the RIT engine from the fresh row, not the boot row
 Test Files  1 failed (1)
      Tests  3 failed | 4 passed (7)
```

**Vocabulary** (`npx vitest run tests/unit/cashGamesVocabulary.test.ts`, root config):

```
 Test Files  1 passed (1)
VITEST_ROOT_EXIT=0
```

**Note on running server tests:** the ROOT vitest config only includes
`tests/**`, so `npx vitest run server/src/...` from the repo root exits 1 with
"No test files found". Server tests need `cd server` (its own
`server/vitest.config.ts`). That cost me a cycle and is written down here so it
does not cost the next lane one.

**Migration probe:** one `execute_sql` call against production, `pg_temp`
copies of the four function bodies, ending in `RAISE EXCEPTION` so the single
transaction it had was aborted. Scoreboard in section 8. An error IS the
success case for that shape (11.5 rule 1); it returned the report as the call's
error text and committed nothing.

**Preconditions re-confirmed at 20:22 UTC**, two hours after the probe, so the
migration's assertions will not abort on a moved board:

```
games_not_opt_in     0     (every enabled game's snapshot says run_it_n_times = opt_in)
bad_rit_now         42     (unchanged - nothing else has fixed it)
bad_min_players_now  4     (unchanged)
bad_seven_deuce_now  0
seated_without_roster 0    (302 of 302 seated players hold a live roster row)
```

---

## 11. WHAT THE INTEGRATOR NEEDS FROM ME

| file | mine? | note |
| --- | --- | --- |
| `supabase/migrations/20260909181230_the_floor_follows_the_player_and_the_ruleset_projects_every_promise.sql` | new, mine | E2 + E3 + E4. Replaces the whole body of `fn_cash_apply_ruleset`; lane C's `20260909191454` sorts after it and edits by anchored literal on `min_buy_in`/`max_buy_in`, which my body preserves verbatim in both the SET list and the predicate. **Apply mine first.** |
| `server/src/engine/ServerTableEngineBase.ts` | **SHARED** | E1. Two methods touched. No control flow moved, no signature changed. See the hunk list below. |
| `server/src/engine/TemplatedRulesAreReRead.test.ts` | new, mine | 7 pins, negative-controlled. |
| `docs/audits/2026-09-09-must-move-audit/lane-E.md` | new, mine | this file. |

No schema-manifest fragment is needed: the migration only does
`CREATE OR REPLACE` on four functions that already exist in production, and
creates no table, function or column that is new.

### Exactly which hunks in the shared engine file are mine

Another lane is editing `ServerTableEngineBase.ts` in the same worktree (the
seat-move notice work: the `seatMoveCancelledNotice` import at line 69 and the
hunks between 2454 and 3285). **Those are not mine.** Mine are four, all in
two methods:

| hunk (post-edit line) | what |
| --- | --- |
| `@@ -2128,11 +2129,19` | `applyRunItTwiceConfig` doc comment only. Replaces the "ONE CAVEAT ... deliberately NOT taken here" paragraph, which now asserts the opposite of what the code does. Zero executable lines. |
| `@@ -4892,0 +4995,24` | `refreshRakeConfig` doc comment only. Adds the "IT IS NOT ONLY RAKE ANY MORE" section. Zero executable lines. |
| `@@ -4910 +5036,5` | the `select` list: 19 columns appended, plus a 4-line comment. |
| `@@ -4945,0 +5076,57` | the assignment block: 19 writes onto `this.tableInfo`, one `this.applyRunItTwiceConfig()` call, and the comment explaining why insurance is not re-configured. |

Two of the four are comments. The whole executable change is 20 assignments and
one method call inside a method that already existed to do exactly this job.

`npx tsc --noEmit -p server` passes on the COMBINED tree (my edits plus the
other lane's in-flight ones), so the two do not conflict as they stand.
