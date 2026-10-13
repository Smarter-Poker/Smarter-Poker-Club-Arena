-- An isolated declared opening pool asset selects the real 100000 pivot.
-- This checks the original allocator kernel, not an accepted-hand settlement.
BEGIN;
INSERT INTO poker_diamond_jackpot_ledger(pool_id,bank,kind,amount,ref,note)
 SELECT id,'main','reseed_in',100000,'fixture:pivot:opening','declared isolated opening pool asset'
 FROM poker_diamond_jackpot_pools WHERE status='active';
INSERT INTO ca_mint_ledger(op_id,action,asset,holder_type,holder_id,amount,reason)
 VALUES('fixture:pivot:opening','mint','diamonds','player','11000000-0000-0000-0000-000000000001',100000,'declared isolated opening pool asset');
DO $$ DECLARE p uuid; r record; f record; m numeric:=0;b numeric:=0;funded_m bigint:=0;funded_b bigint:=0;a bigint;before jsonb;refused boolean;
BEGIN
 SELECT id INTO p FROM poker_diamond_jackpot_pools WHERE status='active';
 PERFORM fixture_assert((SELECT difference=0 FROM fn_ca_diamond_register_vs_supply()),'declared pivot opening asset has matching isolated supply baseline');
 FOREACH a IN ARRAY ARRAY[1,1,1,1,1,2,3,10000000]::bigint[] LOOP
 SELECT * INTO r FROM fn_poker_diamond_jackpot_allocate(p,a);
 funded_m:=funded_m+r.o_main;funded_b:=funded_b+r.o_backup;m:=m+a*0.25;b:=b+a*0.25;
 SELECT * INTO f FROM poker_diamond_jackpot_pools WHERE id=p;
 PERFORM fixture_assert(r.o_main+r.o_backup+r.o_promotional=a AND r.o_main>=0 AND r.o_backup>=0 AND r.o_promotional>=0
 AND funded_m+f.main_whole_carry+f.main_residue=m AND funded_b+f.backup_whole_carry+f.backup_residue=b,
 'real 100000 pivot reader and allocator preserve whole and fraction at small and large units');
 END LOOP;
 before:=to_jsonb(f);refused:=false;
 BEGIN PERFORM fn_poker_diamond_jackpot_allocate(p,0); EXCEPTION WHEN check_violation THEN refused:=true;END;
 PERFORM fixture_assert(refused AND (SELECT to_jsonb(j)=before FROM poker_diamond_jackpot_pools j WHERE id=p),'zero amount refuses without changing carry');
 refused:=false;
 BEGIN PERFORM fn_poker_diamond_jackpot_allocate(p,NULL); EXCEPTION WHEN check_violation THEN refused:=true;END;
 PERFORM fixture_assert(refused AND (SELECT to_jsonb(j)=before FROM poker_diamond_jackpot_pools j WHERE id=p),'NULL amount refuses without changing carry');
 INSERT INTO ca_diamond_economics(name,scope,value_text,units,approved_quote,approved_on,basis,recorded_by)
 VALUES('bbj_pool_split','all','main=90,backup=90,promotional=0;pivot_at=100000,main=90,backup=90,promotional=0','shares','private invalid config',CURRENT_DATE,'isolated refusal','fixture');
 refused:=false;
 BEGIN PERFORM fn_poker_diamond_jackpot_allocate(p,1);EXCEPTION WHEN check_violation THEN refused:=true;END;
 PERFORM fixture_assert(refused AND (SELECT to_jsonb(j)=before FROM poker_diamond_jackpot_pools j WHERE id=p),'invalid shares refuse with exact carry preserved');
END $$;
ROLLBACK;
