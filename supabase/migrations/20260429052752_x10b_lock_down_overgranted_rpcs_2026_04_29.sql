-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429052752 "x10b_lock_down_overgranted_rpcs_2026_04_29"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b1f5bfb41350ae924622300646f5ae20 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 7 — Security lockdown.
-- Several SECURITY DEFINER RPCs were granted EXECUTE to PUBLIC / anon /
-- authenticated. For mutating + state-revealing functions on the settlement /
-- BBJ / tournament path, that means any logged-in user (or any anonymous
-- request) could call them. Tighten to service_role only.

-- BBJ contribution mutation — was inserted as anon-callable. This let any
-- caller inflate the BBJ pool. Locking down.
REVOKE EXECUTE ON FUNCTION public.add_bbj_contribution(uuid, uuid, bigint, numeric, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.add_bbj_contribution(uuid, uuid, bigint, numeric, numeric, text) TO service_role;

-- Tournament balancer — read-mostly but updates tournaments.updated_at;
-- service_role only.
REVOKE EXECUTE ON FUNCTION public.balance_tournament_tables(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.balance_tournament_tables(uuid) TO service_role;

-- BBJ eligibility probe — leaks hand details by user_id. Tighten.
REVOKE EXECUTE ON FUNCTION public.fn_bbj_check_eligible(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_bbj_check_eligible(uuid) TO service_role;

-- Available seats can stay readable to authenticated (lobby UI needs it),
-- but lock from anon/PUBLIC.
REVOKE EXECUTE ON FUNCTION public.fn_get_available_seats(uuid) FROM PUBLIC, anon;

-- Atomic increment helper — keep authenticated grant since agent-credit.js
-- runs on the server (Vercel functions use service_role anyway). Tighten
-- only PUBLIC/anon out of it.
REVOKE EXECUTE ON FUNCTION public.fn_atomic_increment_field(text, uuid, text, integer) FROM PUBLIC, anon;
