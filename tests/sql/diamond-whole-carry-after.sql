CREATE FUNCTION fixture_carry_late_failure() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.hand_number=1200005 THEN RAISE EXCEPTION 'fixture_late_carry_failure'; END IF; RETURN NEW; END $$;
BEGIN;
UPDATE tables SET big_blind=20,small_blind=10 WHERE id='30000000-0000-0000-0000-000000000002';
INSERT INTO ca_diamond_economics(name,scope,value_text,units,approved_quote,approved_on,basis,recorded_by)
 VALUES('bbj_enabled','all','yes','boolean','private carry qualification',CURRENT_DATE,'private fixture','fixture');
INSERT INTO clubs(id,asset,is_platform,union_id) VALUES('20000000-0000-0000-0000-000000000009','diamonds',true,NULL);
INSERT INTO poker_diamond_jackpot_pools(id,arena_id) VALUES('29000000-0000-0000-0000-000000000009','20000000-0000-0000-0000-000000000009');
DO $$ DECLARE h bigint;r jsonb;q jsonb;p uuid;baseline jsonb;state jsonb; m bigint;b bigint;pro bigint; refused boolean;
BEGIN
 p:=fn_poker_diamond_jackpot_pool_for_table('30000000-0000-0000-0000-000000000002');
 FOR h IN 1200001..1200013 LOOP
 q:=fixture_carry_request(h);
 IF h=1200005 THEN
 baseline:=fixture_carry_snapshot();
 CREATE TRIGGER fixture_carry_late_failure AFTER INSERT ON hand_history FOR EACH ROW EXECUTE FUNCTION fixture_carry_late_failure();
 refused:=false;
 BEGIN r:=fixture_carry_commit(h,q); refused:=r->>'success'='false' AND r::text LIKE '%fixture_late_carry_failure%';
 EXCEPTION WHEN OTHERS THEN refused:=SQLERRM LIKE '%fixture_late_carry_failure%'; END;
 DROP TRIGGER fixture_carry_late_failure ON hand_history;
 PERFORM fixture_assert(refused AND baseline=fixture_carry_snapshot(),
 'late actual history failure rolls back all financial rows including owed carry consumption');
 END IF;
 r:=fixture_carry_commit(h,q);
 PERFORM fixture_assert(r->>'success'='true','one-unit accepted hand including carry collision commits');
 SELECT fn_poker_diamond_jackpot_bank(p,'main'),fn_poker_diamond_jackpot_bank(p,'backup'),fn_poker_diamond_jackpot_bank(p,'promotional') INTO m,b,pro;
 PERFORM fixture_assert((SELECT m+main_whole_carry+main_residue=(h-1200000)*0.5
 AND b+backup_whole_carry+backup_residue=(h-1200000)*0.25
 AND m+b+pro=h-1200000 AND main_residue>=0 AND main_residue<1
 AND backup_residue>=0 AND backup_residue<1 FROM poker_diamond_jackpot_pools WHERE id=p),
 'each original bank funded plus owed whole plus fraction equals independently accrued share');
 IF h=1200004 THEN
 PERFORM fixture_assert((SELECT main_whole_carry=0 AND backup_whole_carry=1 AND backup_residue=0 FROM poker_diamond_jackpot_pools WHERE id=p),
 'fourth one-unit budget collision retains its owed whole share');
 SELECT jsonb_agg(to_jsonb(l) ORDER BY id) INTO baseline FROM poker_diamond_jackpot_ledger l;
 refused:=false;
 BEGIN PERFORM fn_poker_diamond_jackpot_withdraw(p,'29000000-0000-0000-0000-000000000009');
 EXCEPTION WHEN check_violation THEN refused:=SQLERRM='diamond_jackpot_withdrawal_has_whole_owed_carry'; END;
 SELECT jsonb_agg(to_jsonb(l) ORDER BY id) INTO state FROM poker_diamond_jackpot_ledger l;
 PERFORM fixture_assert(refused AND baseline=state AND (SELECT backup_whole_carry=1 AND status='active' FROM poker_diamond_jackpot_pools WHERE id=p),
 'original withdrawal refuses owed whole before money legs and preserves original custody');
 refused:=false;
 BEGIN UPDATE poker_diamond_jackpot_pools SET status='retired' WHERE id=p;
 EXCEPTION WHEN check_violation THEN refused:=SQLERRM LIKE '%whole_carry_stays_active%'; END;
 PERFORM fixture_assert(refused,'direct retirement cannot strand owed carry');
 END IF;
 IF h=1200005 THEN
 PERFORM fixture_assert((SELECT backup_whole_carry=0 FROM poker_diamond_jackpot_pools WHERE id=p),
 'next original hand consumes owed whole once'); END IF;
 -- Exact same payload replay must not consume carry or create another drop.
 SELECT jsonb_build_object('pool',to_jsonb(j),'legs',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM poker_diamond_jackpot_ledger l),
 'seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s)) INTO baseline FROM poker_diamond_jackpot_pools j WHERE id=p;
 r:=fixture_carry_commit(h,q);
 SELECT jsonb_build_object('pool',to_jsonb(j),'legs',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM poker_diamond_jackpot_ledger l),
 'seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s)) INTO state FROM poker_diamond_jackpot_pools j WHERE id=p;
 PERFORM fixture_assert(r->>'success'='true' AND baseline=state,'accepted hand replay preserves pool carry drop ledger and seats');
 END LOOP;
 r:=fn_poker_diamond_jackpot_withdraw(p,'29000000-0000-0000-0000-000000000009');
 PERFORM fixture_assert(r->>'total'='13' AND (SELECT status='retired_settled' AND main_residue=0.5 AND backup_residue=0.25 FROM poker_diamond_jackpot_pools WHERE id=p),
 'same original zero-owed withdrawal moves existing money and preserves historical fractions');
 PERFORM fixture_assert((SELECT difference=0 FROM fn_ca_diamond_register_vs_supply()),'carried metadata creates no Diamond supply');
END $$;
ROLLBACK;
