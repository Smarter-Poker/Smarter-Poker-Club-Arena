# Lane C - the SQL that makes Classic, Action and Madness three different games

Scope: `fn_cash_template_defaults`, `fn_cash_game_create` and its impl,
`fn_cash_override_int/bool`, `fn_cash_apply_ruleset` and its callers,
`fn_cash_stakes_label`, `fn_cash_stake_band`, `fn_assign_horse_stake_bands`,
`fn_nit_evictions` and the VPIP readers, the `cash_games` table with its CHECKs,
indexes and triggers, and the five migrations named in the lane brief.

**Everything below was read from PRODUCTION (`kuklfnapbkmacvwxktbh`) with
`pg_get_functiondef` and `execute_sql` between 17:30 and 18:15 UTC on
2026-09-09.** A migration file is never the authority here; the live body is.
Nothing was applied. Probes are rolled back.

---

## 1. THE TRUTH TABLE, derived from `fn_cash_template_defaults` (live 17:33 UTC)

The function takes `(template, variant)` and returns the whole ruleset. There is
no per-variant branch on any rule except the seat choices, so the table is one
row per template plus a family column.

| field                                         | classic                                 | action                                                 | madness                                        | notes                                                                    |
| --------------------------------------------- | --------------------------------------- | ------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `regular_ante`                                | `none`                                  | `sb`                                                   | `bb`                                           | projected to chips as `sb`->`g.sb`, `bb`->`g.bb`, `none`->0              |
| ante columns on `tables`                      | `ante_enabled=false, ante=0, ante_bb=0` | `ante_enabled=true, ante=g.sb, ante_bb=round(sb/bb,4)` | `ante_enabled=true, ante=g.bb, ante_bb=1.0000` |                                                                          |
| `big_blind_ante_enabled`                      | false                                   | false                                                  | **true**                                       | `bb` is the FORMAT (one ante posted by the big blind), not just the size |
| `vpip_floor`                                  | **0**                                   | **30**                                                 | **50**                                         | flat across families, Dan 2026-09-05                                     |
| `vpip_window`                                 | 10                                      | 10                                                     | 10                                             | Dan 2026-09-04, "after 10 hands"                                         |
| `nit_game` on `tables`                        | false                                   | true                                                   | true                                           | derived as `vpip_floor > 0`                                              |
| `career_percent_min`                          | 0                                       | 0                                                      | 0                                              | always 0; only MAINTAIN is used                                          |
| `bombs.enabled`                               | **false**                               | true                                                   | true                                           |                                                                          |
| `bombs.trigger`                               | null                                    | `timed_15m`                                            | `every_orbit`                                  |                                                                          |
| `bomb_pot_trigger_mode`                       | `every_n_hands`                         | `timed`                                                | `once_per_orbit`                               | classic's value is inert because `bomb_pot_enabled=false`                |
| `bomb_pot_interval_seconds`                   | null                                    | **900**                                                | null                                           |                                                                          |
| `bombs.ante_bb` -> `bomb_pot_ante_multiplier` | null -> **2**                           | **2**                                                  | **3**                                          | classic's 2 is a coalesce default on a disabled feature                  |
| `bombs.boards` -> `bomb_pot_board_count`      | null -> **1**                           | **2**                                                  | **2**                                          |                                                                          |
| `bomb_pot_double_board`                       | false                                   | true                                                   | true                                           | `boards >= 2`                                                            |
| `bomb_pot_frequency`                          | 0                                       | 0                                                      | 0                                              |                                                                          |
| `bomb_pot_min_players`                        | 2                                       | 2                                                      | 2                                              |                                                                          |
| `straddle`                                    | false                                   | false                                                  | false                                          | and all three `tables` spellings forced false                            |
| `run_it_n_times`                              | `opt_in`                                | `opt_in`                                               | `opt_in`                                       |                                                                          |
| `min_buyin_bb`                                | **40**                                  | **50**                                                 | **100**                                        |                                                                          |
| `max_buyin_bb`                                | 200                                     | 200                                                    | 200                                            |                                                                          |
| `stay_clock_min`                              | 10                                      | 10                                                     | 10                                             | floor; a host may only RAISE it                                          |
| `rejoin_window_min`                           | 120                                     | 120                                                    | 120                                            | floor; a host may only RAISE it                                          |
| `rake`                                        | `existing`                              | `existing`                                             | `existing`                                     | `rake_percent=-1, rake_cap_bb=-1` means inherit                          |
| handedness, holdem family (`nlh`, `flh`)      | seats **9**, choices [9, 6]             | seats 6, choices [2..9]                                | seats 6, choices [2..9]                        | not locked                                                               |
| handedness, PLO family (`plo4/5/6/8`, `flo8`) | seats 6, choices [6], **LOCKED**        | same                                                   | same                                           |                                                                          |
| handedness, `short_deck` / `pineapple`        | seats 6, choices [2..8]                 | same                                                   | same                                           | not locked                                                               |

Two remarks that matter and are not obvious from the table:

- **`flo8` is in the PLO family, so a Classic FLO8 game is 6-max and locked**,
  while a Classic FLH game is 9-max. `fn_cash_stakes_label` also prints limit
  variants (`flh`, `flo8`) as `bb/bb*2` rather than `sb/bb`.
- **Classic's bomb fields are not null, they are inert.** `bomb_pot_ante_multiplier`
  2 and `bomb_pot_board_count` 1 sit on every Classic table. That is correct
  (the columns are NOT NULL-ish defaults on a disabled feature) and is why the
  Classic check below tests `bomb_pot_enabled`, never the multiplier.

## 2. WHAT AGREES WITH PRODUCTION (verified, no defect)

Read 17:47-18:05 UTC.

- **Every enabled `cash_games` row agrees with its template** on `regular_ante`,
  `vpip_floor`, `vpip_window` and the whole `bombs` object: 0 disagreements
  across 69 classic / 20 action / 20 madness enabled (and 0 across the 41
  disabled). 20260909035303's backfill held.
- **Every open cluster table agrees with its game's snapshot** on the ante trio,
  `nit_game`/`maintain_percent_min`/`maintain_hands`, every `bomb_pot_*` field,
  the buy-in band and the three straddle columns: 0 disagreements across 137
  tables. Classic: 0 tables with an ante, a bomb or a VPIP floor. Action and
  Madness: ante, bomb and floor on **all 40**, `timed`/900 on the 20 Action and
  `once_per_orbit` on the 20 Madness.
- **The one-per-band law holds counting variant.** 0 duplicate
  `(club, template, variant, fn_cash_stake_band(bb))` groups among enabled
  Action/Madness games; 40 games, all `handedness` 6; no INVALID index anywhere.
- **Classic keeps its stakes**: 10 distinct levels (0.01/0.02 through 25/50),
  69 enabled games, and `cash_games_one_per_band_action_madness` names only
  `action` and `madness` in its predicate.
- **Handoff item 5.1 is CLOSED.** `fn_assign_horse_stake_bands` reads
  `fn_available_stake_bands()` (bands with an enabled game), fails open on an
  empty read, projects the merit ladder through `fn_project_stake_band`, and
  **clamps again after hysteresis** - that clamp is exactly the path that would
  otherwise let a horse keep a `high` band with no high game. It cannot mint
  `high` today. (One latent hole in the projection, finding C6 below.)
- **`fn_nit_evictions` carries no `is_horse` predicate** (CLAUDE.md 10.5) and
  the comment records its removal. `cash_tables_needing_engine` likewise.
- `fn_cash_stake_band` (micro <=0.5, low <=2, mid <=6, else high) matches the
  engine's `stakeBandForBigBlind` and the law that pins them.

## 2b. THE FINAL VERIFICATION BOARD (read 19:29:53 UTC, one query)

The lane's own acceptance, re-read at the end rather than quoted from the
middle of the session. Nothing moved under me.

| what                                                                                            | count                 | verdict                                                                   |
| ----------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------- |
| enabled `cash_games`                                                                            | 109                   |                                                                           |
| enabled games whose snapshot disagrees with its template on ante / floor / window / bombs       | **0**                 | PASS                                                                      |
| open cluster tables                                                                             | 140                   |                                                                           |
| Classic tables carrying an ante, a bomb pot or a VPIP floor                                     | **0**                 | PASS (3)                                                                  |
| Action or Madness tables MISSING any of the three                                               | **0**                 | PASS (4)                                                                  |
| tables whose projected columns disagree with their game's snapshot (ante, bombs, floor, window) | **0**                 | PASS (2)                                                                  |
| `(club, template, variant, band)` groups with more than one enabled Action/Madness game         | **0**                 | PASS (5)                                                                  |
| distinct Classic stake levels                                                                   | **10**                | PASS (6)                                                                  |
| bands with an enabled game (`fn_available_stake_bands`)                                         | micro, low, mid, high | PASS (7) - the ladder is bounded and `high` is real (`NLH 25/50 Classic`) |
| tables `lifecycle='closed'` with `status<>'closed'`                                             | **2**                 | OPEN - lane A's `181653` (finding C4), both empty                         |
| tables whose `max_players` differs from the game's handedness                                   | **2**                 | OPEN - my `191454` (finding C3)                                           |
| tables with `run_it_mode <> 'player_choice'`                                                    | **42**                | OPEN - lane E's `181230` (finding C3)                                     |

The three OPEN rows are the three fixes this audit has written and not applied.
Every closed row is a rule that already holds on the felt.

## 3. FINDINGS

Severity: P0 money/integrity, P1 player-visible wrong behaviour, P2 gap/stub/dead
code, P3 polish.

### C1 (P1) - the template promise is enforced at the front door only. **FIX: MINE, written**

`zz_cash_game_floor_from_template` (BEFORE INSERT OR UPDATE OF
`ruleset_snapshot, template_name, variant` on `cash_games`, from 20260907190515)
pins **only** `vpip_floor` and `vpip_window`. 20260909035303 stopped
`fn_cash_game_create_impl` from reading the caller's ante and bombs, but a
direct `UPDATE cash_games SET ruleset_snapshot = ...` - an operator console, a
backfill, the next creation path somebody writes - can still put a small-blind
ante or a bomb pot back on a Classic game, and nothing refuses it. The 23 games
corrected on 09-09 were created by exactly such a batch write.

Evidence: `pg_get_functiondef('fn_cash_game_floor_from_template')` at 17:36 UTC
sets `{vpip_floor}` and `{vpip_window}` and nothing else.

Fix: the trigger pins the whole promise - `regular_ante`, `vpip_floor`,
`vpip_window` and `bombs` - on every write, from `fn_cash_template_defaults`.

### C2 (P1) - a locked key was silently ignored. **FIX: LANE I, not mine**

Since 20260909035303 a caller who sends `regular_ante: 'sb'` on a Classic game
gets a game with no ante and no word about it, while the create flow was still
rendering the ante radio and the bomb controls. Lane I's
`20260909181309_a_locked_rule_is_refused_not_ignored_and_a_band_refusal_names_the_holder.sql`
adds `OVERRIDE_LOCKED: <key> is set by the <template> template (sent %, template %)`
and passes `ONE_GAME_PER_BLIND_CATEGORY` through the create function's
`unique_violation` handler instead of masking it as `GAME_EXISTS`. I had drafted
the same fix; **it is deleted from my work rather than duplicated** - two
migrations rewriting one function body is a coin flip decided by apply order.
`src/config/cashGames.ts` in this worktree already carries the host copy for both
codes (`OVERRIDE_LOCKED`, `ONE_GAME_PER_BLIND_CATEGORY`) and the
`TEMPLATE_LOCKED_RULES` constant that takes the four keys out of the overrides
payload.

### C3 (P1) - the reconciler reconciled half the table. **FIX: PARTLY LANE E, remainder MINE**

`fn_cash_apply_ruleset` is the Gate 5 promise that "the snapshot is the rule",
run every tick from `fn_cash_cluster_tick`. It projected a SUBSET of what
`fn_cash_cluster_open_table` writes, and its drift predicate named a smaller
subset again - so a table could disagree with its own game and the reconciler
reported nothing to reconcile.

Measured 17:50 UTC over the 137 open cluster tables:

| what drifted                                                                 | tables  | who fixes it    |
| ---------------------------------------------------------------------------- | ------- | --------------- |
| `run_it_mode='none'` where the opener writes `player_choice`                 | **42**  | lane E (181230) |
| all three run-it booleans false where the opener writes true                 | **41**  | lane E          |
| `bomb_pot_min_players=3` (opener writes 2)                                   | 4       | lane E          |
| `seven_deuce_amount=2` with seven-deuce OFF                                  | 4       | lane E          |
| `stakes` label `$0.10/$0.25` where the game says `0.10/0.25`; one `0.05/0.1` | **42**  | **mine**        |
| `max_players=7` on a 6-handed PLO5 game (one has a player in seat 7)         | **2**   | **mine**        |
| `career_percent_min` written but never in the predicate                      | 0 today | **mine**        |

The run-it half is the player-visible one: `NLH 1/2 Classic` offered Run It Twice
on the table the controller opened and not on the table Gate 7 adopted, so a
player the cluster moved lost the feature mid-session with no message. Lane E
owns it and its migration sorts after mine would have; my draft of that half is
deleted.

My remainder is the seat ceiling and the label. The ceiling is written as
`GREATEST(g.handedness, highest occupied seat)` so a 7-seat table adopted onto a
6-max game comes down to 6 **the tick after seat 7 empties** - nobody is closed
out of a chair they are sitting in.

### C4 (P2) - the last two ghost tables were outside the selector's sight. **FIX: LANE A (181653), verified**

20260909035303 added `status_followed_lifecycle` to the tick and took
`lifecycle='closed' AND status<>'closed'` from 32 tables to 2. The two that
remain (read 17:45 UTC) are `FLO8 0.50/1 Action` (`fd9335bb`) and
`FLO8 0.50/1 Madness` (`b652e87b`), both empty, both on games disabled
2026-09-04 21:51:40, both still answering `status='waiting'` to every
status-based read, both touched at every `:55` break (`updated_at` 17:56 and
18:00 UTC). The repair could never reach them: `fn_cash_clusters_to_tick`
admits a disabled game only if it holds a table with `lifecycle <> 'closed'`,
and their only table is closed on that axis. Lane A's
`20260909181653_the_worklist_admits_a_game_with_a_half_closed_table.sql` widens
that test to "not closed on BOTH axes", which is the same fix I had drafted.
**Deleted from mine.** I verify the outcome in my probe instead.

### C5 (P1) - `fn_cash_game_ensure` did not know which template it was ensuring. **FIX: MINE, written**

It matched an existing game on `(club_id, variant, sb, bb)` alone and took
`ORDER BY enabled DESC, created_at LIMIT 1`. The template was used only when
CREATING. On the platform club (`fade0000-...-0001`) Action and Madness were
created before Classic at several shared stakes, so:

```
key (nlh, 1.00/2.00)   -> returns "NLH 1/2 Action"     (asked for classic)
key (plo6, 2.00/5.00)  -> returns "PLO6 2/5 Madness"   (asked for classic)
```

read 18:02 UTC; 29 keys on that club carry more than one template, 2 of them
resolve to a non-Classic game. `HorseFleetManager.openPlannedTables` calls
`fn_cash_game_ensure(..., p_template => 'classic', ...)` for every Stable Hand
open order, so a Classic order was answered with a game that charges an ante and
runs a bomb pot. It is not a wallet defect - the seats are bought correctly for
whatever game they land on - but the fleet's own plan said Classic and the floor
gave it Madness.

Two smaller things in the same function: it accepted **any** `p_handedness`
without checking the template's `seat_choices` (the fleet passes
`clampSeatsForVariant(variant, 9)`, so a 9 would have been written onto a
6-locked PLO game had the clamp ever failed), and it wrote a snapshot with **no
`table_mode` key** - 42 of 69 enabled Classic games carry no `table_mode` today
(41 from the Gate 7 adoption, 1 from `ensure`), while `must_move` is true on all
of them.

Fix: the template joins the key; handedness falls back to the template default
when the caller asks for a size the template does not offer, and the
`game_created` event records both what was asked and what was written;
`table_mode` is written, and backfilled from `must_move` for the 42.

### C6 (P2) - `fn_project_stake_band` could hand a horse a band with no game. **FIX: MINE, written**

`20260906093032_a_band_with_no_game_gets_no_horses` folds a missing rung into
the one BELOW it. When there is nothing at or below the wanted rung the
`COALESCE` falls through to `p_band` - the band it was asked to project away.
Read against the live function at 19:20 UTC:

| call                                        | live answer                       | correct                 |
| ------------------------------------------- | --------------------------------- | ----------------------- |
| `fn_project_stake_band('micro', {low,mid})` | **`micro`** - a band with no game | `low`                   |
| `fn_project_stake_band('low', {mid,high})`  | **`low`** - a band with no game   | `mid`                   |
| `fn_project_stake_band('high', {micro})`    | `micro`                           | `micro` (already right) |

Fixed to fall to the LOWEST band that has a game, keeping "no game anywhere ->
return `p_band`" (the caller's fail-open) as the last resort.

**A correction I owe this report.** My first draft asserted
`project('high', {micro}) = 'micro'`, which the OLD body already answers
correctly - a check that cannot fail, which is CLAUDE.md 10.86's trap written
into an assertion. The migration now asserts the two rows above that do
discriminate, and the probe below shows both flipping.

Today all four bands have an enabled game (`high` exists because of
`NLH 25/50 Classic`), so the broken arm has never fired in production. It fires
the first time an operator closes the games in a band while a horse holds a
band below it.

### C7 (P3) - a dead default said forty. **FIX: MINE, written**

`fn_cash_apply_ruleset` and `fn_cash_cluster_open_table` both default
`vpip_window` to **40** when a snapshot lacks the key. Dan's window is ten since
20260904231353 and the trigger now guarantees the key exists, so the branch is
unreachable - but a reader who greps for the window finds three answers. Set to
10 in both.

### C8 (P2, NOT A DEFECT - recorded so it is not "found" again)

- **5 enabled Classic games carry a 100-500 or 400-1000 BB buy-in band**
  (`FLO8 0.25/0.50`, `FLO8 0.50/1`, `PLO4 1/2`, `PLO6 0.25/0.50`, `PLO6 2/5`).
  The buy-in band is explicitly a host-editable field by 20260909035303's own
  rule ("everything else a host still edits: buy-in band, stay clock, rejoin
  window, handedness, table options"), and these are the Deep Stack catalogue's.
  **Left alone.**
- **`bomb_pot_ante_multiplier=2` and `bomb_pot_board_count=1` on Classic
  tables** are inert defaults on a disabled feature, not a bomb pot.
- **Legacy duplicate columns** (`enable_straddle`/`allow_straddle` true on 133
  cluster tables, `min_buy_in_bb`/`max_buyin` etc.) are read by nothing in the
  engine's select list (`server/src/services/supabase/tables.ts`), which reads
  `straddle_enabled` alone. The lobby (`src/components/lobby/lobbyEntries.ts`)
  deliberately reads only the engine's spelling and says so. Not touched: a
  second spelling of a boolean has no correct value, and the one that decides is
  already reconciled to false.
- `fn_cash_template_defaults`'s `VARIANT_UNAVAILABLE` list, the `cash_games`
  variant CHECK and `KNOWN_VARIANTS` in `server/src/engine/VariantRules.ts` are
  the same nine ids (`nlh, plo4, plo5, plo6, plo8, flo8, flh, short_deck,
pineapple`), pinned by `tests/unit/cashGamesVocabulary.test.ts`. **No drift.**

## 4. FILES AND FUNCTIONS READ LINE BY LINE

Live production bodies (`pg_get_functiondef`): `fn_cash_template_defaults`,
`fn_cash_game_create`, `fn_cash_game_create_impl_20260905`,
`fn_cash_override_int`, `fn_cash_override_bool`, `fn_cash_apply_ruleset`,
`fn_cash_cluster_open_table`, `fn_cash_clusters_to_tick`, `fn_cash_cluster_tick`
(first 18KB), `fn_cash_game_ensure`, `fn_cash_game_floor_from_template`,
`fn_guard_one_game_per_blind_category`, `fn_cash_stakes_label`,
`fn_cash_stake_band`, `fn_project_stake_band`, `fn_available_stake_bands`,
`fn_assign_horse_stake_bands`, `fn_nit_check`, `fn_nit_evictions`,
`fn_nit_status`, `fn_cash_vpip_status`, `fn_cash_effective_buyin`,
`fn_cash_rejoin_floor`, `fn_cash_game_barred_seconds`, `fn_cash_session_open`,
`fn_cash_session_close`, `fn_cash_stay_remaining_ms`, `fn_tables_sync_rit`,
`fn_tables_autostart_guard`, `cash_tables_needing_engine`.

Schema: `cash_games` columns / CHECKs / indexes / triggers,
`cash_rejoin_constraints` columns and indexes, all 24 non-internal triggers on
`tables`.

Repo: `supabase/migrations/20260905030225`, `20260905033729`, `20260906004318`,
`20260907190515`, `20260909035303`, `20260904231353`, `20260828_cash_buyins_are_40bb_to_200bb`;
`src/config/cashGames.ts`, `src/components/cash/CashGameCreateFlow.tsx`,
`src/components/cash/CashGameCard.tsx` (rules line), `src/components/lobby/lobbyEntries.ts`
(straddle / RIT predicates), `server/src/engine/VariantRules.ts`,
`server/src/engine/ServerTableEngineBase.ts` (RIT config 2150-2235, VPIP floor
4750-4765, nit eviction 5280-5400), `server/src/services/supabase/tables.ts`
(the engine's select list), `server/src/services/HorseFleetManager.ts`
(`fn_cash_game_ensure` call site), `tests/unit/cashGamesVocabulary.test.ts`,
`tests/unit/vpipFloorIsTheTemplates.test.ts`,
`tests/cash-games-are-created-from-a-template.law.test.tsx`.

## 5. MIGRATIONS

| version                                                                                                    | owner             | state                                   |
| ---------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------- |
| `20260909191454_the_promise_is_pinned_the_ensure_knows_its_template_and_the_seat_ceiling_follows_the_game` | **lane C (mine)** | written, **probed rolled back, PASSES** |
| ~~`20260909181208_the_template_is_the_whole_game_not_only_its_creation`~~                                  | lane C (mine)     | **DELETED, empty skeleton**             |
| ~~`20260909181220_a_rathole_floor_and_a_vpip_bar_belong_to_one_game`~~                                     | lane C (mine)     | **DELETED, empty skeleton**             |
| `20260909181230_..._projects_every_promise`                                                                | lane E            | not mine, untouched                     |
| `20260909181259_a_leave_cancels_the_move...`                                                               | lane B            | not mine, untouched                     |
| `20260909181309_a_locked_rule_is_refused_not_ignored...`                                                   | lane I            | not mine, untouched; it is C2's fix     |
| `20260909181653_the_worklist_admits_a_game_with_a_half_closed_table`                                       | lane A            | not mine, untouched; it is C4's fix     |

### Why the two skeletons were deleted rather than filled

I reserved `181208` and `181220` before reading the other lanes' files. By the
time the work was written:

- the ante/bombs/VPIP override refusal I had drafted for `181208` was already
  lane I's `181309`, better done (it names the sent value and the template value
  in the message);
- the VPIP-bar and rathole-floor material I reserved `181220` for is lane E's
  `181230`, which also carries the `fn_nit_check` change that makes the floor
  follow a player across a must-move move;
- and the half that IS mine could not live at `1812xx` at all. **Lane E replaces
  the entire body of `fn_cash_apply_ruleset`.** A version that sorts before it
  and rewrites the same function loses whichever half applies first. So the
  remaining work was re-reserved at `20260909191454`, which sorts after every
  sibling in this audit, and the reconciler half is written as an **anchored
  literal replacement on the live body** rather than a retype, so it composes
  with lane E's instead of fighting it. The anchors (`min_buy_in`/`max_buy_in`
  in the SET list and in the predicate) exist in both bodies, and the migration
  refuses unless each is present exactly once.

Two empty skeletons on the branch would have broken CI and misrepresented what
shipped, so they are gone rather than committed hollow.

### What `20260909191454` contains

1. `fn_cash_game_floor_from_template` pins all four promised fields on every
   write, not two (C1).
2. `fn_cash_game_ensure` keys on the template, validates handedness against the
   template's `seat_choices`, and writes `table_mode` (C5).
3. `fn_project_stake_band` falls to the lowest band that has a game (C6).
4. Anchored edits adding `max_players` (floored at the highest occupied seat),
   `stakes`, `small_blind`, `big_blind`, `game_variant` and `career_percent_min`
   to `fn_cash_apply_ruleset`'s projection AND its drift predicate (C3
   remainder), plus the dead 40-hand `vpip_window` default in both the
   reconciler and `fn_cash_cluster_open_table` (C7).
5. A realignment that backfills `table_mode`, passes every snapshot through the
   widened trigger, reprojects every open cluster table through
   `fn_cash_apply_ruleset` (never a hand-written `UPDATE tables`), and then
   asserts - aborting the whole transaction if any of it is untrue.

### The probe, rolled back against production 19:24 UTC

One `execute_sql` call, ending in `RAISE EXCEPTION` so the single transaction
the call has is aborted. **The error IS the success case** (CLAUDE.md 11.5); a
probe of this shape that returns success has committed.

```
ERROR:  P0001: PROBE OK (rolled back)
  table_mode backfilled: 42
  tables reprojected by fn_cash_apply_ruleset: 42
  stakes-label drift before: 42  after: 0
  max_players<>handedness before: 2  after: 0 (bar occupied chairs)
  games disagreeing with template after: 0
  tables disagreeing with game after: 0
  seats outside their ceiling: 0
  ensure(nlh 1/2) old key -> "NLH 1/2 Action"   new key(template=classic) -> "NLH 1/2 Classic"
```

and the corrected band assertion, probed separately at 19:31 UTC:

```
ERROR:  P0001: PROBE OK (rolled back)
  BEFORE: project(micro,{low,mid})=micro   project(low,{mid,high})=low
  AFTER : project(micro,{low,mid})=low     project(low,{mid,high})=mid
  unchanged arms: high/{micro}=micro  mid/full=mid  high/{}=high
```

`ensure(nlh 1/2)` is the C5 defect caught in the act: the same club, the same
stakes, the old key returning the Action game and the new key returning the
Classic one.

**The rollback was then verified rather than assumed** (19:26 UTC): 42 games
still lack `table_mode`, 42 tables still drift on the stakes label, 2 are still
7-max on a 6-handed game, and `pg_get_functiondef` shows none of the three
replaced functions carrying its new text. Nothing was committed.

## 6. CLIENT CHANGES (mine, in the worktree, uncommitted)

`src/config/cashGames.ts`

- `TEMPLATE_LOCKED_RULES` and the removal of `regular_ante`, `vpip_floor`,
  `vpip_window` and `bombs` from `CashGameOverrides` / `overridesFromSnapshot`,
  so the browser stops sending four keys the server now refuses by name.
- `templatePromiseLines()` renders those four as the template's promise instead.
- `stakeBandForBigBlind` / `STAKE_BAND_LABEL` / `stakesRungTaken` - the client
  twin of `fn_cash_stake_band`, so the stakes step can grey a rung the club
  already holds rather than letting the host reach Confirm and be refused.
- Host copy for `OVERRIDE_LOCKED` and `ONE_GAME_PER_BLIND_CATEGORY` (lane I's
  two new refusal codes), and for the unauthenticated-caller message.

`src/components/cash/CashGameCreateFlow.tsx` (+ `.css`)

- The ante radio, the bomb-pot toggle, trigger, ante and boards controls are
  GONE from the rules step. They set four fields the server resolves from the
  template, so a host could set them, see them in the preview card, and get a
  different game. They are replaced by the read-only promise readouts.
- One read of `cash_games` (enabled games of this club) feeds the rung-taken
  greying. It is a SELECT; the flow still writes nothing.

## 7. TESTS

New: `tests/unit/theTemplateIsTheWholeGame.test.ts` - 15 assertions, one per
defect this lane fixed, each stating the production shape it came from: all
four fields pinned by the trigger, `template_name = v_t` inside the ensure
lookup, `seat_choices` checked, `table_mode` written, the lowest-available band
arm, the anchored (never retyped) reconciler edit with its uniqueness check, the
seat ceiling floored at the occupied chair, one BEGIN/COMMIT, the assertions,
no repair job (10.12), no em dashes.

It also pins the 10.86 lesson explicitly: the band assertion must use a case
that can FAIL on the old body.

Changed: `tests/cash-games-are-created-from-a-template.law.test.tsx`

- **A pin moved with its mechanism (CLAUDE.md 5.8), it was not weakened.**
  A1.1 read `expect(FLOW).not.toMatch(/\.from\('cash_games'\)/)` - a blanket
  ban on the flow touching the table. A1.1's rule is that the browser never
  WRITES. The flow now does one read, so the pin moved from the TABLE to the
  VERB: `insert`, `update`, `upsert` and `delete` are all refused against both
  `tables` and `cash_games`, the read is named so it cannot drift into a write,
  and the RPC is still the only write path. That is strictly more than the old
  line checked, which never mentioned a verb at all.
- The supabase mock gained `from`, because a mock with only `rpc` sent the new
  read down its error path and printed a TypeError on every run. A test that
  exercises the failure branch is not testing the feature.

### Commands and their tails

```
npx vitest run tests/cash-games-are-created-from-a-template.law.test.tsx \
  tests/unit/theTemplateIsTheWholeGame.test.ts tests/unit/cashGamesVocabulary.test.ts \
  tests/unit/vpipFloorIsTheTemplates.test.ts tests/actionAndMadnessAreOnePerBand.law.test.ts \
  tests/law-registry.law.test.ts
  -> Test Files  6 passed (6)      Tests  356 passed (356)     EXIT:0

npx tsc --noEmit
  -> EXIT:0, no diagnostics (whole tree, including the other lanes' edits)
```

The one remaining stderr line in the law test is React's `act(...)` warning from
the new read resolving after render. It fails nothing and the component handles
the state update correctly; it is noted rather than chased.

## 8. WHAT I DID NOT DO, AND WHY

- **Nothing was applied to production and nothing was committed or pushed.** The
  migration is probed rolled back and handed to the integrator, per the brief.
- **The apply ORDER matters and I cannot enforce it from here.**
  `20260909191454` must be applied AFTER lane E's `20260909181230`. The version
  sorts that way, and the anchored edit is written so it composes with either
  body, but if the integrator applies out of order the anchored block will find
  its anchors in whichever body is live and still produce a correct function -
  what it cannot do is put lane E's run-it work back if lane E is applied
  afterwards with a full-body replace. **Apply in version order.**
- **`fn_cash_cluster_tick` is untouched by me.** Lane A patches that body by
  anchored literal replacement; a second rewrite of the same statement would
  refuse on the anchor. The two ghost tables it repairs are C4, which is lane
  A's fix, and my probe merely verifies the outcome.
- **The 5 Classic games on a 100-500 / 400-1000 BB buy-in band are left alone.**
  The band is a host-editable field by 20260909035303's own rule. If Dan wants
  the Deep Stack catalogue's bands normalised to 40-200 that is a product
  decision, not a defect, and it is his (CLAUDE.md 10.9, "what future events
  owe").
- **The legacy duplicate columns are left alone**
  (`enable_straddle`/`allow_straddle` true on 133 cluster tables while
  `straddle_enabled` - the only one the engine reads - is false). Reconciling
  the spellings the engine ignores would be churn on the hottest table on the
  platform; the one that decides is already projected to false every tick.
- **I did not verify any of this on the felt in a browser.** Every claim here is
  from rows and from function bodies.
- **`fn_cash_game_create_impl_20260905` is not rewritten by me at all**, so lane
  I's refusal work and this migration cannot collide.
