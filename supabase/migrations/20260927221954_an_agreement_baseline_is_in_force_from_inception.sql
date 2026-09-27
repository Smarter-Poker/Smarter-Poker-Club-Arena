-- An agreement baseline is in force from inception.
--
-- WHAT WAS WRONG
-- accounting_agreement_history opened with one baseline snapshot of every
-- agents, club_members and union_clubs row at 2026-09-14 12:09:27.737Z to
-- 12:09:28.153Z. fn_accounting_terms_at, the identity search in
-- fn_accounting_agent_terms_at and the union_clubs lookup in
-- fn_accounting_earning_contract only accept a row observed AT OR BEFORE the
-- instant asked about, so every charge made before 12:09:27Z has no terms at
-- all. That is the whole of why 18 tournaments (741.86 chips: 405.60 Midway
-- Union, 336.26 Deep Stack Society, charged 2026-09-05..09-14 04:51Z) sit in
-- accounting_tournament_fee_custody_obligations with
-- tournament_fee_sources_require_reconciliation: the recorded-evidence
-- capture of 199 pre-baseline contributor charges dies in
-- fn_accounting_earning_contract with accounting_terms_not_observed or
-- cash_commission_earning_club_not_observed.
--
-- THE RULE (Dan, 2026-09-27): a baseline is in force from inception. When a
-- key has no row at or before the instant and that key's EARLIEST row is its
-- event_type='baseline' row, that baseline is the answer. A key whose first
-- row is an INSERT/UPDATE/DELETE did not exist before that write and stays
-- unobserved. The rule lives in ONE place,
-- fn_accounting_history_in_force_from_inception(history_id), and every reader
-- and every verifier of agreement receipts uses it:
--   fn_accounting_terms_at ............ falls back to the key's baseline
--   fn_accounting_agent_terms_at ...... finds an agent identity by its baseline
--                                       (a player's agent_id otherwise raises
--                                       accounting_terms_not_observed; 196 of
--                                       the 199 stranded contributors have one)
--   fn_accounting_earning_contract .... union_clubs lookup accepts the baseline
--   fn_accounting_union_earned_plan ... the union close accepts a baseline
--                                       agreement observed after terms_at
--   fn_calculate_cash_rakeback_periods  the weekly rakeback accepts a
--                                       baseline membership/agent receipt
-- The two verifiers are not optional. Without them the producer would write
-- receipts that the Midway union weekly close refuses as
-- union_earning_agreement_unverified and that the rakeback period refuses as
-- period_membership_contract_invalid, for the week the fees are recognized.
--
-- WHAT CANNOT CHANGE (measured read-only on production 2026-09-27)
-- The new branch is reachable only for an instant earlier than a key's first
-- row, and every key's first row is at or after 2026-09-14 12:09:27.737Z.
--   accounting_tournament_fee_sources   130,936 contracts, earliest terms_at 09-14 12:23:38Z
--   accounting_cash_rake_sources      1,691,545 contracts, earliest terms_at 09-17 18:25:06Z
--   accounting_payable_earning_sources 1,820,413 contracts, earliest terms_at 09-14 14:16:11Z
-- so 0 recorded contracts can resolve differently. rake_records created in
-- the 0.42s baseline window: 0. Every evaluation that now resolves raised
-- (or, in fn_cash_rakeback_period_basis, was counted missing_terms) before.
-- Membership is resolved before the agent search, and the last agents
-- baseline (12:09:27.803Z) precedes the first club_members baseline
-- (12:09:27.808Z), so the agent change cannot turn a no-agent result into a
-- tiered one for any evaluation that previously succeeded.
--
-- It pays nobody. No custody is resolved here; see
-- docs/runbooks/2026-09-27-held-tournament-fees-resolution.sql.
--
-- Preimages are the live pg_get_functiondef of each function; each edit is a
-- single exact substring that must occur once; the postimage md5 is asserted
-- before EXECUTE and read back after. Owner, ACL and configuration are kept.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_accounting_terms_at(text,text,timestamp with time zone)'::regprocedure)) = 'e6e3bf7235783485b29c64198ea39566')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_accounting_agent_terms_at(uuid,uuid,timestamp with time zone)'::regprocedure)) = '31601ee35b7c067ecbe30cf7d689255b')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone)'::regprocedure)) = '8473e50ff5435efd8cc909f99c261541')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_accounting_union_earned_plan(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) = '6a4d1f7dff10c76902beafa9069e0970')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure)) = '55975e55bd6efb128b3cd7a2de6a687f')
-- @live-proof: (SELECT to_regprocedure('public.fn_accounting_history_in_force_from_inception(bigint)') IS NOT NULL)
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION public.fn_accounting_history_in_force_from_inception(p_history_id bigint)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $fn$
 -- True only for a baseline row that is the earliest row of its own key.
 SELECT EXISTS(SELECT 1 FROM public.accounting_agreement_history b
  WHERE b.id=p_history_id AND b.event_type='baseline'
   AND NOT EXISTS(SELECT 1 FROM public.accounting_agreement_history e
    WHERE e.entity_type=b.entity_type AND e.entity_key=b.entity_key
     AND (e.observed_at<b.observed_at OR (e.observed_at=b.observed_at AND e.id<b.id))));
$fn$;
REVOKE ALL ON FUNCTION public.fn_accounting_history_in_force_from_inception(bigint) FROM PUBLIC, anon, authenticated, service_role;

DO $patch$
DECLARE
  item record; v_target regprocedure; v_old text; v_new text; v_before record; i int;
BEGIN
  FOR item IN SELECT * FROM (VALUES
  ('public.fn_accounting_terms_at(text,text,timestamp with time zone)','d262f82e6e75fc3e6830f75972e4b823','e6e3bf7235783485b29c64198ea39566',
   ARRAY[$r$ IF NOT FOUND THEN RAISE EXCEPTION 'accounting_terms_not_observed' USING ERRCODE='55000'; END IF;$r$],
   ARRAY[$r$ IF NOT FOUND THEN
  -- 2026-09-27. A key whose first observation is its baseline was already in
  -- force when observation began, and nothing earlier was ever seen to differ,
  -- so that baseline is in force from inception. A key first seen by INSERT or
  -- UPDATE did not exist before that write and stays unobserved.
  SELECT * INTO h FROM public.accounting_agreement_history
   WHERE entity_type=p_entity_type AND entity_key=p_entity_key
   ORDER BY observed_at,id LIMIT 1;
  IF NOT FOUND OR NOT public.fn_accounting_history_in_force_from_inception(h.id) THEN
   RAISE EXCEPTION 'accounting_terms_not_observed' USING ERRCODE='55000';
  END IF;
 END IF;$r$]),
  ('public.fn_accounting_agent_terms_at(uuid,uuid,timestamp with time zone)','eefa92172db730cfc9c739800d3bc12a','31601ee35b7c067ecbe30cf7d689255b',
   ARRAY[$r$AND observed_at<=p_at;$r$],
   ARRAY[$r$AND (observed_at<=p_at OR public.fn_accounting_history_in_force_from_inception(id));$r$]),
  ('public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone)','df9bfbca2abf9f596921ad60363abafe','8473e50ff5435efd8cc909f99c261541',
   ARRAY[$r$AND h.observed_at<=p_terms_at$r$],
   ARRAY[$r$AND (h.observed_at<=p_terms_at OR public.fn_accounting_history_in_force_from_inception(h.id))$r$]),
  ('public.fn_accounting_union_earned_plan(uuid,timestamp with time zone,timestamp with time zone)','c4e909aebc4228ff1d93695ed92f0368','6a4d1f7dff10c76902beafa9069e0970',
   ARRAY[$r$OR s.observed_at>s.terms_at OR$r$],
   ARRAY[$r$OR (s.observed_at>s.terms_at AND NOT public.fn_accounting_history_in_force_from_inception(s.history_id)) OR$r$]),
  ('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])','2fffb5add208db1eb1e6b66c9df15220','55975e55bd6efb128b3cd7a2de6a687f',
   ARRAY[$r$AND mh.observed_at<=r.agreement_at$r$,$r$AND ah.observed_at<=r.agreement_at$r$],
   ARRAY[$r$AND (mh.observed_at<=r.agreement_at OR public.fn_accounting_history_in_force_from_inception(mh.id))$r$,$r$AND (ah.observed_at<=r.agreement_at OR public.fn_accounting_history_in_force_from_inception(ah.id))$r$])
  ) AS t(signature, pre_md5, post_md5, olds, news) LOOP
    v_target := to_regprocedure(item.signature);
    IF v_target IS NULL THEN
      RAISE EXCEPTION 'BASELINE_INCEPTION_TARGET_MISSING: %', item.signature USING ERRCODE='55000';
    END IF;
    SELECT p.proowner, p.proacl, p.proconfig, p.prosecdef, p.provolatile INTO v_before FROM pg_proc p WHERE p.oid = v_target;
    v_old := pg_get_functiondef(v_target);
    IF md5(v_old) <> item.pre_md5 THEN
      RAISE EXCEPTION 'BASELINE_INCEPTION_PREIMAGE_CHANGED: % (%)', item.signature, md5(v_old) USING ERRCODE='55000';
    END IF;
    v_new := v_old;
    FOR i IN 1 .. cardinality(item.olds) LOOP
      IF (length(v_new) - length(replace(v_new, item.olds[i], ''))) / length(item.olds[i]) <> 1 THEN
        RAISE EXCEPTION 'BASELINE_INCEPTION_EDIT_NOT_UNIQUE: % #%', item.signature, i USING ERRCODE='55000';
      END IF;
      v_new := replace(v_new, item.olds[i], item.news[i]);
    END LOOP;
    IF md5(v_new) <> item.post_md5 THEN
      RAISE EXCEPTION 'BASELINE_INCEPTION_RESULT_CHANGED: % (%)', item.signature, md5(v_new) USING ERRCODE='55000';
    END IF;
    EXECUTE v_new;
    IF md5(pg_get_functiondef(v_target)) <> item.post_md5 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid = v_target
        AND p.proowner = v_before.proowner AND p.proacl IS NOT DISTINCT FROM v_before.proacl
        AND p.proconfig IS NOT DISTINCT FROM v_before.proconfig AND p.prosecdef = v_before.prosecdef
        AND p.provolatile = v_before.provolatile) THEN
      RAISE EXCEPTION 'BASELINE_INCEPTION_READBACK_CHANGED: %', item.signature USING ERRCODE='55000';
    END IF;
  END LOOP;
END
$patch$;

-- Self-contained access, identical to what each function already had.
REVOKE ALL ON FUNCTION public.fn_accounting_terms_at(text,text,timestamptz),
  public.fn_accounting_agent_terms_at(uuid,uuid,timestamptz),
  public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamptz),
  public.fn_accounting_union_earned_plan(uuid,timestamptz,timestamptz),
  public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamptz),
  public.fn_accounting_union_earned_plan(uuid,timestamptz,timestamptz),
  public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])
  FROM service_role;
GRANT EXECUTE ON FUNCTION public.fn_accounting_terms_at(text,text,timestamptz),
  public.fn_accounting_agent_terms_at(uuid,uuid,timestamptz) TO service_role;

-- Postimage: the rule is installed, private, and answers as specified.
DO $post$
BEGIN
  IF has_function_privilege('anon','public.fn_accounting_history_in_force_from_inception(bigint)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_accounting_history_in_force_from_inception(bigint)','EXECUTE')
     OR has_function_privilege('service_role','public.fn_accounting_history_in_force_from_inception(bigint)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_accounting_terms_at(text,text,timestamptz)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.fn_accounting_terms_at(text,text,timestamptz)','EXECUTE')
     OR has_function_privilege('service_role','public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamptz)','EXECUTE') THEN
    RAISE EXCEPTION 'BASELINE_INCEPTION_ACCESS_CHANGED' USING ERRCODE='55000';
  END IF;
  IF public.fn_accounting_history_in_force_from_inception(NULL)
     OR public.fn_accounting_history_in_force_from_inception(-1) THEN
    RAISE EXCEPTION 'BASELINE_INCEPTION_RULE_ANSWERS_WITHOUT_A_ROW' USING ERRCODE='55000';
  END IF;
END
$post$;
COMMIT;
