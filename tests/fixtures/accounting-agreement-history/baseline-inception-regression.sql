-- A baseline is in force from inception (migration 20260927221954).
-- On the production preimage the first assertion raises
-- accounting_terms_not_observed: a charge made before the 2026-09-14 baseline
-- has no terms at all. After the migration every assertion holds.
CREATE FUNCTION abi_ok(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label; END$$;
CREATE FUNCTION abi_refusal(statement text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE statement; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END$$;
CREATE FUNCTION abi_hid(p_type text,p_key text,p_event text) RETURNS bigint LANGUAGE sql AS $$
 SELECT id FROM accounting_agreement_history WHERE entity_type=p_type AND entity_key=p_key AND event_type=p_event ORDER BY id LIMIT 1$$;

-- Club u(600) plays in union u(601), whose house club is u(601) itself.
-- Club u(603) is a standalone club. Player u(610) belongs to both.
INSERT INTO clubs VALUES(u(601),true,NULL),(u(600),false,u(601)),(u(603),false,NULL);
INSERT INTO accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms) VALUES
 ('agents',u(613)::text,u(600),u(614),'baseline','2026-09-14 12:09:27.74+00',
   jsonb_build_object('id',u(613),'club_id',u(600),'user_id',u(614),'parent_agent_id',NULL,'role','super_agent','status','active','commission_rate',20)),
 ('agents',u(612)::text,u(600),u(611),'baseline','2026-09-14 12:09:27.75+00',
   jsonb_build_object('id',u(612),'club_id',u(600),'user_id',u(611),'parent_agent_id',u(613),'role','agent','status','active','commission_rate',0.5)),
 ('club_members',u(600)::text||':'||u(610)::text,u(600),u(610),'baseline','2026-09-14 12:09:27.81+00',
   jsonb_build_object('club_id',u(600),'user_id',u(610),'agent_id',u(611),'role','player','status','active','is_active',true)),
 ('club_members',u(603)::text||':'||u(610)::text,u(603),u(610),'baseline','2026-09-14 12:09:27.82+00',
   jsonb_build_object('club_id',u(603),'user_id',u(610),'agent_id',NULL,'role','player','status','active','is_active',true)),
 ('union_clubs',u(620)::text,u(600),NULL,'baseline','2026-09-14 12:09:28.15+00',
   jsonb_build_object('id',u(620),'club_id',u(600),'union_id',u(601),'club_commission_rate',0.9)),
 -- First seen by INSERT after the baseline: it did not exist before its write.
 ('club_members',u(600)::text||':'||u(615)::text,u(600),u(615),'INSERT','2026-09-16 08:35:47+00',
   jsonb_build_object('club_id',u(600),'user_id',u(615),'agent_id',NULL,'role','player','status','active','is_active',true)),
 ('union_clubs',u(621)::text,u(600),NULL,'INSERT','2026-09-16 09:00:00+00',
   jsonb_build_object('id',u(621),'club_id',u(600),'union_id',u(601),'club_commission_rate',0.5)),
 -- A later observed change to a baseline key.
 ('union_clubs',u(620)::text,u(600),NULL,'UPDATE','2026-09-18 00:00:00+00',
   jsonb_build_object('id',u(620),'club_id',u(600),'union_id',u(601),'club_commission_rate',0.8)),
 -- A 'baseline' row that is not its key's first row cannot reach back.
 ('club_members',u(603)::text||':'||u(616)::text,u(603),u(616),'INSERT','2026-09-15 00:00:00+00',
   jsonb_build_object('club_id',u(603),'user_id',u(616),'status','active','is_active',true)),
 ('club_members',u(603)::text||':'||u(616)::text,u(603),u(616),'baseline','2026-09-16 00:00:00+00',
   jsonb_build_object('club_id',u(603),'user_id',u(616),'status','active','is_active',true));

-- 1. The defect: a charge before the baseline now reads the baseline.
SELECT abi_ok((public.fn_accounting_terms_at('club_members',u(600)::text||':'||u(610)::text,'2026-09-10 12:00+00')->>'history_id')::bigint
  = abi_hid('club_members',u(600)::text||':'||u(610)::text,'baseline'),'a membership charged before the baseline reads its baseline');
SELECT abi_ok((public.fn_accounting_terms_at('union_clubs',u(620)::text,'2026-09-05 19:50+00')->'terms'->>'club_commission_rate')='0.9',
  'a union club agreement charged before the baseline reads its baseline rate');
SELECT abi_ok((public.fn_accounting_terms_at('club_members',u(600)::text||':'||u(610)::text,'2026-09-10 12:00+00')->>'observed_at')::timestamptz
  = '2026-09-14 12:09:27.81+00','the receipt states when the baseline was actually observed, never a backdated instant');

-- 2. Nothing else reaches back.
SELECT abi_ok(abi_refusal(format('SELECT public.fn_accounting_terms_at(%L,%L,%L)','club_members',u(600)::text||':'||u(615)::text,'2026-09-10 12:00+00'))
  ='accounting_terms_not_observed','a key first seen by INSERT is unobserved before the baseline');
SELECT abi_ok(abi_refusal(format('SELECT public.fn_accounting_terms_at(%L,%L,%L)','club_members',u(600)::text||':'||u(615)::text,'2026-09-15 00:00+00'))
  ='accounting_terms_not_observed','a key first seen by INSERT is unobserved until its own write');
SELECT abi_ok(abi_refusal(format('SELECT public.fn_accounting_terms_at(%L,%L,%L)','club_members',u(603)::text||':'||u(616)::text,'2026-09-10 12:00+00'))
  ='accounting_terms_not_observed','a baseline row that is not its key''s first observation does not reach back');
SELECT abi_ok(abi_refusal(format('SELECT public.fn_accounting_terms_at(%L,%L,%L)','club_members',u(600)::text||':'||u(699)::text,'2026-09-10 12:00+00'))
  ='accounting_terms_not_observed','a key with no history is unobserved');
SELECT abi_ok(abi_refusal(format('SELECT public.fn_accounting_terms_at(%L,%L,%L)','club_members',u(600)::text||':'||u(610)::text,'infinity'))
  ='invalid_accounting_terms_request','request validation is unchanged');

-- 3. Every instant with an observed row answers exactly as before.
SELECT abi_ok((public.fn_accounting_terms_at('union_clubs',u(620)::text,'2026-09-17 00:00+00')->>'history_id')::bigint
  = abi_hid('union_clubs',u(620)::text,'baseline'),'between the baseline and a change the baseline answers');
SELECT abi_ok((public.fn_accounting_terms_at('union_clubs',u(620)::text,'2026-09-19 00:00+00')->'terms'->>'club_commission_rate')='0.8',
  'after an observed change the change answers');
SELECT abi_ok((public.fn_accounting_terms_at('club_members',u(600)::text||':'||u(615)::text,'2026-09-17 00:00+00')->>'history_id')::bigint
  = abi_hid('club_members',u(600)::text||':'||u(615)::text,'INSERT'),'an INSERT-first key answers from its own write');

-- 4. The single rule.
SELECT abi_ok(public.fn_accounting_history_in_force_from_inception(abi_hid('club_members',u(600)::text||':'||u(610)::text,'baseline')),
  'a first-row baseline is in force from inception');
SELECT abi_ok(NOT public.fn_accounting_history_in_force_from_inception(abi_hid('club_members',u(600)::text||':'||u(615)::text,'INSERT')),
  'an INSERT is never in force before it was observed');
SELECT abi_ok(NOT public.fn_accounting_history_in_force_from_inception(abi_hid('union_clubs',u(620)::text,'UPDATE')),
  'a later change is never in force before it was observed');
SELECT abi_ok(NOT public.fn_accounting_history_in_force_from_inception(abi_hid('club_members',u(603)::text||':'||u(616)::text,'baseline')),
  'a baseline behind an earlier row is not the inception');
SELECT abi_ok(NOT public.fn_accounting_history_in_force_from_inception(NULL),'no row, no answer');
SELECT abi_ok(NOT has_function_privilege('service_role','public.fn_accounting_history_in_force_from_inception(bigint)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.fn_accounting_history_in_force_from_inception(bigint)','EXECUTE'),
  'the rule is private to the definer readers');

-- 5. The agent identity a pre-baseline membership names is found by its baseline.
SELECT abi_ok((public.fn_accounting_agent_terms_at(u(600),u(611),'2026-09-10 12:00+00')->'terms'->>'id')=u(612)::text,
  'a pre-baseline agent identity resolves to its baseline');

-- 6. The whole earning contract for a pre-baseline union charge, as the
--    recorded-evidence capture evaluates it.
DO $$
DECLARE c jsonb;
BEGIN
  c:=public.fn_accounting_earning_contract(u(600),u(610),10.00,u(601),'2026-09-10 12:00+00');
  PERFORM abi_ok(c->>'coordinator_union_id'=u(601)::text AND (c->'union_agreement'->>'history_id')::bigint=abi_hid('union_clubs',u(620)::text,'baseline')
    AND c->'union_agreement'->'terms'->>'club_commission_rate'='0.9','the union agreement in force from inception names the coordinator');
  PERFORM abi_ok((c->'membership'->>'history_id')::bigint=abi_hid('club_members',u(600)::text||':'||u(610)::text,'baseline'),
    'the contract records the baseline membership receipt');
  PERFORM abi_ok(jsonb_array_length(c->'tiers')=2 AND (c->'tiers'->0->>'amount')::numeric=5.00 AND c->'tiers'->0->>'user_id'=u(611)::text
    AND (c->'tiers'->1->>'amount')::numeric=1.00 AND c->'tiers'->1->>'user_id'=u(614)::text AND (c->>'club_residual')::numeric=4.00,
    'agent tiers apply to the remaining rake exactly as installed');
  PERFORM abi_ok((c->>'terms_at')::timestamptz='2026-09-10 12:00+00','terms_at is the charge time');
  c:=public.fn_accounting_earning_contract(u(603),u(610),1.00,NULL,'2026-09-08 13:00+00');
  PERFORM abi_ok(c->>'coordinator_union_id' IS NULL AND jsonb_array_length(c->'tiers')=0 AND (c->>'club_residual')::numeric=1.00,
    'a standalone pre-baseline charge keeps the whole fee in its club');
END $$;
SELECT abi_ok(abi_refusal(format('SELECT public.fn_accounting_earning_contract(%L,%L,10.00,%L,%L)',u(600),u(610),u(601),'2026-09-17 00:00+00'))
  ='cash_commission_earning_club_not_observed','two observed union agreements after the INSERT still refuse, unchanged');
SELECT abi_ok(abi_refusal(format('SELECT public.fn_accounting_earning_contract(%L,%L,10.00,%L,%L)',u(600),u(615),u(601),'2026-09-10 12:00+00'))
  ='accounting_terms_not_observed','a membership that did not exist yet still refuses');

-- 7. The two verifiers accept exactly what the producer now writes.
SELECT abi_ok(position('OR (s.observed_at>s.terms_at AND NOT public.fn_accounting_history_in_force_from_inception(s.history_id)) OR'
  IN pg_get_functiondef('public.fn_accounting_union_earned_plan(uuid,timestamptz,timestamptz)'::regprocedure))>0,
  'the union close accepts an agreement in force from inception');
SELECT abi_ok(position('AND (mh.observed_at<=r.agreement_at OR public.fn_accounting_history_in_force_from_inception(mh.id))'
  IN pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure))>0
  AND position('AND (ah.observed_at<=r.agreement_at OR public.fn_accounting_history_in_force_from_inception(ah.id))'
  IN pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure))>0,
  'the weekly rakeback accepts membership and agent receipts in force from inception');
SELECT abi_ok((SELECT md5(pg_get_functiondef('public.fn_accounting_terms_at(text,text,timestamptz)'::regprocedure)))='e6e3bf7235783485b29c64198ea39566'
  AND (SELECT md5(pg_get_functiondef('public.fn_accounting_agent_terms_at(uuid,uuid,timestamptz)'::regprocedure)))='31601ee35b7c067ecbe30cf7d689255b'
  AND (SELECT md5(pg_get_functiondef('public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamptz)'::regprocedure)))='8473e50ff5435efd8cc909f99c261541'
  AND (SELECT md5(pg_get_functiondef('public.fn_accounting_union_earned_plan(uuid,timestamptz,timestamptz)'::regprocedure)))='6a4d1f7dff10c76902beafa9069e0970'
  AND (SELECT md5(pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure)))='55975e55bd6efb128b3cd7a2de6a687f',
  'the installed postimages are the ones production will carry');
