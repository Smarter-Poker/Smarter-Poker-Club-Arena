-- 20261003053203_welcome_unwind_cancels_through_the_receipted_door
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-03 05:32:03 UTC.
--
-- WHAT WAS WRONG (a real owner hits this):
--
-- fn_unwind_unused_first_club_welcome_package is the authority behind both
-- owner doors for a brand-new club's opening package: "Remove Welcome Games"
-- (fn_remove_first_club_welcome_games) and Retire Club on a pristine welcome
-- club (fn_retire_settled_club). It ended every unused package tournament with
--
--     UPDATE public.tournaments SET status='CANCELLED',ended_at=...,updated_at=now()
--      WHERE id=ANY(v_tournaments) AND ... NOT IN('COMPLETED','CANCELLED','CANCELED');
--
-- Since 20260909014444 every CANCELLED transition is checked at COMMIT by the
-- deferred constraint trigger tournaments_cancel_must_refund, which requires
-- the immutable receipt that only atomic_cancel_tournament writes. The bare
-- UPDATE writes none, so as soon as a new club's opening board or Daily
-- Freezeout has materialized (about one minute after creation) both owner
-- doors fail at commit with
--
--     P0404  tournament <id> has no immutable cancellation receipt
--
-- Club Create Certification never saw it: its reset probe is rollback-only,
-- and a deferred trigger never fires in a transaction that rolls back.
-- Reproduced on 2026-10-03 against residual fixture club 8f13335a (15
-- REGISTERING package tournaments): fn_remove_first_club_welcome_games as the
-- owner raised exactly that P0404.
--
-- WHAT THIS CHANGES:
--
-- Each unused package tournament is cancelled through atomic_cancel_tournament
-- - the same receipted door fn_close_managed_game uses for an owner's Close -
-- in id order, under the global settlement lane the unwind already holds and
-- with app.managed_game_lifecycle already 'on'. Each receipt must come back
-- ok, fully settled, CANCELLED and with zero source players, or the whole
-- unwind refuses (55000) and nothing moves. Nothing else in the body changes:
-- the table close that follows skips tables the receipt already closed.
--
-- MEASURED (rolled back, same fixture): 15 receipted cancels plus the full
-- unwind in 1.7 s; SET CONSTRAINTS ALL IMMEDIATE then passed; 15 receipts,
-- 0 open tables, club treasury 99,700 -> 100,000 (the 100 BBJ and 200 Spin
-- seeds returned through the existing declared paths). No refund lines: no
-- package tournament ever had a registration.
--
-- Exact-fragment rewrite: refuses unless each fragment appears exactly once,
-- proves the substitution reverses to the byte, and requires every catalogue
-- attribute to be unchanged. Replay is a no-op. One transaction (production
-- DDL policy).

-- @live-proof: (SELECT bool_and(p.prosrc LIKE '%v_cancel:=public.atomic_cancel_tournament(v_cancel_id,v_actor);%') AND bool_and(p.prosrc NOT LIKE '%UPDATE public.tournaments SET status=''CANCELLED''%') AND bool_and(p.prosrc LIKE '%target.id=t.satellite_target_id OR target.id=t.satellite_target%') FROM pg_proc p WHERE p.oid='public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

DO $welcome_unwind_receipted_cancel$
DECLARE
  v_proc regprocedure := 'public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure;
  v_before text;
  v_after text;
  v_reversed text;
  v_source text;
  v_metadata_before jsonb;
  v_metadata_after jsonb;
  v_decl_old text := $decl_old$  v_saved jsonb; v_result jsonb;
BEGIN$decl_old$;
  v_decl_new text := $decl_new$  v_saved jsonb; v_result jsonb;
  v_cancel_id uuid; v_cancel jsonb;
BEGIN$decl_new$;
  v_old text := $old$  UPDATE public.tournaments SET status='CANCELLED',ended_at=COALESCE(ended_at,now()),updated_at=now()
   WHERE id=ANY(v_tournaments) AND upper(COALESCE(status::text,'')) NOT IN('COMPLETED','CANCELLED','CANCELED');$old$;
  v_new text := $new$  -- A cancellation is a terminal settlement with an immutable receipt
  -- (deferred trigger tournaments_cancel_must_refund). Use the receipted door
  -- fn_close_managed_game uses; the global lane and lifecycle flag are held.
  FOR v_cancel_id IN SELECT t.id FROM public.tournaments t
     WHERE t.id=ANY(v_tournaments)
       AND upper(COALESCE(t.status::text,'')) NOT IN('COMPLETED','CANCELLED','CANCELED')
     ORDER BY t.id LOOP
    v_cancel:=public.atomic_cancel_tournament(v_cancel_id,v_actor);
    IF v_cancel->>'ok' IS DISTINCT FROM 'true'
       OR v_cancel->>'fully_settled' IS DISTINCT FROM 'true'
       OR v_cancel->>'status' IS DISTINCT FROM 'CANCELLED'
       OR v_cancel->>'tournament_id' IS DISTINCT FROM v_cancel_id::text
       OR COALESCE((v_cancel->>'source_player_count')::integer,-1)<>0 THEN
      RAISE EXCEPTION 'WELCOME_TOURNAMENT_CANCELLATION_RECEIPT_REFUSED: %',v_cancel_id
        USING ERRCODE='55000';
    END IF;
  END LOOP;$new$;
  v_hits integer;
BEGIN
  IF to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'WELCOME_UNWIND_RECEIPTED_CANCEL_DOOR_MISSING';
  END IF;

  v_before := pg_get_functiondef(v_proc);
  SELECT jsonb_build_object('owner',p.proowner,'acl',p.proacl,'config',p.proconfig,
           'secdef',p.prosecdef,'volatile',p.provolatile,'parallel',p.proparallel,
           'leakproof',p.proleakproof,'language',p.prolang,'rettype',p.prorettype,
           'retset',p.proretset,'kind',p.prokind)
    INTO STRICT v_metadata_before
    FROM pg_proc p WHERE p.oid=v_proc;

  IF position(v_new in v_before)>0 THEN
    -- Replay: already installed. Prove the old statement is really gone.
    IF position(v_old in v_before)>0 OR position(v_decl_new in v_before)=0 THEN
      RAISE EXCEPTION 'WELCOME_UNWIND_RECEIPTED_CANCEL_PARTIAL_REFUSED';
    END IF;
  ELSE
    v_hits := (length(v_before)-length(replace(v_before,v_old,'')))/length(v_old);
    IF v_hits<>1 THEN
      RAISE EXCEPTION 'WELCOME_UNWIND_CANCEL_PREIMAGE_REFUSED: % hits',v_hits;
    END IF;
    v_hits := (length(v_before)-length(replace(v_before,v_decl_old,'')))/length(v_decl_old);
    IF v_hits<>1 THEN
      RAISE EXCEPTION 'WELCOME_UNWIND_DECLARE_PREIMAGE_REFUSED: % hits',v_hits;
    END IF;
    v_after := replace(replace(v_before,v_old,v_new),v_decl_old,v_decl_new);
    v_reversed := replace(replace(v_after,v_new,v_old),v_decl_new,v_decl_old);
    IF v_reversed IS DISTINCT FROM v_before THEN
      RAISE EXCEPTION 'WELCOME_UNWIND_RECEIPTED_CANCEL_ROUNDTRIP_REFUSED';
    END IF;
    EXECUTE v_after;
  END IF;

  SELECT p.prosrc,
         jsonb_build_object('owner',p.proowner,'acl',p.proacl,'config',p.proconfig,
           'secdef',p.prosecdef,'volatile',p.provolatile,'parallel',p.proparallel,
           'leakproof',p.proleakproof,'language',p.prolang,'rettype',p.prorettype,
           'retset',p.proretset,'kind',p.prokind)
    INTO STRICT v_source,v_metadata_after
    FROM pg_proc p WHERE p.oid=v_proc;
  IF position('v_cancel:=public.atomic_cancel_tournament(v_cancel_id,v_actor);' in v_source)=0
     OR position('UPDATE public.tournaments SET status=''CANCELLED''' in v_source)>0
     OR position('PERFORM set_config(''app.managed_game_lifecycle'',''on'',true);' in v_source)
        >= position('v_cancel:=public.atomic_cancel_tournament(v_cancel_id,v_actor);' in v_source)
     OR position('PERFORM public.fn_ca_lock_settlement_lane_global();' in v_source)=0
     OR v_source NOT LIKE '%target.id=t.satellite_target_id OR target.id=t.satellite_target%'
     OR v_source NOT LIKE '%1 Chip Deep Stack Spin PLO6%'
     OR v_metadata_after IS DISTINCT FROM v_metadata_before THEN
    RAISE EXCEPTION 'WELCOME_UNWIND_RECEIPTED_CANCEL_POSTIMAGE_REFUSED: metadata %',
      v_metadata_after IS NOT DISTINCT FROM v_metadata_before;
  END IF;
END
$welcome_unwind_receipted_cancel$;

COMMIT;
