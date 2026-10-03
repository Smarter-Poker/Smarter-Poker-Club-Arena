-- 20261003230910_a_tournament_table_s_hand_does_not_wait_for_its_sibling_tabl.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A TOURNAMENT TABLE'S HAND DOES NOT WAIT FOR ITS SIBLING TABLES (phase 7 of
-- 9: availability). Full account:
-- docs/changelog/2026-10-03-a-tournament-table-s-hand-does-not-wait-for-its-sibling-tables.md.
--
-- Every per-table F06 hand call (fn_f06_hand_number_state, and through it
-- fn_f06_allocate_hand_number and fn_f06_table_state; fn_f06_begin_hand;
-- fn_f06_finish_hand) opened with smarter_private.f06_prefix, which takes the
-- tournament lane T(id) EXCLUSIVELY and the tournament row FOR UPDATE. So
-- every table of one tournament dealt one at a time: production 21:05-22:59
-- UTC 2026-10-03, the 40-table MTT a9901ed2 ("Afternoon Free Buy") logged
-- 4,800+ lock waits of 1 s or more on that one key (finish 1,362, allocate
-- 1,254, number state 1,169, begin 825), dealt 126 hands in 10 minutes across
-- 40 tables, and each of the four calls averaged 55-70 ms against 1 ms of
-- work. docs/changelog/2026-09-29-a-tournament-start-locks-the-bank-without-
-- blocking-foreign-keys.md had already named it and left it.
--
-- These calls now take public.fn_ca_f06_share_table_lane: the lease fence
-- (f06_authority before and after, unchanged), G shared and T(id) SHARED (the
-- shape fn_ca_share_settlement_lane_for_table gives the same table's hand
-- settlement), the tournament row FOR SHARE (what settlement and
-- fn_ca_retain_hand_submission already take), then this table's row and its
-- seats FOR UPDATE, in f06_prefix's order. Calls on one table still
-- serialize on the table row; calls on different tables no longer wait for
-- each other. Every tournament-wide authority (breaks, parks, moves,
-- eliminations, custody, generation changes, cancellation, finish of a hand
-- that never started) keeps T(id) EXCLUSIVE, and an exclusive request still
-- waits for every shared holder and is not starved (Postgres queues new
-- shared requests behind a waiting exclusive one). fn_f06_finish_hand takes
-- the shared lane only for an accepted hand; never_started keeps f06_prefix
-- because proving that nothing started needs the exclusive lane.
--
-- Invariants and where they now live: hand numbers come from the global
-- sequence under its own shared allocation lock; one reserved permit per table
-- and one permit per (table, hand number) are unique indexes (f06_one_hand,
-- f06_hand_permits_table_id_hand_number_key); source exclusion rows are written
-- only under T(id) exclusive; tournament status is written only under T(id) or
-- G exclusive; the lease is fenced by its row lock. No money moves and no
-- money path changes. f06_prefix itself is unchanged.
--
-- Applied as substitutions on the md5-pinned live text of the three
-- functions (each fragment exactly once, reverse substitution reproduces the
-- pin, privileges unchanged). Post-images, computed on the exact live
-- pre-images by scripts/ci/test-a-tournament-table-s-hand-does-not-wait-for-
-- its-sibling-tables.py: fn_f06_hand_number_state 79c2a20b8f72b7fdacab80bbe7850e30,
-- fn_f06_begin_hand e498a501aaa983f397bd4da1afa09875,
-- fn_f06_finish_hand f85ee8fbf794e9087926715fd340499d.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)'::regprocedure)) = 'e498a501aaa983f397bd4da1afa09875')

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION public.fn_ca_f06_share_table_lane(p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
BEGIN
  /* THE SHARED TABLE LANE OF A TOURNAMENT (2026-10-03). For per-table F06
     hand calls only: what f06_prefix does for one table and no users, with
     the tournament lane T(id) taken SHARED instead of exclusive and the
     tournament row FOR SHARE instead of FOR UPDATE. Same order as f06_prefix
     and as fn_ca_share_settlement_lane_for_table: lease fence, G shared,
     T(id) shared, lease re-check, tournament row, table row, seats. */
  IF p_table_id IS NULL THEN
    RAISE EXCEPTION 'F06_TABLE_LANE_NEEDS_A_TABLE' USING ERRCODE = '22023';
  END IF;
  PERFORM smarter_private.f06_authority(p_tournament_id, p_lease_generation);
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || p_tournament_id::text, 0));
  PERFORM smarter_private.f06_authority(p_tournament_id, p_lease_generation, false);
  PERFORM 1 FROM public.tournaments WHERE id = p_tournament_id FOR SHARE;
  PERFORM 1 FROM public.tables WHERE id = p_table_id FOR UPDATE;
  PERFORM s.id FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id AND s.table_id = p_table_id
   ORDER BY s.id FOR UPDATE OF s;
END
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_f06_share_table_lane(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_f06_share_table_lane(uuid, uuid, uuid) TO service_role;
COMMENT ON FUNCTION public.fn_ca_f06_share_table_lane(uuid, uuid, uuid) IS
  'Per-table F06 hand lane: lease fence, G and T(id) shared, tournament row FOR SHARE, this table and its seats FOR UPDATE. Only for calls that touch one table and prove nothing about other tables; tournament-wide authorities take f06_prefix (T(id) exclusive).';

DO $subs$
DECLARE
  v_sig regprocedure; v_def text; v_old text; v_new text; v_n integer; v_after text; v_acl text;
  v_pin text;
BEGIN
  -- fn_f06_hand_number_state
  v_sig := 'public.fn_f06_hand_number_state(uuid,uuid,uuid)'::regprocedure;
  v_pin := 'cfb6d1f8b0793c0e4ef4e0b5f147779c';
  v_def := pg_get_functiondef(v_sig);
  IF md5(v_def) <> v_pin THEN
    RAISE EXCEPTION 'fn_f06_hand_number_state is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E' PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,\'{}\',ARRAY[p_table_id]);\n';
  v_new := E' /* A TABLE\'S HAND DOES NOT WAIT FOR ITS SIBLING TABLES (2026-10-03): the\n'
        || E'    tournament lane T(id) shared, the tournament row FOR SHARE, this table\n'
        || E'    and its seats FOR UPDATE. See fn_ca_f06_share_table_lane. */\n'
        || E' PERFORM public.fn_ca_f06_share_table_lane(p_tournament_id,p_lease_generation,p_table_id);\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_f06_hand_number_state: the replaced lane occurs % times, expected exactly 1', v_n;
  END IF;
  SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = v_sig;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef(v_sig);
  IF md5(v_after) <> md5(replace(v_def, v_old, v_new))
     OR md5(replace(v_after, v_new, v_old)) <> v_pin THEN
    RAISE EXCEPTION 'fn_f06_hand_number_state is not its intended post-image (md5 %)', md5(v_after);
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = v_sig) IS DISTINCT FROM v_acl
     OR has_function_privilege('anon', v_sig, 'EXECUTE')
     OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_f06_hand_number_state: its privileges changed';
  END IF;
  RAISE NOTICE 'fn_f06_hand_number_state post-image md5 %', md5(v_after);

  -- fn_f06_begin_hand
  v_sig := 'public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)'::regprocedure;
  v_pin := '9dcf2427b3fec27594af66bff55565d1';
  v_def := pg_get_functiondef(v_sig);
  IF md5(v_def) <> v_pin THEN
    RAISE EXCEPTION 'fn_f06_begin_hand is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E' PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,\'{}\',ARRAY[p_table_id]);\n';
  v_new := E' /* A TABLE\'S HAND DOES NOT WAIT FOR ITS SIBLING TABLES (2026-10-03): the\n'
        || E'    tournament lane T(id) shared, the tournament row FOR SHARE, this table\n'
        || E'    and its seats FOR UPDATE. See fn_ca_f06_share_table_lane. */\n'
        || E' PERFORM public.fn_ca_f06_share_table_lane(p_tournament_id,p_lease_generation,p_table_id);\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_f06_begin_hand: the replaced lane occurs % times, expected exactly 1', v_n;
  END IF;
  SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = v_sig;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef(v_sig);
  IF md5(v_after) <> md5(replace(v_def, v_old, v_new))
     OR md5(replace(v_after, v_new, v_old)) <> v_pin THEN
    RAISE EXCEPTION 'fn_f06_begin_hand is not its intended post-image (md5 %)', md5(v_after);
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = v_sig) IS DISTINCT FROM v_acl
     OR has_function_privilege('anon', v_sig, 'EXECUTE')
     OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_f06_begin_hand: its privileges changed';
  END IF;
  RAISE NOTICE 'fn_f06_begin_hand post-image md5 %', md5(v_after);

  -- fn_f06_finish_hand
  v_sig := 'public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid)'::regprocedure;
  v_pin := 'd5700b1c4e4663c5b9e12915a75d269b';
  v_def := pg_get_functiondef(v_sig);
  IF md5(v_def) <> v_pin THEN
    RAISE EXCEPTION 'fn_f06_finish_hand is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E' PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,\'{}\',ARRAY[h.table_id]);\n';
  v_new := E' /* A TABLE\'S HAND DOES NOT WAIT FOR ITS SIBLING TABLES (2026-10-03). An\n'
        || E'    accepted finish only records the committed hand of this table: the\n'
        || E'    shared table lane. Every other outcome asserts that nothing started,\n'
        || E'    which only the exclusive lane can prove, so it keeps f06_prefix. */\n'
        || E' IF p_outcome=\'accepted\' THEN\n'
        || E' PERFORM public.fn_ca_f06_share_table_lane(p_tournament_id,p_lease_generation,h.table_id);\n'
        || E' ELSE\n'
        || E' PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,\'{}\',ARRAY[h.table_id]);\n'
        || E' END IF;\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_f06_finish_hand: the replaced lane occurs % times, expected exactly 1', v_n;
  END IF;
  SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = v_sig;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef(v_sig);
  IF md5(v_after) <> md5(replace(v_def, v_old, v_new))
     OR md5(replace(v_after, v_new, v_old)) <> v_pin THEN
    RAISE EXCEPTION 'fn_f06_finish_hand is not its intended post-image (md5 %)', md5(v_after);
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = v_sig) IS DISTINCT FROM v_acl
     OR has_function_privilege('anon', v_sig, 'EXECUTE')
     OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_f06_finish_hand: its privileges changed';
  END IF;
  RAISE NOTICE 'fn_f06_finish_hand post-image md5 %', md5(v_after);

END $subs$;

DO $post$
BEGIN
  IF position('smarter_private.f06_prefix(' IN pg_get_functiondef('public.fn_f06_hand_number_state(uuid,uuid,uuid)'::regprocedure)) > 0
     OR position('smarter_private.f06_prefix(' IN pg_get_functiondef('public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'F06_TABLE_LANE_NOT_INSTALLED';
  END IF;
  IF position($q$IF p_outcome='accepted' THEN$q$ IN pg_get_functiondef('public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid)'::regprocedure))
     > position('smarter_private.f06_prefix(' IN pg_get_functiondef('public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid)'::regprocedure)) THEN
    RAISE EXCEPTION 'F06_FINISH_NO_START_LOST_ITS_EXCLUSIVE_LANE';
  END IF;
  IF has_function_privilege('anon', 'public.fn_ca_f06_share_table_lane(uuid,uuid,uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_f06_share_table_lane(uuid,uuid,uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'F06_TABLE_LANE_EXPOSED';
  END IF;
END
$post$;

COMMIT;
