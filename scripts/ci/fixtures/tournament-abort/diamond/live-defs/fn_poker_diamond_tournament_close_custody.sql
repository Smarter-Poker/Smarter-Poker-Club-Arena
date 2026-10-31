-- live_md5 c190bce2730ae5b9b08a886883e84def
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_close_custody(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_c record; v_n integer := 0; v_open bigint; v_receipt jsonb;
BEGIN
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  v_open := public.fn_poker_diamond_tournament_custody(p_tournament_id);
  IF v_open <> 0 THEN
    RETURN jsonb_build_object('ok',true,'closed',0,'still_held',v_open);
  END IF;
  -- 2026-10-21: wallets lock in id order, as every hand settlement does, so a
  -- finish over hundreds of entries never interleaves against live hands.
  PERFORM p.id FROM public.profiles p
   WHERE p.id IN (SELECT c.user_id FROM public.poker_diamond_custody c
                   WHERE c.purpose='tournament_entry' AND c.target_id=p_tournament_id
                     AND c.state<>'released' AND c.balance=0)
   ORDER BY p.id FOR UPDATE OF p;
  FOR v_c IN SELECT c.id FROM public.poker_diamond_custody c
              WHERE c.purpose='tournament_entry' AND c.target_id=p_tournament_id AND c.state<>'released' AND c.balance=0
              ORDER BY c.created_at, c.id
  LOOP
    PERFORM set_config('app.poker_diamond_tournament_release', v_c.id::text, true);
    v_receipt := public.fn_poker_diamond_release(v_c.id, uuid_in(md5('poker-tournament-close:'||v_c.id::text)::cstring));
    PERFORM set_config('app.poker_diamond_tournament_release', '', true);
    IF COALESCE((v_receipt->>'success')::boolean,false) IS NOT TRUE OR (v_receipt->>'amount')::bigint <> 0 THEN
      RAISE EXCEPTION 'diamond_tournament_close_failed' USING ERRCODE='P0404';
    END IF;
    v_n := v_n + 1;
  END LOOP;
  -- 2026-10-06 (20261007000010): a completed event keeps no promise; any
  -- guarantee earmark still open is released (fn_settle_tournament_rake calls
  -- this door at the terminal).
  PERFORM public.fn_poker_diamond_guarantee_release(p_tournament_id, 'complete');
  RETURN jsonb_build_object('ok',true,'closed',v_n,'still_held',0);
END $function$

