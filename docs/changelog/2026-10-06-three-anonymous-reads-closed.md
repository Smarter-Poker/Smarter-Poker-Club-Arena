# 2026-10-06 — three anonymous reads closed: player_stats, Commander entries and waitlist, the seat map

Dan approved the three security fixes on 2026-10-06 ("YES, GO AHEAD AND PROCEED").
Each closes a read that a browser holding only the published key - no account -
could make while the Diamond Arena is open to the public.

## Shipped

- **#6301, `20261006135147_the_player_arena_record_is_not_published_to_a_browser`.**
  `player_stats` loses "Player stats are public" (`USING (true)`, roles PUBLIC)
  and anon's SELECT grant. Readers keep exactly what they asked for before:
  `player_stats_self` (own rows) and the new `player_stats_club_member_read`
  (rows of a club the viewer is an active or approved member of). The public
  profile's cross-club arena record now comes from `ca_public_arena_record_v1`,
  a SECURITY DEFINER reader that returns the five play fields and no money.
- **#6302, `20261006135311_commander_entries_and_waitlist_are_not_public`.**
  `captain_entries_select` was `USING (true)` for PUBLIC; it now has the scope
  its own insert/update/delete siblings already had (own entry, or active staff
  of the tournament's venue), TO authenticated. `captain_waitlist_select` loses
  its `player_id IS NULL` branch, which admitted every walk-in row to a caller
  with no account. anon's SELECT on both tables is revoked.
- **#6303, `20261006140021_a_seat_map_is_readable_only_in_scope`.** anon's 25
  column grants on `table_seats` are revoked. That was the join side of the
  inference that defeated `a_browser_cannot_read_which_seat_or_member_is_a_horse`
  (classify on player_stats volume, join the seat map); with #6301 neither half
  is reachable without an account.
- **All three migrations open with `BEGIN;` and close with `COMMIT;`.** As
  first written they could not have been applied: `apply-merged-migration.yml`
  refuses a file that does not carry its own transaction. Statements unchanged.
- **The new guard's two failure-message truncations carry `window-ok` markers**
  (Source Windows Are Structural): they shorten only the text of a failure
  message; every check reads the whole statement.

## Who reads these tables (checked before shipping)

- Code in club-arena, Smarter-Poker-World-Hub and smarter-poker-commander. Every
  Club Arena page that reads a seat or a stat is behind AuthGuard; the signed-out
  landing page reads nothing from the database. The engine, the hub's public
  venue head-count (`SUPABASE_SERVICE_ROLE_KEY` is set on the hub's production
  project) and every Commander API route read with the service role.
- Production edge logs, 24 hours: every publishable-key read of these tables and
  of the seat-count functions was signed in; the only anonymous read was one
  `table_seats` GET with no referer. The signed-in `player_stats` reads were all
  club-scoped (admin rake, agent last-played) or the player's own rows.
- Live catalogue: no view, and no other table's policy, reads these tables as a
  browser role. Seven SECURITY INVOKER functions anon can call read them
  (`cash_tables_needing_engine`, `cash_tables_with_players`,
  `fn_batch_active_player_counts`, `fn_get_active_player_count`,
  `get_club_players_playing`, `get_club_traffic`, `calculate_pilot_metrics`).
  They now refuse an anonymous caller; none has one in code or in the logs, and
  signed-in callers are unchanged.

## Rehearsed against production (rolled back)

- player_stats: anon refused (table, `total_winnings`, the definer reader); a
  signed-in stranger reads 0 rows but gets the profile record (3/3 rows); a
  member reads their whole club (679/679) and 0 rows of a club they are not in;
  own rows 2/2; the own-row upsert AchievementTriggerService makes still works;
  service_role 2814/2814.
- Commander: anon refused (entries, name/payout, walk-ins); a signed-in stranger
  reads nothing; a player reads their own entry (1/1), a waiting player their
  own rows (2/2); venue staff read 318/318 entries and 19/19 waitlist rows
  including 18/18 walk-ins; service_role everything.
- table_seats: anon refused (seat-map columns and row count); a signed-in
  account reads live seats (6/6) with `horse_id` still closed; a club member's
  seat counts agree with the owner's (441/441 from each of the three functions).

## Deliberately not changed

- `table_seats` "Public read access" is still `USING (true)` for signed-in
  accounts: any account reads every seat and stack. Narrowing it to scope is
  its own change (the migration header says why).
- Two signed-out Commander screens - the tablet kiosk and the walk-in status
  page - lose instant realtime nudges on entry/waitlist changes and keep their
  10 s / 15 s polls. That realtime feed was the same exposure.
- `commander_waitlist` was already refusing anonymous REST reads before this,
  by accident: `commander_staff`'s policy calls `fn_user_is_active_staff_at_venue`,
  which anon cannot execute. The walk-in branch was a hole that a function grant
  was masking; it is now closed by the policy itself.
- The Commander insert policies still admit a `player_id IS NULL` row from any
  role, including a caller with no account (anon holds INSERT). No traffic uses
  that path; it is a write, and it is not part of this change.
