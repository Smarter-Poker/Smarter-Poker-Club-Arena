-- 20261027145103_lightning_plo4_pool_recovers_after_the_unsettled_anchor_exit_is.sql
-- One incident, after its source correction. No seat, wallet or hand is rewritten.
-- At 13:17:05 UTC a stopped normal folder's pool session closed while hand
-- 6ac38507 was unsettled. Its anchor was cashed out at its full 160.52 stack.
-- Settlement correctly refused the missing anchor and froze the cluster.
-- The existing instance reaper voided that uncommitted hand at 13:26:49 UTC.
-- The 1.00 committed-at-fold exposure was never an anchor debit: no player
-- is charged, credited, or clawed back here, and the void is never resettled.
-- The maintained unfreeze door records the recovery, retires old sessions,
-- advances the epoch and asserts that the anchor chip total does not change.
-- @live-proof: (SELECT resolved AND resolution LIKE '%20261027145103%' FROM public.financial_alerts WHERE id='b5b9b1e5-2970-440e-a193-0b2e6f473cb8')
-- @live-proof: (SELECT EXISTS(SELECT 1 FROM public.cash_cluster_events WHERE game_id='705270cd-03c2-40d9-8749-038f741a295c' AND at >= (SELECT resolved_at - interval '1 minute' FROM public.financial_alerts WHERE id='b5b9b1e5-2970-440e-a193-0b2e6f473cb8') AND kind='cluster_unfrozen' AND payload->>'reason' LIKE '%20261027145103%'))
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
DO $recovery$
DECLARE
  c_game constant uuid := '705270cd-03c2-40d9-8749-038f741a295c';
  c_hand constant uuid := '6ac38507-6ac1-412b-8b2d-54ab63ef1437';
  c_instance constant uuid := 'e217b11a-98bd-47d4-bc7e-abcecbf23b18';
  c_alert constant uuid := 'b5b9b1e5-2970-440e-a193-0b2e6f473cb8';
  c_actor constant uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  c_reason constant text := 'Migration 20261027145103: stop and disconnect exits now retain anchors for every unsettled original hand. Incident 6ac38507 was already voided by the original instance reaper without an accepted settlement. Preserve all original financial records; recover only the frozen epoch through the existing money-neutral unfreeze door.';
  g record;
  a record;
  result jsonb;
BEGIN
  IF md5(pg_get_functiondef('public.fn_lightning_stop_playing(uuid)'::regprocedure)) <> '1b32acb1f0779fc10d162ae2debdf440'
     OR md5(pg_get_functiondef('public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure)) <> '982d09db9e40ccde65476081152a384b' THEN
    RAISE EXCEPTION 'The unsettled-anchor exit correction is not installed';
  END IF;
  IF md5(pg_get_functiondef('public.fn_cash_cluster_unfreeze(uuid,uuid,text)'::regprocedure)) <> '00dd3144409c27951431893458bab580' THEN
    RAISE EXCEPTION 'The qualified unfreeze door changed; inspect it before recovery';
  END IF;
  SELECT * INTO STRICT g FROM public.cash_games WHERE id=c_game FOR UPDATE;
  SELECT * INTO STRICT a FROM public.financial_alerts WHERE id=c_alert FOR UPDATE;
  IF a.resolved AND a.resolution LIKE '%20261027145103%' AND EXISTS(
      SELECT 1 FROM public.cash_cluster_events WHERE game_id=c_game AND at>=a.resolved_at-interval '1 minute'
       AND kind='cluster_unfrozen' AND payload->>'reason'=c_reason) THEN
    RETURN;
  END IF;
  IF g.cluster_mode IS DISTINCT FROM 'frozen' OR g.cluster_epoch IS DISTINCT FROM 3
     OR a.resolved IS DISTINCT FROM false OR a.source IS DISTINCT FROM 'lightning_settlement'
     OR a.context->>'hand_id' IS DISTINCT FROM c_hand::text
     OR a.context->>'invariant' IS DISTINCT FROM 'anchor_not_live'
     OR a.context->>'cluster_id' IS DISTINCT FROM c_game::text THEN
    RAISE EXCEPTION 'The exact frozen incident changed; no recovery was sent';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.lightning_instance WHERE id=c_instance AND hand_id=c_hand
       AND cluster_id=c_game AND state='abandoned' AND completed_at IS NOT NULL
       AND abandon_reason LIKE 'reaped:%the hand is void%')
     OR NOT EXISTS(SELECT 1 FROM public.lightning_hand WHERE hand_id=c_hand AND cluster_id=c_game
       AND lightning_instance_id=c_instance AND settled_at IS NULL AND settle_receipt IS NULL
       AND hand_history_id IS NULL AND settle_request_id IS NULL)
     OR EXISTS(SELECT 1 FROM public.hand_history WHERE id=c_hand) THEN
    RAISE EXCEPTION 'The original hand is not the independently observed uncommitted void';
  END IF;
  result := public.fn_cash_cluster_unfreeze(c_game,c_actor,c_reason);
  IF result->>'ok' IS DISTINCT FROM 'true' OR result->>'unfrozen' IS DISTINCT FROM 'true'
     OR result->>'epoch_before' IS DISTINCT FROM '3' OR result->>'epoch_after' IS DISTINCT FROM '4' THEN
    RAISE EXCEPTION 'The maintained unfreeze door refused: %',result;
  END IF;
  UPDATE public.financial_alerts SET resolved=true,resolved_at=clock_timestamp(),resolved_by=c_actor,
    resolution=c_reason,context=context||jsonb_build_object('recovery_migration','20261027145103',
      'recovery_result',result,'hand_disposition','original_instance_reaper_void_no_settlement_replay')
    WHERE id=c_alert AND resolved=false;
  IF NOT FOUND THEN RAISE EXCEPTION 'The incident resolution changed during recovery'; END IF;
END
$recovery$;
COMMIT;
