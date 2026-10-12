-- Snapshot completion and age alone never prove successful settlement.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.sp_prune_hand_state_snapshots(integer)'::regprocedure)) IS DISTINCT FROM 'ee1166d02463fdec606f82eb5f27534d'
 OR md5(pg_get_functiondef('smarter_private.horse_adaptive_disposal_certificate_matches(uuid,uuid,bigint,text)'::regprocedure)) IS DISTINCT FROM 'b512986eabb51dc559d4bc2d138b2a39'
 THEN RAISE EXCEPTION 'HORSE_SNAPSHOT_RETENTION_PREIMAGE_CHANGED'; END IF;
END $guard$;
CREATE INDEX horse_adaptive_disposal_snapshot_identity ON smarter_private.horse_adaptive_disposal_certificates(table_id,hand_number);
CREATE FUNCTION smarter_private.horse_snapshot_disposable(p_snapshot uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE s public.hand_state_snapshots; c smarter_private.horse_adaptive_disposal_certificates;
BEGIN
 SELECT * INTO s FROM public.hand_state_snapshots WHERE id=p_snapshot;
 IF NOT FOUND OR s.is_complete IS DISTINCT FROM true
 OR NOT isfinite(s.created_at) OR NOT isfinite(s.updated_at)
 OR s.created_at>=statement_timestamp()-interval '8 days' OR s.updated_at>=statement_timestamp()-interval '8 days'
 OR jsonb_typeof(s.players_json) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(s.players_json)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(s.players_json) p
  WHERE jsonb_typeof(p) IS DISTINCT FROM 'object' OR p->'is_horse' IS DISTINCT FROM 'true'::jsonb
  OR COALESCE(p->>'user_id','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$') THEN RETURN false; END IF;
 SELECT * INTO c FROM smarter_private.horse_adaptive_disposal_certificates d WHERE d.table_id=s.table_id AND d.hand_number=s.hand_number LIMIT 1;
 IF NOT FOUND OR NOT smarter_private.horse_adaptive_disposal_certificate_matches(c.hand_id,c.table_id,c.hand_number,c.request_hash)
 OR smarter_private.f06_hand_cards_unresolved(s.table_id,s.hand_number)
 OR smarter_private.f06_movement_boundary_retained(s.table_id,s.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits p WHERE p.table_id=s.table_id AND p.hand_number=s.hand_number AND p.state='reserved')
 OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.id=c.hand_id AND (h.reported IS true OR h.has_human IS DISTINCT FROM false))
 OR EXISTS(SELECT 1 FROM public.bbj_payouts b WHERE b.table_id=s.table_id AND b.hand_number=s.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=c.hand_id)
 OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates k WHERE k.hand_id=c.hand_id AND k.state='pending')
 THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables t WHERE t.id=s.table_id)
 OR EXISTS(SELECT 1 FROM public.tables tab WHERE tab.id=s.table_id AND tab.tournament_id IS NOT NULL
  AND (NOT EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=tab.tournament_id
   AND upper(COALESCE(t.status::text,'')) IN('COMPLETED','CANCELLED','CANCELED')
   AND COALESCE(t.bounty_pool,0)<=COALESCE(t.bounty_pool_paid,0))
   OR EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=tab.tournament_id AND e.closed_at IS NULL))) THEN RETURN false; END IF;
 RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.horse_snapshot_disposable(uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $patch$
DECLARE original text; replacement text; before_metadata jsonb; after_metadata jsonb;
BEGIN
 SELECT to_jsonb(p)-'prosrc' INTO before_metadata FROM pg_proc p WHERE oid='public.sp_prune_hand_state_snapshots(integer)'::regprocedure;
 original:=pg_get_functiondef('public.sp_prune_hand_state_snapshots(integer)'::regprocedure);
 replacement:=replace(original,$old$      select s.id from public.hand_state_snapshots s
       where ((s.is_complete = true  and s.created_at < now() - interval '6 hours')
          or (s.is_complete = false and s.created_at < now() - interval '30 days'))$old$,$new$      select s.id from smarter_private.horse_adaptive_disposal_certificates c
       join public.hand_state_snapshots s on s.table_id=c.table_id and s.hand_number=c.hand_number
       where smarter_private.horse_snapshot_disposable(s.id)$new$);
 replacement:=replace(replacement,'v_round    constant integer  := 2000;','v_round    constant integer  := 250;');
 replacement:=replace(replacement,'delete from public.hand_state_snapshots h using doomed d where h.id = d.id;','delete from public.hand_state_snapshots h using doomed d where h.id = d.id AND smarter_private.horse_snapshot_disposable(h.id);');
 IF replacement=original OR position($q$interval '6 hours'$q$ IN replacement)>0 OR position($q$interval '30 days'$q$ IN replacement)>0 THEN RAISE EXCEPTION 'HORSE_SNAPSHOT_RETENTION_ANCHOR_CHANGED'; END IF;
 EXECUTE replacement;
 SELECT to_jsonb(p)-'prosrc' INTO after_metadata FROM pg_proc p WHERE oid='public.sp_prune_hand_state_snapshots(integer)'::regprocedure;
 IF after_metadata IS DISTINCT FROM before_metadata THEN RAISE EXCEPTION 'HORSE_SNAPSHOT_RETENTION_METADATA_CHANGED'; END IF;
END $patch$;
COMMENT ON FUNCTION public.sp_prune_hand_state_snapshots(integer) IS 'Existing two-minute bounded retention. Only completed snapshots with original successful horse-only eight-day disposal, original snapshot horse flags and no current F06/movement/report/BBJ/projection/knockout hold are disposable. Incomplete, human, mixed and unknown snapshots remain original recovery evidence.';
COMMIT;
