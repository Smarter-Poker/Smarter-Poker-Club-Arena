-- 20260917230515_union_eco_terms_are_observed_at_their_original_write.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Preserve explicit Union ECO settings changes in the original agreement journal
-- and evaluate their exact interval coverage. Other financial gaps remain blocked;
-- this neither authorizes payment nor fabricates prior commercial terms.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

-- Successor to Union37. Existing historical packages remain sealed.
DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure))
    IS DISTINCT FROM '501b5a243800f96ef549aa4b137bc7bf' THEN
  RAISE EXCEPTION 'union_eco_evidence_predecessor_changed';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.accounting_agreement_history'::regclass
    AND conname='accounting_agreement_history_entity_type_check'
    AND pg_get_constraintdef(oid)=$expected$CHECK ((entity_type = ANY (ARRAY['agents'::text, 'club_members'::text, 'union_clubs'::text])))$expected$) THEN
  RAISE EXCEPTION 'union_eco_agreement_scope_predecessor_changed';
 END IF;
END $guard$;

-- Union terms belong to a Union, never to a fabricated club. Preserve the
-- original non-null club requirement for every existing journal entity type.
ALTER TABLE public.accounting_agreement_history ADD COLUMN union_id uuid;
ALTER TABLE public.accounting_agreement_history ALTER COLUMN club_id DROP NOT NULL;
ALTER TABLE public.accounting_agreement_history DROP CONSTRAINT accounting_agreement_history_entity_type_check;
ALTER TABLE public.accounting_agreement_history ADD CONSTRAINT accounting_agreement_history_entity_type_check
 CHECK(entity_type IN('agents','club_members','union_clubs','unions'));
ALTER TABLE public.accounting_agreement_history ADD CONSTRAINT accounting_agreement_history_scope_check
 CHECK((entity_type='unions' AND union_id IS NOT NULL AND club_id IS NULL AND subject_user_id IS NULL
         AND entity_key=union_id::text)
    OR (entity_type<>'unions' AND club_id IS NOT NULL AND union_id IS NULL));
CREATE INDEX accounting_agreement_history_union_time
 ON public.accounting_agreement_history(union_id,observed_at,id) WHERE entity_type='unions';

CREATE FUNCTION public.fn_accounting_union_eco_terms(p_settings jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(p_settings)='object' THEN
  COALESCE((SELECT jsonb_object_agg(key,value) FROM jsonb_each(p_settings)
   WHERE key=ANY(ARRAY['eco_enabled','eco_base_mode','eco_rate','eco_include_horses'])),'{}'::jsonb)
 ELSE '{}'::jsonb END;
$$;

CREATE FUNCTION public.fn_accounting_union_eco_capture()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b jsonb; a jsonb; stamp timestamptz:=clock_timestamp(); moved boolean;
BEGIN
 b:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE public.fn_accounting_union_eco_terms(OLD.settings) END;
 a:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE public.fn_accounting_union_eco_terms(NEW.settings) END;
 moved:=TG_OP='UPDATE' AND OLD.id IS DISTINCT FROM NEW.id;
 IF b IS NOT DISTINCT FROM a AND NOT moved THEN RETURN COALESCE(NEW,OLD); END IF;
 INSERT INTO public.accounting_agreement_history(entity_type,entity_key,union_id,club_id,event_type,
  observed_at,actor_id,before_terms,after_terms)
 VALUES('unions',CASE WHEN TG_OP='INSERT' THEN NEW.id ELSE OLD.id END::text,
  CASE WHEN TG_OP='INSERT' THEN NEW.id ELSE OLD.id END,NULL,CASE WHEN moved THEN 'DELETE' ELSE TG_OP END,
  stamp,auth.uid(),b,CASE WHEN moved THEN NULL ELSE a END);
 IF moved THEN
  INSERT INTO public.accounting_agreement_history(entity_type,entity_key,union_id,club_id,event_type,
   observed_at,actor_id,before_terms,after_terms)
  VALUES('unions',NEW.id::text,NEW.id,NULL,'INSERT',stamp,auth.uid(),NULL,a);
 END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER accounting_union_eco_history
 AFTER INSERT OR DELETE OR UPDATE OF id,settings ON public.unions
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_union_eco_capture();

-- The settings write and receipt commit or roll back together. Existing rows
-- are NOT baselined: a later observation cannot establish an earlier agreement.
-- This reader never consults today's unions.settings or supplies defaults.
CREATE FUNCTION public.fn_union_eco_terms_evidence(p_union_id uuid,p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE first_at timestamptz; r record; previous_terms jsonb; seen boolean:=false;
 terms jsonb; rate numeric; issue text; issues jsonb:='[]'; segments jsonb:='[]';
BEGIN
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end)
  OR p_end<=p_start OR p_end>statement_timestamp() OR p_end-p_start>interval '8 days' THEN
  RETURN jsonb_build_object('status','blocked','issues',jsonb_build_array('invalid_closed_eco_terms_period'));
 END IF;
 SELECT max(observed_at) INTO first_at FROM public.accounting_agreement_history
  WHERE entity_type='unions' AND union_id=p_union_id AND observed_at<=p_start;
 IF first_at IS NULL THEN
  RETURN jsonb_build_object('status','blocked','issues',jsonb_build_array('eco_terms_opening_coverage_missing'));
 END IF;
 FOR r IN
  SELECT h.*,lead(h.observed_at,1,p_end) OVER(ORDER BY h.observed_at,h.id) AS next_at,
   count(*) OVER(PARTITION BY h.observed_at) AS same_time
  FROM public.accounting_agreement_history h
  WHERE h.entity_type='unions' AND h.union_id=p_union_id AND h.observed_at>=first_at AND h.observed_at<p_end
  ORDER BY h.observed_at,h.id
 LOOP
  terms:=r.after_terms; issue:=NULL;
  IF r.same_time<>1 OR NOT isfinite(r.observed_at) THEN issue:='eco_terms_ambiguous_observation';
  ELSIF r.event_type='baseline' THEN issue:='eco_terms_observation_is_not_original_write';
  ELSIF seen AND r.before_terms IS DISTINCT FROM previous_terms THEN issue:='eco_terms_history_discontinuity';
  ELSIF r.event_type='DELETE' OR terms IS NULL THEN issue:='eco_terms_deleted_during_period';
  ELSIF jsonb_typeof(terms) IS DISTINCT FROM 'object'
    OR NOT terms ?& ARRAY['eco_enabled','eco_base_mode','eco_rate','eco_include_horses'] THEN
   issue:='eco_terms_explicit_configuration_missing';
  ELSIF jsonb_typeof(terms->'eco_enabled') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(terms->'eco_include_horses') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(terms->'eco_base_mode') IS DISTINCT FROM 'string'
    OR jsonb_typeof(terms->'eco_rate') IS DISTINCT FROM 'number' THEN issue:='eco_terms_invalid_types';
  ELSIF terms->>'eco_base_mode' NOT IN('club_cash_profit','net_invoice_position','winnings_plus_rake','winnings_only') THEN
   issue:='eco_terms_unsupported_mode';
  ELSIF terms->'eco_include_horses' IS DISTINCT FROM 'true'::jsonb THEN
   issue:='eco_terms_excludes_horses';
  ELSE
   rate:=(terms->>'eco_rate')::numeric;
   IF rate::text IN('NaN','Infinity','-Infinity') OR rate<0 OR rate>1 THEN issue:='eco_terms_invalid_rate'; END IF;
  END IF;
  IF issue IS NOT NULL THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason',issue,'agreement_id',r.id));
  END IF;
  segments:=segments||jsonb_build_array(jsonb_build_object('agreement_id',r.id,'observed_at',r.observed_at,
   'from',greatest(p_start,r.observed_at),'to',r.next_at,'terms',terms));
  seen:=true; previous_terms:=terms;
 END LOOP;
 RETURN jsonb_build_object('status',CASE WHEN seen AND issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,
  'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',issues,'segments',segments,
  'scope','observed_commercial_terms_only','payment_authorized',false);
END $$;

REVOKE ALL ON FUNCTION public.fn_accounting_union_eco_terms(jsonb),public.fn_accounting_union_eco_capture(),
 public.fn_union_eco_terms_evidence(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
-- Capture is trigger-only. Evidence is private to the existing P&L report;
-- the latter's established service-role entry point/ACL remain unchanged.

DO $patch$
DECLARE source text; needle text; replacement text;
BEGIN
 source:=pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure);
 needle:=$needle$ v_refunds jsonb; v_unknown jsonb; v_open_count int; v_close_count int;$needle$;
 replacement:=$replacement$ v_refunds jsonb; v_unknown jsonb; v_open_count int; v_close_count int; v_eco_terms jsonb;$replacement$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'union_eco_report_declaration_changed'; END IF;
 source:=replace(source,needle,replacement);
 needle:=$needle$"tournament_earning_and_open_equity_basis_uncertified","eco_commercial_basis_uncertified"]'::jsonb;$needle$;
 replacement:=$replacement$"tournament_earning_and_open_equity_basis_uncertified"]'::jsonb;
 v_eco_terms:=public.fn_union_eco_terms_evidence(p_union_id,p_start,p_end);
 IF v_eco_terms->>'status' IS DISTINCT FROM 'ready' THEN
  v_issues:=v_issues||'"eco_commercial_basis_uncertified"'::jsonb;
 END IF;$replacement$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'union_eco_report_issue_changed'; END IF;
 source:=replace(source,needle,replacement);
 needle:=$needle$'posted_pnl_payment_evidence',v_payments,'player_pnl',NULL,'eco_amount',NULL,$needle$;
 replacement:=$replacement$'posted_pnl_payment_evidence',v_payments,'player_pnl',NULL,'eco_amount',NULL,
  'eco_commercial_terms_evidence',v_eco_terms,$replacement$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'union_eco_report_result_changed'; END IF;
 source:=replace(source,needle,replacement);
 needle:=$needle$'all_players_included',true,$needle$;
 replacement:=$replacement$'all_players_included',false,$replacement$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'union_pnl_coverage_claim_changed'; END IF;
 EXECUTE replace(source,needle,replacement);
END $patch$;

COMMIT;
