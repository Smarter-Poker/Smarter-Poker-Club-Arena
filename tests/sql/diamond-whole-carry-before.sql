CREATE FUNCTION fixture_carry_snapshot() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('profiles',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM profiles t),
 'accrual',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM ca_diamond_rake_accrual t),
 'custody',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM poker_diamond_custody t),
 'lots',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM diamond_purchase_lots t),
 'seats',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM table_seats t),
 'journal',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM diamond_transactions t),
 'credit_keys',(SELECT jsonb_agg(to_jsonb(t) ORDER BY key) FROM wallet_credit_idempotency t),
 'reservations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY custody_id,lot_id) FROM poker_diamond_lot_reservations t),
 'pools',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM poker_diamond_jackpot_pools t),
 'movements',(SELECT jsonb_agg(to_jsonb(t) ORDER BY request_id) FROM poker_diamond_movements t),
 'register',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM ca_mint_ledger t),
 'receipts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY hand_number) FROM poker_diamond_hand_receipts t),
 'commits',(SELECT jsonb_agg(to_jsonb(t) ORDER BY hand_number) FROM hand_atomic_commits t),
 'history',(SELECT jsonb_agg(to_jsonb(t) ORDER BY hand_number) FROM hand_history t),
 'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM poker_diamond_jackpot_ledger t),
 'hits',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM poker_diamond_jackpot_hits t),
 'notifications',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM notifications t));
$$;
CREATE FUNCTION fixture_carry_request(h bigint) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE q jsonb:=fixture_jackpot_request(h,1); BEGIN
 q:=jsonb_set(q,'{row,big_blind}','20');
 q:=jsonb_set(q,'{row,_accepted_post_commit_facts,diamond_jackpot,big_blind}','20');
 RETURN q; END $$;
CREATE FUNCTION fixture_carry_commit(h bigint,q jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT fn_ca_commit_hand_settlement('30000000-0000-0000-0000-000000000002',h,
 q->'stacks',0,1,NULL,0,q->'row','[]'::jsonb,'fixture-jackpot',
 '90000000-0000-0000-0000-000000000001',q->'obligations'); $$;
BEGIN;
UPDATE tables SET big_blind=20,small_blind=10 WHERE id='30000000-0000-0000-0000-000000000002';
INSERT INTO ca_diamond_economics(name,scope,value_text,units,approved_quote,approved_on,basis,recorded_by)
 VALUES('bbj_enabled','all','yes','boolean','private carry qualification',CURRENT_DATE,'private fixture','fixture');
DO $$ DECLARE h bigint;r jsonb; BEGIN
 FOR h IN 1200001..1200003 LOOP
 r:=fixture_carry_commit(h,fixture_carry_request(h));
 PERFORM fixture_assert(r->>'success'='true','prior one-unit drop accepted through real hand writer');
 END LOOP;
 r:=fixture_carry_commit(1200004,fixture_carry_request(1200004));
 PERFORM fixture_assert(r->>'success'='false' AND r::text LIKE '%backup_residue_check%',
 'fourth actual one-unit accepted hand fails before carry correction');
 PERFORM fixture_assert(NOT EXISTS(SELECT 1 FROM hand_atomic_commits WHERE hand_number=1200004),
 'failed fourth hand has no durable atomic commit');
 PERFORM fixture_assert((SELECT main_residue=0.5 AND backup_residue=0.75 FROM poker_diamond_jackpot_pools WHERE status='active'),
 'failed fourth hand preserves prior fractions');
END $$;
ROLLBACK;
