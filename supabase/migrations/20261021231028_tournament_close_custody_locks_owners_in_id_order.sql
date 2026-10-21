-- Turbo Tuesday PKO bc8e3d86 (351 Diamond entries) was decided at 23:03 UTC on
-- 2026-10-21 and every terminal finish attempt was refused with 40P01. The
-- finish releases each entry custody through fn_poker_diamond_release, which
-- locks the owner's profiles row, in custody creation order. Live hand commits
-- lock the same players' profiles in id order (fn_poker_diamond_settle_cash_hand
-- ORDER BY p.id FOR UPDATE). 351 sequential locks in a different order against
-- continuous hand traffic from the same players deadlock on every attempt.
--
-- Take every releasable owner's profile lock once, in id order, before the
-- release loop. Each release then re-locks a row this transaction already
-- holds. No amount, receipt, custody state, ledger row or release order changes.
BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='10s';
DO $pre$ BEGIN
IF md5(pg_get_functiondef('public.fn_poker_diamond_tournament_close_custody(uuid)'::regprocedure))<>'634cc0054bb96b9bb775f601831c57ee' THEN
RAISE EXCEPTION 'TOURNAMENT_CLOSE_CUSTODY_PREIMAGE_DRIFT'; END IF;
END $pre$;
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
END $function$;
-- Unchanged access: the terminal settlement owner calls it; no API role does.
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_close_custody(uuid) FROM PUBLIC, anon, authenticated, service_role;
DO $post$ BEGIN
IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_poker_diamond_tournament_close_custody(uuid)'::regprocedure
 AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
 AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
 AND p.proacl::text='{postgres=X/postgres}'
 AND md5(pg_get_functiondef(p.oid))='c190bce2730ae5b9b08a886883e84def'
 AND p.prosrc LIKE '%ORDER BY p.id FOR UPDATE OF p;%'
 AND p.prosrc LIKE '%public.fn_poker_diamond_release(v_c.id, uuid_in(md5(''poker-tournament-close:''||v_c.id::text)::cstring))%') THEN
RAISE EXCEPTION 'TOURNAMENT_CLOSE_CUSTODY_POSTIMAGE_DRIFT'; END IF;
END $post$;
COMMIT;
