-- @live-proof: (md5(pg_get_functiondef('fn_accounting_cash_commission_source_guard()'::regprocedure))='f6bb6de73cb43d54a42dbc31caab4a3b' AND md5(pg_get_functiondef('fn_accounting_union_earned_plan_sets(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='01abfa84da1dbe701503ad1da7585d0b' AND md5(pg_get_functiondef('fn_accounting_union_earned_plan_window(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='912dd5c0dd309f446de6fecd87b60cc0' AND md5(pg_get_functiondef('fn_accrue_cash_hand_commissions(uuid)'::regprocedure))='020617e6132d5df34b79b403b34f2062' AND md5(pg_get_functiondef('fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='fabde84baa4d2bee303531de45c65c06' AND md5(pg_get_functiondef('fn_rakeback_recompute_split(uuid,date,date)'::regprocedure))='cb4c66d535d0b0584ec2dad3d6f26c13' AND md5(pg_get_functiondef('smarter_private.admit_cash_atomic_contracts(uuid,jsonb)'::regprocedure))='a284c613275609a927efd8b7543fab87' AND to_regclass('public.accounting_cash_atomic_contract_admissions') IS NOT NULL AND position('accounting_effective_cash_rake_sources' IN pg_get_viewdef('public.accounting_payable_earning_sources'::regclass,true))>0 AND NOT has_function_privilege('authenticated','smarter_private.admit_cash_atomic_contracts(uuid,jsonb)','EXECUTE'))
-- 20261019211745_unpaid_cash_contracts_resume_from_atomic_earning_history.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout='3s';
DO $preimage$
BEGIN
 IF md5(pg_get_functiondef('public.fn_accounting_terms_at(text,text,timestamptz)'::regprocedure))<>'3752cf9b57688dab0bf32acd2b43e3a3'
 OR md5(pg_get_functiondef('public.fn_accounting_agent_terms_at(uuid,uuid,timestamptz)'::regprocedure))<>'727b249d33b322b1fc85b4c3437e37de'
 THEN RAISE EXCEPTION 'atomic_cash_admission_terms_not_installed'; END IF;
END $preimage$;

-- Original accrual receipts remain immutable. An explicit restart of the
-- original hand accrual may admit a proven atomic-history contract ONLY while
-- its entire week is unpaid. This receipt preserves both contracts and every
-- original pending commission. The existing commission writer and settlement
-- route remain authoritative; no wallet or compensating payment is introduced.
CREATE TABLE public.accounting_cash_atomic_contract_admissions(
 source_id uuid PRIMARY KEY,
 original_contract jsonb NOT NULL,
 admitted_contract jsonb NOT NULL,
 original_commissions jsonb NOT NULL,
 invalid_history_ids bigint[] NOT NULL,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(cardinality(invalid_history_ids)>0),
 CHECK(jsonb_typeof(original_commissions)='array')
);
ALTER TABLE public.accounting_cash_atomic_contract_admissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_cash_atomic_contract_admissions FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER accounting_cash_atomic_admission_immutable
 BEFORE UPDATE OR DELETE ON public.accounting_cash_atomic_contract_admissions
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_atomic_admission_no_truncate
 BEFORE TRUNCATE ON public.accounting_cash_atomic_contract_admissions
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();

CREATE VIEW public.accounting_effective_cash_rake_sources AS
 SELECT s.id,s.rake_record_id,s.player_id,s.club_id,s.union_id,s.coordinator_union_id,
 s.earned_at,s.rake_credit,COALESCE(a.admitted_contract,s.contract) AS contract,
 greatest(s.recorded_at,a.admitted_at) AS recorded_at
 FROM public.accounting_cash_rake_sources s
 LEFT JOIN public.accounting_cash_atomic_contract_admissions a ON a.source_id=s.id;
REVOKE ALL ON public.accounting_effective_cash_rake_sources FROM PUBLIC,anon,authenticated,service_role;

INSERT INTO public.ca_ledger_maintenance_kinds(kind,note,severity)
 VALUES('atomic-earning-admission','Explicit original-hand accrual restart before any weekly payment. Both earning contracts and all replaced unpaid commission rows remain in the immutable admission and journal mutation records. No wallet movement.','info');

CREATE FUNCTION smarter_private.admit_cash_atomic_contracts(p_record uuid,p_expected jsonb)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET TimeZone='UTC' AS $admit$
DECLARE s record; canonical jsonb; plan jsonb; expectation jsonb; old_rows jsonb;
 bad_ids bigint[]; original_tier_count int; posted int; n int:=0; old_setting text;
 w_from timestamptz;w_to timestamptz;lock_key text;
BEGIN
 IF NOT public.fn_caller_is_engine() OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'atomic_cash_admission_not_authorised' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_cash_hand:'||(SELECT hand_id::text FROM public.rake_records WHERE id=p_record),0));
 -- Reuse the original source owner's funding/attribution/earning proof.
 plan:=public.fn_accounting_cash_commission_plan(p_record);
 w_from:=public.fn_union_week_start((plan->>'earned_at')::timestamptz);
 w_to:=public.fn_union_week_start(w_from+interval '8 days');
 FOR lock_key IN SELECT DISTINCT CASE WHEN p->>'coordinator_union_id' IS NOT NULL THEN 'union-accounting:' ELSE 'club-accounting:' END
  ||COALESCE(p->>'coordinator_union_id',p->>'club_id')||':'||extract(epoch FROM w_from)::text||':'||extract(epoch FROM w_to)::text
  FROM jsonb_array_elements(plan->'players')p ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(lock_key,0));
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_expected)k WHERE NOT EXISTS(
  SELECT 1 FROM public.accounting_cash_rake_sources x WHERE x.rake_record_id=p_record AND x.id::text=k))
 THEN RAISE EXCEPTION 'atomic_cash_admission_foreign_source' USING ERRCODE='23514'; END IF;
 FOR s IN SELECT x.*,x.xmin::text original_xid FROM public.accounting_cash_rake_sources x
  WHERE x.rake_record_id=p_record AND p_expected ? x.id::text ORDER BY x.id LOOP
  expectation:=p_expected->s.id::text;
  IF md5(s.contract::text) IS DISTINCT FROM expectation->>'original_md5'
  THEN RAISE EXCEPTION 'atomic_cash_admission_original_changed' USING ERRCODE='23514'; END IF;
  SELECT a.admitted_contract INTO canonical FROM public.accounting_cash_atomic_contract_admissions a WHERE a.source_id=s.id;
  IF FOUND THEN
   IF md5(canonical::text) IS DISTINCT FROM expectation->>'admitted_md5' THEN RAISE EXCEPTION 'atomic_cash_admission_replay_conflict' USING ERRCODE='23514'; END IF;
   CONTINUE;
  END IF;
  IF EXISTS(SELECT 1 FROM public.agent_commission_settlements a WHERE a.club_id=s.club_id AND a.period_start<=s.earned_at AND a.period_end>s.earned_at)
   OR EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.period_start<=s.earned_at AND r.period_end>s.earned_at
    AND ((r.union_id IS NOT NULL AND r.union_id=s.coordinator_union_id) OR(r.standalone_club_id=s.club_id AND s.coordinator_union_id IS NULL)))
   OR EXISTS(SELECT 1 FROM public.rakeback_periods r WHERE r.club_id=s.club_id AND r.user_id=s.player_id
    AND r.period_start=(w_from AT TIME ZONE 'America/Los_Angeles')::date AND r.status<>'pending')
  THEN RAISE EXCEPTION 'atomic_cash_admission_week_already_paid' USING ERRCODE='23514'; END IF;
  SELECT array_agg(DISTINCT h.id ORDER BY h.id) INTO bad_ids
  FROM (SELECT(s.contract#>>'{membership,history_id}')::bigint id
   UNION ALL SELECT(t#>>'{agreement,history_id}')::bigint FROM jsonb_array_elements(s.contract->'tiers')t
   UNION ALL SELECT(s.contract#>>'{union_agreement,history_id}')::bigint)refs
  JOIN public.accounting_agreement_history h ON h.id=refs.id
  WHERE h.transaction_id::text<>s.original_xid AND EXISTS(
   SELECT 1 FROM public.accounting_agreement_history later WHERE later.transaction_id=h.transaction_id AND later.observed_at>s.earned_at);
  IF bad_ids IS NULL THEN RAISE EXCEPTION 'atomic_cash_admission_no_unfinished_external_history' USING ERRCODE='23514'; END IF;
  SELECT p INTO STRICT canonical FROM jsonb_array_elements(plan->'players')p
   WHERE p->>'player_id'=s.player_id::text AND p->>'club_id'=s.club_id::text;
  IF md5(canonical::text) IS DISTINCT FROM expectation->>'admitted_md5'
   OR canonical=s.contract OR canonical->>'attribution_id' IS DISTINCT FROM s.contract->>'attribution_id'
   OR canonical->>'coordinator_union_id' IS DISTINCT FROM s.coordinator_union_id::text
   OR canonical->>'union_id' IS DISTINCT FROM s.union_id::text
   OR (canonical->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit
  THEN RAISE EXCEPTION 'atomic_cash_admission_canonical_changed' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.agent_commissions a WHERE a.source_type='cash_rake_accrual' AND a.source_id=s.id FOR UPDATE;
  SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') INTO old_rows FROM public.agent_commissions a
   WHERE a.source_type='cash_rake_accrual' AND a.source_id=s.id;
  SELECT count(*) INTO original_tier_count FROM jsonb_array_elements(s.contract->'tiers')t WHERE(t->>'amount')::numeric>0;
  IF jsonb_array_length(old_rows)<>original_tier_count OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(old_rows)a WHERE a->>'settled_at' IS NOT NULL OR a->>'club_id' IS DISTINCT FROM s.club_id::text
    OR(a->>'created_at')::timestamptz IS DISTINCT FROM s.earned_at OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.contract->'tiers')t
     WHERE t->>'user_id'=a->>'user_id' AND(t->>'amount')::numeric=(a->>'amount')::numeric AND(t->>'rate')::numeric=(a->>'commission_rate')::numeric))
  THEN RAISE EXCEPTION 'atomic_cash_admission_original_commissions_changed' USING ERRCODE='23514'; END IF;
  INSERT INTO public.accounting_cash_atomic_contract_admissions(source_id,original_contract,admitted_contract,original_commissions,invalid_history_ids)
   VALUES(s.id,s.contract,canonical,old_rows,bad_ids);
  old_setting:=current_setting('app.ledger_maintenance',true);
  PERFORM set_config('app.ledger_maintenance','atomic-earning-admission:'||s.id::text,true);
  DELETE FROM public.agent_commissions WHERE source_type='cash_rake_accrual' AND source_id=s.id;
  PERFORM set_config('app.ledger_maintenance',COALESCE(old_setting,''),true);
  -- Reverse only the original source's display contributions, then use its
  -- SAME native posting function. Deleted agent profiles are never recreated.
  UPDATE public.agents a SET lifetime_rake_generated=COALESCE(a.lifetime_rake_generated,0)-s.rake_credit,
   weekly_rake_generated=COALESCE(a.weekly_rake_generated,0)-CASE WHEN public.fn_union_week_start(s.earned_at)=public.fn_union_week_start(now()) THEN s.rake_credit ELSE 0 END
   WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(s.contract->'tiers')t WHERE a.id=(t->>'agent_id')::uuid AND a.user_id=(t->>'user_id')::uuid)
    AND a.club_id=s.club_id;
  posted:=public.fn_post_accounting_commission_source(s.id,'cash_rake_accrual',s.earned_at,canonical);
  IF posted<>(SELECT count(*) FROM jsonb_array_elements(canonical->'tiers')t WHERE(t->>'amount')::numeric>0)
  THEN RAISE EXCEPTION 'atomic_cash_admission_posting_incomplete' USING ERRCODE='23514'; END IF;
  n:=n+1;
  PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||s.club_id::text||':'||(w_from AT TIME ZONE 'America/Los_Angeles')::date::text,0));
  INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end)
   VALUES(s.club_id,(w_from AT TIME ZONE 'America/Los_Angeles')::date,(w_to AT TIME ZONE 'America/Los_Angeles')::date-1)
   ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET last_requested_at=clock_timestamp(),status='pending',reason=NULL;
 END LOOP;
 RETURN n;
END $admit$;
REVOKE ALL ON FUNCTION smarter_private.admit_cash_atomic_contracts(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

DO $owner$ BEGIN IF md5(pg_get_functiondef('fn_accounting_cash_commission_source_guard()'::regprocedure))<>'64cada14be0804682ca22bf136dd01c0' THEN RAISE EXCEPTION 'atomic_cash_admission_owner_preimage_changed: fn_accounting_cash_commission_source_guard()'; END IF; END $owner$;
CREATE OR REPLACE FUNCTION public.fn_accounting_cash_commission_source_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE source public.accounting_cash_rake_sources%ROWTYPE; matches int;
BEGIN
 IF NEW.source_type='cash_rake_accrual' THEN
  SELECT * INTO source FROM public.accounting_effective_cash_rake_sources WHERE id=NEW.source_id;
  IF NOT FOUND OR NEW.club_id IS DISTINCT FROM source.club_id OR NEW.created_at IS DISTINCT FROM source.earned_at THEN
   RAISE EXCEPTION 'cash_commission_source_receipt_required' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO matches FROM jsonb_array_elements(source.contract->'tiers') t
   WHERE t->>'user_id'=NEW.user_id::text AND (t->>'amount')::numeric=NEW.amount
    AND (t->>'rate')::numeric=NEW.commission_rate AND NEW.amount>0;
  IF matches<>1 THEN RAISE EXCEPTION 'cash_commission_disagrees_with_recorded_entitlement' USING ERRCODE='23514'; END IF;
 ELSIF NEW.source_type IN('rake','rake_settlement') AND EXISTS(
  SELECT 1 FROM public.rake_records r CROSS JOIN public.accounting_cash_accrual_cutover c
   WHERE c.singleton AND r.hand_id=NEW.source_id AND r.created_at>=c.starts_at
     AND NOT COALESCE(r.is_tournament,false) AND r.tournament_id IS NULL) THEN
  RAISE EXCEPTION 'cash_commission_requires_canonical_source_writer' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$;


DO $owner$ BEGIN IF md5(pg_get_functiondef('fn_accounting_union_earned_plan_sets(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'c7548ae4cfa6ff517316bee6715447b4' THEN RAISE EXCEPTION 'atomic_cash_admission_owner_preimage_changed: fn_accounting_union_earned_plan_sets(uuid,timestamp with time zone,timestamp with time zone)'; END IF; END $owner$;
CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_sets(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
 SET enable_indexscan TO 'off'
AS $function$
DECLARE
 res record;
BEGIN
 -- THE EARNED PLAN, READ AS SETS (20261003). The same six source proofs,
 -- the same conservation test and the same totals, fingerprint and basis as
 -- fn_accounting_union_earned_plan_v3, computed in one statement that reads
 -- each source row of the window once (v3 reads the week's sources four
 -- times and probes three tables per bank receipt). This function only ever
 -- CERTIFIES: it returns NULL whenever a proof finds anything, a value it
 -- reads cannot be cast, or anything else raises, and the caller then runs
 -- v3, which refuses exactly as it always refused. Where it is stricter than
 -- v3 (a rake record outside the cash-positive set, a NULL check result) it
 -- only sends the book to v3.
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_start>=p_end
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND starts_at<=p_start) THEN
  RETURN NULL;
 END IF;
 BEGIN
  EXECUTE $q$
  WITH tw AS MATERIALIZED (
   SELECT t.id,t.created_at,t.amount FROM public.union_wallet_transactions t
    WHERE t.union_id=$1 AND t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake'
     AND t.created_at>=$2 AND t.created_at<$3
  ), cw AS MATERIALIZED (
   SELECT c.rake_record_id,c.union_transaction_id,c.banked_at,c.amount,c.club_ledger_id
    FROM public.accounting_cash_bank_receipts c WHERE c.union_id=$1 AND c.banked_at>=$2 AND c.banked_at<$3
  ), fw AS MATERIALIZED (
   SELECT f.tournament_id,f.union_wallet_transaction_id,f.recognized_at,f.net_rake,f.status,f.bank_journal_id
    FROM public.accounting_tournament_fee_recognitions f WHERE f.union_id=$1 AND f.recognized_at>=$2 AND f.recognized_at<$3
  ), tour_keys AS MATERIALIZED (
   -- The tournament branch of accounting_payable_earning_sources, keyed: its
   -- recognized sources of the window whose recognition is this union's.
   SELECT rs.source_id,rs.tournament_id,rs.recognized_at,rs.rake_credit
    FROM public.accounting_tournament_recognized_sources rs
    JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=rs.tournament_id
    WHERE rs.recognized_at>=$2 AND rs.recognized_at<$3 AND rs.disposition='earned'
     AND r.status='recognized' AND rs.recognized_at=r.recognized_at AND r.union_id=$1
  ), raw AS (
   SELECT 'cash_rake_accrual'::text AS source_type,s.id AS source_id,s.rake_record_id,NULL::uuid AS tournament_id,s.player_id,s.club_id,
    s.union_id,s.coordinator_union_id,s.earned_at,s.rake_credit,s.contract,'cash'::text AS game_type,NULL::boolean AS terms_match
    FROM public.accounting_effective_cash_rake_sources s WHERE s.union_id=$1 AND s.earned_at>=$2 AND s.earned_at<$3
   UNION ALL
   SELECT 'tournament_fee_accrual'::text,s.id,s.rake_record_id,s.tournament_id,s.player_id,s.club_id,
    s.union_id,s.coordinator_union_id,k.recognized_at,s.rake_credit,s.contract,COALESCE(s.game_type,'cash'),
    (public.fn_accounting_tournament_source_terms_at(s.tournament_id,s.charged_at,s.contract)=(s.contract->>'terms_at')::timestamptz)
    FROM public.accounting_tournament_fee_sources s
    JOIN tour_keys k ON k.source_id=s.id AND k.tournament_id=s.tournament_id AND k.rake_credit=s.rake_credit
    WHERE s.id=ANY(ARRAY(SELECT source_id FROM tour_keys)) AND s.union_id=$1
  ), detoasted AS (
   -- contract is stored compressed; || '{}' hands back the same object once
   -- decompressed, so the many reads below do not decompress it again.
   SELECT r.*,r.contract||'{}'::jsonb AS cj FROM raw r OFFSET 0
  ), sources AS (
   SELECT s.*,s.cj->'union_agreement' AS agreement,(s.cj->>'terms_at')::timestamptz AS terms_at,
    COALESCE((s.cj->>'is_union_house')::boolean,false) AS is_house
    FROM detoasted s OFFSET 0
  ), checked AS (
   SELECT s.*,h.id AS history_id,h.observed_at,h.after_terms,s.agreement->'terms' AS terms,
    COALESCE(CASE s.game_type WHEN 'cash' THEN s.agreement->'terms'->>'rate_cash'
     WHEN 'mtt' THEN s.agreement->'terms'->>'rate_mtt' WHEN 'sng' THEN s.agreement->'terms'->>'rate_sng'
     WHEN 'spin' THEN s.agreement->'terms'->>'rate_spin' WHEN 'satellite' THEN s.agreement->'terms'->>'rate_satellite' END,
     s.agreement->'terms'->>'club_commission_rate')::numeric AS rate
    FROM sources s LEFT JOIN public.accounting_agreement_history h ON h.id=(s.agreement->>'history_id')::bigint
    OFFSET 0
  ), src AS MATERIALIZED (
   SELECT s.source_type,s.source_id,s.rake_record_id,s.tournament_id,s.club_id,s.earned_at,s.rake_credit,s.game_type,s.rate,s.is_house,
    (s.cj->>'is_union_house')::boolean AS house_flag,
    md5(jsonb_build_array(s.source_type,s.source_id,s.rake_record_id,s.tournament_id,s.earned_at,s.rake_credit,s.cj)::text) AS row_md5,
    (s.cj->>'club_id' IS DISTINCT FROM s.club_id::text OR s.cj->>'player_id' IS DISTINCT FROM s.player_id::text
     OR s.cj->>'union_id' IS DISTINCT FROM $1::text OR s.coordinator_union_id IS DISTINCT FROM $1
     OR (s.cj->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit OR s.terms_at IS NULL OR s.terms_at>s.earned_at
     OR (s.source_type='cash_rake_accrual' AND s.terms_at IS DISTINCT FROM s.earned_at)
     OR (s.source_type='tournament_fee_accrual' AND s.terms_match IS NOT TRUE)
     OR (s.is_house AND (s.agreement IS DISTINCT FROM 'null'::jsonb OR NOT EXISTS(SELECT 1 FROM public.clubs c
       WHERE c.id=s.club_id AND c.is_union IS TRUE AND (c.id=$1 OR c.union_id=$1))))
     OR (NOT s.is_house AND (s.history_id IS NULL OR s.after_terms IS DISTINCT FROM s.terms
       OR s.terms->>'club_id' IS DISTINCT FROM s.club_id::text OR s.terms->>'union_id' IS DISTINCT FROM $1::text
       OR s.observed_at>s.terms_at OR s.observed_at IS DISTINCT FROM (s.agreement->>'observed_at')::timestamptz
       OR NOT EXISTS(SELECT 1 FROM public.accounting_agreement_history h WHERE h.id=s.history_id AND h.entity_type='union_clubs'
        AND h.club_id=s.club_id AND h.entity_key=s.terms->>'id')
       OR EXISTS(SELECT 1 FROM public.accounting_agreement_history h JOIN public.accounting_agreement_history old ON old.id=s.history_id
         WHERE h.entity_type='union_clubs' AND h.entity_key=old.entity_key AND h.observed_at<=s.terms_at AND (h.observed_at,h.id)>(old.observed_at,old.id))
       OR s.rate IS NULL OR s.rate<0 OR s.rate>1 OR s.rate::text IN('NaN','Infinity','-Infinity')))) AS agreement_bad
    FROM checked s
  ), rw AS MATERIALIZED (
   SELECT r.id,r.rake_amount,r.created_at FROM public.rake_records r
    WHERE r.created_at>=$2 AND r.created_at<$3 AND r.rake_amount>0 AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
  ), bw AS MATERIALIZED (
   SELECT b.rake_record_id,b.status,b.earned_at FROM public.accounting_cash_accrual_batches b
    WHERE b.earned_at>=$2 AND b.earned_at<$3
  ), xw AS MATERIALIZED (
   SELECT s.rake_record_id,count(*) AS n,sum(s.rake_credit) AS total,min(s.earned_at) AS min_e,max(s.earned_at) AS max_e
    FROM src s WHERE s.source_type='cash_rake_accrual' GROUP BY s.rake_record_id
  ), counts AS (
   SELECT
    (SELECT count(*) FROM tw t LEFT JOIN cw c ON c.union_transaction_id=t.id LEFT JOIN fw f ON f.union_wallet_transaction_id=t.id
      WHERE (c.rake_record_id IS NULL)=(f.tournament_id IS NULL)
       OR (c.rake_record_id IS NOT NULL AND (c.amount IS DISTINCT FROM t.amount OR c.banked_at IS DISTINCT FROM t.created_at OR c.club_ledger_id IS NOT NULL
         OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions f2 WHERE f2.union_wallet_transaction_id=t.id)))
       OR (f.tournament_id IS NOT NULL AND (f.net_rake IS DISTINCT FROM t.amount OR f.recognized_at IS DISTINCT FROM t.created_at
         OR f.status IS DISTINCT FROM 'recognized' OR f.bank_journal_id IS NOT NULL
         OR EXISTS(SELECT 1 FROM public.accounting_cash_bank_receipts c2 WHERE c2.union_transaction_id=t.id)))
       OR t.amount IS NULL OR t.amount<=0 OR t.amount<>round(t.amount,2) OR t.amount::text IN('NaN','Infinity','-Infinity')) AS q1,
    (SELECT count(*) FROM (SELECT c.union_transaction_id AS bank_id,c.banked_at AS earned_at,c.amount FROM cw c
        UNION ALL SELECT f.union_wallet_transaction_id,f.recognized_at,f.net_rake FROM fw f WHERE f.net_rake>0) s
      LEFT JOIN tw t ON t.id=s.bank_id AND t.created_at=s.earned_at AND t.amount IS NOT DISTINCT FROM s.amount
      WHERE t.id IS NULL) AS q2,
    (SELECT count(*) FROM cw c LEFT JOIN rw r ON r.id=c.rake_record_id LEFT JOIN bw b ON b.rake_record_id=c.rake_record_id
       LEFT JOIN xw x ON x.rake_record_id=c.rake_record_id
      WHERE r.id IS NULL OR r.rake_amount IS DISTINCT FROM c.amount OR r.created_at IS DISTINCT FROM c.banked_at
       OR b.rake_record_id IS NULL OR b.status IS DISTINCT FROM 'accrued' OR b.earned_at IS DISTINCT FROM r.created_at
       OR x.n IS NULL OR x.total IS DISTINCT FROM c.amount OR x.min_e IS DISTINCT FROM c.banked_at OR x.max_e IS DISTINCT FROM c.banked_at
       OR (SELECT count(*) FROM public.accounting_effective_cash_rake_sources s2 WHERE s2.rake_record_id=c.rake_record_id)<>x.n) AS q3,
    (SELECT count(*) FROM fw f LEFT JOIN (SELECT s.tournament_id,s.earned_at,count(*) AS n,sum(s.rake_credit) AS total FROM src s
        WHERE s.source_type='tournament_fee_accrual' GROUP BY s.tournament_id,s.earned_at) x
       ON x.tournament_id=f.tournament_id AND x.earned_at=f.recognized_at
      WHERE f.net_rake>0 AND (f.status IS DISTINCT FROM 'recognized' OR x.n IS NULL OR x.total IS DISTINCT FROM f.net_rake)) AS q4,
    (SELECT count(*) FROM src s
       LEFT JOIN cw c ON s.source_type='cash_rake_accrual' AND c.rake_record_id=s.rake_record_id
       LEFT JOIN fw f ON s.source_type='tournament_fee_accrual' AND f.tournament_id=s.tournament_id
      WHERE (s.source_type='cash_rake_accrual' AND (c.rake_record_id IS NULL OR c.banked_at IS DISTINCT FROM s.earned_at))
       OR (s.source_type='tournament_fee_accrual' AND (f.tournament_id IS NULL OR f.recognized_at IS DISTINCT FROM s.earned_at
         OR f.status IS DISTINCT FROM 'recognized'))
       OR s.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual')) AS q5,
    (SELECT count(*) FROM src s WHERE s.agreement_bad IS NOT FALSE) AS q6
  ), basis AS (
   SELECT club_id,game_type,sum(rake_credit) AS rake_in,
    CASE WHEN sum(rake_credit)>0 THEN sum(rake_credit*rate)/sum(rake_credit) ELSE 0 END AS rate,
    trunc(sum(rake_credit*rate),2) AS payout FROM src WHERE is_house IS FALSE GROUP BY club_id,game_type
  )
  SELECT k.q1,k.q2,k.q3,k.q4,k.q5,k.q6,
   (SELECT COALESCE(sum(amount),0) FROM tw) AS bank_total,
   (SELECT COALESCE(sum(rake_credit),0) FROM src) AS source_total,
   (SELECT COALESCE(sum(rake_credit) FILTER(WHERE house_flag),0) FROM src) AS house_total,
   (SELECT md5(COALESCE(string_agg(row_md5,'' ORDER BY source_type,source_id),'')) FROM src) AS fingerprint,
   (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY club_id,game_type),'[]') FROM basis b) AS detail
  FROM counts k
  $q$ INTO res USING p_union_id,p_start,p_end;
 EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
 END;
 IF res.q1<>0 OR res.q2<>0 OR res.q3<>0 OR res.q4<>0 OR res.q5<>0 OR res.q6<>0
  OR res.bank_total IS NULL OR res.source_total IS DISTINCT FROM res.bank_total THEN
  RETURN NULL;
 END IF;
 RETURN jsonb_build_object('accounting_version',3,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,
  'period_rake',res.bank_total,'earned_rake',res.source_total,'house_rake',res.house_total,'source_fingerprint',res.fingerprint,'basis_detail',res.detail);
END
$function$;


DO $owner$ BEGIN IF md5(pg_get_functiondef('fn_accounting_union_earned_plan_window(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'102e5be492a144a705a2882d91675069' THEN RAISE EXCEPTION 'atomic_cash_admission_owner_preimage_changed: fn_accounting_union_earned_plan_window(uuid,timestamp with time zone,timestamp with time zone)'; END IF; END $owner$;
CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_window(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(value jsonb, cash_ids uuid[], cash_md5 bytea, fee_ids uuid[], fee_md5 bytea)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
 SET enable_indexscan TO 'off'
AS $function$
DECLARE
 res record;
BEGIN
 -- ONE WINDOW OF THE EARNED PLAN (chunked close, 20261003): the set path
 -- below, derived from fn_accounting_union_earned_plan_sets, over one window
 -- p_start..p_end of a closed week. A passing window returns its raw sums, its
 -- club/game basis sums and every source's row md5 with its id, which
 -- fn_accounting_union_earned_plan_combine adds up into the week's plan.
 -- Anything else returns no row. The set path's own header follows.
 -- THE EARNED PLAN, READ AS SETS (20261003). The same six source proofs,
 -- the same conservation test and the same totals, fingerprint and basis as
 -- fn_accounting_union_earned_plan_v3, computed in one statement that reads
 -- each source row of the window once (v3 reads the week's sources four
 -- times and probes three tables per bank receipt). This function only ever
 -- CERTIFIES: it returns NULL whenever a proof finds anything, a value it
 -- reads cannot be cast, or anything else raises, and the caller then runs
 -- v3, which refuses exactly as it always refused. Where it is stricter than
 -- v3 (a rake record outside the cash-positive set, a NULL check result) it
 -- only sends the book to v3.
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_start>=p_end
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND starts_at<=p_start) THEN
  RETURN;
 END IF;
 BEGIN
  EXECUTE $q$
  WITH tw AS MATERIALIZED (
   SELECT t.id,t.created_at,t.amount FROM public.union_wallet_transactions t
    WHERE t.union_id=$1 AND t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake'
     AND t.created_at>=$2 AND t.created_at<$3
  ), cw AS MATERIALIZED (
   SELECT c.rake_record_id,c.union_transaction_id,c.banked_at,c.amount,c.club_ledger_id
    FROM public.accounting_cash_bank_receipts c WHERE c.union_id=$1 AND c.banked_at>=$2 AND c.banked_at<$3
  ), fw AS MATERIALIZED (
   SELECT f.tournament_id,f.union_wallet_transaction_id,f.recognized_at,f.net_rake,f.status,f.bank_journal_id
    FROM public.accounting_tournament_fee_recognitions f WHERE f.union_id=$1 AND f.recognized_at>=$2 AND f.recognized_at<$3
  ), tour_keys AS MATERIALIZED (
   -- The tournament branch of accounting_payable_earning_sources, keyed: its
   -- recognized sources of the window whose recognition is this union's.
   SELECT rs.source_id,rs.tournament_id,rs.recognized_at,rs.rake_credit
    FROM public.accounting_tournament_recognized_sources rs
    JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=rs.tournament_id
    WHERE rs.recognized_at>=$2 AND rs.recognized_at<$3 AND rs.disposition='earned'
     AND r.status='recognized' AND rs.recognized_at=r.recognized_at AND r.union_id=$1
  ), raw AS (
   SELECT 'cash_rake_accrual'::text AS source_type,s.id AS source_id,s.rake_record_id,NULL::uuid AS tournament_id,s.player_id,s.club_id,
    s.union_id,s.coordinator_union_id,s.earned_at,s.rake_credit,s.contract,'cash'::text AS game_type,NULL::boolean AS terms_match
    FROM public.accounting_effective_cash_rake_sources s WHERE s.union_id=$1 AND s.earned_at>=$2 AND s.earned_at<$3
   UNION ALL
   SELECT 'tournament_fee_accrual'::text,s.id,s.rake_record_id,s.tournament_id,s.player_id,s.club_id,
    s.union_id,s.coordinator_union_id,k.recognized_at,s.rake_credit,s.contract,COALESCE(s.game_type,'cash'),
    (public.fn_accounting_tournament_source_terms_at(s.tournament_id,s.charged_at,s.contract)=(s.contract->>'terms_at')::timestamptz)
    FROM public.accounting_tournament_fee_sources s
    JOIN tour_keys k ON k.source_id=s.id AND k.tournament_id=s.tournament_id AND k.rake_credit=s.rake_credit
    WHERE s.id=ANY(ARRAY(SELECT source_id FROM tour_keys)) AND s.union_id=$1
  ), detoasted AS (
   -- contract is stored compressed; || '{}' hands back the same object once
   -- decompressed, so the many reads below do not decompress it again.
   SELECT r.*,r.contract||'{}'::jsonb AS cj FROM raw r OFFSET 0
  ), sources AS (
   SELECT s.*,s.cj->'union_agreement' AS agreement,(s.cj->>'terms_at')::timestamptz AS terms_at,
    COALESCE((s.cj->>'is_union_house')::boolean,false) AS is_house
    FROM detoasted s OFFSET 0
  ), checked AS (
   SELECT s.*,h.id AS history_id,h.observed_at,h.after_terms,s.agreement->'terms' AS terms,
    COALESCE(CASE s.game_type WHEN 'cash' THEN s.agreement->'terms'->>'rate_cash'
     WHEN 'mtt' THEN s.agreement->'terms'->>'rate_mtt' WHEN 'sng' THEN s.agreement->'terms'->>'rate_sng'
     WHEN 'spin' THEN s.agreement->'terms'->>'rate_spin' WHEN 'satellite' THEN s.agreement->'terms'->>'rate_satellite' END,
     s.agreement->'terms'->>'club_commission_rate')::numeric AS rate
    FROM sources s LEFT JOIN public.accounting_agreement_history h ON h.id=(s.agreement->>'history_id')::bigint
    OFFSET 0
  ), src AS MATERIALIZED (
   SELECT s.source_type,s.source_id,s.rake_record_id,s.tournament_id,s.club_id,s.earned_at,s.rake_credit,s.game_type,s.rate,s.is_house,
    (s.cj->>'is_union_house')::boolean AS house_flag,
    md5(jsonb_build_array(s.source_type,s.source_id,s.rake_record_id,s.tournament_id,s.earned_at,s.rake_credit,s.cj)::text) AS row_md5,
    (s.cj->>'club_id' IS DISTINCT FROM s.club_id::text OR s.cj->>'player_id' IS DISTINCT FROM s.player_id::text
     OR s.cj->>'union_id' IS DISTINCT FROM $1::text OR s.coordinator_union_id IS DISTINCT FROM $1
     OR (s.cj->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit OR s.terms_at IS NULL OR s.terms_at>s.earned_at
     OR (s.source_type='cash_rake_accrual' AND s.terms_at IS DISTINCT FROM s.earned_at)
     OR (s.source_type='tournament_fee_accrual' AND s.terms_match IS NOT TRUE)
     OR (s.is_house AND (s.agreement IS DISTINCT FROM 'null'::jsonb OR NOT EXISTS(SELECT 1 FROM public.clubs c
       WHERE c.id=s.club_id AND c.is_union IS TRUE AND (c.id=$1 OR c.union_id=$1))))
     OR (NOT s.is_house AND (s.history_id IS NULL OR s.after_terms IS DISTINCT FROM s.terms
       OR s.terms->>'club_id' IS DISTINCT FROM s.club_id::text OR s.terms->>'union_id' IS DISTINCT FROM $1::text
       OR s.observed_at>s.terms_at OR s.observed_at IS DISTINCT FROM (s.agreement->>'observed_at')::timestamptz
       OR NOT EXISTS(SELECT 1 FROM public.accounting_agreement_history h WHERE h.id=s.history_id AND h.entity_type='union_clubs'
        AND h.club_id=s.club_id AND h.entity_key=s.terms->>'id')
       OR EXISTS(SELECT 1 FROM public.accounting_agreement_history h JOIN public.accounting_agreement_history old ON old.id=s.history_id
         WHERE h.entity_type='union_clubs' AND h.entity_key=old.entity_key AND h.observed_at<=s.terms_at AND (h.observed_at,h.id)>(old.observed_at,old.id))
       OR s.rate IS NULL OR s.rate<0 OR s.rate>1 OR s.rate::text IN('NaN','Infinity','-Infinity')))) AS agreement_bad
    FROM checked s
  ), rw AS MATERIALIZED (
   SELECT r.id,r.rake_amount,r.created_at FROM public.rake_records r
    WHERE r.created_at>=$2 AND r.created_at<$3 AND r.rake_amount>0 AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
  ), bw AS MATERIALIZED (
   SELECT b.rake_record_id,b.status,b.earned_at FROM public.accounting_cash_accrual_batches b
    WHERE b.earned_at>=$2 AND b.earned_at<$3
  ), xw AS MATERIALIZED (
   SELECT s.rake_record_id,count(*) AS n,sum(s.rake_credit) AS total,min(s.earned_at) AS min_e,max(s.earned_at) AS max_e
    FROM src s WHERE s.source_type='cash_rake_accrual' GROUP BY s.rake_record_id
  ), counts AS (
   SELECT
    (SELECT count(*) FROM tw t LEFT JOIN cw c ON c.union_transaction_id=t.id LEFT JOIN fw f ON f.union_wallet_transaction_id=t.id
      WHERE (c.rake_record_id IS NULL)=(f.tournament_id IS NULL)
       OR (c.rake_record_id IS NOT NULL AND (c.amount IS DISTINCT FROM t.amount OR c.banked_at IS DISTINCT FROM t.created_at OR c.club_ledger_id IS NOT NULL
         OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions f2 WHERE f2.union_wallet_transaction_id=t.id)))
       OR (f.tournament_id IS NOT NULL AND (f.net_rake IS DISTINCT FROM t.amount OR f.recognized_at IS DISTINCT FROM t.created_at
         OR f.status IS DISTINCT FROM 'recognized' OR f.bank_journal_id IS NOT NULL
         OR EXISTS(SELECT 1 FROM public.accounting_cash_bank_receipts c2 WHERE c2.union_transaction_id=t.id)))
       OR t.amount IS NULL OR t.amount<=0 OR t.amount<>round(t.amount,2) OR t.amount::text IN('NaN','Infinity','-Infinity')) AS q1,
    (SELECT count(*) FROM (SELECT c.union_transaction_id AS bank_id,c.banked_at AS earned_at,c.amount FROM cw c
        UNION ALL SELECT f.union_wallet_transaction_id,f.recognized_at,f.net_rake FROM fw f WHERE f.net_rake>0) s
      LEFT JOIN tw t ON t.id=s.bank_id AND t.created_at=s.earned_at AND t.amount IS NOT DISTINCT FROM s.amount
      WHERE t.id IS NULL) AS q2,
    (SELECT count(*) FROM cw c LEFT JOIN rw r ON r.id=c.rake_record_id LEFT JOIN bw b ON b.rake_record_id=c.rake_record_id
       LEFT JOIN xw x ON x.rake_record_id=c.rake_record_id
      WHERE r.id IS NULL OR r.rake_amount IS DISTINCT FROM c.amount OR r.created_at IS DISTINCT FROM c.banked_at
       OR b.rake_record_id IS NULL OR b.status IS DISTINCT FROM 'accrued' OR b.earned_at IS DISTINCT FROM r.created_at
       OR x.n IS NULL OR x.total IS DISTINCT FROM c.amount OR x.min_e IS DISTINCT FROM c.banked_at OR x.max_e IS DISTINCT FROM c.banked_at
       OR (SELECT count(*) FROM public.accounting_effective_cash_rake_sources s2 WHERE s2.rake_record_id=c.rake_record_id)<>x.n) AS q3,
    (SELECT count(*) FROM fw f LEFT JOIN (SELECT s.tournament_id,s.earned_at,count(*) AS n,sum(s.rake_credit) AS total FROM src s
        WHERE s.source_type='tournament_fee_accrual' GROUP BY s.tournament_id,s.earned_at) x
       ON x.tournament_id=f.tournament_id AND x.earned_at=f.recognized_at
      WHERE f.net_rake>0 AND (f.status IS DISTINCT FROM 'recognized' OR x.n IS NULL OR x.total IS DISTINCT FROM f.net_rake)) AS q4,
    (SELECT count(*) FROM src s
       LEFT JOIN cw c ON s.source_type='cash_rake_accrual' AND c.rake_record_id=s.rake_record_id
       LEFT JOIN fw f ON s.source_type='tournament_fee_accrual' AND f.tournament_id=s.tournament_id
      WHERE (s.source_type='cash_rake_accrual' AND (c.rake_record_id IS NULL OR c.banked_at IS DISTINCT FROM s.earned_at))
       OR (s.source_type='tournament_fee_accrual' AND (f.tournament_id IS NULL OR f.recognized_at IS DISTINCT FROM s.earned_at
         OR f.status IS DISTINCT FROM 'recognized'))
       OR s.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual')) AS q5,
    (SELECT count(*) FROM src s WHERE s.agreement_bad IS NOT FALSE) AS q6
  ), basis AS (
   SELECT club_id,game_type,sum(rake_credit) AS rake_in,
    CASE WHEN sum(rake_credit)>0 THEN sum(rake_credit*rate)/sum(rake_credit) ELSE 0 END AS rate,
    trunc(sum(rake_credit*rate),2) AS payout FROM src WHERE is_house IS FALSE GROUP BY club_id,game_type
  )
  SELECT k.q1,k.q2,k.q3,k.q4,k.q5,k.q6,
   (SELECT sum(amount) FROM tw) AS bank_sum,
   (SELECT sum(rake_credit) FROM src) AS source_sum,
   (SELECT sum(rake_credit) FILTER(WHERE house_flag) FROM src) AS house_sum,
   (SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id',p.club_id,'game_type',p.game_type,'rake_in',p.rake_in,'weighted',p.weighted) ORDER BY p.club_id,p.game_type),'[]')
     FROM (SELECT club_id,game_type,sum(rake_credit) AS rake_in,sum(rake_credit*rate) AS weighted FROM src WHERE is_house IS FALSE GROUP BY club_id,game_type) p) AS basis_part,
   (SELECT count(*) FROM src WHERE source_type NOT IN('cash_rake_accrual','tournament_fee_accrual')) AS other_types,
   (SELECT array_agg(source_id ORDER BY source_id) FROM src WHERE source_type='cash_rake_accrual') AS cash_ids,
   (SELECT string_agg(decode(row_md5,'hex'),''::bytea ORDER BY source_id) FROM src WHERE source_type='cash_rake_accrual') AS cash_md5,
   (SELECT array_agg(source_id ORDER BY source_id) FROM src WHERE source_type='tournament_fee_accrual') AS fee_ids,
   (SELECT string_agg(decode(row_md5,'hex'),''::bytea ORDER BY source_id) FROM src WHERE source_type='tournament_fee_accrual') AS fee_md5
  FROM counts k
  $q$ INTO res USING p_union_id,p_start,p_end;
 EXCEPTION WHEN OTHERS THEN
  RETURN;
 END;
 -- The week's conservation test (sources = bank) is the combine's: a window
 -- may hold a bank row whose sources are in it and still differ in its sums.
 IF res.q1<>0 OR res.q2<>0 OR res.q3<>0 OR res.q4<>0 OR res.q5<>0 OR res.q6<>0 OR res.other_types<>0 THEN
  RETURN;
 END IF;
 RETURN QUERY SELECT jsonb_build_object('bank_sum',res.bank_sum,'source_sum',res.source_sum,'house_sum',res.house_sum,'basis',res.basis_part),
  res.cash_ids,res.cash_md5,res.fee_ids,res.fee_md5;
END
$function$;


DO $owner$ BEGIN IF md5(pg_get_functiondef('fn_accrue_cash_hand_commissions(uuid)'::regprocedure))<>'3a21b5c01cc4fad0358ef041683ff29c' THEN RAISE EXCEPTION 'atomic_cash_admission_owner_preimage_changed: fn_accrue_cash_hand_commissions(uuid)'; END IF; END $owner$;
CREATE OR REPLACE FUNCTION public.fn_accrue_cash_hand_commissions(p_hand_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE source public.rake_records%ROWTYPE; batch public.accounting_cash_accrual_batches%ROWTYPE;
 fingerprint text; plan jsonb; player jsonb; source_id uuid; count_rows int:=0; cutoff timestamptz;scope record;week_start timestamptz;week_end timestamptz;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_hand_id IS NULL THEN RAISE EXCEPTION 'cash_hand_id_required' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_cash_hand:'||p_hand_id::text,0));
 SELECT * INTO source FROM public.rake_records WHERE hand_id=p_hand_id FOR SHARE;
 IF NOT FOUND OR COALESCE(source.is_tournament,false) OR source.tournament_id IS NOT NULL OR source.rake_amount<=0
 THEN RAISE EXCEPTION 'cash_rake_source_required' USING ERRCODE='23514'; END IF;
 SELECT md5(jsonb_build_object('record',source.id,'hand',source.hand_id,'rake',source.rake_amount,'earned_at',source.created_at,
   'shares',COALESCE(jsonb_agg(jsonb_build_array(a.id,a.player_id,a.club_id,a.weighted_rake_credit) ORDER BY a.player_id),'[]'::jsonb))::text)
 INTO fingerprint FROM public.rake_attributions a WHERE a.rake_record_id=source.id;
 SELECT * INTO batch FROM public.accounting_cash_accrual_batches WHERE rake_record_id=source.id;
 IF FOUND THEN
  IF batch.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'cash_accrual_source_changed_after_recording' USING ERRCODE='23514'; END IF;
  -- An explicit restart may admit a bounded, expected atomic-history
  -- correction before this original accrual's duplicate return. Ordinary
  -- duplicate requests retain their existing behavior and do not reprice.
  IF NULLIF(current_setting('app.accounting_atomic_contracts',true),'') IS NOT NULL THEN
   PERFORM smarter_private.admit_cash_atomic_contracts(source.id,current_setting('app.accounting_atomic_contracts')::jsonb);
  END IF;
  RETURN jsonb_build_object('recorded',true,'duplicate',true,'status',batch.status,'source_version',2);
 END IF;
 IF NOT public.fn_ca_launch_accounting_accepts(source.club_id,source.created_at) THEN
  RETURN jsonb_build_object('status','waived','recorded',false,'reason','owner_directed_launch_waiver');
 END IF;
 SELECT starts_at INTO cutoff FROM public.accounting_cash_accrual_cutover WHERE singleton;
 IF cutoff IS NULL THEN RAISE EXCEPTION 'cash_accrual_cutover_missing' USING ERRCODE='23514'; END IF;
 -- Legacy rows remain untouched. Recording this gap is not a commission
 -- credit or a successful weekly close. The coordinator must reject it.
 IF source.created_at<cutoff THEN
  INSERT INTO public.accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status)
   VALUES(source.id,source.hand_id,source.created_at,fingerprint,'legacy_unverified');
  RETURN jsonb_build_object('recorded',true,'status','legacy_unverified','requires_reconciliation',true,'source_version',2);
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commissions ac WHERE ac.source_id=source.hand_id AND ac.source_type IN('rake','rake_settlement'))
 THEN RAISE EXCEPTION 'cash_accrual_legacy_writer_after_cutover' USING ERRCODE='23514'; END IF;
 plan:=public.fn_accounting_cash_commission_plan(source.id);
 week_start:=public.fn_union_week_start(source.created_at);week_end:=public.fn_union_week_start(week_start+interval '8 days');
 FOR scope IN SELECT DISTINCT CASE WHEN p->>'coordinator_union_id' IS NOT NULL THEN 'union-accounting:' ELSE 'club-accounting:' END
   ||COALESCE(p->>'coordinator_union_id',p->>'club_id')||':'||extract(epoch FROM week_start)::text||':'||extract(epoch FROM week_end)::text AS lock_key
   FROM jsonb_array_elements(plan->'players')p ORDER BY lock_key LOOP
  -- Shared: an accrual excludes the weekly close, never a sibling accrual.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(scope.lock_key,0));
 END LOOP;
 -- An empty or zero-own-commission completed week still closes the source set.
 IF EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r CROSS JOIN LATERAL jsonb_array_elements(plan->'players')p
  WHERE r.period_start<=source.created_at AND r.period_end>source.created_at
   AND((r.union_id IS NOT NULL AND r.union_id::text=p->>'coordinator_union_id')
    OR(r.standalone_club_id IS NOT NULL AND p->>'coordinator_union_id' IS NULL AND r.standalone_club_id::text=p->>'club_id')))
 THEN RAISE EXCEPTION 'cash_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
 INSERT INTO public.accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status,plan)
  VALUES(source.id,source.hand_id,source.created_at,fingerprint,'accrued',plan);
 FOR player IN SELECT value FROM jsonb_array_elements(plan->'players') LOOP
  IF EXISTS(SELECT 1 FROM public.agent_commission_settlements s WHERE s.club_id=(player->>'club_id')::uuid
   AND source.created_at>=s.period_start AND source.created_at<s.period_end)
  THEN RAISE EXCEPTION 'cash_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
  INSERT INTO public.accounting_cash_rake_sources(rake_record_id,player_id,club_id,union_id,coordinator_union_id,earned_at,rake_credit,contract)
   VALUES(source.id,(player->>'player_id')::uuid,(player->>'club_id')::uuid,(player->>'union_id')::uuid,(player->>'coordinator_union_id')::uuid,source.created_at,(player->>'rake_credit')::numeric,player)
   RETURNING id INTO source_id;
  count_rows:=count_rows+public.fn_post_accounting_commission_source(source_id,'cash_rake_accrual',source.created_at,player);
 END LOOP;
 RETURN jsonb_build_object('recorded',true,'status','accrued','source_version',2,'rows_written',count_rows);
END $function$;


DO $owner$ BEGIN IF md5(pg_get_functiondef('fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'092876cece2010b1eeb2fc4eb2dae753' THEN RAISE EXCEPTION 'atomic_cash_admission_owner_preimage_changed: fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone)'; END IF; END $owner$;
CREATE OR REPLACE FUNCTION public.fn_prepare_accounting_week(p_union_id uuid, p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE clubs uuid[];club uuid;result jsonb;problems jsonb:='[]';from_date date;to_date date;ready boolean;verified boolean;source_check jsonb;refusal_key text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to)
  OR p_from IS DISTINCT FROM public.fn_union_week_start(p_from)
  OR p_to IS DISTINCT FROM public.fn_union_week_start(p_from+interval '8 days') OR p_to>now()
 THEN RAISE EXCEPTION 'accounting_preparation_requires_closed_week' USING ERRCODE='22023'; END IF;
 from_date:=(p_from AT TIME ZONE 'America/Los_Angeles')::date;to_date:=(p_to AT TIME ZONE 'America/Los_Angeles')::date-1;
 IF (p_union_id IS NULL)=(p_club_id IS NULL) THEN RAISE EXCEPTION 'invalid_accounting_scope' USING ERRCODE='22023'; END IF;
 IF p_union_id IS NOT NULL THEN PERFORM public.fn_union_pnl_closed_book_barrier(p_to); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
  CASE WHEN p_union_id IS NOT NULL THEN 'union-accounting:' ELSE 'club-accounting:' END
   ||COALESCE(p_union_id,p_club_id)::text||':'||extract(epoch FROM p_from)::text||':'||extract(epoch FROM p_to)::text,0));
 -- The source queue is part of this book. Check it under the same week lock,
 -- before discovery, payer locks, calculations, or any financial stage.
 -- ONE REFUSAL CHECK PER ATTEMPT (20261003): inside one union close attempt
 -- (app.accounting_close_memo='on', set only by fn_weekly_accounting_attempt_begin,
 -- cleared by it and by attempt_end) the cascade's preparation repeats the
 -- scheduler's, for the same book, under this same week lock, which the
 -- attempt has held since. A 'ready' answer of this attempt is reused there;
 -- anything else, and every call outside an attempt, asks the queue as before.
 refusal_key:=COALESCE(p_union_id,p_club_id)::text||'|'||p_from::text||'|'||p_to::text;
 IF current_setting('app.accounting_close_memo',true)='on'
  AND current_setting('app.accounting_cash_refusal_memo',true)=refusal_key THEN
  source_check:=jsonb_build_object('status','ready','count',0,'sources','[]'::jsonb);
 ELSE
  source_check:=public.fn_cash_source_refusals_for_period(p_union_id,p_club_id,p_from,p_to);
  IF current_setting('app.accounting_close_memo',true)='on' AND source_check->>'status'='ready'
   AND source_check->'count'='0'::jsonb AND source_check->'sources'='[]'::jsonb THEN
   PERFORM set_config('app.accounting_cash_refusal_memo',refusal_key,true);
  END IF;
 END IF;
 IF source_check->>'status' IS DISTINCT FROM 'ready'
  OR source_check->'count' IS DISTINCT FROM '0'::jsonb
  OR source_check->'sources' IS DISTINCT FROM '[]'::jsonb THEN
  RETURN jsonb_build_object('success',false,'accounting_version',3,
   'union_id',p_union_id,'club_id',p_club_id,'period_start',p_from,'period_end',p_to,'clubs',0,
   'problems',jsonb_build_array(jsonb_build_object('reason','cash_source_refusals_pending',
    'source_check',source_check)));
 END IF;
 -- P&L/ECO is part of a union's full weekly close. A diagnostic gap must
 -- stop this book before any payer stage, even when rake sources are ready.
 IF p_union_id IS NOT NULL THEN
  source_check:=public.fn_union_pnl_close_quality(p_union_id,p_from,p_to);
  IF source_check->>'status' IS DISTINCT FROM 'ready' THEN
   RETURN jsonb_build_object('success',false,'accounting_version',3,
    'union_id',p_union_id,'club_id',p_club_id,'period_start',p_from,'period_end',p_to,'clubs',0,
    'problems',jsonb_build_array(jsonb_build_object('reason','union_pnl_basis_uncertified','pnl_evidence',source_check)));
  END IF;
 END IF;
 SELECT COALESCE(array_agg(c.club_id ORDER BY c.club_id),ARRAY[]::uuid[]) INTO clubs
  FROM public.fn_accounting_week_clubs(p_union_id,p_club_id,p_from,p_to)c;
 -- Same order as the routing stages, before Round 1 takes any treasury row.
 PERFORM public.fn_lock_rakeback_payer_clubs(clubs);
 IF p_union_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r
    WHERE r.scope_kind='union' AND r.scope_id=p_union_id AND r.round_no=3
     AND r.period_start=p_from AND r.period_end=p_to) THEN
  -- CHUNKED CLOSE (20261003): inside a chunked attempt (job 272 sets
  -- app.weekly_accounting_chunked) a round 3 an earlier attempt committed is
  -- answered from its own receipt, as the cascade answers it, instead of
  -- reading the whole week again to prove it a duplicate.
  IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on' THEN
   SELECT r.result||jsonb_build_object('duplicate',true) INTO source_check FROM public.accounting_routed_settlement_runs r
    WHERE r.scope_kind='union' AND r.scope_id=p_union_id AND r.round_no=3 AND r.period_start=p_from AND r.period_end=p_to;
  ELSE
  source_check:=public.fn_settle_accounting_rakeback_stage('union',p_union_id,p_from,p_to);
  END IF;
  IF source_check->>'success' IS DISTINCT FROM 'true' OR source_check->>'duplicate' IS DISTINCT FROM 'true' THEN
   RAISE EXCEPTION 'original_paid_scope_replay_not_confirmed' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('success',true,'accounting_version',3,'union_id',p_union_id,'club_id',p_club_id,
    'period_start',p_from,'period_end',p_to,'clubs',cardinality(clubs),'problems','[]'::jsonb,'paid_scope_replay',true);
 END IF;
 FOREACH club IN ARRAY clubs LOOP
  -- Reuse a receipt that is proven current (20260928233000): complete, ready,
  -- not superseded by a later request, and no earning source of this club
  -- for this week recorded after it. Rounds 2 and 3 re-verify certificates.
  IF EXISTS(SELECT 1 FROM public.accounting_period_recompute_requests q
    WHERE q.club_id=club AND q.period_start=from_date AND q.period_end=to_date
     AND q.status='complete' AND q.attempted_at IS NOT NULL
     AND q.last_requested_at<=q.attempted_at
     AND q.last_result->>'accounting_version'='2' AND q.last_result->>'status'='ready'
     AND q.last_result->>'club_id'=club::text AND q.last_result->>'period_start'=from_date::text
     AND q.last_result->>'period_end'=to_date::text
     AND NOT EXISTS(SELECT 1 FROM public.accounting_effective_cash_rake_sources s
       WHERE s.club_id=club AND s.earned_at>=p_from AND s.earned_at<p_to AND s.recorded_at>q.attempted_at-interval '1 minute')
     AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f
       WHERE f.club_id=club AND f.charged_at<p_to AND f.recorded_at>q.attempted_at-interval '1 minute')) THEN
   CONTINUE;
  END IF;
  -- SPLIT RECOMPUTE (20261003): inside a chunked close attempt a closed week
  -- is calculated in parts of its own (fn_rakeback_recompute_split); NULL
  -- everywhere else, and the whole-period call follows as before.
  result:=public.fn_rakeback_recompute_split(club,from_date,to_date);
  IF result->>'status'='in_progress' THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('club_id',club,'period_start',from_date,'period_end',to_date,
    'reason','weekly_calculation_in_progress'));
   CONTINUE;
  END IF;
  IF result IS NULL THEN
  result:=public.fn_rakeback_recompute_periods(club,from_date,to_date,NULL);
  END IF;
  ready:=result->>'accounting_version'='2' AND result->>'club_id'=club::text
   AND result->>'period_start'=from_date::text AND result->>'period_end'=to_date::text
   AND result->>'status'='ready' AND result->>'request_state'='complete' AND result->>'request_recorded'='true';
  SELECT EXISTS(SELECT 1 FROM public.accounting_period_recompute_requests q
   WHERE q.id::text=result->>'request_id' AND q.club_id=club AND q.period_start=from_date AND q.period_end=to_date
    AND to_jsonb(q.requested_at)=result->'requested_at' AND q.status='complete'
    AND q.last_result->>'accounting_version'='2' AND q.last_result->>'status'='ready'
    AND q.last_result->>'club_id'=club::text AND q.last_result->>'period_start'=from_date::text
    AND q.last_result->>'period_end'=to_date::text) INTO verified;
  IF ready IS DISTINCT FROM true OR NOT verified THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('club_id',club,'period_start',from_date,'period_end',to_date,
    'reason',COALESCE(result->>'reason','weekly_calculation_receipt_not_confirmed')));
  END IF;
 END LOOP;
 RETURN jsonb_build_object('success',jsonb_array_length(problems)=0,'accounting_version',3,
  'union_id',p_union_id,'club_id',p_club_id,'period_start',p_from,'period_end',p_to,'clubs',cardinality(clubs),'problems',problems);
END $function$;


DO $owner$ BEGIN IF md5(pg_get_functiondef('fn_rakeback_recompute_split(uuid,date,date)'::regprocedure))<>'6b2a9c08ba56ea9f65b31a1cc80c3351' THEN RAISE EXCEPTION 'atomic_cash_admission_owner_preimage_changed: fn_rakeback_recompute_split(uuid,date,date)'; END IF; END $owner$;
CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_split(p_club_id uuid, p_period_start date, p_period_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- A CLOSED WEEK'S RECOMPUTE IN PARTS (20261003). Inside a chunked close
-- attempt: the whole-period call of fn_rakeback_recompute_periods for this
-- club-week, made of parts kept across attempts (see the migration header).
-- Answers 'in_progress' while parts remain, or exactly what
-- fn_rakeback_recompute_periods returns, with the request row it records.
-- NULL outside a chunked close attempt, for an open or pre-cutover week and
-- for an unknown club: the caller then makes the whole-period call itself.
DECLARE v_from timestamptz; v_to timestamptz; cutover timestamptz; began timestamptz; did boolean:=false;
 oldest timestamptz; w record; v jsonb; pages jsonb; n_pages integer; i integer; ids uuid[];
 tq jsonb; ev bigint; inc bigint; dr bigint; issue_count bigint; receipt jsonb; result jsonb;
 request public.accounting_period_recompute_requests%ROWTYPE; request_state text;
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NULL
  OR p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
  OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR extract(isodow FROM p_period_start)<>1 OR p_period_end<>p_period_start+6 THEN
  RETURN NULL;
 END IF;
 v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
 SELECT starts_at INTO cutover FROM public.accounting_cash_accrual_cutover WHERE singleton;
 IF v_to>clock_timestamp() OR cutover IS NULL OR v_from<cutover
  OR NOT EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id) THEN
  RETURN NULL;
 END IF;
 -- The calculator's own club-week lock, for every part and the receipt.
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||p_club_id::text||':'||p_period_start::text,0));
 began:=NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz
  -COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval;
 -- At least one part per attempt (not per club): a union book asks for each
 -- of its clubs in one attempt.
 did:=COALESCE(current_setting('app.accounting_split_did',true),'')='on';
 -- Parts are kept only while no source of this club-week was recorded after
 -- the oldest of them (the preparation's reuse rule), for 12 hours, and only
 -- when made after the week closed.
 SELECT min(computed_at) INTO oldest FROM public.accounting_recompute_split_parts
  WHERE club_id=p_club_id AND period_start=p_period_start;
 IF oldest IS NOT NULL AND (oldest<v_to OR oldest<clock_timestamp()-interval '12 hours'
   OR EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND period_end<>p_period_end)
   OR EXISTS(SELECT 1 FROM public.accounting_effective_cash_rake_sources s
     WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to AND s.recorded_at>oldest-interval '1 minute')
   OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f
     WHERE f.club_id=p_club_id AND f.charged_at<v_to AND f.recorded_at>oldest-interval '1 minute')) THEN
  DELETE FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start;
 END IF;
 -- 1. The player pages.
 IF NOT EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='players') THEN
  IF did AND clock_timestamp()>began+interval '90 seconds' THEN
   RETURN jsonb_build_object('status','in_progress','club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'stage','players');
  END IF;
  WITH p AS (SELECT s.player_id,count(*) AS n FROM public.accounting_payable_earning_sources s
    WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to GROUP BY s.player_id),
  q AS (SELECT p.player_id,((sum(p.n) OVER(ORDER BY p.player_id)-p.n)/20000)::bigint AS pg FROM p)
  SELECT COALESCE(jsonb_agg(x.ids ORDER BY x.pg),'[]'::jsonb) INTO pages
   FROM (SELECT q.pg,jsonb_agg(q.player_id ORDER BY q.player_id) AS ids FROM q GROUP BY q.pg) x;
  INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
  VALUES(p_club_id,p_period_start,p_period_end,'players',0,jsonb_build_object('pages',pages));
  did:=true; PERFORM set_config('app.accounting_split_did','on',true);
 END IF;
 SELECT value->'pages' INTO pages FROM public.accounting_recompute_split_parts
  WHERE club_id=p_club_id AND period_start=p_period_start AND kind='players' AND part=0;
 n_pages:=jsonb_array_length(pages);
 -- 2. The tournament gate, six hours at a time.
 FOR w IN SELECT (row_number() OVER(ORDER BY g)-1)::int AS idx,g AS ws,LEAST(g+interval '6 hours',v_to) AS we
   FROM generate_series(v_from,v_to-interval '1 microsecond',interval '6 hours') g ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='tq' AND part=w.idx);
  IF did AND clock_timestamp()>began+interval '90 seconds' THEN EXIT; END IF;
  INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
  VALUES(p_club_id,p_period_start,p_period_end,'tq',w.idx,public.fn_accounting_tournament_week_quality(p_club_id,w.ws,w.we));
  did:=true; PERFORM set_config('app.accounting_split_did','on',true);
 END LOOP;
 -- 3. The source-evidence counts, two hours at a time.
 FOR w IN SELECT (row_number() OVER(ORDER BY g)-1)::int AS idx,g AS ws,LEAST(g+interval '2 hours',v_to) AS we
   FROM generate_series(v_from,v_to-interval '1 microsecond',interval '2 hours') g ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='counts' AND part=w.idx);
  IF did AND clock_timestamp()>began+interval '90 seconds' THEN EXIT; END IF;
  INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
  VALUES(p_club_id,p_period_start,p_period_end,'counts',w.idx,public.fn_rakeback_split_counts(p_club_id,v_from,v_to,w.ws,w.we));
  did:=true; PERFORM set_config('app.accounting_split_did','on',true);
 END LOOP;
 IF (SELECT count(*) FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='tq')
    <>(SELECT count(*) FROM generate_series(v_from,v_to-interval '1 microsecond',interval '6 hours'))
  OR (SELECT count(*) FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='counts')
    <>(SELECT count(*) FROM generate_series(v_from,v_to-interval '1 microsecond',interval '2 hours')) THEN
  RETURN jsonb_build_object('status','in_progress','club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'stage','windows');
 END IF;
 -- The whole-period call's receipt and its tests, in its order.
 receipt:=jsonb_build_object('accounting_version',2,'club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'written',0,'status','blocked');
 SELECT p.value INTO tq FROM public.accounting_recompute_split_parts p
  WHERE p.club_id=p_club_id AND p.period_start=p_period_start AND p.kind='tq' AND p.value->>'status' IS DISTINCT FROM 'ready'
  ORDER BY (p.value->>'tournament_id')::uuid NULLS LAST,p.part LIMIT 1;
 IF tq IS NOT NULL THEN
  result:=receipt||tq||jsonb_build_object('written',0);
 ELSE
  SELECT sum((value->>'evidence')::bigint),sum((value->>'incomplete')::bigint),sum((value->>'drifted')::bigint) INTO ev,inc,dr
   FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='counts';
  IF ev>0 THEN result:=receipt||jsonb_build_object('reason','cash_earning_evidence_incomplete','source_count',ev); END IF;
  IF result IS NULL THEN
   SELECT count(*) INTO issue_count FROM public.rakeback_periods rp
    WHERE rp.club_id=p_club_id AND rp.period_start<=p_period_end AND rp.period_end>=p_period_start
      AND (rp.status<>'pending' OR rp.period_start<>p_period_start OR rp.period_end<>p_period_end
        OR NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c WHERE c.period_id=rp.id));
   IF issue_count>0 THEN result:=receipt||jsonb_build_object('reason','legacy_or_paid_period_requires_reconciliation','period_count',issue_count);
   ELSIF inc>0 THEN result:=receipt||jsonb_build_object('reason','cash_source_receipts_incomplete','source_count',inc);
   ELSIF dr>0 THEN result:=receipt||jsonb_build_object('reason','cash_source_receipts_drifted','source_count',dr);
   END IF;
  END IF;
 END IF;
 -- 4. The check pass, then 5. the write pass, page by page.
 IF result IS NULL THEN
  FOR i IN 0..n_pages-1 LOOP
   CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='check' AND part=i);
   IF did AND clock_timestamp()>began+interval '90 seconds' THEN
    RETURN jsonb_build_object('status','in_progress','club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'stage','check');
   END IF;
   ids:=ARRAY(SELECT jsonb_array_elements_text(pages->i)::uuid);
   INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
   VALUES(p_club_id,p_period_start,p_period_end,'check',i,public.fn_rakeback_split_check(p_club_id,p_period_start,p_period_end,ids));
   did:=true; PERFORM set_config('app.accounting_split_did','on',true);
  END LOOP;
  SELECT receipt||jsonb_build_object('reason',p.value->>'reason') INTO result FROM public.accounting_recompute_split_parts p
   WHERE p.club_id=p_club_id AND p.period_start=p_period_start AND p.kind='check' AND p.value ? 'reason' ORDER BY p.part LIMIT 1;
 END IF;
 IF result IS NULL THEN
  FOR i IN 0..n_pages-1 LOOP
   CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='write' AND part=i);
   IF did AND clock_timestamp()>began+interval '90 seconds' THEN
    RETURN jsonb_build_object('status','in_progress','club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'stage','write');
   END IF;
   ids:=ARRAY(SELECT jsonb_array_elements_text(pages->i)::uuid);
   INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
   VALUES(p_club_id,p_period_start,p_period_end,'write',i,public.fn_rakeback_split_write(p_club_id,p_period_start,p_period_end,ids));
   did:=true; PERFORM set_config('app.accounting_split_did','on',true);
  END LOOP;
  SELECT receipt||jsonb_build_object('status','ready','written',COALESCE(sum((value->>'written')::integer),0),'confirmed_players',COALESCE(sum((value->>'confirmed')::integer),0))
   INTO result FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='write';
 END IF;
 -- The request row, exactly as fn_rakeback_recompute_periods records a
 -- whole-period call.
 INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end)
  VALUES(p_club_id,p_period_start,p_period_end)
  ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET last_requested_at=clock_timestamp(),status='pending',reason=NULL
  RETURNING * INTO request;
 request_state:=CASE WHEN result->>'status'='ready' THEN 'complete' ELSE 'blocked' END;
 UPDATE public.accounting_period_recompute_requests SET status=request_state,reason=result->>'reason',
  attempted_at=clock_timestamp(),attempts=attempts+1,last_result=result WHERE id=request.id;
 DELETE FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start;
 RETURN result||jsonb_build_object('request_id',request.id,'requested_at',request.requested_at,
  'request_state',request_state,'request_recorded',true);
END
$function$;


DO $view$ DECLARE d text;BEGIN
 SELECT pg_get_viewdef('public.accounting_payable_earning_sources'::regclass,true) INTO d;
 IF position('FROM accounting_cash_rake_sources s' in d)=0 OR position('accounting_effective_cash_rake_sources' in d)>0
 THEN RAISE EXCEPTION 'atomic_cash_admission_payable_view_changed'; END IF;
 EXECUTE 'CREATE OR REPLACE VIEW public.accounting_payable_earning_sources AS '||replace(d,'FROM accounting_cash_rake_sources s','FROM public.accounting_effective_cash_rake_sources s');
END $view$;

COMMIT;
