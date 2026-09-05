# The fn*cash*\* definers ask who is calling: the audit, done once (2026-09-05, 16:20 CDT)

Branch `fix/the-thaw-arrives-in-installments`, commit 3 of 3. Result: **zero
class (b) defects, so no migration.** This file is the evidence.

## Why

The cash cluster grew forty-odd `fn_cash_*` functions in one week, most of
them SECURITY DEFINER, several of them browser-callable, and the rule they
have to carry (`scripts/ci/check-definer-authorization.mjs`: a SECURITY
DEFINER function that writes and that a browser role can execute must derive
the actor from `auth.uid()` / `auth.role()` / `auth.jwt()`, never from a
parameter) was checked migration by migration as each landed, never across
the family at once. The `atomic_*` money RPCs the cluster calls are in the
same sweep because the tick and the door call them and their grants decide
who else can.

## What was run

1. `node scripts/ci/check-definer-authorization.mjs --all` - the repository
   archaeology. Exit 1 with 125 findings, every one of them in a migration
   file older than 2026-08-31 whose function has since been superseded or
   re-granted live (the script's own header says this mode "would produce
   failures no commit could ever fix" and is for reading, not gating). **None
   of the 125 is an `fn_cash_*` or `atomic_*` function.** The one adjacent
   name, `fn_concurrent_game_load`, is anon-readable by design (the four-table
   limit's counter, called from the seat door) and is on the live baseline.
2. `node scripts/ci/audit-live-definer-exposure.mjs` - the live four
   questions, against production with the service-role key:

   ```
   [definer-exposure] live: 2, baselined: 2, new: 0; anon-executable writers: 0 (must be 0);
                      RLS-off writable tables: 1 (0 new); anon-readable functions: 7 (0 new)
   ```

3. The family inventory, via psql (session pooler; the direct host refused
   connections all afternoon): every `public.fn_cash_%` and `public.atomic_%`
   function with `prosecdef`, `has_function_privilege` for `anon`,
   `authenticated` and `service_role`, whether the body mentions `auth.uid()`,
   `auth.role()`, `auth.jwt()` or `fn_caller_is_engine()`, and whether it
   writes (`INSERT INTO` / `UPDATE` / `DELETE FROM` / `PERFORM` in the
   source). 54 functions. Then every browser-callable writer's guard was read
   in full, because a mention of `auth.uid()` is not a binding: the
   `process_tournament_rebuy` trap (`IF auth.uid() IS NOT NULL AND auth.uid()
<> p_user_id`) skips the check for a caller with no uid at all. Every guard
   here has the right polarity: `auth.uid() IS NULL OR auth.uid() <>
p_user_id` refuses, or `v_uid := auth.uid()` with NULL refused before any
   write.

## Classes

| class | meaning                                                                        | count |
| ----- | ------------------------------------------------------------------------------ | ----- |
| (a)   | SECURITY DEFINER, browser-callable, derives the actor from the request         | 12    |
| (b)   | SECURITY DEFINER, browser-callable, WRITES, does not derive the actor - DEFECT | **0** |
| (c)   | SECURITY DEFINER, service_role only (no anon, no authenticated EXECUTE)        | 24    |
| (d)   | SECURITY DEFINER, browser-callable, read-only, does not derive the actor       | 2     |
| (e)   | SECURITY INVOKER (runs as the caller, under the caller's RLS and grants)       | 17    |
| -     | trigger function, not invocable as an RPC                                      | 1     |

Of the 17 SECURITY INVOKER functions, 7 are executable by a browser role:
six pure helpers (`fn_cash_money_text`, `fn_cash_override_bool`,
`fn_cash_override_int`, `fn_cash_stakes_label`, `fn_cash_stay_remaining_ms`,
`fn_cash_template_defaults`) that read no table (IMMUTABLE or a clock read;
they format labels and defaults for the lobby), and `atomic_chip_transfer`,
whose entire body is one `RAISE EXCEPTION 'WALLET_POOL_RETIRED'`. Two
(`atomic_tournament_register`, `atomic_tournament_unregister`) hold EXECUTE
for none of the three API roles and are unreachable through PostgREST.

### The two (d) functions, noted and left

Neither is anon-executable; both are `authenticated`. Neither writes. Neither
is called from the browser bundle (`src/` 0 callers each); both are engine
paths (`server/src` 1 and 4), and `fn_cash_rejoin_floor` is also called from
inside `atomic_table_buyin`, which runs as the definer regardless of the
grant.

- `fn_cash_game_open_seats(p_table_id)` returns the open-seat count of a
  table: lobby data, already painted on every lobby card.
- `fn_cash_rejoin_floor(p_user_id, p_table_id)` returns the rejoin floor for
  a player at a table and raises `VPIP_BARRED:<seconds>` if the player is
  barred. A logged-in caller can ask it about another user, so it tells a
  member whether someone else is under a two-hour VPIP bar and what stack
  they would need to sit back down. Read-only, no money, no writes; the
  brief's rule (d) is "note the exposure", and this is the note. If the
  engine is ever confirmed as its only caller, `REVOKE EXECUTE ... FROM
authenticated` is a pure grant change (no PostgREST schema reload) and can
  ride any later migration.

## The inventory

`asks` lists which of the four caller-identity calls appear in the body;
`EXECUTE` lists the API roles that hold it (`-` means none of the three).

| function                         | security | body   | EXECUTE                         | asks                             | class                                   | note                                                                                                                                                              |
| -------------------------------- | -------- | ------ | ------------------------------- | -------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atomic_cancel_tournament`       | definer  | writes | service_role                    | auth.uid()                       | (c) service_role only                   |                                                                                                                                                                   |
| `atomic_chip_transfer`           | invoker  | reads  | authenticated,service_role      | -                                | (e) SECURITY INVOKER, browser-callable  | tombstone: body is one RAISE (WALLET_POOL_RETIRED); writes nothing                                                                                                |
| `atomic_credit_wallet_and_log`   | invoker  | writes | service_role                    | -                                | (e) SECURITY INVOKER, service_role only |                                                                                                                                                                   |
| `atomic_deduct_wallet_and_log`   | invoker  | writes | service_role                    | -                                | (e) SECURITY INVOKER, service_role only |                                                                                                                                                                   |
| `atomic_distribute_rake`         | definer  | writes | service_role                    | auth.uid()                       | (c) service_role only                   |                                                                                                                                                                   |
| `atomic_pay_player_rakeback`     | invoker  | writes | service_role                    | -                                | (e) SECURITY INVOKER, service_role only |                                                                                                                                                                   |
| `atomic_pay_player_rakeback`     | invoker  | writes | service_role                    | -                                | (e) SECURITY INVOKER, service_role only |                                                                                                                                                                   |
| `atomic_seat_cashout_locked`     | definer  | writes | authenticated,service_role      | auth.uid(),fn_caller_is_engine() | (a) binds the caller                    | refuses unless engine, or auth.uid() = p_user_id, or a same-transaction club_admin GUC set by fn_admin_kick_player                                                |
| `atomic_table_addon`             | invoker  | writes | service_role                    | auth.uid()                       | (e) SECURITY INVOKER, service_role only |                                                                                                                                                                   |
| `atomic_table_buyin`             | definer  | writes | authenticated,service_role      | auth.uid(),fn_caller_is_engine() | (a) binds the caller                    | refuses unless engine or auth.uid() = p_user_id (NULL uid refused)                                                                                                |
| `atomic_table_cashout`           | definer  | writes | service_role                    | auth.uid(),fn_caller_is_engine() | (c) service_role only                   |                                                                                                                                                                   |
| `atomic_table_rebuy`             | definer  | writes | authenticated,service_role      | auth.uid(),fn_caller_is_engine() | (a) binds the caller                    | refuses unless engine or auth.uid() = p_user_id (NULL uid refused)                                                                                                |
| `atomic_tournament_register`     | invoker  | writes | -                               | -                                | (e) SECURITY INVOKER, no API role       | no EXECUTE for anon, authenticated or service_role: unreachable by any API role                                                                                   |
| `atomic_tournament_unregister`   | invoker  | writes | -                               | -                                | (e) SECURITY INVOKER, no API role       | no EXECUTE for anon, authenticated or service_role: unreachable by any API role                                                                                   |
| `atomic_wallet_transfer`         | invoker  | writes | service_role                    | -                                | (e) SECURITY INVOKER, service_role only |                                                                                                                                                                   |
| `fn_cash_apply_ruleset`          | definer  | writes | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_cluster_census`         | definer  | reads  | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_cluster_open_table`     | definer  | writes | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_cluster_tick`           | definer  | writes | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_clusters_tick_all`      | definer  | writes | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_clusters_to_tick`       | definer  | reads  | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_effective_buyin`        | definer  | reads  | authenticated,service_role      | auth.uid()                       | (a) binds the caller                    |                                                                                                                                                                   |
| `fn_cash_game_barred_seconds`    | definer  | reads  | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_game_create`            | definer  | writes | authenticated,service_role      | auth.uid()                       | (a) binds the caller                    | v_uid := auth.uid(), NULL refused, then fn_can_create_games / is_club_admin                                                                                       |
| `fn_cash_game_ensure`            | definer  | writes | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_game_join`              | definer  | writes | authenticated,service_role      | auth.uid()                       | (a) binds the caller                    | v_uid := auth.uid(), NULL refused; every write keyed on v_uid                                                                                                     |
| `fn_cash_game_leave_waitlist`    | definer  | writes | authenticated,service_role      | auth.uid()                       | (a) binds the caller                    | v_uid := auth.uid(), NULL refused                                                                                                                                 |
| `fn_cash_game_lobby`             | definer  | reads  | authenticated,service_role      | auth.uid()                       | (a) binds the caller                    |                                                                                                                                                                   |
| `fn_cash_game_must_move_list`    | definer  | reads  | service_role                    | auth.uid(),fn_caller_is_engine() | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_game_open_seats`        | definer  | reads  | authenticated,service_role      | -                                | (d) read-only, no actor                 | open-seat count for a table id; lobby data; called by the engine only (src/ 0, server/src 1)                                                                      |
| `fn_cash_game_roster_track`      | invoker  | writes | service_role                    | -                                | trigger (out of scope)                  |                                                                                                                                                                   |
| `fn_cash_game_waitlist_position` | definer  | reads  | authenticated,service_role      | auth.uid()                       | (a) binds the caller                    |                                                                                                                                                                   |
| `fn_cash_leave_check`            | definer  | reads  | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_money_text`             | invoker  | reads  | anon,authenticated,service_role | -                                | (e) SECURITY INVOKER, browser-callable  |                                                                                                                                                                   |
| `fn_cash_override_bool`          | invoker  | reads  | anon,authenticated,service_role | -                                | (e) SECURITY INVOKER, browser-callable  |                                                                                                                                                                   |
| `fn_cash_override_int`           | invoker  | reads  | anon,authenticated,service_role | -                                | (e) SECURITY INVOKER, browser-callable  |                                                                                                                                                                   |
| `fn_cash_pot_conservation_check` | definer  | writes | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_rejoin_floor`           | definer  | reads  | authenticated,service_role      | -                                | (d) read-only, no actor                 | rejoin floor / VPIP bar for (user, table): a logged-in caller can ask about another user; called by the engine and atomic_table_buyin only (src/ 0, server/src 4) |
| `fn_cash_seat_change_cancel`     | definer  | writes | authenticated,service_role      | auth.uid()                       | (a) binds the caller                    | v_uid := auth.uid(), NULL refused                                                                                                                                 |
| `fn_cash_seat_change_plan`       | definer  | writes | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_seat_change_request`    | definer  | writes | authenticated,service_role      | auth.uid(),fn_caller_is_engine() | (a) binds the caller                    | auth.uid(); only the engine may name p_user_id                                                                                                                    |
| `fn_cash_seat_change_status`     | definer  | reads  | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_seat_move_announce`     | definer  | writes | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_seat_move_execute`      | definer  | writes | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_seat_moves_pending`     | definer  | reads  | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_seat_swap_execute`      | definer  | writes | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_session_add_baseline`   | definer  | writes | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_session_close`          | definer  | writes | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_session_evaluate`       | definer  | writes | service_role                    | fn_caller_is_engine()            | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_session_open`           | definer  | writes | service_role                    | -                                | (c) service_role only                   |                                                                                                                                                                   |
| `fn_cash_stakes_label`           | invoker  | reads  | anon,authenticated,service_role | -                                | (e) SECURITY INVOKER, browser-callable  |                                                                                                                                                                   |
| `fn_cash_stay_remaining_ms`      | invoker  | reads  | anon,authenticated,service_role | -                                | (e) SECURITY INVOKER, browser-callable  |                                                                                                                                                                   |
| `fn_cash_template_defaults`      | invoker  | reads  | anon,authenticated,service_role | -                                | (e) SECURITY INVOKER, browser-callable  |                                                                                                                                                                   |
| `fn_cash_vpip_status`            | definer  | reads  | authenticated,service_role      | auth.uid()                       | (a) binds the caller                    |                                                                                                                                                                   |

## What would have been done for a (b)

Recorded so the next sweep does not have to decide it again: grep `src/` and
`server/src` for callers; if nothing in the browser bundle calls it, `REVOKE
EXECUTE FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO service_role` in
one migration (pure GRANT/REVOKE, so no `pgrst_ddl_watch` reload - CLAUDE.md
section 2 rule 5); if the browser must call it, re-declare from the repo
source with `v_uid := auth.uid()` and a NULL refusal before the first write,
asserting the live md5 first (the way `20260905083756` and every tick
migration since does). There was nothing to apply, so `supabase_migrations.
schema_migrations` is unchanged by this commit.
