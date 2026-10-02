-- Everything the stages wrote or returned, normalized only for values that are
-- new on every run (generated row ids and wall-clock stamps).
\pset format unaligned
\pset tuples_only on
SELECT 'OUT',ord,step,ok,sqlstate,message,result FROM public.wcs_out ORDER BY ord;
SELECT 'LEDGER',from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,
 metadata-'payout_id'-'wallet_transaction_id',pre_from_balance,post_from_balance,pre_to_balance,post_to_balance,status
 FROM public.chip_ledger WHERE category IN('rakeback','commission') ORDER BY idempotency_key;
SELECT 'WALLET',user_id,wallet_type,type,amount,category,description,balance_after FROM public.wallet_transactions ORDER BY 2,3,4,5,6,7,8;
SELECT 'MEMBER',club_id,user_id,chip_balance FROM public.club_members ORDER BY 2,3;
SELECT 'CLUB',id,chip_treasury FROM public.clubs ORDER BY 2;
SELECT 'ACS',club_id,user_id,union_id,period_start,period_end,amount,rows_count,settlement_ref FROM public.agent_commission_settlements ORDER BY 2,3;
SELECT 'ROLLUP',club_id,user_id,owed,rows_behind,oldest_unsettled FROM public.agent_commission_unsettled_rollup ORDER BY 2,3;
SELECT 'PAYOUT',rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,wallet_transaction_id IS NOT NULL FROM public.rakeback_period_payouts ORDER BY 2;
SELECT 'PERIOD',id,status,paid_at IS NOT NULL FROM public.rakeback_periods ORDER BY 2;
SELECT 'RUN',round_no,union_id,standalone_club_id,source_fingerprint,result FROM public.accounting_routed_settlement_runs ORDER BY 2;
SELECT 'INVOICES',count(*),sum(net_amount) FROM public.settlement_invoices;
