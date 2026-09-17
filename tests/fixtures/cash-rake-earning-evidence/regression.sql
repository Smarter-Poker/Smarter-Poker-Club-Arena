INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms) VALUES
 ('agents',u(901)::text,u(10),u(511),'INSERT','2026-01-01Z',jsonb_build_object('id',u(901),'club_id',u(10),'user_id',u(511),'status','active','commission_rate',0.6)),
 ('club_members',u(10)::text||':'||u(501)::text,u(10),u(501),'INSERT','2026-01-01Z',jsonb_build_object('club_id',u(10),'user_id',u(501),'agent_id',u(511),'is_active',true,'status','approved','player_rakeback_pct',0.2)),
 ('club_members',u(20)::text||':'||u(502)::text,u(20),u(502),'INSERT','2026-01-01Z',jsonb_build_object('club_id',u(20),'user_id',u(502),'agent_id',NULL,'is_active',true,'status','active','player_rakeback_pct',0.1));
SELECT assert_true(fn_accounting_terms_at('agents',u(901)::text,'2026-02-01Z')->'terms'->>'commission_rate'='0.6','exact observed agreement is returned');
SELECT assert_true(refuses(format('SELECT fn_accounting_terms_at(''agents'',%L,''2025-12-31Z'')',u(901)::text),'55000'),'baseline does not become historical terms');
SELECT assert_true(refuses(format('SELECT fn_accounting_terms_at(''invented'',%L,now())',u(901)::text),'22023'),'unknown agreement type refused');
SELECT assert_true(refuses(format('SELECT fn_accounting_terms_at(''agents'',%L,''infinity'')',u(901)::text),'22023'),'infinite earning time refused');
SELECT assert_true(fn_accounting_agent_terms_at(u(10),u(511),'2026-02-01Z')->'terms'->>'id'=u(901)::text,'agent resolved by historical user and exact club');
SELECT assert_true(refuses(format('SELECT fn_accounting_agent_terms_at(%L,%L,''2026-02-01Z'')',u(20),u(511)),'55000'),'other club cannot borrow an agent contract');

INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms) VALUES
 ('agents',u(902)::text,u(10),u(521),'INSERT','2026-01-01Z',jsonb_build_object('id',u(902),'club_id',u(10),'user_id',u(521),'status','active')),
 ('agents',u(902)::text,u(20),u(521),'UPDATE','2026-02-01Z',jsonb_build_object('id',u(902),'club_id',u(20),'user_id',u(521),'status','active'));
SELECT assert_true(refuses(format('SELECT fn_accounting_agent_terms_at(%L,%L,''2026-03-01Z'')',u(10),u(521)),'55000'),'moved agent does not resurrect old club identity');
SELECT assert_true(fn_accounting_agent_terms_at(u(10),u(521),'2026-01-15Z')->'terms'->>'club_id'=u(10)::text,'move does not alter previous earning contract');
SELECT assert_true(fn_accounting_agent_terms_at(u(20),u(521),'2026-03-01Z')->'terms'->>'club_id'=u(20)::text,'move establishes observed new club identity');
INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms) VALUES
 ('agents',u(903)::text,u(20),u(521),'INSERT','2026-02-01Z',jsonb_build_object('id',u(903),'club_id',u(20),'user_id',u(521),'status','active'));
SELECT assert_true(refuses(format('SELECT fn_accounting_agent_terms_at(%L,%L,''2026-03-01Z'')',u(20),u(521)),'55000'),'two active historical identities are ambiguous');

INSERT INTO public.clubs VALUES(u(10),u(40),false),(u(20),u(40),false),(u(30),u(40),true);
INSERT INTO public.rake_records VALUES
 (u(201),u(301),u(30),u(401),10.05,false,NULL,'2026-09-14T06:59:59.999999Z','{}'),
 (u(202),u(302),u(30),u(401),1.01,false,NULL,'2026-09-14T07:00:00Z','{}');
INSERT INTO public.rake_attributions VALUES
 (u(701),u(201),u(301),u(501),u(10),6.01),
 (u(702),u(201),u(301),u(502),u(20),4.04),
 (u(703),u(202),u(302),u(501),u(10),1.01);
CREATE TEMP TABLE evidence AS SELECT fn_cash_rakeback_period_basis(u(10),'2026-09-07','2026-09-13') value;
SELECT assert_true((SELECT value->>'total_rake'='6.0100000000000000' OR (value->>'total_rake')::numeric=6.01 FROM evidence),'earning club receives only its actual contributors');
SELECT assert_true((SELECT value->>'status'='ready' AND value->>'payable'='false' AND value->>'written'='0' FROM evidence),'read-only ready evidence never means payable or written');
SELECT assert_true((SELECT (value->>'from')::timestamptz='2026-09-07T07:00:00Z' AND (value->>'to')::timestamptz='2026-09-14T07:00:00Z' FROM evidence),'Pacific interval is exact and half-open');
SELECT assert_true((SELECT jsonb_array_length(value->'rows'->0->'contract_versions')=2 FROM evidence),'member and assigned agent historical contract identities retained');
SELECT assert_true((fn_cash_rakeback_period_basis(u(20),'2026-09-07','2026-09-13')->>'total_rake')::numeric=4.04,'same source may accrue another club without scope collision');
SELECT assert_true((fn_cash_rakeback_period_basis(u(10),'2026-09-14','2026-09-20')->>'total_rake')::numeric=1.01,'exact boundary belongs to the next Pacific week');
SELECT assert_true((fn_cash_rakeback_period_basis(u(10),'2026-03-02','2026-03-08')->>'to')::timestamptz-(fn_cash_rakeback_period_basis(u(10),'2026-03-02','2026-03-08')->>'from')::timestamptz=interval '167 hours','spring accounting interval is 167 hours');
SELECT assert_true((fn_cash_rakeback_period_basis(u(10),'2026-10-26','2026-11-01')->>'to')::timestamptz-(fn_cash_rakeback_period_basis(u(10),'2026-10-26','2026-11-01')->>'from')::timestamptz=interval '169 hours','autumn accounting interval is 169 hours');
SELECT assert_true(refuses(format('SELECT fn_cash_rakeback_period_basis(%L,''2026-09-08'',''2026-09-14'')',u(10)),'22023'),'noncanonical week is rejected');

INSERT INTO public.rake_records VALUES(u(203),u(303),u(30),u(401),1,false,NULL,'2026-09-10Z','{}');
SELECT assert_true((fn_cash_rakeback_period_basis(u(10),'2026-09-07','2026-09-13')->>'missing_source_count')::int=1,'unattributed house source blocks member-club completeness');
INSERT INTO public.rake_attributions VALUES(u(704),u(203),u(303),u(503),u(10),1);
SELECT assert_true((fn_cash_rakeback_period_basis(u(10),'2026-09-07','2026-09-13')->>'missing_terms_count')::int=1,'historical membership gaps are counted without current membership fallback');
INSERT INTO public.rakeback_periods VALUES(u(801),u(501),u(10),'2026-09-07','2026-09-13','pending',6.01,1.2);
SELECT assert_true((fn_cash_rakeback_period_basis(u(10),'2026-09-07','2026-09-13')->>'legacy_pending_conflicts')::int=1,'matching legacy pending values still require provenance reconciliation');
INSERT INTO public.rakeback_periods VALUES(u(802),u(502),u(20),'2026-09-07','2026-09-13','paid',4.04,0.4);
SELECT assert_true((fn_cash_rakeback_period_basis(u(20),'2026-09-07','2026-09-13')->>'paid_period_conflicts')::int=1,'paid periods remain protected conflicts');
SELECT assert_true((SELECT count(*)=2 AND sum(rakeback_amount)=1.6 FROM public.rakeback_periods),'all previews leave periods unchanged');
SELECT assert_true(NOT has_function_privilege('anon','fn_cash_rakeback_period_basis(uuid,date,date,uuid[])','EXECUTE') AND NOT has_function_privilege('authenticated','fn_accounting_terms_at(text,text,timestamptz)','EXECUTE'),'public and authenticated cannot read private accounting terms');

INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,before_terms,after_terms)
 VALUES('agents',u(902)::text,u(20),u(521),'DELETE','2026-04-01Z','{}',NULL);
SELECT assert_true(fn_accounting_terms_at('agents',u(902)::text,'2026-05-01Z')->'terms'='null'::jsonb,'deletion is preserved as observed absence rather than resurrected terms');
SELECT assert_true((fn_accounting_agent_terms_at(u(20),u(521),'2026-05-01Z')->'terms'->>'id')=u(903)::text,'deleted duplicate identity no longer creates ambiguity');
INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms) VALUES
 ('agents',u(904)::text,u(20),u(531),'INSERT','2026-02-01T00:00:00.000001Z',jsonb_build_object('id',u(904),'club_id',u(20),'user_id',u(531),'status','active')),
 ('agents',u(904)::text,u(20),u(531),'UPDATE','2026-02-01T00:00:00.000002Z',jsonb_build_object('id',u(904),'club_id',u(20),'user_id',u(531),'status','suspended'));
SELECT assert_true(fn_accounting_agent_terms_at(u(20),u(531),'2026-02-01T00:00:00.000001Z')->'terms'->>'status'='active','observed agreement boundary retains microseconds');
SELECT assert_true(refuses(format('SELECT fn_accounting_agent_terms_at(%L,%L,''2026-02-01T00:00:00.000002Z'')',u(20),u(531)),'55000'),'suspension becomes effective at its exact observed boundary');
UPDATE public.rake_attributions SET weighted_rake_credit=6.011 WHERE id=u(701);
SELECT assert_true((fn_cash_rakeback_period_basis(u(10),'2026-09-07','2026-09-13')->>'missing_source_count')::int=1,'fractional source credits cannot masquerade as whole cents');
UPDATE public.rake_attributions SET weighted_rake_credit=6.01,hand_id=u(999) WHERE id=u(701);
SELECT assert_true((fn_cash_rakeback_period_basis(u(10),'2026-09-07','2026-09-13')->>'missing_source_count')::int=1,'matching source amount with another hand is rejected');
UPDATE public.rake_attributions SET hand_id=u(301),club_id=u(30) WHERE id=u(701);
SELECT assert_true((fn_cash_rakeback_period_basis(u(10),'2026-09-07','2026-09-13')->>'missing_source_count')::int=1,'house attribution is unresolved earning-club evidence');
UPDATE public.rake_attributions SET club_id=u(10) WHERE id=u(701);
SELECT assert_true(jsonb_array_length(fn_cash_rakeback_period_basis(u(10),'2026-09-07','2026-09-13',ARRAY[u(501)])->'rows')=1,'user filter scopes preview without widening the recipient list');
SELECT assert_true((SELECT count(*)=2 AND sum(rakeback_amount)=1.6 FROM public.rakeback_periods),'hostile source previews still cannot write liabilities');
SELECT set_config('test.engine','false',false);
SELECT assert_true(refuses(format('SELECT fn_accounting_agent_terms_at(%L,%L,now())',u(10),u(511)),'42501'),'internal caller check rejects untrusted invocation');
SELECT assert_true(refuses(format('SELECT fn_cash_rakeback_period_basis(%L,''2026-09-07'',''2026-09-13'')',u(10)),'42501'),'basis reader enforces internal authority');
