BEGIN;
DO $$ BEGIN PERFORM id FROM public.rakeback_periods WHERE id=dr_u('period1') FOR UPDATE; END $$;
INSERT INTO public.accounting_rakeback_period_calculations(period_id,source_fingerprint,club_id,player_id,coordinator_union_id,period_start,period_end,rake_generated,rakeback_amount,display_rate,payer_kind,payer_user_id,source_allocations)
 SELECT period_id,md5(source_fingerprint||'published-next'),club_id,player_id,coordinator_union_id,period_start,period_end,rake_generated,rakeback_amount,display_rate,payer_kind,payer_user_id,source_allocations FROM public.accounting_rakeback_period_calculations WHERE period_id=dr_u('period1') ORDER BY id DESC LIMIT 1;
SELECT 'PUBLISHER_OWNS_EXISTING_PERIOD';
