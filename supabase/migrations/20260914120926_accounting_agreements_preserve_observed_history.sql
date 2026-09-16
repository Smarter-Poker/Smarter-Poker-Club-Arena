-- Preserve observed terms from installation onward. Never invent a historical effective date.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE TABLE public.accounting_agreement_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 entity_type text NOT NULL CHECK(entity_type IN('agents','club_members','union_clubs')),
 entity_key text NOT NULL,
 club_id uuid NOT NULL,
 subject_user_id uuid,
 event_type text NOT NULL CHECK(event_type IN('baseline','INSERT','UPDATE','DELETE')),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 transaction_id bigint NOT NULL DEFAULT txid_current(),
 actor_id uuid,
 before_terms jsonb,
 after_terms jsonb,
 CHECK(before_terms IS NOT NULL OR after_terms IS NOT NULL)
);
CREATE INDEX accounting_agreement_history_entity_time ON public.accounting_agreement_history(entity_type,entity_key,observed_at,id);
CREATE INDEX accounting_agreement_history_club_time ON public.accounting_agreement_history(club_id,observed_at,id);
ALTER TABLE public.accounting_agreement_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.accounting_agreement_history FROM PUBLIC,anon,authenticated;
GRANT SELECT ON TABLE public.accounting_agreement_history TO service_role;

CREATE FUNCTION public.fn_accounting_agreement_terms(p_entity_type text,p_row jsonb) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=public AS $function$
 SELECT CASE WHEN p_row IS NULL THEN NULL ELSE
  (SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(p_row) e
    WHERE e.key=ANY(CASE p_entity_type
      WHEN 'agents' THEN ARRAY['id','club_id','user_id','parent_agent_id','role','status','commission_rate','player_rakeback_rate','is_prepaid']
      WHEN 'club_members' THEN ARRAY['club_id','user_id','agent_id','parent_agent_id','role','status','is_active','commission_rate','rakeback_rate','player_rakeback_pct']
      WHEN 'union_clubs' THEN ARRAY['id','club_id','union_id','club_commission_rate','rate_cash','rate_mtt','rate_sng','rate_spin','rate_satellite']
      ELSE ARRAY[]::text[] END)) END;
$function$;

CREATE FUNCTION public.fn_accounting_agreement_capture() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE b jsonb; a jsonb; identity_row jsonb; identity_key text; moved boolean;
BEGIN
 b:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE public.fn_accounting_agreement_terms(TG_TABLE_NAME,to_jsonb(OLD)) END;
 a:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE public.fn_accounting_agreement_terms(TG_TABLE_NAME,to_jsonb(NEW)) END;
 IF b IS NOT DISTINCT FROM a THEN RETURN COALESCE(NEW,OLD); END IF;
 identity_row:=COALESCE(b,a);
 identity_key:=CASE WHEN TG_TABLE_NAME='club_members' THEN identity_row->>'club_id'||':'||(identity_row->>'user_id') ELSE identity_row->>'id' END;
 moved:=TG_OP='UPDATE' AND (b->>'id' IS DISTINCT FROM a->>'id'
   OR b->>'club_id' IS DISTINCT FROM a->>'club_id' OR b->>'user_id' IS DISTINCT FROM a->>'user_id');
 INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,actor_id,before_terms,after_terms)
 VALUES(TG_TABLE_NAME,identity_key,(identity_row->>'club_id')::uuid,(identity_row->>'user_id')::uuid,TG_OP,auth.uid(),b,CASE WHEN moved THEN NULL ELSE a END);
 -- A moved identity closes its original key and establishes the new key too.
 -- Both changes are observed in this transaction; neither is backdated.
 IF moved THEN
   identity_key:=CASE WHEN TG_TABLE_NAME='club_members' THEN a->>'club_id'||':'||(a->>'user_id') ELSE a->>'id' END;
   INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,actor_id,before_terms,after_terms)
   VALUES(TG_TABLE_NAME,identity_key,(a->>'club_id')::uuid,(a->>'user_id')::uuid,'UPDATE',auth.uid(),NULL,a);
 END IF;
 RETURN COALESCE(NEW,OLD);
END $function$;

CREATE FUNCTION public.fn_accounting_agreement_history_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public AS $function$
BEGIN RAISE EXCEPTION 'accounting_agreement_history_is_immutable' USING ERRCODE='55000'; END $function$;
CREATE TRIGGER accounting_agreement_history_immutable BEFORE UPDATE OR DELETE ON public.accounting_agreement_history
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_agreement_history_no_truncate BEFORE TRUNCATE ON public.accounting_agreement_history
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();

-- Listen only to agreement columns, never to high-volume wallet/counter updates.
CREATE TRIGGER accounting_agreement_history AFTER INSERT OR DELETE OR UPDATE OF id,club_id,user_id,parent_agent_id,role,status,commission_rate,player_rakeback_rate,is_prepaid
 ON public.agents FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_capture();
CREATE TRIGGER accounting_agreement_history AFTER INSERT OR DELETE OR UPDATE OF club_id,user_id,agent_id,parent_agent_id,role,status,is_active,commission_rate,rakeback_rate,player_rakeback_pct
 ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_capture();
CREATE TRIGGER accounting_agreement_history AFTER INSERT OR DELETE OR UPDATE OF id,club_id,union_id,club_commission_rate,rate_cash,rate_mtt,rate_sng,rate_spin,rate_satellite
 ON public.union_clubs FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_capture();
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES
 ('agents','accounting_agreement_history','Append observed identity, hierarchy and rate terms; no balances or counters are written. History failure rolls back the agreement change.'),
 ('club_members','accounting_agreement_history','Append observed membership, agent assignment and player deal; no balances are written. History failure rolls back the agreement change.');

INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,after_terms)
 SELECT 'agents',a.id::text,a.club_id,a.user_id,'baseline',public.fn_accounting_agreement_terms('agents',to_jsonb(a)) FROM public.agents a;
INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,after_terms)
 SELECT 'club_members',m.club_id::text||':'||m.user_id::text,m.club_id,m.user_id,'baseline',public.fn_accounting_agreement_terms('club_members',to_jsonb(m)) FROM public.club_members m;
INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,event_type,after_terms)
 SELECT 'union_clubs',u.id::text,u.club_id,'baseline',public.fn_accounting_agreement_terms('union_clubs',to_jsonb(u)) FROM public.union_clubs u;
REVOKE ALL ON FUNCTION public.fn_accounting_agreement_terms(text,jsonb),public.fn_accounting_agreement_capture(),public.fn_accounting_agreement_history_immutable() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accounting_agreement_terms(text,jsonb) TO service_role;
COMMIT;
