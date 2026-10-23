-- Explicit owner-requested occupancy retirement, not a public API or repair loop.
-- This temporary helper belongs to one database session and is never installed
-- in public. Read the original occupancy IDs and barriers before execution.
-- In ONE tool/database call, replace the execution marker with:
-- SELECT pg_temp.retire_lightning_occupancies('<source-game-uuid>',ARRAY['<occupancy-uuid>']::uuid[]);
-- Preserve this file's transaction. Read original seat_cashout_receipts after
-- an unknown acknowledgment before repeating the same occupancy request.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
CREATE OR REPLACE FUNCTION pg_temp.retire_lightning_occupancies(p_source_game_id uuid,p_occupancy_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp
SET lock_timeout TO '1s' SET statement_timeout TO '8s' AS $retire$
DECLARE g record; requested uuid[]; actor uuid; seat record; receipt jsonb;
 outcomes jsonb:='[]'::jsonb; credited numeric:=0; departed int:=0; replayed int:=0;
BEGIN
 IF NOT coalesce(public.fn_caller_is_engine(),false) THEN RAISE EXCEPTION 'Engine authority required' USING ERRCODE='42501'; END IF;
 IF p_source_game_id IS NULL OR p_occupancy_ids IS NULL OR cardinality(p_occupancy_ids) NOT BETWEEN 1 AND 100
    OR array_position(p_occupancy_ids,NULL) IS NOT NULL THEN RAISE EXCEPTION 'RETIREMENT_INVALID_REQUEST' USING ERRCODE='22023'; END IF;
 SELECT array_agg(DISTINCT x ORDER BY x) INTO requested FROM unnest(p_occupancy_ids) x;
 IF public.fn_platform_frozen() OR public.fn_entry_purchases_frozen() THEN RETURN jsonb_build_object('ok',false,'pending',true,'reason','platform_frozen'); END IF;
 -- Original cashout/buyin/move lock order: user before game and seat.
 FOR actor IN SELECT DISTINCT ts.user_id FROM public.table_seats ts JOIN public.tables t ON t.id=ts.table_id
  WHERE t.cluster_id=p_source_game_id AND ts.occupancy_id=ANY(requested) AND ts.user_id IS NOT NULL ORDER BY ts.user_id LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended('table_cap:'||actor::text,0)) THEN RETURN jsonb_build_object('ok',false,'pending',true,'reason','player_transaction_busy'); END IF;
 END LOOP;
 SELECT * INTO g FROM public.cash_games WHERE id=p_source_game_id FOR UPDATE;
 IF NOT FOUND OR g.enabled OR g.cluster_mode<>'must_move' OR coalesce((SELECT target.id FROM public.cash_games source
 JOIN public.cash_games target
  ON target.id::text=source.ruleset_snapshot->>'canonical_lightning_game_id'
  AND target.club_id=source.club_id AND target.variant=source.variant
  AND target.sb=source.sb AND target.bb=source.bb
  AND target.template_name IN ('action','madness') AND target.closed_at IS NULL
 WHERE source.id=g.id AND source.template_name IN ('action','madness')),g.id)=g.id THEN RETURN jsonb_build_object('ok',false,'pending',true,'reason','retired_source_not_drained'); END IF;
 IF EXISTS(SELECT 1 FROM unnest(requested) q(occ) WHERE NOT EXISTS(SELECT 1 FROM public.table_seats ts JOIN public.tables t ON t.id=ts.table_id WHERE ts.occupancy_id=q.occ AND t.cluster_id=g.id)) THEN RAISE EXCEPTION 'RETIREMENT_OCCUPANCY_SCOPE_MISMATCH' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.tables t WHERE t.cluster_id=g.id AND coalesce(t.lifecycle,'')<>'closed' AND NOT coalesce(t.is_deleted,false)
   AND (t.dealing_halted_at IS NULL OR t.dealing_halt_observed_at IS NULL OR t.dealing_halt_observed_at<t.dealing_halted_at)) THEN RETURN jsonb_build_object('ok',false,'pending',true,'reason','halt_not_observed'); END IF;
 IF EXISTS(SELECT 1 FROM public.hand_state_snapshots h JOIN public.tables t ON t.id=h.table_id WHERE t.cluster_id=g.id AND NOT h.is_complete AND coalesce(t.lifecycle,'')<>'closed')
 OR EXISTS(SELECT 1 FROM public.lightning_instance i WHERE i.cluster_id=g.id AND i.state IN ('forming','reserved','dealing','settling'))
 OR EXISTS(SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id=g.id AND ps.exited_at IS NULL)
 OR EXISTS(SELECT 1 FROM public.lightning_reservation r WHERE r.cluster_id=g.id AND r.state IN ('pending','committed')) THEN RETURN jsonb_build_object('ok',false,'pending',true,'reason','settlement_in_flight'); END IF;
 FOR seat IN SELECT ts.* FROM public.table_seats ts JOIN public.tables t ON t.id=ts.table_id
  WHERE t.cluster_id=g.id AND ts.occupancy_id=ANY(requested) ORDER BY ts.user_id,ts.id FOR UPDATE OF ts LOOP
  IF seat.left_at IS NOT NULL THEN replayed:=replayed+1;
  ELSE
   -- Original service exit declares table_cashout and performs the original
   -- per-occupancy idempotent credit, session close and authoritative receipt.
   PERFORM public.player_leave_table(seat.table_id,seat.user_id);
   departed:=departed+1;
  END IF;
  SELECT cr.receipt INTO receipt FROM public.seat_cashout_receipts cr WHERE cr.occupancy_id=seat.occupancy_id;
  IF receipt IS NULL OR EXISTS(SELECT 1 FROM public.table_seats ts WHERE ts.occupancy_id=seat.occupancy_id AND ts.left_at IS NULL) THEN RAISE EXCEPTION 'RETIREMENT_CASHOUT_RECEIPT_MISSING' USING ERRCODE='23514'; END IF;
  IF seat.left_at IS NULL THEN credited:=credited+coalesce((receipt->>'stack')::numeric,0); END IF;
  outcomes:=outcomes||jsonb_build_array(receipt);
 END LOOP;
 RETURN jsonb_build_object('ok',true,'pending',false,'source_game_id',g.id,'canonical_game_id',coalesce((SELECT target.id FROM public.cash_games source
 JOIN public.cash_games target
  ON target.id::text=source.ruleset_snapshot->>'canonical_lightning_game_id'
  AND target.club_id=source.club_id AND target.variant=source.variant
  AND target.sb=source.sb AND target.bb=source.bb
  AND target.template_name IN ('action','madness') AND target.closed_at IS NULL
 WHERE source.id=g.id AND source.template_name IN ('action','madness')),g.id),
  'departed',departed,'replayed',replayed,'credited_this_call',credited,'receipts',outcomes,
  'remaining_seats',(SELECT count(*) FROM public.table_seats ts JOIN public.tables t ON t.id=ts.table_id WHERE t.cluster_id=g.id AND ts.left_at IS NULL));
END $retire$;

-- @execute-retirement-here
COMMIT;

