-- A pristine welcome reset must answer inside PostgREST's statement timeout.
-- The first implementation joined the entire hand-history relation to tables
-- and then placed an OR across tournament and table identities. On production
-- volume that shape repeatedly timed out before a brand-new club could reset.
-- Both identity columns already have purpose-built indexes. Keep the same
-- refusal semantics while asking the two indexed questions independently.
-- @live-proof: position('h.tournament_id=ANY(v_tournaments)' in pg_get_functiondef('public.fn_get_club_welcome_package_reset_impact(uuid)'::regprocedure)) > 0 AND position('h.table_id=ANY(v_tables)' in pg_get_functiondef('public.fn_get_club_welcome_package_reset_impact(uuid)'::regprocedure)) > 0 AND position('h.tournament_id=ANY(v_tournaments)' in pg_get_functiondef('public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure)) > 0 AND position('h.table_id=ANY(v_tables)' in pg_get_functiondef('public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure)) > 0 AND position('fn_retire_settled_club' in pg_get_functiondef('public.fn_ca_settlement_lane_doctrine()'::regprocedure)) > 0

BEGIN;

DO $rewrite_welcome_hand_checks$
DECLARE
  v_oid oid;
  v_before text;
  v_after text;
  v_old text;
  v_new text;
BEGIN
  v_oid := to_regprocedure('public.fn_get_club_welcome_package_reset_impact(uuid)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'WELCOME_RESET_IMPACT_FUNCTION_MISSING';
  END IF;
  v_before := pg_get_functiondef(v_oid);
  v_old := $old$SELECT count(*) INTO v_hands FROM public.hand_history h LEFT JOIN public.tables t ON t.id=h.table_id
   WHERE h.tournament_id=ANY(v_tournaments) OR t.id=ANY(v_tables);$old$;
  v_new := $new$SELECT
    (SELECT count(*) FROM public.hand_history h
      WHERE h.tournament_id=ANY(v_tournaments)) +
    (SELECT count(*) FROM public.hand_history h
      WHERE h.table_id=ANY(v_tables)
        AND (h.tournament_id IS NULL OR h.tournament_id<>ALL(v_tournaments)))
    INTO v_hands;$new$;
  v_after := replace(v_before,v_old,v_new);
  IF v_after = v_before THEN
    RAISE EXCEPTION 'WELCOME_RESET_IMPACT_HAND_CHECK_SHAPE_CHANGED';
  END IF;
  EXECUTE v_after;

  v_oid := to_regprocedure('public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'WELCOME_UNWIND_FUNCTION_MISSING';
  END IF;
  v_before := pg_get_functiondef(v_oid);
  v_old := $old$OR EXISTS(SELECT 1 FROM public.hand_history h LEFT JOIN public.tables t ON t.id=h.table_id
          WHERE h.tournament_id=ANY(v_tournaments) OR t.id=ANY(v_tables))$old$;
  v_new := $new$OR EXISTS(SELECT 1 FROM public.hand_history h
          WHERE h.tournament_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.hand_history h
          WHERE h.table_id=ANY(v_tables))$new$;
  v_after := replace(v_before,v_old,v_new);
  IF v_after = v_before THEN
    RAISE EXCEPTION 'WELCOME_UNWIND_HAND_CHECK_SHAPE_CHANGED';
  END IF;
  EXECUTE v_after;
END $rewrite_welcome_hand_checks$;

-- The retained-record owner retirement is deliberately a cross-resource
-- authority: it takes the global settlement lane before locking the club and
-- composing with the welcome unwind. The first retirement migration omitted
-- that new reviewed caller from the doctrine, so the live doctrine correctly
-- refused it. Add exactly this authority and prove the doctrine immediately.
DO $review_retained_club_retirement_lane$
DECLARE
  v_oid oid:=to_regprocedure('public.fn_ca_settlement_lane_doctrine()');
  v_before text;
  v_after text;
  v_old text:=$old$'fn_remove_first_club_welcome_games','fn_unwind_unused_first_club_welcome_package'$old$;
  v_new text:=$new$'fn_remove_first_club_welcome_games','fn_retire_settled_club','fn_unwind_unused_first_club_welcome_package'$new$;
  v_count integer;
  v_answer jsonb;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'CLUB_RETIREMENT_REQUIRES_SETTLEMENT_LANE_DOCTRINE';
  END IF;
  v_before:=pg_get_functiondef(v_oid);
  v_count:=(length(v_before)-length(replace(v_before,v_old,'')))/length(v_old);
  IF v_count<>1 THEN
    RAISE EXCEPTION 'CLUB_RETIREMENT_LANE_DOCTRINE_DRIFT: %',v_count;
  END IF;
  v_after:=replace(v_before,v_old,v_new);
  EXECUTE v_after;
  IF replace(pg_get_functiondef(v_oid),v_new,v_old) IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'CLUB_RETIREMENT_LANE_DOCTRINE_REVERSE_SUBSTITUTION_FAILED';
  END IF;
  v_answer:=public.fn_ca_settlement_lane_doctrine();
  IF COALESCE((v_answer->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'CLUB_RETIREMENT_SETTLEMENT_LANE_DOCTRINE_FAILED: %',v_answer->'violations';
  END IF;
END $review_retained_club_retirement_lane$;

COMMIT;
