BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('fn_club_weekly_accounting_summary(uuid)'::regprocedure))<>'5c4002a9a18e416f269cb0ec714320c9' THEN
 RAISE EXCEPTION 'weekly summary reader source changed since review'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_club_weekly_accounting_summary(p_period_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE period public.settlement_periods%ROWTYPE; close_row public.ca_settlements%ROWTYPE;
 received numeric; outgoing numeric; downstream numeric; by_role jsonb; unknown_roles int; rows_count int;
 ledger_ids jsonb; run_status text; basis numeric; missing_periods int;
BEGIN
 SELECT * INTO period FROM public.settlement_periods WHERE id=p_period_id;
 IF NOT FOUND OR period.club_id IS NULL OR period.union_id IS NULL THEN
   RAISE EXCEPTION 'club_accounting_period_missing' USING ERRCODE='22023'; END IF;
 IF NOT public.fn_caller_is_engine() AND NOT EXISTS(
   SELECT 1 FROM public.fn_accounting_party_users('club',period.club_id) u WHERE u.user_id=auth.uid())
   AND (auth.uid() IS NULL OR NOT public.fn_is_union_overseer(period.union_id,auth.uid())) THEN
   RAISE EXCEPTION 'club_accounting_not_authorised' USING ERRCODE='42501'; END IF;
 SELECT * INTO close_row FROM public.ca_settlements s
 WHERE s.union_id=period.union_id AND s.settlement_type='union_rakeback_close' AND s.state='final'
   AND s.external_ref=period.union_id::text||':'||to_char(period.start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
      ||'..'||to_char(period.end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
 basis:=(close_row.totals->'basis_by_club'->>period.club_id::text)::numeric;
 SELECT status INTO run_status FROM public.union_accounting_runs WHERE union_id=period.union_id
   AND period_start=period.start_at AND period_end=period.end_at;

 WITH transfers AS (
   SELECT l.*,i.to_entity_type,i.breakdown->>'payee_role_at_transfer' AS payee_role
   FROM public.chip_ledger l LEFT JOIN public.settlement_invoices i ON i.source_ledger_id=l.id
   WHERE l.club_id=period.club_id AND l.status='posted' AND l.category IN('rakeback','commission')
     AND (l.settlement_id=close_row.id::text OR
       ((l.metadata->>'period_start')::timestamptz=period.start_at AND (l.metadata->>'period_end')::timestamptz=period.end_at))
 ), club_out AS (
   SELECT *,CASE WHEN to_entity_type='player' THEN 'player'
       WHEN payee_role IN('super_agent','agent','sub_agent') THEN payee_role ELSE 'unclassified' END AS tier
   FROM transfers WHERE from_type='club_treasury' AND from_entity_id=period.club_id
     AND to_type IN('player_wallet','agent_wallet')
 ), grouped AS (SELECT tier,sum(amount) AS paid FROM club_out GROUP BY tier)
 SELECT (SELECT COALESCE(sum(amount),0) FROM transfers WHERE from_type IN('union_wallet','union_bank')
            AND from_entity_id=period.union_id AND to_type='club_treasury' AND to_entity_id=period.club_id),
        (SELECT COALESCE(sum(amount),0) FROM club_out),
        (SELECT COALESCE(sum(amount),0) FROM transfers WHERE from_type IN('player_wallet','agent_wallet') AND to_type IN('player_wallet','agent_wallet')),
        (SELECT COALESCE(jsonb_object_agg(tier,paid),'{}') FROM grouped),
        (SELECT count(*) FROM club_out WHERE tier='unclassified'),
        (SELECT count(*) FROM transfers),
        (SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]') FROM transfers)
 INTO received,outgoing,downstream,by_role,unknown_roles,rows_count,ledger_ids;

 -- A timestamp alone cannot assign an earning week to an old payout.
 -- Keep the uncertainty visible instead of making the money disappear.
 SELECT count(*) INTO missing_periods FROM public.chip_ledger l
 WHERE l.club_id=period.club_id AND l.status='posted' AND l.category IN('rakeback','commission')
   AND l.from_type IN('club_treasury','player_wallet','agent_wallet')
   AND l.to_type IN('player_wallet','agent_wallet')
   AND l.created_at>=period.start_at AND l.created_at<period.end_at+interval '1 day'
   AND l.metadata->>'period_start' IS NULL AND l.settlement_id IS DISTINCT FROM close_row.id::text;
 RETURN jsonb_build_object('period_id',period.id,'club_id',period.club_id,'union_id',period.union_id,
   'period_start',period.start_at,'period_end',period.end_at,'currency','CHIPS',
   'rake_earned',basis,'rake_received',received,'expected_union_receipt',close_row.totals->'payout_by_club'->period.club_id::text,
   'paid_super_agents',COALESCE((by_role->>'super_agent')::numeric,0),
   'paid_agents',COALESCE((by_role->>'agent')::numeric,0),'paid_sub_agents',COALESCE((by_role->>'sub_agent')::numeric,0),
   'paid_players',COALESCE((by_role->>'player')::numeric,0),'paid_unclassified',COALESCE((by_role->>'unclassified')::numeric,0),
   'total_paid_by_club',outgoing,'retained_by_club',received-outgoing,'downstream_redistributed',downstream,
   'transfer_count',rows_count,'source_ledger_ids',ledger_ids,'unclassified_role_count',unknown_roles,'missing_period_count',missing_periods,
   'status',CASE WHEN run_status='complete' AND unknown_roles=0 AND missing_periods=0 AND basis IS NOT NULL THEN 'complete' ELSE 'needs_reconciliation' END,
   'run_status',run_status,'basis_source','Recorded Union Close',
   'note','Club Payments Are Counted Once. Downstream Redistribution Is Separate. Figures Show Posted Transfers, Not Unpaid Entitlements.');
END $function$;
COMMIT;
