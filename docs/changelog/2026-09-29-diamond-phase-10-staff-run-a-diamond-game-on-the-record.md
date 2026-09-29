# Diamond Phase 10: Staff Run A Diamond Game, On The Record

Status: line 4 of Phase 10 (staff-only game configuration), items 4 and 5 of the ordered build list in `docs/DIAMOND-PHASE-10-AUDIT-2026-09-21.md`, plus the seat-first gap found on 2026-09-29. Platform staff can now edit, close, cancel and remove a player from a Diamond game, open a heads-up Diamond sit-and-go that can actually be sat, and pause, resume and kick at a Diamond table. Every one of those acts, and every act of the five Diamond configuration doors that already existed, leaves one audit row naming who did it. No screen calls the doors yet (item 8). Both switches stay off.

## The Database

Migration `staff_run_a_diamond_game_on_the_record` (`20260929213000`):

- **One audit home.** Every Diamond configuration door files one `admin_audit_log` row through `fn_log_admin_action`, via the owner-only helper `fn_poker_diamond_staff_audit`. The row holds the operator (`admin_user_id`, `actor_role`), the action (`diamond.*`), the target (`diamond_table` or `diamond_tournament`), the row before and after, and which columns changed. The audit named two homes. `table_settings_changes` cannot hold an event, because its `table_id` is required. `admin_audit_log` holds tables and events alike, is what the operator console writes, and platform staff can already read it.
- **The five doors that existed** now file their row. `fn_poker_diamond_open_cash_table` also writes its operator to `tables.created_by`, which is NULL on all 17 Diamond tables today. The four table doors are pinned and redefined with the same signature. The shared `fn_poker_diamond_create_tournament` changes by asserted substitution only: both of its answers pass through `fn_poker_diamond_audit_tournament_created`, and nothing else in it moves.
- **Five new platform-staff doors**, each asking `fn_is_platform_admin()` and a live session, each granted to `authenticated` and `service_role`:
  - `fn_poker_diamond_edit_cash_table(p_table_id uuid, p_name text, p_small_blind integer, p_big_blind integer, p_min_buy_in integer, p_max_buy_in integer, p_max_players integer)`. Every argument after the table id defaults to NULL, meaning "keep". It edits an empty table only: waiting, nobody seated, no custody. The result is held to the open door's rules and the creation guard's (big blind above small, the seat law for the table's game) and re-proved by `fn_poker_diamond_plain_cash_table`. Returns `{ok, table_id, audit_id, name, small_blind, big_blind, min_buy_in, max_buy_in, max_players}`.
  - `fn_poker_diamond_close_cash_table(p_table_id uuid)`. It is refused while any seat holds custody (`diamond_table_seat_holds_custody`) or a player sits. Returns `{ok, table_id, status, audit_id}`.
  - `fn_poker_diamond_remove_tournament_player(p_tournament_id uuid, p_user_id uuid, p_request_id uuid DEFAULT NULL)`. It goes through `fn_ca_unregister_tournament_player_exact`, whose Diamond branch sends the entry home from its own custody row, a seat-first chair included. It returns that authority's receipt plus `audit_id`, and its refusals (`not_registered`, `tournament_started`) unchanged. A repeated request id replays the receipt and files nothing.
  - `fn_poker_diamond_cancel_tournament(p_tournament_id uuid)`. It goes onto `fn_poker_diamond_tournament_cancel`: every entry goes home, seats, tables and roster close, and the immutable receipt names the operator. It returns the receipt plus `audit_id`. A second call replays the receipt and files nothing.
  - `fn_poker_diamond_create_seat_first_board(p_config jsonb)`. It takes a Spin, or a sit-and-go with `maxPlayers` 2, in the creation door's own configuration. It creates the event through `fn_poker_diamond_create_tournament` and its one joinable table in the same transaction, as `fn_create_seat_first_game_atomic` opens a chip board. It returns the creation door's answer plus `table_id` and `board_audit_id`. A Diamond Spin is still refused by name until a reserve source is authorized.
- **The managed lifecycle guard** (`fn_guard_managed_game_lifecycle`) refused to cancel an event with a registration unless the engine did it, so the staff cancellation could not reach an event with a player in it. It now also admits the one event `fn_poker_diamond_cancel_tournament` names, in that door's own transaction. Every other caller meets the same refusal. It is changed by asserted substitution.
- `fn_can_create_games` is not touched and is asserted unchanged. Staff lobby posting stays refused (Dan's decision 4).

Migration `the_staff_diamond_cancellation_is_a_reviewed_lane_authority` (`20260929213100`): `fn_poker_diamond_cancel_tournament` takes the global settlement lane before the event row, as the authority it calls does. The live-catalog lane doctrine (`fn_ca_settlement_lane_doctrine`, asked by CI) requires every such caller to be on its reviewed list, and this door was not. It is added by asserted substitution, next to `atomic_cancel_tournament` and `fn_close_managed_game`, and the migration proves the doctrine answers ok. The rehearsal also proved it still refuses an unreviewed caller.

## The Engine

- `authorizeTableAdmin` (`server/src/handlers/admin.ts`): at a Diamond table, the caller's platform role (admin, superadmin or god, the list `fn_is_platform_admin` holds) is the whole answer. The arena's only club rows are automatic players, so before this change pause, resume and kick were refused to everyone there. A chip table is unchanged, and platform staff gain nothing at one. A Diamond tournament chair is still sent to registration management (409), where the staff removal door now works.

## The Rehearsal

This was one rolled-back transaction through the real doors, with every deferred constraint forced at each commit point, run before the apply:

- A player was refused at all six staff doors, and staff without a live session at all five new ones.
- A table was opened (its operator written to `created_by`), given a straddle, run-it-twice and a bomb pot, then edited from 1/2 to 2/5 with new buy-ins and nine seats. It was re-proved plain, and six bad edits were refused by name.
- A player bought a seat there through the engine's buy-in door, after which the edit and the close were both refused. A second, empty table closed once and then refused every door.
- The board door refused an MTT, a three-seat sit-and-go and a Spin (no reserve source). It opened two heads-up boards, each with its table, and three chairs were sold through the real seat door.
- An MTT was created and entered twice.
- Staff removed one entry (100 Diamonds home; the replay filed nothing; a non-registrant was answered `not_registered`) and one seat-first chair (110 home, seat vacated).
- The guard still refused a direct cancellation of an event nobody named.
- Staff cancelled the MTT with an entry still in it (100 home, the receipt naming the operator) and a full board with both chairs seated (220 home, table closed).
- Sixteen audit rows were filed, every one a Diamond staff row naming the operator, and the Diamond supply identity was unchanged.

## Dan's Questions

None new. Staff lobby posting stays off, as decided (decision 4). The Spin reserve source question from Phase 9 still stands: until it is answered, the board door refuses a Diamond Spin by name, as the creation door does.

Law: staff-run-a-diamond-game-on-the-record.
