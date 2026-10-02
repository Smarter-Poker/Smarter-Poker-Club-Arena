-- 20261002205511_welcome_certification_accepts_fresh_exact_board
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-02 20:55:11 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
--
-- The production Create Club certificate retires its own unused welcome
-- fixture immediately after proving the complete package.  Three private
-- cleanup helpers nevertheless classified the exact twelve Spin/SNG board
-- rows only after their timestamps were five or ten minutes old.  The board
-- creator and cleanup already share advisory lock (530090,1), and the helpers
-- additionally prove the reserved owner namespace, exact package shape,
-- exact game/table allowlist, zero registrations/play/history, provenance,
-- custody, dynamic foreign keys and one-shot delete permits.  The age test
-- therefore did not add lineage; it only made immediate cleanup impossible.
--
-- Remove timestamp age from board *discovery* in all three helpers.  Keep the
-- ten-minute rule for deleting a real engine lease, plus every activity,
-- custody and lineage refusal.  The correction is a guarded, reversible
-- source rewrite and changes no club, game, player, wallet or chip row.
--
-- @live-proof: (SELECT count(*)=3 AND bool_and(p.prosrc NOT LIKE '%COALESCE(t.created_at,''infinity''::timestamptz)%v_cutoff%') FROM pg_proc p WHERE p.oid=ANY(ARRAY['public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure,'public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)'::regprocedure,'public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure]))

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

DO $rewrite$
DECLARE
  v_proc regprocedure;
  v_before text;
  v_after text;
  v_roundtrip text;
  v_old_tournament text;
  v_new_tournament text;
  v_old_table text;
  v_new_table text;
  v_old_count text;
  v_new_count text;
  v_hits integer;
BEGIN
  FOREACH v_proc IN ARRAY ARRAY[
    'public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure,
    'public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)'::regprocedure,
    'public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure
  ] LOOP
    v_before:=pg_get_functiondef(v_proc);
    IF v_proc IN (
      'public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure,
      'public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)'::regprocedure
    ) THEN
      v_old_tournament:=$old$     AND COALESCE(t.created_at,'infinity'::timestamptz)<=v_cutoff
     AND COALESCE(t.updated_at,'infinity'::timestamptz)<=v_cutoff;$old$;
      v_new_tournament:=';';
      v_old_table:=$old$                   OR COALESCE(t.created_at,'infinity'::timestamptz)>v_cutoff
                   OR COALESCE(t.updated_at,'infinity'::timestamptz)>v_cutoff))$old$;
      v_new_table:='))';
    ELSE
      v_old_tournament:=$old$     AND COALESCE(t.created_at,'infinity'::timestamptz)
           <=transaction_timestamp()-interval '5 minutes'
     AND COALESCE(t.updated_at,'infinity'::timestamptz)
           <=transaction_timestamp()-interval '5 minutes';$old$;
      v_new_tournament:=';';
      v_old_table:=$old$                   OR COALESCE(t.created_at,'infinity'::timestamptz)
                        >transaction_timestamp()-interval '5 minutes'
                   OR COALESCE(t.updated_at,'infinity'::timestamptz)
                        >transaction_timestamp()-interval '5 minutes'))$old$;
      v_new_table:='))';
    END IF;

    v_hits:=(length(v_before)-length(replace(v_before,v_old_tournament,'')))
      /length(v_old_tournament);
    IF v_hits<>1 THEN
      RAISE EXCEPTION 'FRESH_BOARD_TOURNAMENT_DISCOVERY_PREIMAGE_REFUSED: % %',v_proc,v_hits;
    END IF;
    v_after:=replace(v_before,v_old_tournament,v_new_tournament);

    v_hits:=(length(v_after)-length(replace(v_after,v_old_table,'')))
      /length(v_old_table);
    IF v_hits<>1 THEN
      RAISE EXCEPTION 'FRESH_BOARD_TABLE_DISCOVERY_PREIMAGE_REFUSED: % %',v_proc,v_hits;
    END IF;
    v_after:=replace(v_after,v_old_table,v_new_table);

    v_old_count:=$old$IF cardinality(v_board_tournaments)<>v_expected_count
     OR cardinality(v_board_tournaments)>12$old$;
    v_new_count:=$new$IF cardinality(v_board_tournaments) NOT IN (0,12)
     OR v_expected_count IS DISTINCT FROM cardinality(v_board_tournaments)$new$;
    v_hits:=(length(v_after)-length(replace(v_after,v_old_count,'')))/length(v_old_count);
    IF v_hits<>1 THEN
      RAISE EXCEPTION 'FRESH_BOARD_COMPLETE_ALLOWLIST_PREIMAGE_REFUSED: % %',v_proc,v_hits;
    END IF;
    v_after:=replace(v_after,v_old_count,v_new_count);

    v_roundtrip:=replace(replace(replace(v_before,v_old_tournament,v_new_tournament),
                         v_old_table,v_new_table),v_old_count,v_new_count);
    IF v_roundtrip IS DISTINCT FROM v_after THEN
      RAISE EXCEPTION 'FRESH_BOARD_DISCOVERY_SUBSTITUTION_REFUSED: %',v_proc;
    END IF;
    EXECUTE v_after;
  END LOOP;
END
$rewrite$;

DO $assert$
DECLARE
  v_proc regprocedure;
  v_source text;
BEGIN
  FOREACH v_proc IN ARRAY ARRAY[
    'public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure,
    'public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)'::regprocedure,
    'public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure
  ] LOOP
    SELECT p.prosrc INTO v_source FROM pg_proc p WHERE p.oid=v_proc;
    IF v_source LIKE '%COALESCE(t.created_at,''infinity''::timestamptz)%v_cutoff%'
       OR v_source LIKE '%COALESCE(t.updated_at,''infinity''::timestamptz)%v_cutoff%'
       OR v_source LIKE '%COALESCE(t.created_at,''infinity''::timestamptz)%transaction_timestamp()%'
       OR v_source LIKE '%COALESCE(t.updated_at,''infinity''::timestamptz)%transaction_timestamp()%'
       OR v_source NOT LIKE '%pg_advisory_xact_lock(530090,1)%'
       OR v_source NOT LIKE '%current_players=0%'
       OR v_source NOT LIKE '%cardinality(v_board_tournaments) NOT IN (0,12)%'
       OR v_source NOT LIKE '%v_expected_count IS DISTINCT FROM cardinality(v_board_tournaments)%'
       OR v_source NOT LIKE '%WELCOME_CERTIFICATION_FIXTURE_IDENTITY_REFUSED%'
       OR NOT EXISTS(
         SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
          WHERE p.oid=v_proc AND p.prosecdef AND r.rolname='postgres'
       )
       OR has_function_privilege('anon',v_proc,'EXECUTE')
       OR has_function_privilege('authenticated',v_proc,'EXECUTE')
       OR has_function_privilege('service_role',v_proc,'EXECUTE') THEN
      RAISE EXCEPTION 'FRESH_BOARD_DISCOVERY_POSTIMAGE_REFUSED: %',v_proc;
    END IF;
  END LOOP;
  IF (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure)
       NOT LIKE '%l.acquired_at>=v_cutoff OR l.heartbeat_at>=v_cutoff%'
     OR (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure)
       NOT LIKE '%smarter_private.f06_lease_has_pending_custody%'
     OR (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)'::regprocedure)
       NOT LIKE '%origin_kind IS DISTINCT FROM ''prelaunch''%'
     OR (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure)
       NOT LIKE '%WELCOME_CERTIFICATION_BOARD_FIXTURE_HAS_ACTIVITY%' THEN
    RAISE EXCEPTION 'FRESH_BOARD_ACTIVITY_OR_CUSTODY_GUARD_REFUSED';
  END IF;
END
$assert$;

COMMIT;
