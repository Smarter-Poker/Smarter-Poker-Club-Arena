BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='90s';SET LOCAL lock_timeout='2s';
DO $candidate$DECLARE started timestamptz:=clock_timestamp();result jsonb;BEGIN
 IF md5(pg_get_functiondef('public.fn_club_weekly_accounting_summary(uuid)'::regprocedure))<>'b00039e968bc69a56046c2fe0634fc8b'OR current_setting('transaction_read_only')<>'on'OR smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'private_candidate_current_owner_or_readonly_changed';END IF;
 WITH original_result AS MATERIALIZED(WITH deposits AS MATERIALIZED (
  SELECT 'cash_rake_accrual'::text AS source_type,b.rake_record_id AS source_group,b.club_ledger_id AS ledger_id,b.amount,b.banked_at,
   b.club_id,b.union_id,b.union_transaction_id,NULL::uuid AS tournament_id
  FROM public.accounting_cash_bank_receipts b WHERE b.union_id IS NULL AND b.rake_record_id IN(
   SELECT x.rake_record_id FROM public.accounting_cash_bank_receipts x
    WHERE x.union_id IS NULL AND x.club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid AND x.banked_at>='2026-10-19 07:00Z'::timestamptz AND x.banked_at<'2026-10-26 07:00Z'::timestamptz
   UNION SELECT s.rake_record_id FROM public.accounting_cash_rake_sources s WHERE s.club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid AND s.union_id IS NULL
    AND NULL::uuid IS NULL AND s.coordinator_union_id IS NULL AND s.earned_at>='2026-10-19 07:00Z'::timestamptz AND s.earned_at<'2026-10-26 07:00Z'::timestamptz
   UNION SELECT s.rake_record_id FROM public.accounting_cash_rake_sources s WHERE s.club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid AND s.union_id IS NULL
    AND NULL::uuid IS NOT NULL AND s.coordinator_union_id=NULL::uuid AND s.earned_at>='2026-10-19 07:00Z'::timestamptz AND s.earned_at<'2026-10-26 07:00Z'::timestamptz)
  UNION ALL
  SELECT 'tournament_fee_accrual',f.tournament_id,f.bank_journal_id,f.net_rake,f.recognized_at,f.bank_club_id,f.union_id,f.union_wallet_transaction_id,f.tournament_id
  FROM public.accounting_tournament_fee_recognitions f WHERE f.union_id IS NULL AND f.net_rake>0 AND f.tournament_id IN(
   SELECT y.tournament_id FROM public.accounting_tournament_fee_recognitions y
    WHERE y.bank_club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid AND y.recognized_at>='2026-10-19 07:00Z'::timestamptz AND y.recognized_at<'2026-10-26 07:00Z'::timestamptz
   UNION SELECT s.tournament_id FROM public.accounting_payable_earning_sources s WHERE s.source_type='tournament_fee_accrual'
    AND s.club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid AND s.union_id IS NULL AND NULL::uuid IS NULL AND s.coordinator_union_id IS NULL
    AND s.earned_at>='2026-10-19 07:00Z'::timestamptz AND s.earned_at<'2026-10-26 07:00Z'::timestamptz
   UNION SELECT s.tournament_id FROM public.accounting_payable_earning_sources s WHERE s.source_type='tournament_fee_accrual'
    AND s.club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid AND s.union_id IS NULL AND NULL::uuid IS NOT NULL AND s.coordinator_union_id=NULL::uuid
    AND s.earned_at>='2026-10-19 07:00Z'::timestamptz AND s.earned_at<'2026-10-26 07:00Z'::timestamptz)
 ), judged AS (
  SELECT b.*,cg.n+tg.n AS n,COALESCE(cg.total,0)+COALESCE(tg.total,0) AS total,cg.bad+tg.bad AS bad,
   COALESCE(cg.mine,false) OR COALESCE(tg.mine,false) AS mine
  FROM (SELECT * FROM deposits ORDER BY source_type,banked_at,source_group) b
  CROSS JOIN LATERAL (SELECT count(*) AS n,sum(s.rake_credit) AS total,
    count(*) FILTER(WHERE s.club_id IS DISTINCT FROM 'e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid OR s.union_id IS NOT NULL
     OR s.coordinator_union_id IS DISTINCT FROM NULL::uuid OR s.earned_at IS DISTINCT FROM b.banked_at) AS bad,
    bool_or(s.club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid AND s.coordinator_union_id IS NOT DISTINCT FROM NULL::uuid) AS mine
   FROM public.accounting_cash_rake_sources s WHERE b.source_type='cash_rake_accrual' AND s.rake_record_id=b.source_group OFFSET 0) cg
  CROSS JOIN LATERAL (SELECT count(*) AS n,sum(s.rake_credit) AS total,
    count(*) FILTER(WHERE s.club_id IS DISTINCT FROM 'e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid OR s.union_id IS NOT NULL
     OR s.coordinator_union_id IS DISTINCT FROM NULL::uuid OR s.earned_at IS DISTINCT FROM b.banked_at) AS bad,
    bool_or(s.club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid AND s.coordinator_union_id IS NOT DISTINCT FROM NULL::uuid) AS mine
   FROM public.accounting_payable_earning_sources s WHERE b.source_type='tournament_fee_accrual' AND s.source_type='tournament_fee_accrual'
    AND s.tournament_id=b.source_group OFFSET 0) tg
 ), verdict AS MATERIALIZED (
  SELECT j.source_type,j.source_group,j.banked_at,j.ledger_id,j.amount,(j.n>0 AND NOT j.mine) AS skipped,
   (j.n=0 OR j.bad>0 OR j.total IS DISTINCT FROM j.amount OR j.club_id IS DISTINCT FROM 'e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid
    OR j.union_transaction_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=j.ledger_id AND l.status='posted'
    AND l.club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid AND l.amount=j.amount AND l.created_at=j.banked_at
    AND j.banked_at>='2026-10-19 07:00Z'::timestamptz AND j.banked_at<'2026-10-26 07:00Z'::timestamptz
    AND ((j.source_type='cash_rake_accrual' AND l.from_type='table_stack'
       AND l.to_type='chip_retirement' AND l.to_entity_id IS NULL AND l.category='burn')
     OR (j.source_type='tournament_fee_accrual' AND l.from_type='prize_liability' AND l.from_entity_id=j.tournament_id
       AND l.to_type='chip_retirement' AND l.to_entity_id IS NULL AND l.category='burn')))) AS issue
  FROM judged j
  WHERE NOT(j.n>0 AND NOT j.mine)
 )
 SELECT count(*) FILTER(WHERE NOT skipped AND issue),COALESCE(sum(amount) FILTER(WHERE NOT skipped AND NOT issue),0),
  COALESCE(jsonb_agg(ledger_id ORDER BY source_type,banked_at,source_group) FILTER(WHERE NOT skipped AND NOT issue),'[]'::jsonb)
 FROM verdict)SELECT jsonb_build_object('bank_bad',bad,'bank_burned',burned,'ordered_ledger_ids_count',jsonb_array_length(ids),'ordered_ledger_ids_md5',md5(ids::text),'ordered_ledger_ids_json_bytes',octet_length(ids::text)) INTO result FROM original_result x(bad,burned,ids);
 RAISE NOTICE 'actual_C2_whole_private_aggregate %',jsonb_build_object('elapsed_ms',extract(epoch FROM clock_timestamp()-started)*1000,'club_id','e14bc9f7-736d-425f-8f2c-e78305ebac1d','period_start','2026-10-19 07:00Z','period_end','2026-10-26 07:00Z','result',result,'full_original_ordered_JSON_computed',true);
END$candidate$;
ROLLBACK;
