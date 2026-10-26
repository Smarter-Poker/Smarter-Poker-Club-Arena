-- 20261024193700_a_rebuy_is_never_seated_on_a_table_being_broken
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-24 19:37:00 UTC.
--
-- WHAT WAS WRONG
--
-- Fourth cause behind Dan's "276 entries and 9 rebuys" (2026-10-24). After the
-- bounty place fix (20261024072516) went live, the largest remaining refusal
-- of process_tournament_rebuy was F06_SOURCE_EXCLUDED: 192 refusals between
-- 15:06 and 19:35 UTC, 60 more that morning.
--
-- THE LINE THAT PRODUCED IT
--
-- Postgres logs place every one of them at
--   f06_source_guard() line 158
--   <- fn_ca_assign_tournament_player_seat_locked line 231
--   <- process_tournament_rebuy
-- Line 231 (clearing a departed occupant's stale roster coordinate) is reached
-- only when the rebuying player has no live seat, i.e. when the seat came from
-- fn_ca_choose_tournament_seat_locked. f06_source_guard refuses that write only
-- when the destination table has an F06 table break in progress. So the
-- chooser had picked a table that was being broken.
--
-- It does that by design of its ORDER BY: the table with the MOST free seats
-- first. A table being broken is the one whose players were just moved off,
-- so it is very often the emptiest table in the event. The purchase rolls
-- back, the next try picks the same table, and the 30 second offer expires.
--
-- THE FIX
--
-- The chooser now ranks a table with a break in progress (an
-- smarter_private.f06_operations row for it in any state other than
-- 'acknowledged' / 'withdrawn_before_manifest', the same predicate as the
-- f06_one_source partial unique index, so it is an index probe) LAST, before
-- every existing key. Nothing else changes: if no other table has a legal
-- free chair, it still chooses the breaking table exactly as it does today,
-- so this can only remove refusals, never add a new one.
--
-- Patched by exact anchor with an md5 precondition on the measured live body.
-- fn_ca_guard_mtt_admission_contract's stored definition md5 for this function
-- is a historical record (it already differs from the live body) and is only
-- consulted when that contract row is written; runtime reads only its abi.
-- One transaction, no hot-table lock.
--
-- Pinned by tests/a-rebuy-is-never-seated-on-a-table-being-broken.law.test.ts.
--
-- @live-proof: (SELECT position('A REBUY IS NEVER SEATED ON A TABLE BEING BROKEN' IN pg_get_functiondef('public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)'::regprocedure))>0)

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $a_rebuy_is_never_seated_on_a_breaking_table$
DECLARE
  v_sig constant regprocedure :=
    'public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)'::regprocedure;
  v_marker constant text := 'A REBUY IS NEVER SEATED ON A TABLE BEING BROKEN';
  v_src text;
  v_def text;
  v_old text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_sig;
  IF position(v_marker IN v_src) > 0 THEN
    RETURN; -- already installed
  END IF;
  IF md5(v_src) <> '8a3849d04f1fa2d6a2e266e86527877e' THEN
    RAISE EXCEPTION 'fn_ca_choose_tournament_seat_locked body changed (md5 %); refusing to patch a body this migration did not measure', md5(v_src);
  END IF;

  v_def := pg_get_functiondef(v_sig);
  v_old := E'   ORDER BY (\n       SELECT count(*)\n';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) THEN
    RAISE EXCEPTION 'chooser ORDER BY anchor is not present exactly once';
  END IF;
  v_def := replace(v_def, v_old, $new$   -- A REBUY IS NEVER SEATED ON A TABLE BEING BROKEN (2026-10-24): a table
   -- with an F06 break in progress sorts last, so the emptiest-table rule
   -- below never sends a rebuy onto the table being emptied.
   ORDER BY EXISTS (
       SELECT 1 FROM smarter_private.f06_operations o
        WHERE o.source_table_id=tb.id
          AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')),
     (
       SELECT count(*)
$new$);
  EXECUTE v_def;

  IF position(v_marker IN (SELECT prosrc FROM pg_proc WHERE oid = v_sig)) = 0 THEN
    RAISE EXCEPTION 'patched chooser did not install';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = v_sig AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[]
       AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'patched chooser lost its security definer, settings or private grant';
  END IF;
END
$a_rebuy_is_never_seated_on_a_breaking_table$;

COMMIT;
