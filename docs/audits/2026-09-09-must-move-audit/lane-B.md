# Lane B - the SQL of the must-move lobby, seat moves and seat changes

Full audit, 2026-09-09. Every definition below was read LINE BY LINE from the
LIVE production body (`pg_get_functiondef` on `kuklfnapbkmacvwxktbh`), which is
the truth over any migration file, and then compared with the newest migration
in this repo that defines it.

Status of this file: written first, updated as the lane proceeds. Every finding
carries DONE / PARTIAL / NOT STARTED.

---

## 1. Coverage - what was read line by line

### Functions (live body, `pg_get_functiondef`)

| function | args | secdef | live md5 (prosrc) | newest repo migration defining it | live == repo? |
| --- | --- | --- | --- | --- | --- |
| `fn_cash_seat_change_request` | `(uuid, uuid, uuid)` | yes | - | `20260905064237_horses_use_the_seat_change_and_presence_follows_the_move` | yes |
| `fn_cash_seat_change_plan` | `(uuid, timestamptz)` | yes | `424e5c6ade9b6c8adf3f97a211b9b838` | `20260907164541_a_seat_change_nobody_got_comes_back` | yes |
| `fn_cash_seat_change_cancel` | `(uuid)` | yes | - | `20260905060000_the_must_move_lobby_...` | yes |
| `fn_cash_seat_change_status` | `(uuid, uuid)` | yes, STABLE sql | - | `20260905060000_the_must_move_lobby_...` | yes |
| `fn_cash_seat_move_execute` | `(uuid)` | yes, `statement_timeout=30s` | `d23c0c9ad3166df5ac8bde4ed8ab08ac` | `20260908042800_maintenance_announcement_and_entry_purchases_are_serialized` | **NO - see F0** |
| `fn_cash_seat_move_execute_before_maintenance_gate` | `(uuid)` | yes | `6055ba8953646538bd866f2f9294366e` | same file | yes |
| `fn_cash_seat_swap_execute` | `(uuid)` | yes | `09991eef2a1baa4597a211e035b1f8e9` | same file | **NO - see F0** |
| `fn_cash_seat_swap_execute_before_maintenance_gate` | `(uuid)` | yes | `463bb7b45dfbce09e1c837143be3c6ab` | same file | yes |
| `fn_cash_game_lobby` | `(uuid)` | yes, STABLE | - | `20260906163151_one_definition_of_a_games_players_and_tables` | yes |
| `fn_cash_game_join` | `(uuid)` | yes | - | `20260905064000_booted_for_low_vpip_is_barred_for_two_hours` | yes |
| `fn_cash_game_must_move_list` | `(uuid)` | yes, STABLE sql | - | `20260905074022_the_must_move_list_is_read_through_the_lobby_not_by_the_brow` | yes |
| `fn_cash_session_open` | `(uuid, uuid, numeric)` | yes | - | `20260904160500_cash_games_slice_1` (+ cluster snapshot edit) | yes |
| `fn_cash_session_close` | `(uuid, uuid, numeric, text)` | yes | - | `20260905064000_booted_for_low_vpip_is_barred_for_two_hours` | yes |
| `atomic_table_buyin` | 7 args | yes, `statement_timeout=30s` | - | `20260909062006_chips_are_two_decimals_on_the_addon_path` | yes |
| `atomic_table_buyin_before_maintenance_announcement_gate` | 7 args | yes | - | `20260908042800_...serialized` | yes |
| `fn_cash_game_roster_track` | trigger | **no** (invoker) | `a441e273d59ee341da01956c6123280d` | `20260905060000_the_must_move_lobby_...` | yes |
| `fn_bind_cash_seat_move_occupancy` | trigger | yes | - | **no migration on this branch - see F0** | n/a |
| `fn_cash_seat_moves_pending` | `(uuid)` | yes | - | `20260905060000_...` | yes |
| `fn_cash_seat_move_announce` | `(uuid[])` | yes | - | `20260905060000_...` | yes |
| `fn_cash_seat_move_set_window` / `fn_cash_seat_move_window` | trigger / `(uuid)` | no | - | `20260907171945_a_move_waits_as_long_as_the_table_takes` | yes |
| `fn_cash_game_open_seats` | `(uuid)` | yes, STABLE | - | `20260905060000_...` | yes |
| `fn_cash_game_waitlist_position`, `fn_cash_game_leave_waitlist` | `(uuid)` | yes | - | `20260905053000_join_game_seats_you_at_the_right_table_or_holds_your_place` | yes |
| `fn_refuse_seat_on_closed_cluster_table` | trigger | no | - | `20260905050000_the_move_survives_the_hand_and_a_game_seats_you_once` | yes |
| `fn_cash_cluster_census` | `(uuid, timestamptz)` | yes, STABLE | - | `20260906163151_...` | yes |
| `fn_cash_cluster_tick` | `(uuid, integer)` | yes | - | `20260907173251_a_disabled_game_still_tells_the_truth_about_itself` + later literal patches | read in full (35 KB); steps 1, 2, 2b, 3, 5 belong to this lane |
| `fn_cash_rejoin_floor`, `fn_cash_game_barred_seconds`, `fn_caller_is_engine` | - | - | - | - | read as callees |

### Tables, constraints, indexes, RLS, grants (live catalogue)

`cash_seat_moves`, `cash_seat_change_requests`, `cash_game_roster`,
`cash_seat_move_receipts`, `cash_game_waitlist`, `cash_rejoin_constraints` -
every column, CHECK, FK, index, RLS policy and role grant enumerated; the 33
triggers on `table_seats` enumerated and the four in this lane's path read in
full (`trg_cash_game_roster_track`, `trg_refuse_seat_on_closed_cluster_table`,
`zzz_bind_cash_seat_move_occupancy`, `zz_cash_seat_move_window`).

### Client / engine callers (for the contract, not this lane's to change)

`server/src/services/supabase/seatMoves.ts`, `.../seatChange.ts`,
`src/services/cashGameLobby.ts` (refusal copy map),
`src/components/table/CashClusterHUD.tsx`, `.../MustMoveLobbyModal.tsx`.

---

## 2. Findings

### F0 (P2, evidence only, NOT A DEFECT OF THIS BRANCH) - three live objects have no migration on `main`

`fn_cash_seat_move_execute`, `fn_cash_seat_swap_execute`, the trigger function
`fn_bind_cash_seat_move_occupancy`, the table `cash_seat_move_receipts`, the
columns `cash_seat_moves.source_occupancy_id` / `source_seat_number`, the index
`cash_seat_moves_one_pending_per_player` and the CHECK
`pending_move_has_original_occupancy` are all LIVE on production and are defined
by migrations that exist only on the branch
`codex/club-arena-phase-two-occupancy-contract`
(`20260908220604`, `20260909024909`, `20260909052547`, `20260909054702`,
`20260909062236`, `20260909074353`), recorded in `schema_migrations` under
DIFFERENT versions (`20260909172143`, `20260909172350`, `20260909173145`, ...).

This matters to every other lane: **the executor you read in the repo is not the
executor that is running.** The live `fn_cash_seat_move_execute` is a 8.5 KB
lock-ordering, receipt-claiming wrapper around
`fn_cash_seat_move_execute_before_maintenance_gate`; the repo's newest copy is
the pre-occupancy body. Every md5 guard in this lane's migration is taken from
the LIVE body for that reason.

Consequence measured: 17 moves were cancelled `original_occupancy_not_recorded`
in the last 24 h - the one-off cancellation that migration performed on apply.
Fix: none needed here; it lands when that branch merges. Flagged so the
integrator does not "restore" the repo body over the live one.
**Status: EVIDENCE ONLY.**

### F1 (P1) - a player who leaves the game keeps their move, their list place and their spent seat change

`fn_cash_game_roster_track` (live, invoker-rights trigger on `table_seats`)
closes the roster row on an undeclared chair-empty **only when the player has no
pending move**:

```sql
IF current_setting('app.cash_seat_move', true) IS DISTINCT FROM 'on'
   AND NOT EXISTS (... another live chair in the game ...)
   AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m
                    WHERE m.player_id = NEW.user_id AND m.game_id = v_game AND m.state = 'pending') THEN
```

The executor and the swap both declare themselves (`app.cash_seat_move = 'on'`),
so an UNDECLARED empty chair is always a leave. The third clause therefore does
not distinguish "still in the game" from "left with a move still planned", and
three things follow:

1. **The destination chair stays reserved for a player who has gone** until the
   from-table's next hand boundary refuses the move. `fn_cash_game_open_seats`
   and the census both subtract pending moves, so the lobby, the planner, the
   break step and the horse fleet all see one fewer chair than exists.
   Measured on production over 24 h: **137 moves cancelled `player_not_seated`**,
   each one a chair the must-move list could not have for as long as the move
   lived (the window is `fn_cash_seat_move_window`: 3 to 15 minutes).
2. **A rejoin inside that window keeps the OLD roster row** - the old
   `joined_at`, so the old must-move position, and the old
   `seat_change_used_at`, so no seat change. Dan: "IF THEY LEAVE A TABLE AND
   JOIN THE SAME GAME AND STAKES AGAIN, THEY GO TO THE BOTTOM OF THE LIST."
   Measured over three days: 63 rejoins into the same game within 20 minutes of
   a `player_not_seated` cancellation; **2 of them were spanned by the old
   roster row** (the other 61 landed after the tick's reconcile had closed it,
   which is the net catching what the trigger missed - CLAUDE.md 10.12: the net
   firing is the proof the live path is wrong).
3. **A swap partner is held out of the deal until its own expiry.** The held
   side (`ready_at` set, `heldForSwap` in the engine) waits for a partner that
   will never arrive, because nothing cancels the leaver's side.

Fix: `fn_cash_game_roster_track` cancels the player's pending move
(`player_left_game`), releases a linked swap partner (`swap_partner_gone`),
closes the roster row and cancels a listed request, all in the same trigger.
Migration + probe S11/S12/S13 + law test.
**Status: DONE (migration written, probed rolled back).**

### F2 (P2) - the executor's own expiry branch says nothing about why

`20260907171507_an_expired_move_says_what_it_was_waiting_for` gave the TICK's
expiry sweep a note (`player_left_before_boundary` /
`player_busted_before_boundary` / `engine_did_not_execute_before_expiry`) and
left the two executors writing a bare `state = 'expired'`:

```sql
IF m.expires_at <= clock_timestamp() THEN
  UPDATE public.cash_seat_moves SET state = 'expired' WHERE id = m.id;   -- no note
```

and in the swap gate, BOTH sides are stamped `'expired'` + `'swap_partner_gone'`
whichever side actually ran out, so the row cannot say which. This is the exact
shape CLAUDE.md 10.86 rule 1 forbids: an outcome that cannot say "I could not
tell". The executor branch is reachable in the race between the tick's sweep and
a hand boundary (`fn_cash_seat_moves_pending` filters expired rows, so the
engine only reaches it when the row expires between the read and the call).

Fix: `boundary_reached_after_expiry` on the single-move gate; each swap side
carries its own state and its own reason.
**Status: SUPERSEDED BY LANE A - not shipped by this lane.** Lane A found the
same two paths (its finding A3) and fixed them better in
`20260909181642_every_expiry_says_why_including_the_executors.sql`: it
separates `own_ttl_expired` from `swap_partner_gone` and stops recording a
still-pending partner as `expired`, which my draft did not. My half was deleted
rather than duplicated. See section 4.

### F3 (P2) - a seat change off a table that BECAME Main 1 is still executed

`fn_cash_seat_change_request` refuses a request FROM Main 1
(`SEAT_CHANGE_NOT_FROM_MAIN`) and refuses a request TO Main 1
(`SEAT_CHANGE_NEVER_TO_MAIN`); `fn_cash_seat_change_plan` refuses a swap PARTNER
sitting on Main 1. Nothing re-checks the REQUESTER's table after the request is
listed. The tick's ROLES step renumbers tables every pass - `feeder_became_main1`
when no main is live, `main_renumbered` when a main closes - so a request listed
from a feeder is executed as a seat change off the main game once that feeder
becomes Main 1. Dan: "NEVER TO THE MAIN GAME", and the main game has no seat
change at all.

Fix: the planner cancels such a request with note `now_on_main_one` and
**returns the allowance**, the same shape as the 2026-09-07 `left_table` fix (a
change the system made is not the change they asked for and must not spend the
one they get). Probe S15.
**Status: DONE.**

### F4 (P3) - the swap gate checks lifecycle but not status

The single-move gate refuses a destination whose `status NOT IN ('waiting',
'running', 'active')` OR whose `lifecycle IN ('breaking', 'closed')`. The swap
gate reads `lifecycle` only, and does not check the table exists at all
(`ta.lifecycle` on a NULL record is NULL, so the IF is false and the swap
proceeds). The tick repairs `status closed / lifecycle live` in both directions
now, so the window is small - but it is the window in which a swap lands two
players on a table nobody can join.

Fix: same predicate on both, plus a NULL-record check.
**Status: NOT SHIPPED - it lives in the body lane A rewrites. See section 5.**

### F5 (P3) - `authenticated` holds INSERT/UPDATE/DELETE on `cash_seat_moves` and `cash_game_waitlist`

Live grants:

```
cash_seat_moves      authenticated  INSERT,SELECT,UPDATE,DELETE,REFERENCES,TRIGGER
cash_game_waitlist   authenticated  INSERT,SELECT,UPDATE,DELETE,REFERENCES,TRIGGER
```

with RLS enabled and exactly ONE policy on each, both `FOR SELECT`
(`player_id = auth.uid()` / `user_id = auth.uid()`). So RLS refuses every write
and the grant is a lie about who may write - the opposite direction from the
usual danger, but the same defect class as the 2026-09-05 "the seat move
executors are engine-only and say so" migration: the table must state the rule
the RPCs state. `cash_seat_change_requests` and `cash_game_roster` are already
service_role-only, which is the shape the other two should have.

Fix: REVOKE the write grants from `authenticated` and `anon`; SELECT stays.
**Status: DONE.**

### F6 (P2, NOT FIXED - reported) - `fn_cash_game_join` returns a table it does not hold

`fn_cash_game_join` returns `action: 'seat'` with a `table_id` and leaves the
browser to call `atomic_table_buyin` for a seat at that table. Between the two
calls nothing holds the chair: no `table_waitlist` notified row, no reservation.
`fn_cash_game_open_seats` subtracts notified holds and pending moves, so the
door is honest about what it can see, but two players told about the same last
chair both get `seat`, and the loser gets SQLSTATE 23505 or
`TABLE_SIZE: table is full` at the buy-in. The 2026-09-09 client work
(`2026-09-09-cash-buyin-seat-refusal-recovery.md`) recovers from exactly that
refusal, which is the net; the live path still hands out the same chair twice.

Not fixed here because the fix is a reservation (a `table_waitlist` notified row
with a hold, which `atomic_table_buyin` already honours via `SEAT_RESERVED`) and
that changes the door every browser and the horse fleet walk through - lane A
owns `fn_cash_clusters_tick_all` / the fleet and lane E owns the join surface.
Costed in section 5.
**Status: NOT STARTED (reported, deliberately out of lane).**

### F9 (P3, NOT FIXED - measured and handed over) - 39 cash sessions are open with no chair

`cash_player_session` rows that are open (`closed_at IS NULL`) whose player
holds no live seat at that table: **39**, oldest 2026-09-06 06:28 UTC, 37 of
them on tables that are now closed, all 39 in cluster games, all 39 horses
(which under 10.5 is not a mitigation - it is the whole platform's population).
29 have no `table_seats` row at all any more, i.e. the departed row was later
deleted by `atomic_table_buyin` reclaiming that chair.

**It is a bookkeeping leak, not a money leak, and that was checked rather than
assumed.** `fn_cash_session_close` is what writes the rathole floor, so an
un-closed session could mean a winner who left with no floor written. Measured
against `ca_seat_stack_exits` (the 2026-08-25 trigger that logs every exit of a
NON-ZERO stack): **0** of the 39 have a logged non-zero stack exit, and **0**
have an exit above their session baseline. Nobody ratholed through this.

Not fixed here: the close is called from the engine cash-out and table-close
paths, which are lane E's surface and the engine's, not this lane's SQL. What
the next agent needs: a session whose seat is gone should be closed with
`closed_reason = 'seat_gone'` by whichever path removed the seat, not swept -
CLAUDE.md 10.12 forbids the sweep. `fn_cash_session_open` already self-heals
the same-table rejoin case (`stale_on_reopen`), which is why this has never
been visible.

### F7 (P3, NOT A DEFECT) - `fn_cash_game_must_move_list` is engine-or-signed-in, and horses are on it

`AND (auth.uid() IS NOT NULL OR public.fn_caller_is_engine())` - a signed-out
caller reads an empty list rather than a refusal. Horses appear on the list, get
`seat_change` moves, and are counted by every census: no `is_horse` predicate
exists anywhere in this lane's SQL (checked over every `fn_cash_*` and
`atomic_table_buyin*` body: the only four bodies that contain the string
"horse" at all are `fn_cash_cluster_tick` and `fn_cash_clusters_tick_all`
(`p_eligible_horses`, a COUNT of buyers) and the two executor gates (`horse_id`,
a column carried across a move). CLAUDE.md 10.5 holds in this lane.
**Status: VERIFIED CLEAN.**

---

## 3. Dan's rules, verified one by one

From `docs/changelog/2026-09-05-the-must-move-lobby.md`. "PASS" means the live
SQL enforces it and the probe exercises it.

| Dan's rule | where it lives | verdict |
| --- | --- | --- |
| Every player at a feeder game gets ONE seat change | `fn_cash_seat_change_request` raises `SEAT_CHANGE_USED` off `cash_game_roster.seat_change_used_at`; `idx_cash_seat_change_requests_open` UNIQUE (game, user) WHERE requested | PASS (probe S5) |
| Never to Main 1 | `SEAT_CHANGE_NEVER_TO_MAIN` at the door; planner excludes `role='main' AND main_index=1` for the target AND for a swap partner | PASS (S5), plus **F3**: not re-checked for the REQUESTER after a renumber - fixed |
| Never FROM Main 1 | `SEAT_CHANGE_NOT_FROM_MAIN` | PASS (S5), plus F3 |
| No seats -> first on the list | planner finds no target -> the request stays `requested`; tick step 2b runs AFTER the mains are filled and BEFORE a feeder is opened; `fn_cash_seat_change_status.position` counts older requests on the same target | PASS (S6) |
| Two requests that take each other's table are swapped | planner's second SELECT; two rows linked both ways by `swap_move_id`, each carrying the other's `to_seat_number` | PASS (S6, S7) |
| A specific feeder table can be requested | `p_to_table_id`; validated open, in-game, not Main 1, not the same table | PASS (S5, S6) |
| Seat change re-posts the BB | executor sets `entry_hold='waiting'`, `entry_post_agreed=true` for `reason='seat_change'` (both single and swap) | PASS (S4, S7) |
| Auto-move posts nothing | `entry_hold='moved'` for `must_move` / `break` / `balance` | PASS (S3) |
| Join order is the must-move order, and is posted | `cash_game_roster.joined_at` carried across every move (the executor copies `joined_at` from the source chair and the roster row is untouched); `fn_cash_game_must_move_list` orders by it; tick step 2 orders by it | PASS (S1, S2, S3) |
| Leave and rejoin the same game -> bottom of the list | roster row closes on leave, a fresh row opens on the new chair | **FAILED for a player with a pending move - F1** - fixed (S11, S12) |
| Rathole protection only for winners | `fn_cash_session_close`: `IF v_s.id IS NULL OR p_stack <= COALESCE(v_s.baseline, 0) THEN RETURN;` - no session or not above baseline, no floor. Baseline = buy-in, raised by `fn_cash_session_add_baseline` on every add-on | PASS (S9) |
| A cancelled `left_table` request restores the allowance | `fn_cash_seat_change_plan` (2026-09-07) | PASS - **and every other cancel path audited below** |
| An expired move carries no reason | tick sweep fixed 2026-09-07; **executors still bare - F2** - fixed |

### Every cancel path, and whether the allowance is restored - no path double-spends

The allowance is spent at REQUEST time (`seat_change_used_at = now()`), so every
path that ends a request without delivering the change must return it, and no
path may return it twice (returning it twice is harmless in itself -
`seat_change_used_at = NULL` is idempotent - but returning it for a request that
DID deliver would be a second free change).

| path | who | request ends as | allowance | correct? |
| --- | --- | --- | --- | --- |
| player cancels a listed request | `fn_cash_seat_change_cancel` | `cancelled` / `cancelled_by_player` | RETURNED | yes |
| player cancels after a move is planned | `fn_cash_seat_change_cancel` | no row matches (`status='moved'`), 0 rows | NOT returned | yes - the move is the engine's now (probe S8) |
| the player is no longer in the chair they asked from | `fn_cash_seat_change_plan` | `cancelled` / `left_table` | RETURNED | yes (2026-09-07) |
| the requester's table became Main 1 | `fn_cash_seat_change_plan` | `cancelled` / `now_on_main_one` | RETURNED | **F3, new** |
| the player leaves the game | `fn_cash_game_roster_track` | `cancelled` / `left_game` | not returned - the roster row CLOSES, and the rejoin opens a fresh row with `seat_change_used_at` NULL | yes |
| the tick finds a request with no open roster row | `fn_cash_cluster_tick` step 1 | `cancelled` / `left_game` | same as above | yes |
| the planned move dies (cancelled / expired) and the player is still in the from-chair | `fn_cash_cluster_tick` step 1 | back to `requested` / `move_<state>` | stays SPENT | yes - the request is alive again, so the allowance is still in use. Returning it here would give a second change |
| the move dies and the player is NOT in the from-chair | tick step 1's `EXISTS` fails, so the row stays `moved` | stays SPENT | **see F8 below** |

### F8 (P2) - a request whose move died while the player was elsewhere is stranded as `moved`

Tick step 1 only re-lists a `moved` request when the player is still in
`rq.from_table_id`. If the move died AND the player is somewhere else in the
game (a must-move took them first, a break moved them), the request stays
`status='moved'` for ever with the allowance spent and no move delivered - the
same class as the 2026-09-07 defect, one level up.

Measured on production 2026-09-09: **0 rows in that state right now** (`dead
moved requests total = 0`), and 3 open roster rows carry a spent allowance, all
3 with a live request or a delivered move behind them. So it is a latent hole,
not a live loss - which is why it is P2 and why the fix is the narrowest one:
the same tick statement, with the `EXISTS` widened from "in the from-table" to
"in the game", and the request re-listed FROM the table they are actually at.
**Status: DONE.** The statement lives in `fn_cash_cluster_tick`, which lane A
also patches; the two anchors were proven disjoint and order-independent
(section 4, probe 1) and the behaviour is probe 2 section S14.

---

## 4. Migrations (reconciliation with lane A)

### What this lane ships

**`supabase/migrations/20260909181259_a_leave_cancels_the_move_and_a_move_says_why_it_expired.sql`**
- one file, one `BEGIN` / `COMMIT`, reasoning in the header (CLAUDE.md 10.9),
  post-apply `DO $assert$` block, NOT applied to production.
- Part 1 (F1): `fn_cash_game_roster_track` - whole body, guarded on the live
  md5 `a441e273d59ee341da01956c6123280d`, skips itself if already applied.
- Part 2 (F3): `fn_cash_seat_change_plan` - whole body, guarded on
  `424e5c6ade9b6c8adf3f97a211b9b838`, skips itself if already applied.
- Part 3 (F8): `fn_cash_cluster_tick` - ONE anchored literal replacement of the
  seat-change re-list statement, read live at apply time.
- Part 4 (F5): the REVOKEs.

### The reconciliation with lane A, stated plainly

**I DELETED MY HALF. Lane A's fix stands.** Lane A's finding A3 is my F2 - the
same two executor expiry paths - and its
`20260909181642_every_expiry_says_why_including_the_executors.sql` is the
better fix: it separates `own_ttl_expired` from `swap_partner_gone` and stops
recording a still-pending partner as `expired`, which my draft did not. Two
migrations rewriting one statement is a coin flip decided by apply order, so
the F2 half (and with it my F4 edit to the swap gate, which sat in the same
body) is gone from `20260909181259` entirely. **F4 is therefore reported and
NOT fixed** - see section 5.

The filename still says "and a move says why it expired". It is kept because
the version is already reserved and renaming the file is a second reservation;
the header says in its first paragraph that the file no longer does that and
who owns it instead.

**The remaining overlap is one function, and it is proven disjoint.** Lane A's
`20260909181632` (the tick's expiry sweep) and `20260909181704` (the ROLES
demote) patch `fn_cash_cluster_tick` by anchored literal, and so does my part
3 (the seat-change re-list). All three anchors were proven unique and
order-independent against the live 35 KB body in one rolled-back call:

```
PROBE PASS: anchors unique (A1,A2,B = 1,1,1) and order-independent;
identical text both ways (35054 chars)
```

The probe replaces each anchor with a marked copy of itself in both orders
(A then B, and B then A) and asserts the two results are byte-identical, and
that each lane's anchor survives the other lane's replacement - which is the
property the apply-order guard actually depends on. `20260909181653` was
checked too and does not touch the tick at all: it patches
`fn_cash_clusters_to_tick` (the earlier grep matched the substring).

**Skeletons.** This lane reserved exactly ONE version, `20260909181259`, and it
is now a full migration. `20260909181220_a_rathole_floor_and_a_vpip_bar_belong_to_one_game.sql`
and `20260909181208_the_template_is_the_whole_game_not_only_its_creation.sql`
are NOT this lane's - they are not in this session's transcript and this lane
never ran `reserve-migration-version.sh` for either. Left untouched, and
flagged here for their owners: both are still 7-line skeletons and an empty
skeleton must not survive on the branch.

### Tests

`tests/a-leave-cancels-the-move.law.test.ts` (19 assertions) with its registry
entry `docs/laws.d/a-leave-cancels-the-move.md`. It pins the cancel, the swap
release, the declared-executor exemption, the `now_on_main_one` return with its
allowance, the re-list following the player, the re-listed request NOT getting
a second button, the REVOKEs, the one-transaction shape, the md5 guards, the
fact that the tick is patched by anchor and not re-emitted, and - explicitly -
that this migration does NOT touch the two executor paths lane A owns.


## 5. What could not be fixed here

**F4 (the swap gate checks lifecycle but not status, and does not check the
destination row exists at all).** Real, small, and deliberately NOT fixed: the
only sane place for it is inside
`fn_cash_seat_swap_execute_before_maintenance_gate`, which lane A rewrites in
`20260909181642`. Two lanes editing one body is exactly what the coordination
note forbids. Handed to the integrator as a one-line follow-up on top of lane
A's version:

```sql
IF ta.id IS NULL OR tb.id IS NULL
   OR ta.lifecycle IN ('breaking', 'closed') OR tb.lifecycle IN ('breaking', 'closed')
   OR ta.status NOT IN ('waiting', 'running', 'active')
   OR tb.status NOT IN ('waiting', 'running', 'active') THEN
```

(the single-move gate already reads exactly that predicate; the swap gate reads
`lifecycle` only, and on a NULL record `ta.lifecycle IN (...)` is NULL, so a
destination that has vanished passes the test.)

F6 (the join door hands out a chair it does not hold) - the fix is a real
reservation and it crosses two other lanes' surfaces. Costed:

- **Option A (recommended)**: `fn_cash_game_join`, on the `seat` branch, writes
  a `table_waitlist` row `status='notified'` with
  `hold_expires_at = now() + 60s` for that table, exactly as the open-seat offer
  path does. `atomic_table_buyin` already honours it (`SEAT_RESERVED`, and it
  excludes the caller's own hold), `fn_cash_game_open_seats` already subtracts
  it, and the tick already expires stale notified rows. Cost: a second player
  asking in that minute is told the seat is held rather than being told to take
  it and refused at the door. Risk: a browser that asks and never buys in costs
  the game a chair for 60 s.
- **Option B**: leave it and rely on the client recovery shipped 2026-09-09.
  Cost: the refusal is player-visible, and CLAUDE.md 10.12 says a recovery is
  not a fix.

## 6. Commands and probe output

### Probe 1 - the anchors are disjoint and order-independent (one call, rolled back)

Proves this lane's `fn_cash_cluster_tick` edit composes with lane A's two, by
replacing each anchor with a marked copy of itself in BOTH orders and comparing
the results byte for byte:

```
ERROR:  P0001: PROBE PASS: anchors unique (A1,A2,B = 1,1,1) and
order-independent; identical text both ways (35054 chars)
```

### Probe 2 - the behaviour (one call, rolled back, CLAUDE.md 11.5)

One `DO` block ending in `RAISE EXCEPTION`, so the abort is what undoes the
fixtures and the function bodies together. The helper that seats a fixture
player lives in `pg_temp` (11.5 rule 4). No chips moved: every fixture player
is seated by reviving a departed chair or inserting one inside the aborted
transaction, and no wallet path is called.

```
ERROR:  P0001: PROBE PASS: S11 leave-cancels-move
S12 rejoin-bottom-fresh-button S13 swap-partner-released
S14 relist-follows-the-player S15 main-one-returns-button S16 grants
```

| section | what it proves |
| --- | --- |
| S11 | a player with a pending `must_move` who leaves: the move is `cancelled` / `player_left_game`, the roster row closes, and `fn_cash_game_open_seats` on the destination goes back UP by one - the chair the departed player was holding is released immediately |
| S12 | the rejoin opens a NEW roster row (later `joined_at`), with `seat_change_used_at` NULL, last on `fn_cash_game_must_move_list` |
| S13 | a swap where one side leaves: the leaver's move is `player_left_game`, the partner's is `swap_partner_gone`, and `fn_cash_seat_moves_pending` no longer offers the held side - the player is dealt back in |
| S14 | a request whose move died while a must-move had taken the player elsewhere is re-listed by the tick as `requested` / `move_cancelled`, `from_table_id` rewritten to the chair they are actually in, and the allowance stays spent (no second button) |
| S15 | a request listed from a feeder that is then renumbered Main 1 is cancelled `now_on_main_one`, the allowance is returned, and a `seat_change_returned` event is written |
| S16 | `authenticated` can no longer INSERT/UPDATE a seat move or a waitlist row, and still holds its read-own SELECT |

**Two live guards refused the probe and were right to, both recorded because
they are evidence about production, not obstacles:**

1. At 18:54 UTC the fixture insert was refused with
   `PLATFORM_FROZEN: scheduled maintenance has closed new entries. INSERT on
   table_seats was refused without moving chips.` - the :53 last-hand phase of
   the hourly break (CLAUDE.md 13). The probe was re-run after :00.
2. `fn_guard_managed_game_lifecycle`: `This table cannot be closed while
   players are seated`. The S15 fixture was closing Main 1 to force the
   renumber; it now does what the ROLES step actually does - steps the old
   Main 1 down to feeder and promotes the feeder - and closes nothing.

**The probe found a bug in this lane's own SQL before it shipped**, which is
the entire point of 11.5: the first draft of the tick edit used a `LATERAL` in
the UPDATE's FROM list referencing the UPDATE target, and Postgres refused it
with `42P10: invalid reference to FROM-clause entry for table "rq"`. It is a
correlated scalar subquery in the SET now, with an `EXISTS` guard so the NOT
NULL `from_table_id` can never be set to NULL. Had this been written straight
into a migration and applied, `fn_cash_cluster_tick` would have raised on every
pass for every game.

### Rollback verified

After probe 2, on production:

| check | result |
| --- | --- |
| `authenticated` still has INSERT on `cash_seat_moves` (the REVOKE rolled back) | true |
| the live tick does NOT contain this lane's edit | true |
| the live `fn_cash_game_roster_track` does NOT contain `player_left_game` | true |
| no `PROBE Main 2` table exists | true |

### Tests

```
npx vitest run tests/a-leave-cancels-the-move.law.test.ts tests/law-registry.law.test.ts
 tests/a-leave-cancels-the-move.law.test.ts (21 tests) 12ms
 tests/law-registry.law.test.ts (293 tests) 131ms
 Test Files  2 passed (2)
      Tests  314 passed (314)
```

Two of the 21 exist only because the probe caught the LATERAL bug: one pins the
correlated subquery and forbids the LATERAL by name, the other pins the
`EXISTS` that keeps the NOT NULL `from_table_id` from being set to NULL. The
law-registry law passes, so `docs/laws.d/a-leave-cancels-the-move.md` is
accepted.

No TypeScript changed outside `tests/`, so no `tsc` run was needed.

### Files this lane changed

| file | what |
| --- | --- |
| `supabase/migrations/20260909181259_a_leave_cancels_the_move_and_a_move_says_why_it_expired.sql` | was an empty skeleton; now the full migration for F1, F3, F8 and F5 |
| `tests/a-leave-cancels-the-move.law.test.ts` | new, 19 assertions |
| `docs/laws.d/a-leave-cancels-the-move.md` | new, the registry entry the law test requires |
| `docs/audits/2026-09-09-must-move-audit/lane-B.md` | this report |

No shared file was touched (brief rule 9). `scripts/dev/probe-must-move-lobby.sql`
was READ as the base for the probe and deliberately left alone: lane A is
editing `scripts/dev/probe-cluster-boards.sql` and the S11-S16 sections above
live in this report rather than in a file two lanes would conflict over.

---

## 7. Follow-up, 2026-09-10: F6 is fixed - the join door holds the chair it hands out

Assigned by the integrator after lanes A and E finished. Everything below was
done with psql on the session pooler (the Supabase MCP is gone; the brief's
project id was wrong and production is `kuklfnapbkmacvwxktbh`), every probe in
a real `BEGIN ... ROLLBACK` with `SET LOCAL lock_timeout = '4s'`. Nothing was
applied to production. No TypeScript gate was run (the integrator is merging
`main` into this tree); the one new law test is written and **UNRUN**, see 7.6.

### 7.1 The hold, as designed

`supabase/migrations/20260910183043_the_join_door_holds_the_chair_it_hands_out.sql`
replaces `fn_cash_game_join` (live md5 `65c5304a59da3882a540794de16fe9a7`,
unchanged since `20260905064000`; guarded, self-skipping, one transaction,
post-apply assertions). On the `'seat'` branch the door now:

1. **Locks the candidate table on the buy-in gate's own key**,
   `pg_advisory_xact_lock(hashtextextended('table_seat:' || id, 0))`, and
   re-reads `fn_cash_game_open_seats` under the lock. Candidates are walked in
   the order the door always used (shortest live Main, then the feeder); the
   first that still has a chair under its lock wins, so two callers in the
   same instant are serialized and the second moves on.
2. **Writes the same row the open-seat offer writes** (`fn_offer_open_seat`):
   `table_waitlist` `status = 'notified'`, `notified_at = now()`,
   `hold_expires_at = now() + 60s`, `position = 0` (a place in a table's line
   is 1-based, so 0 identifies the join door's hold as data without a schema
   change; an existing 'waiting' row at that table is turned into the hold and
   keeps its own position).
3. **One live hold per player per game**: any other live hold of the caller's
   on a table of this game is expired in the same statement.
4. Returns the same payload as before plus one additive key, `hold_expires_at`,
   with `open_seats` counted as the chairs open TO THE CALLER (their held chair
   included, so it never reads 0 for the person it was just handed to).

Everything else already honoured that row and is unchanged: the buy-in gate
counts live notified holds of OTHER players against `max_players`
(`SEAT_RESERVED`); `fn_cash_game_open_seats` and `fn_cash_cluster_census`
subtract live holds; the gate and `fn_seat_insert_cancel_waitlist` flip the
holder's row to 'seated' when they sit; a lapsed hold stops counting the moment
`hold_expires_at` passes (both readers compare against the clock) and
`fn_sweep_stale_waitlists` / `fn_offer_open_seat` retire the row.

### 7.2 The three answers

**(a) The same caller buying in within the minute is admitted.** The gate's
hold count is `w.status = 'notified' AND w.user_id <> p_user_id AND
COALESCE(w.hold_expires_at, w.notified_at + 60s) > now()`: the holder's own
row is excluded, so `seats_taken + holds(others) < max_players` and they sit;
their hold flips to 'seated'. Probe S17: A handed the last chair, hold row
written (`notified`, `position 0`, expires in 60 s), `fn_cash_game_open_seats`
reads 0 for everyone else, A's `atomic_table_buyin` admitted, row `seated`.

**(b) A second caller in that minute is told the truth.** The door only offers
tables with `fn_cash_game_open_seats(tb.id) > 0`, and that subtracts the first
caller's live hold, so the held chair is not offered: the second caller gets
the next table with a free chair, or the game waitlist with the existing
`'waitlisted'` payload and the existing copy. Probe S18: B handed the chair, C
`waitlisted` position 1 with a `cash_game_waitlist` row, and C going straight to
the buy-in door anyway (a stale tab) refused `SEAT_RESERVED` with no seat
written. Same-instant: S21 below.

**(c) Horses are players.** A horse is seated by `HorseFleetManager` through
`atomic_table_buyin` - the same door with the same `SEAT_RESERVED` refusal,
which `HorseBuyInRefusal.ts` already classifies (`seat_reserved`) as an
expected, counted seeding-race outcome. A horse's own hold (an offer from
`fn_offer_open_seat`, which has offered chairs to horses since 2026-08-31)
refuses a human exactly the same way. The fleet never calls `fn_cash_game_join`
(service_role has no `auth.uid()` and the door says NOT_AUTHENTICATED), so it
neither writes nor needs this hold, and it is not "unaffected" by a hold it did
not create - it is refused by it exactly as a human is, which is the 10.5
answer. The fleet's `humansWaitingByTable` read counts a notified row as a
person waiting for that table (true) and reduces the horse seat target there by
one for the 60 s the hold lives, which is the direction that rule was written
for. No `is_horse` anywhere in the migration; the post-apply assertion refuses
a body that reads it.

**Asking twice is one hold.** A caller already holding a live chair in this
game is told the SAME table again and the hold is refreshed, never a second
row - without this, `fn_cash_game_open_seats` would subtract their own hold
and the second click would move them to another table while the first hold
stood. Probe S19: B's second ask returns Main 2, exactly one live hold of B's in
the game, `hold_expires_at` moved forward; a stray live hold planted for B on
the feeder is expired by the next ask, count back to 1.

### 7.3 Probe scoreboard (rolled back; the error is the success case)

`scripts/dev/probe-join-door-hold.sql`, run 2026-09-10 18:36 UTC:

```
ERROR:  PROBE PASS: S17 first-caller-held-and-admitted
S18 second-caller-told-the-truth S19 asking-twice-is-one-hold
S20 lapse-frees-the-chair S22 table-lock-held
```

| section | what it proves |
| --- | --- |
| S17 | first caller handed the last chair; hold row `notified`/`position 0`/`+60 s`; `open_seats` 0 to everyone else, 1 to the holder; holder's buy-in admitted; row `seated` |
| S18 | second caller `waitlisted` #1 (game waitlist row written); a buy-in by the second caller onto the held chair refused `SEAT_RESERVED`, no seat written |
| S19 | second ask by the holder: same table, one live hold in the game, expiry refreshed; a stray second hold lapses on the next ask |
| S20 | hold set to lapsed: `open_seats` counts the chair again, the next caller is handed it, the lapsed holder asking again is `waitlisted` (the truth), `fn_sweep_stale_waitlists()` retires the lapsed row and leaves the live one, the new holder's buy-in admitted |
| S21 | **the same-instant race, two real sessions**: session 1 (new door, player A) `RACE_TID <table> ACT seat`, `advisory_locks_held 1`; session 2 asking for `table_seat:<table>` with `lock_timeout = 2s` (what the buy-in gate or a second door call does): `ERROR: canceling statement due to lock timeout` (55P03). Both rolled back. Note: the lock was held ~7 s on a real live table for this proof; a real buy-in there in that window waited, nothing failed |
| S22 | after the door runs, the session holds exactly the advisory lock it took (the guard is real, not a comment) |

Rollback verified afterwards: `table_waitlist` rows with `position = 0`: 0
(there were 0 before, 10,149 rows total); `fn_cash_game_join` live body
unpatched; no `PROBE Main 2`; no hold left for the race-probe horse.

**Two live guards refused the first fixture and were right to:**
`fn_stamp_active_seat_game_scope` refuses a user-less `table_seats` row
("Active seat requires an existing table and player"), so every filler is a
real horse on a real chair now; and the fixture had to pick a game with no
open `cash_game_waitlist` rows so S18's "position 1" is honest.

### 7.4 The eleven-migration sequence

All audit migrations present in the tree, in version order, in ONE psql
transaction (bodies with `BEGIN`/`COMMIT` stripped, each file's own inline
post-apply assertions running as written), then rolled back - 2026-09-10 18:38
UTC against the current live bodies:

```
=== applying 20260909181230   (lane E)
=== applying 20260909181259   (lane B, yesterday)
=== applying 20260909181309   (lane I)
=== applying 20260909181632   (lane A)
=== applying 20260909181642   (lane A)
=== applying 20260909181653   (lane A)
=== applying 20260909181704   (lane A)
=== applying 20260909191454
=== applying 20260910181433
=== applying 20260910181447   (NOTICE: trigger zz_cash_seat_move_resolved does not exist, skipping - its own DROP IF EXISTS)
=== applying 20260910183043   (lane B, today)
=== ALL ELEVEN APPLIED IN SEQUENCE, EVERY ASSERTION PASSED; ROLLING BACK
SEQ_ROLLED_BACK
```

The nine the integrator named (my two plus lane A's four, lane E's, lane I's
and `191454`) are a subset; the two added today (`181433`, `181447`) applied
cleanly in the same run. The two empty skeletons flagged yesterday
(`181208`, `181220`) are no longer in the tree.

### 7.5 New findings from this pass (measured, not fixed here)

**F10 (P2) - the buy-in door does not honour the planner's reservation.**
`fn_cash_game_open_seats` subtracts pending unlinked `cash_seat_moves`, so the
planner and the lobby treat a planned must-move as a reserved chair - but the
buy-in gate counts only `table_waitlist` holds, so a browser (or the fleet) can
take a chair the controller has planned a move into, and the move is refused
`destination_full`. Measured 2026-09-10: **41 `destination_full` in 24 h, 17 of
them with a fresh buy-in by another player landing on the destination inside
the move's window.** Same defect class as F6, other door. The fix is one
clause in `atomic_table_buyin_before_maintenance_announcement_gate`, beside
the hold count:

```sql
SELECT COUNT(*) INTO v_moves FROM public.cash_seat_moves m
 WHERE m.to_table_id = p_table_id AND m.state = 'pending' AND m.swap_move_id IS NULL
   AND m.player_id <> p_user_id AND m.expires_at > now();
IF v_seats_taken + v_holds + v_moves >= v_max_players THEN
  RAISE EXCEPTION 'SEAT_RESERVED: the open seat is held for a player the game is moving here' ...
```

Not done here: that gate is a money path with fifteen migrations on it and its
own lane; a second `SEAT_RESERVED` reason also needs the client's refusal
mapper (lane G) to keep its 2026-09-09 recovery.

**F11 (P2, security, pre-existing) - a browser can write its own hold.**
`table_waitlist` carries the RLS policy `waitlist_user_own` FOR ALL
(`user_id = auth.uid()`) with INSERT/UPDATE/DELETE granted to `authenticated`.
A signed-in player can therefore INSERT a `notified` row for themselves at any
table with any `hold_expires_at`, and every reader above - the buy-in gate, the
open-seat count, the census, the fleet's humans-waiting read - will honour it:
a chair blocked for as long as they like, at no cost. This pre-dates this
migration and is what `join_waitlist` (a SECURITY DEFINER RPC) exists to
replace; the fix is to narrow the policy to SELECT and route the two browser
writes (`join_waitlist`, leave) through their definers. Not this lane's table;
handed over.

### 7.6 Files this pass changed

| file | what |
| --- | --- |
| `supabase/migrations/20260910183043_the_join_door_holds_the_chair_it_hands_out.sql` | new, F6 |
| `scripts/dev/probe-join-door-hold.sql` | new, S17-S22 as run (S21 as the two-session pair) |
| `tests/the-join-door-holds-the-chair.law.test.ts` | new, 11 assertions on the migration text - **UNRUN** by instruction; run with `npx vitest run tests/the-join-door-holds-the-chair.law.test.ts tests/law-registry.law.test.ts` |
| `docs/laws.d/the-join-door-holds-the-chair.md` | the registry entry the law test requires |
| this file | section 7 |

`src/services/cashGameLobby.ts` (lane G) is **not** edited and needs no edit:
the join response gains one additive key (`hold_expires_at`), no new action, no
new copy; the client navigates to `table_id` on `'seat'` and ignores unknown
keys. The only copy that can now reach a player from this change is the
existing lapsed-offer notification from `fn_sweep_stale_waitlists` ("Seat Offer
Expired ... Join The Waitlist Again To Get Back In.", in-app only), which is
true in substance and whose second sentence lane G may want to sharpen to
"Tap Join Game Again".

---

## 8. Follow-up, 2026-09-10 (later): F10 and F11 fixed at the root

Both assigned by the integrator after section 7. psql on the session pooler,
every probe `BEGIN ... ROLLBACK` with `lock_timeout = '4s'`, nothing applied,
no TS gate run (two new law tests are written and **UNRUN**, see 8.5).

### 8.1 F10 - the door honours the chair the game promised

`supabase/migrations/20260910184427_the_door_honours_the_chair_the_game_promised.sql`
patches the LIVE `atomic_table_buyin_before_maintenance_announcement_gate`
(md5 `823cfb123c2d5041ecc824d188a31997`) by two anchored literal replacements
- the DECLARE line and the hold block - never a re-emit of the hottest money
path on the platform; the result is checked for eighteen landmarks of that
path (idempotency key, session liveness, rejoin floor, ban, VIP, nit, the
table lock, TABLE_SIZE, the cap, the club wallet, the debit, the session
open, the ledger row, and no `is_horse`) before it is executed.

**The clause**, beside the hold count:

```sql
SELECT COUNT(*) INTO v_moves
  FROM public.cash_seat_moves m
 WHERE m.to_table_id = p_table_id
   AND m.state = 'pending'
   AND m.swap_move_id IS NULL
   AND m.player_id <> p_user_id;
IF v_seats_taken + v_holds + v_moves >= v_max_players THEN
  RAISE EXCEPTION 'SEAT_RESERVED: the open seat is held for a player the game is moving here'
    USING HINT = 'Tap Join Game for the next open chair.';
END IF;
```

**Every reason a pending move can exist for a destination** (the CHECK allows
exactly four): `must_move` (tick step 2) - reservation; `break` (tick step 5)
- reservation; `balance` (`fn_cash_cluster_balance`) - reservation;
`seat_change` unlinked (the planner found an open chair) - reservation;
`seat_change` linked by `swap_move_id` (two players exchange two OCCUPIED
chairs) - **not** a reservation, as the 2026-09-05 lobby changelog says in as
many words. The clause counts exactly what `fn_cash_game_open_seats` counts
(`to_table_id`, `pending`, `swap_move_id IS NULL`; no reason filter, no
`expires_at` filter, so the door and the census agree in the 5 s before the
tick sweeps a lapsed move) plus `player_id <> p_user_id`, so nobody is refused
by their own reservation.

**The refusal code** is the existing `SEAT_RESERVED:` prefix with a message
that names the other cause. `src/lib/cashBuyIn.ts:175` matches
`/^SEAT_RESERVED:/`, and the 2026-09-09 recovery treats that prefix as a known
refusal (attempt cleared, sheet stays open, a new seat can be chosen); a new
code would have fallen into the unknown-outcome path and lost it. The client
copy shown today for the prefix is "This Seat Is Reserved For The Next Player
On The Waiting List. Please Join The Waitlist." - actionable, wrong about who.
The lane G edit, **not made**: in `src/lib/cashBuyIn.ts` before the
`/^SEAT_RESERVED:/` line, add
`if (/^SEAT_RESERVED: .*moving here/.test(m)) return 'This Chair Is Held For A Player The Game Is Moving Here. Tap Join Game For The Next Open Chair.';`.

Horses: the fleet walks through this door and `HorseBuyInRefusal.ts` already
classifies `SEAT_RESERVED` as `seat_reserved`, an expected seeding-race
outcome; a horse is refused a promised chair exactly as a human is. No
`is_horse`.

**Probe scoreboard (rolled back, 18:48 UTC):**

```
PROBE PASS: S23 promised-chair-refused S24 door-and-census-agree
S25 own-reservation-never-refuses S26 mover-lands
S27 swap-is-not-a-reservation S28 no-is_horse
```

| section | what it proves |
| --- | --- |
| S23 | chair count N (Main 2 filled to max-1 with real horses), one pending `must_move` into it: a stranger's buy-in for the last chair refused `SEAT_RESERVED: the open seat is held for a player the game is moving here`, no seat written, no wallet row |
| S24 | seats + pending unlinked plans == max_players: the door and the census read the same chair |
| S25 | the mover's own buy-in at the destination passes the clause (own move excluded) and is stopped by the seat trigger's `ALREADY_IN_GAME` - not `SEAT_RESERVED` - because they are seated on the feeder |
| S26 | the mover's path is unaffected: `fn_cash_seat_move_execute` lands them on the promised chair, `open_seats` 0 |
| S27 | a linked swap into the table (B on Main 2 <-> C on the feeder) is not a reservation: the stranger is admitted onto a free chair beside it |
| S28 | no `is_horse` in the gate |

An event trigger on this database (`[autorevoke]`) stripped PUBLIC/anon
EXECUTE from the inner gate on CREATE, as the migration's assertion expects;
the inner gate was already `{postgres=X/postgres}` and stays so.

### 8.2 F11 - a browser never writes the waitlist itself

`supabase/migrations/20260910184439_a_browser_never_writes_the_waitlist_itself.sql`.

**Every client caller of a direct `table_waitlist` write, read before
restricting anything** (grep of `src/` and of the World Hub's `pages/`, `src/`):

| caller | verb | status | what must change |
| --- | --- | --- | --- |
| `src/services/WaitlistService.ts:208` (`joinWaitlist`) | insert | LIVE (ClubHomePage:3335) | `supabase.rpc('fn_table_waitlist_join', { p_table_id: tableId })` and `mapRow(data.entry)` |
| `src/services/WaitlistService.ts:267` (`leaveWaitlist`) | update status left | LIVE (TableModalsLayer:874) | `supabase.rpc('fn_table_waitlist_leave', { p_table_id: tableId })` -> `{ ok, cancelled }` |
| `src/services/WaitlistService.ts:522` (`leave`) | update status left | LIVE (ClubHomePage:3344, WaitlistPage:156) | the same leave call |
| `src/components/waitlist/WaitlistManager.tsx:155` | insert | DEAD (mounted nowhere) | the join door, if it is ever mounted |
| `src/components/waitlist/WaitlistManager.tsx:189` | delete own | DEAD | the leave door |
| `src/components/waitlist/WaitlistManager.tsx:206, :214` | delete OTHER players' rows | DEAD, and **already refused** by the old policy (RLS DELETE matched 0 rows, silently) | a host action needs a definer of its own; none is written here because nothing mounts it |
| `WaitlistManager.tsx:96`, `GlobalWaitlistListener.tsx:192`, `TableService.ts:706`, `WaitlistService.ts:177/229/290/311/332/364/402/454/470` | select | unaffected | none |
| `Smarter-Poker-World-Hub/pages/api/club-arena/waitlist.js:60-187` (8 sites), `pages/api/poker/engine/seat.js` | service role key | unaffected (bypasses RLS) | none; `seat.js`'s `SERVICE_ROLE_KEY \|\| ANON_KEY` fallback would now be refused if the service key were ever missing, which is the correct failure |
| `server/src/services/HorseFleetManager.ts`, `HorseSessionRotator.ts` | service_role | unaffected | none |

**The policy shape:** `waitlist_user_own` (FOR ALL) is dropped;
`waitlist_user_own_read` FOR SELECT TO authenticated USING `user_id =
auth.uid()` replaces it; `waitlist_public_queue_read` and
`waitlist_admin_read` untouched, so the table has three SELECT policies and no
write policy for a browser role. INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/
TRIGGER revoked from `authenticated` and `anon`; SELECT granted; service_role
keeps everything. The two legitimate writes get `fn_table_waitlist_join(p_table_id)`
and `fn_table_waitlist_leave(p_table_id)`: SECURITY DEFINER, keyed on
`auth.uid()` only, EXECUTE to authenticated and service_role, refused to
PUBLIC/anon. The join door refuses what the offer path refuses (a tournament
table, a closed or deleted table) and returns `already_seated` rather than
queueing a player who is already in the chair; it is idempotent (an active row
is returned, never doubled). `join_waitlist(p_table_id, p_user_id)` - invoker
rights, service_role-only, takes a user id - is left as it is.

**Probe scoreboard (rolled back, as `SET LOCAL ROLE authenticated` with a
JWT for a real horse, 18:49 UTC):**

```
PROBE PASS: S29 direct-writes-refused S30 reads-work S31 join-door-works
S32 leave-door-works S33 game-doors-work
S34 door-refuses-what-the-offer-refuses S35 service-writes S36 policy-shape
```

| section | what it proves |
| --- | --- |
| S29 | a direct INSERT of a ten-year `notified` hold, a direct UPDATE and a direct DELETE are all refused `42501` |
| S30 | the player still reads their own rows and the public queue |
| S31 | `fn_table_waitlist_join` writes the line (`waiting`), a second call returns the same row with `already_on_waitlist`, one live row |
| S32 | `fn_table_waitlist_leave` sets it `left` (cancelled 1), a second call cancels 0 |
| S33 | `fn_cash_game_join` (which writes the section-7 hold as the definer) and `fn_cash_game_leave_waitlist` still work for that browser |
| S34 | a tournament table is refused `WAITLIST_TOURNAMENT_TABLE`, a closed table `WAITLIST_TABLE_CLOSED` |
| S35 | `service_role` still writes the table (the fleet's own prune and insert) |
| S36 | three SELECT policies, zero write policies |

### 8.3 The thirteen-migration sequence

Every audit migration in the tree in version order, one rolled-back psql
transaction: `20260909181230`, `181259`, `181309`, `181632`, `181642`,
`181653`, `181704`, `191454`, `20260910181433`, `181447`, `183043`, `184427`,
`184439`. **First run, 18:50 UTC: ten applied, then `20260910181447` (another
lane's) refused itself** - "18:50:00 UTC is inside the hourly maintenance break
window (:50-:03 UTC); apply after :03" - which is its own guard doing its job,
not a failure of the sequence. Re-run after :03: see 8.4.

### 8.4 Sequence result

(filled in below)

### 8.5 Files this pass changed

| file | what |
| --- | --- |
| `supabase/migrations/20260910184427_the_door_honours_the_chair_the_game_promised.sql` | new, F10 |
| `supabase/migrations/20260910184439_a_browser_never_writes_the_waitlist_itself.sql` | new, F11 |
| `scripts/ci/schema-manifest.d/cowork-mustmove-lane-b.json` | new - declares `fn_table_waitlist_join`, `fn_table_waitlist_leave` |
| `scripts/dev/probe-join-door-hold.sql` | section 2 appended: S23-S28, S29-S36 as run |
| `tests/the-door-honours-the-chair-the-game-promised.law.test.ts` + `docs/laws.d/...md` | new, 9 assertions, **UNRUN** |
| `tests/a-browser-never-writes-the-waitlist-itself.law.test.ts` + `docs/laws.d/...md` | new, 8 assertions, **UNRUN** |
| this file | section 8 |

No client file edited. Lane G's three `WaitlistService.ts` call sites (208,
267, 522) MUST move to the two doors in the same release as `184439`, or the
Join Waitlist / Leave Waitlist buttons on `ClubHomePage`, `WaitlistPage` and
the table modal layer will be refused `42501`. That ordering is the one
thing in this pass that cannot be probed rolled back; it is a release note.
