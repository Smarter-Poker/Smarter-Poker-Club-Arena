SET request.jwt.claims='{"role":"service_role"}';
CREATE TABLE sep8_spin_fixture.original_proofs(tournament_id uuid PRIMARY KEY,proof jsonb NOT NULL);
DO $$ DECLARE c record;p jsonb;snapshot jsonb;err text;BEGIN
 FOR c IN SELECT * FROM sep8_spin_fixture.cases ORDER BY tournament_id LOOP
  p:=public.fn_ca_sep8_spin_original_fee_proof(c.tournament_id);
  PERFORM sep8_spin_fixture.assert(p->>'raw_source_count'='1' AND p->>'recognized_contributors'='3'
   AND (p->>'fee')::numeric=c.fee AND jsonb_array_length(p->'contributors')=3
   AND jsonb_array_length(p->'scope_versions')=(SELECT count(*) FROM sep8_spin_fixture.originals d,jsonb_array_elements(d.document->'events') e,jsonb_array_elements(e->'managed_contracts') v WHERE e->'tournament'->>'id'=c.tournament_id::text AND (v->>'published_at')::timestamptz<=(e->'raw_fees'->0->>'created_at')::timestamptz),
   'Exact original paid funding, reserve and immutable scope '||c.tournament_id);
  INSERT INTO sep8_spin_fixture.original_proofs VALUES(c.tournament_id,p);
  snapshot:=sep8_spin_fixture.snapshot();err:=NULL;
  BEGIN
   PERFORM public.fn_ca_capture_tournament_fee_from_recorded_evidence(r.id)
    FROM public.rake_records r WHERE r.tournament_id=c.tournament_id;
  EXCEPTION WHEN SQLSTATE '55000' OR SQLSTATE '23514' THEN err:=SQLERRM;END;
  PERFORM sep8_spin_fixture.assert(err IN('accounting_terms_not_observed','cash_commission_earning_club_not_observed')
   AND snapshot=sep8_spin_fixture.snapshot(),'Missing original terms refuse with zero writes '||c.tournament_id);
 END LOOP;
END $$;
SELECT sep8_spin_fixture.assert(public.fn_ca_sep8_spin_original_fee_proof('00000000-0000-0000-0000-000000000000') IS NULL,
 'Unknown event never gains original Spin authority');
DO $$ DECLARE c record;err text;before jsonb;BEGIN
 SELECT * INTO c FROM sep8_spin_fixture.cases ORDER BY tournament_id LIMIT 1;
 before:=sep8_spin_fixture.snapshot();
 BEGIN
  SET LOCAL session_replication_role=replica;
  UPDATE public.chip_ledger SET amount=amount+0.01 WHERE tournament_id=c.tournament_id AND category='spin_prize';
  SET LOCAL session_replication_role=origin;
  PERFORM public.fn_ca_sep8_spin_original_fee_proof(c.tournament_id);
 EXCEPTION WHEN SQLSTATE 'P0404' THEN err:=SQLERRM;END;
 PERFORM sep8_spin_fixture.assert(err='named Spin original prize draw credit disagrees'
 AND before=sep8_spin_fixture.snapshot(),'Changed reserve cash leg refused and atomic rollback');
 err:=NULL;
 BEGIN
  SET LOCAL session_replication_role=replica;
  UPDATE public.managed_game_contract_versions SET published_at='2026-09-18' WHERE game_id=c.tournament_id AND version=1;
  SET LOCAL session_replication_role=origin;
  PERFORM public.fn_ca_sep8_spin_original_fee_proof(c.tournament_id);
 EXCEPTION WHEN SQLSTATE 'P0404' THEN err:=SQLERRM;END;
 PERFORM sep8_spin_fixture.assert(err='named Spin original created scope missing'
 AND before=sep8_spin_fixture.snapshot(),'Late original scope refused and atomic rollback');
 err:=NULL;
 BEGIN
  SET LOCAL session_replication_role=replica;
  UPDATE public.tournament_refund_entitlements SET gross=gross+0.01,refund_prize=refund_prize+0.01 WHERE tournament_id=c.tournament_id;
  SET LOCAL session_replication_role=origin;
  PERFORM public.fn_ca_sep8_spin_original_fee_proof(c.tournament_id);
 EXCEPTION WHEN SQLSTATE 'P0404' THEN err:=SQLERRM;END;
 PERFORM sep8_spin_fixture.assert(err='named Spin original paid entry ambiguous'
 AND before=sep8_spin_fixture.snapshot(),'Changed original charge refused and atomic rollback');
END $$;
SELECT sep8_spin_fixture.assert(NOT has_function_privilege('service_role','public.fn_ca_sep8_spin_original_fee_proof(uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.fn_ca_sep8_spin_original_fee_proof(uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','public.fn_ca_sep8_spin_original_fee_proof(uuid)','EXECUTE'),
 'Original proof private to owning database functions');
SELECT jsonb_agg(to_jsonb(p) ORDER BY tournament_id) FROM sep8_spin_fixture.original_proofs p;
