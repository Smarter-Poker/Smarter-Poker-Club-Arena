-- PROPOSAL ONLY. Internal accepted-hand helper. No client or service EXECUTE.
-- All mutable seat, membership, hierarchy and rebate terms are read in ONE
-- SQL statement for the whole hand. Subsequent inserts consult only its JSON.
CREATE FUNCTION public.fn_ca_capture_cash_commission_source(p_hand_id uuid,p_stacks jsonb)
RETURNS void LANGUAGE plpgsql SET search_path TO public,extensions,pg_temp AS $f$
DECLARE
 v_commit public.hand_atomic_commits%ROWTYPE; v_rake jsonb; v_snapshot jsonb; v_fact jsonb;
 v_errors jsonb; v_hash text; v_existing text; v_state text; v_chain jsonb;
 v_direct uuid; v_payer uuid; v_rate numeric; v_direct_rate numeric; v_terms jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.ca_cash_commission_authority WHERE singleton AND contract_version=1) THEN
   RAISE EXCEPTION 'Cash commission source authority is not activated';
 END IF;
 SELECT * INTO STRICT v_commit FROM public.hand_atomic_commits WHERE hand_id=p_hand_id;
 v_rake:=v_commit.post_commit_payload->'rake';
 IF v_rake IS NULL OR jsonb_typeof(v_rake)='null'
    OR nullif(v_rake->>'tournament_id','') IS NOT NULL THEN RETURN; END IF;
 v_hash:=encode(extensions.digest(convert_to(v_commit.post_commit_payload::text,'UTF8'),'sha256'),'hex');
 IF v_hash IS DISTINCT FROM v_commit.post_commit_payload_hash
    OR v_rake->'contributions' IS DISTINCT FROM v_commit.post_commit_payload->'accepted_hand_facts'->'contributions' THEN
   RAISE EXCEPTION 'Commission source does not match accepted hand envelope';
 END IF;
 SELECT accepted_payload_hash INTO v_existing FROM public.ca_cash_commission_sources WHERE hand_id=p_hand_id;
 IF FOUND THEN
   IF v_existing IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'Commission source hash conflict'; END IF;
   RETURN;
 END IF;
 WITH RECURSIVE shares AS MATERIALIZED (
   SELECT * FROM public.fn_allocate_rake_credits((v_rake->>'amount')::numeric,
     v_rake->'contributions',v_rake->>'method')
 ), roster AS MATERIALIZED (
   SELECT a.*,s.id AS seat_id,s.joined_at AS seat_joined_at,s.club_id AS booked_club_id,
     cm.user_id AS member_user_id,cm.agent_id AS assigned_agent_user_id,cm.role AS member_role,
     cm.player_rakeback_pct,cm.status AS member_status,cm.membership_lifecycle_status,
     d.id AS direct_id,d.user_id AS direct_user_id,d.commission_rate AS direct_rate,
     d.player_rakeback_rate AS default_player_rate,d.status AS direct_status
   FROM shares a
   LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(p_stacks)
     WHERE value->>'user_id'=a.user_id::text) st ON true
   LEFT JOIN public.table_seats s ON s.table_id=v_commit.table_id AND s.user_id=a.user_id
     AND s.id=(st.value->>'seat_id')::uuid
     AND s.joined_at=(st.value->>'seat_joined_at')::timestamptz
   LEFT JOIN public.club_members cm ON cm.user_id=a.user_id AND cm.club_id=s.club_id
   -- An explicit assignment never falls back to the player when invalid.
   LEFT JOIN public.agents d ON d.user_id=coalesce(cm.agent_id,a.user_id) AND d.club_id=s.club_id
 ), chain AS (
   SELECT r.user_id AS player_id,a.id,a.user_id,a.club_id,a.commission_rate,a.parent_agent_id,a.role,a.status,
     1 AS depth,ARRAY[a.id] AS path,false AS cycle
   FROM roster r JOIN public.agents a ON a.id=r.direct_id
   UNION ALL
   SELECT c.player_id,a.id,a.user_id,a.club_id,a.commission_rate,a.parent_agent_id,a.role,a.status,
     c.depth+1,c.path||a.id,a.id=ANY(c.path)
   FROM chain c JOIN public.agents a ON a.id=c.parent_agent_id WHERE NOT c.cycle AND c.depth<65
 )
 SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('hierarchy',
   coalesce((SELECT jsonb_agg(jsonb_build_object('agent_id',c.id,'user_id',c.user_id,
     'club_id',c.club_id,'contract_rate',c.commission_rate,'parent_agent_id',c.parent_agent_id,
     'role',c.role,'status',c.status,'depth',c.depth,'cycle',c.cycle) ORDER BY depth)
     FROM chain c WHERE c.player_id=r.user_id),'[]'::jsonb)) ORDER BY r.user_id),'[]'::jsonb)
 INTO v_snapshot FROM roster r;
 IF (SELECT coalesce(sum((f->>'credit')::numeric),0) FROM jsonb_array_elements(v_snapshot) f)
    IS DISTINCT FROM (v_rake->>'amount')::numeric THEN
   RAISE EXCEPTION 'Accepted rake allocator does not conserve source amount';
 END IF;
 INSERT INTO public.ca_cash_commission_sources(hand_id,table_id,hand_number,requested_club_id,
   accepted_payload_hash,rake_total,rake_method,contributions,returned_uncalled,contributor_count,accepted_at,settled_at)
 VALUES(p_hand_id,v_commit.table_id,v_commit.hand_number,(v_rake->>'club_id')::uuid,
   v_hash,(v_rake->>'amount')::numeric,v_rake->>'method',v_rake->'contributions',
   coalesce(v_rake->'returned_uncalled','{}'::jsonb),jsonb_array_length(v_snapshot),v_commit.committed_at,v_commit.committed_at);
 FOR v_fact IN SELECT value FROM jsonb_array_elements(v_snapshot) LOOP
   v_errors:='[]'::jsonb; v_chain:=v_fact->'hierarchy';
   v_direct:=(v_fact->>'direct_id')::uuid; v_payer:=NULL; v_rate:=NULL;
   v_direct_rate:=(v_fact->>'direct_rate')::numeric;
   v_terms:=jsonb_build_object('member_role',v_fact->'member_role',
     'member_status',v_fact->'member_status','membership_lifecycle_status',v_fact->'membership_lifecycle_status',
     'assigned_agent_user_id',v_fact->'assigned_agent_user_id',
     'negotiated_rate',v_fact->'player_rakeback_pct','agent_default_rate',v_fact->'default_player_rate','errors','[]'::jsonb);
   IF (v_fact->>'player_rakeback_pct')::numeric<0
      OR (v_fact->>'default_player_rate')::numeric<0 THEN
     v_errors:=v_errors||jsonb_build_array('accepted_negative_rebate_terms');
   END IF;
   IF v_fact->>'seat_id' IS NULL OR v_fact->>'booked_club_id' IS NULL THEN
     v_state:='seat_unavailable'; v_errors:=v_errors||jsonb_build_array('accepted_seat_generation_unavailable');
   ELSIF v_fact->>'member_user_id' IS NULL THEN
     v_state:='membership_unavailable'; v_errors:=v_errors||jsonb_build_array('accepted_membership_unavailable');
   ELSIF v_fact->>'assigned_agent_user_id' IS NOT NULL
      AND (v_direct IS NULL OR v_fact->>'direct_status' IS DISTINCT FROM 'active') THEN
     v_state:='assigned_invalid'; v_errors:=v_errors||jsonb_build_array('accepted_assigned_agent_invalid');
   ELSIF v_direct IS NOT NULL AND v_fact->>'direct_status' IS DISTINCT FROM 'active' THEN
     v_state:='assigned_invalid'; v_errors:=v_errors||jsonb_build_array('accepted_self_agent_inactive');
   ELSIF v_direct IS NULL THEN
     v_state:='unassigned'; v_rate:=NULL;
     v_terms:=v_terms||jsonb_build_object('rate_source','legacy_volume_unbound',
       'errors',jsonb_build_array('unassigned_rebate_policy_unbound'));
   ELSE
     v_state:=CASE WHEN v_fact->>'assigned_agent_user_id' IS NULL THEN 'self_agent' ELSE 'assigned' END;
     v_payer:=(v_fact->>'direct_user_id')::uuid;
     IF v_state='self_agent' OR v_fact->>'member_role' IN ('co_owner','admin','owner','agent','super_agent','sub_agent') THEN
       v_rate:=0; v_terms:=v_terms||jsonb_build_object('rate_source','staff_or_self_agent_no_player_rebate');
     ELSIF (v_fact->>'player_rakeback_pct')::numeric>0 THEN
       v_rate:=(v_fact->>'player_rakeback_pct')::numeric;
       v_terms:=v_terms||jsonb_build_object('rate_source','negotiated_player_deal');
     ELSIF (v_fact->>'default_player_rate')::numeric>0 THEN
       v_rate:=(v_fact->>'default_player_rate')::numeric;
       v_terms:=v_terms||jsonb_build_object('rate_source','assigned_agent_default');
     ELSE
       v_errors:=v_errors||jsonb_build_array('accepted_player_rebate_terms_unavailable');
       v_terms:=v_terms||jsonb_build_object('rate_source','missing_positive_configured_terms');
     END IF;
     IF v_rate IS NOT NULL AND (v_rate<0 OR v_rate>1 OR v_rate::text IN ('NaN','Infinity','-Infinity')) THEN
       v_errors:=v_errors||jsonb_build_array('accepted_player_rebate_rate_invalid');
     ELSIF v_rate>0 AND (v_direct_rate IS NULL OR v_direct_rate-v_rate<0.10) THEN
       v_errors:=v_errors||jsonb_build_array('accepted_player_rebate_margin_invalid');
     END IF;
   END IF;
   IF jsonb_array_length(v_chain)>0 AND (
     EXISTS(SELECT 1 FROM jsonb_array_elements(v_chain) j
       WHERE j->>'club_id' IS DISTINCT FROM v_fact->>'booked_club_id'
         OR j->>'status' IS DISTINCT FROM 'active' OR (j->>'cycle')::boolean
         OR (j->>'depth')::integer>64 OR j->>'contract_rate' IS NULL
         OR (j->>'contract_rate')::numeric<0 OR (j->>'contract_rate')::numeric>0.70
         OR j->>'contract_rate' IN ('NaN','Infinity','-Infinity'))
     OR (v_chain->-1->>'parent_agent_id') IS NOT NULL) THEN
     v_errors:=v_errors||jsonb_build_array('accepted_hierarchy_invalid');
   END IF;
   IF EXISTS(SELECT 1 FROM (SELECT (j->>'contract_rate')::numeric AS rate,
       lag((j->>'contract_rate')::numeric) OVER(ORDER BY (j->>'depth')::integer) AS child_rate
       FROM jsonb_array_elements(v_chain) j) gaps WHERE rate-child_rate<0.10) THEN
     v_errors:=v_errors||jsonb_build_array('accepted_hierarchy_margin_invalid');
   END IF;
   INSERT INTO public.ca_cash_commission_facts(hand_id,player_id,booked_club_id,seat_id,seat_joined_at,
     rake_credit,direct_agent_id,payer_user_id,assignment_state,direct_commission_rate,
     player_rebate_rate,player_rebate_entitlement,player_terms,hierarchy,errors)
   VALUES(p_hand_id,(v_fact->>'user_id')::uuid,(v_fact->>'booked_club_id')::uuid,
     (v_fact->>'seat_id')::uuid,(v_fact->>'seat_joined_at')::timestamptz,(v_fact->>'credit')::numeric,
     v_direct,v_payer,v_state,v_direct_rate,v_rate,
     CASE WHEN jsonb_array_length(v_errors)=0 THEN (v_fact->>'credit')::numeric*v_rate ELSE NULL END,
     v_terms,v_chain,v_errors);
 END LOOP;
END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_capture_cash_commission_source(uuid,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
