-- 20261024194135_an_authored_equal_blind_level_can_open_a_table
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-24 19:41:35 UTC.
--
-- WHAT WAS WRONG
--
-- The owner's October 20 Midway standard opens every scheduled tournament at
-- 25/25 (docs/changelog/2026-10-20-midway-standard-structures.md; pinned by
-- MidwayStructurePolicy.law.test.ts). 220 events in the last/next three days
-- carry that level 1.
--
-- fn_ensure_late_registration_capacity refuses any level with SB >= BB before
-- it opens a new table, so during the opening level of every one of those
-- events, once the existing tables are full, no table can be opened:
--   180 late registrations refused in 24 hours
--     (fn_seat_late_registrant_before_maintenance_gate -> capacity line 184)
--   9 rebuys refused
--     (fn_ca_choose_tournament_seat_locked line 15 -> capacity line 184)
-- all with "Tournament current blind level is invalid".
--
-- THE LINE
--
--   IF ... OR v_sb>=v_bb THEN RAISE 'Tournament current blind level is invalid'
--
-- That clause was written for a DEGENERATE overflow level, where independent
-- 10,000,000 ceilings clamp SB, BB and ante to one number (see the 2026-09-09
-- note inside fn_resolve_tournament_blinds). That path now guarantees SB < BB
-- itself before it returns, so the only level this clause still meets is an
-- authored, persisted one - such as 25/25.
--
-- THE FIX
--
-- Refuse SB > BB (a small blind larger than the big blind is never a level);
-- accept SB = BB. Every other check on the line is unchanged. A tournament
-- table with 25/25 passes the tables constraints (tables_cash_needs_a_game and
-- fn_tables_creation_guard's blind rule both apply to cash tables only), and
-- the engine deals a tournament table from the event's level, not from the
-- table row.
--
-- Patched by exact anchor with an md5 precondition. One transaction, no
-- hot-table lock.
--
-- Pinned by tests/an-authored-equal-blind-level-can-open-a-table.law.test.ts.
--
-- @live-proof: (SELECT position('OR v_ante<0 OR v_sb>v_bb THEN' IN pg_get_functiondef('public.fn_ensure_late_registration_capacity(uuid,integer)'::regprocedure))>0 AND position('OR v_sb>=v_bb THEN' IN pg_get_functiondef('public.fn_ensure_late_registration_capacity(uuid,integer)'::regprocedure))=0)

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $an_authored_equal_blind_level_can_open_a_table$
DECLARE
  v_sig constant regprocedure :=
    'public.fn_ensure_late_registration_capacity(uuid,integer)'::regprocedure;
  v_old constant text := 'OR v_ante<0 OR v_sb>=v_bb THEN';
  v_new constant text := 'OR v_ante<0 OR v_sb>v_bb THEN';
  v_src text;
  v_def text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_sig;
  IF position(v_new IN v_src) > 0 AND position(v_old IN v_src) = 0 THEN
    RETURN; -- already installed
  END IF;
  IF md5(v_src) <> 'c971b2727cdd42e8a9642523a81e8364' THEN
    RAISE EXCEPTION 'fn_ensure_late_registration_capacity body changed (md5 %); refusing to patch a body this migration did not measure', md5(v_src);
  END IF;
  v_def := pg_get_functiondef(v_sig);
  IF (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) THEN
    RAISE EXCEPTION 'capacity blind-level anchor is not present exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_sig;
  IF position(v_new IN v_src) = 0 OR position(v_old IN v_src) > 0 THEN
    RAISE EXCEPTION 'patched capacity check did not install';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = v_sig AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'patched capacity function lost its security definer, settings or grants';
  END IF;
END
$an_authored_equal_blind_level_can_open_a_table$;

COMMIT;
