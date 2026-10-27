-- Before/after installation on existing settled statements. Private fixture only.
\set ON_ERROR_STOP on
DO $$ BEGIN
 IF current_database()<>'diamond_custody_legacy' THEN RAISE EXCEPTION 'legacy private fixture required'; END IF;
END $$;
CREATE TEMP TABLE statement_financial_before AS SELECT
 (SELECT jsonb_agg(to_jsonb(d) ORDER BY owner_id,day) FROM public.diamond_spin_days d) AS days,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.diamond_transactions t) AS wallets,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.ca_mint_ledger t) AS burns,
 (SELECT jsonb_agg(to_jsonb(n)-'message'-'data'-'updated_at' ORDER BY id) FROM public.notifications n) AS notices,
 (SELECT jsonb_object_agg(id,data) FROM public.notifications) AS data;
\i :candidate
DO $probe$
DECLARE old record;v_notice record;
BEGIN
 SELECT * INTO old FROM statement_financial_before;
 IF old.days IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(d) ORDER BY owner_id,day) FROM public.diamond_spin_days d)
  OR old.wallets IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.diamond_transactions t)
  OR old.burns IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.ca_mint_ledger t)
  OR old.notices IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(n)-'message'-'data'-'updated_at' ORDER BY id) FROM public.notifications n) THEN
  RAISE EXCEPTION 'display correction changed financial receipts, read state or notice identity'; END IF;
 FOR v_notice IN SELECT * FROM public.notifications WHERE type='diamond_spin_settlement' LOOP
  IF v_notice.message LIKE '%Entries:%' OR v_notice.message NOT LIKE '%Diamonds Collected:%'
   OR v_notice.message NOT LIKE '%Chip Payouts: 0.00 Chips (Paid Separately).%'
   OR v_notice.data->>'statement_version'<>'2'
   OR (v_notice.data-ARRAY['statement_version','diamonds_collected','chip_payouts','diamond_prizes','inventory_cost_diamonds']) IS DISTINCT FROM old.data->v_notice.id::text THEN
   RAISE EXCEPTION 'historical statement not corrected or original metadata lost: %',to_jsonb(v_notice); END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.notifications WHERE message LIKE '%Platform Burn (0%): 0 Diamonds. Your Net Credit: 100 Diamonds.') THEN
  RAISE EXCEPTION 'legacy pre-burn contract rewritten'; END IF;
 RAISE NOTICE 'PASS Diamond statement history: original notification corrected, read state and metadata retained, settled receipts wallets and burns byte-identical, legacy burn unchanged';
END $probe$;
