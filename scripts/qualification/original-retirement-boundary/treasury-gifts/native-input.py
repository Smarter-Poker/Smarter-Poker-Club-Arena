"""Actual7 original treasury flow witnesses; retain finite245 source authorities."""
from pathlib import Path
p=Path(__file__).resolve().parent
setup_sql=(p/'setup-financial-fixture.sql').read_text()+(p/'setup-baseline-functions.sql').read_text()+(p/'additional-reader-schema.sql').read_text()+(p/'additional-baseline-readers.sql').read_text()
setup_sql+="CREATE TEMP TABLE treasury_original_finite_counts AS SELECT (SELECT count(*)FROM smarter_private.original_inventory_restoration_cases)cases,(SELECT count(*)FROM smarter_private.original_inventory_restoration_certificates)certificates;DROP TABLE wallet_jackpot_original_money;CREATE TEMP TABLE wallet_jackpot_original_money AS SELECT md5((SELECT jsonb_agg(to_jsonb(l)ORDER BY id)::text FROM chip_ledger l))ledger,md5((SELECT jsonb_agg(to_jsonb(b)ORDER BY id)::text FROM bbj_payouts b))payouts,md5((SELECT jsonb_agg(to_jsonb(b)ORDER BY id)::text FROM bbj_pools b))pools;"
admissions_sql=(p/'supported-seven-admissions.sql').read_text().replace('BEGIN;','',1).replace('COMMIT;','SET LOCAL statement_timeout=0;')
wallet_after_sql=(p.parent/'wallet-jackpot/native-cases.sql').read_text()
wallet_after_sql=wallet_after_sql.replace('jsonb_array_length(a)<>84','jsonb_array_length(a)<>91').replace("f->>'kind'<>'cash_return' OR (f->>'buyins')::numeric<>0","f->>'kind'NOT IN('cash_return','cash_funding')")
wallet_after_sql=wallet_after_sql.replace("FROM jsonb_array_elements(a)f)<>33465.32", "FROM jsonb_array_elements(a)f)<>36126.65")
wallet_after_sql=wallet_after_sql.replace("FROM public.fn_union_pnl_original_flow_evidence('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z')GROUP BY club_id,user_id", "FROM public.fn_union_pnl_original_flow_evidence('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z')WHERE ledger_id IN(SELECT ledger_id FROM union_pnl_original_flows WHERE ledger_snapshot->>'category'='bbj_payout')GROUP BY club_id,user_id")
wallet_after_sql=wallet_after_sql.replace('count(*)=43','count(*)=65')
after_sql="""DO $treasury$
DECLARE f jsonb;before_digest text;after_digest text;
BEGIN
 IF (SELECT count(*)FROM smarter_private.original_inventory_restoration_cases)IS DISTINCT FROM(SELECT cases FROM treasury_original_finite_counts) OR (SELECT count(*)FROM smarter_private.original_inventory_restoration_certificates)IS DISTINCT FROM(SELECT certificates FROM treasury_original_finite_counts) THEN RAISE EXCEPTION 'treasury_changed_finite245_population';END IF;
 SELECT jsonb_agg(to_jsonb(q)ORDER BY ledger_id)INTO f FROM public.fn_union_pnl_original_flow_evidence('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z')q WHERE ledger_id IN(SELECT ledger_id FROM smarter_private.original_treasury_funding_witnesses);
 IF jsonb_array_length(f)<>7 OR EXISTS(SELECT FROM jsonb_array_elements(f)x WHERE x->'valid'IS DISTINCT FROM 'true'::jsonb)
 OR(SELECT sum((x->>'buyins')::numeric)FROM jsonb_array_elements(f)x)IS DISTINCT FROM947::numeric
 OR(SELECT sum((x->>'cashouts')::numeric)FROM jsonb_array_elements(f)x)IS DISTINCT FROM2661.33::numeric THEN RAISE EXCEPTION 'treasury_original7_flow_projection_disagrees';END IF;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'treasury_original65_authority_not_qualified';END IF;
 RAISE NOTICE 'PASS original65 actual authorities finite245unchanged combined84BBJ+7treasury';
END$treasury$;""".replace('FROM947','FROM 947').replace('FROM2661','FROM 2661')
