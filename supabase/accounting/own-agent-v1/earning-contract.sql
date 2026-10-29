CREATE OR REPLACE FUNCTION public.fn_accounting_earning_contract(p_club_id uuid, p_player_id uuid, p_rake numeric, p_game_union_id uuid, p_terms_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE member jsonb;agent jsonb;terms jsonb;chain jsonb;remaining numeric;rate numeric;amount numeric;
 seen uuid[];agent_id uuid;parent_id uuid;agent_user uuid;direct_user uuid;union_count int;coordinator_union uuid;union_agreement jsonb;union_house boolean;
BEGIN
 -- Private EXECUTE grants admit only trusted source owners, including the
 -- registration trigger running for a human. Public wrappers verify actors.
 IF p_club_id IS NULL OR p_player_id IS NULL OR p_terms_at IS NULL OR NOT isfinite(p_terms_at) OR p_terms_at>clock_timestamp()
  OR p_rake IS NULL OR p_rake<0 OR p_rake<>round(p_rake,2) OR p_rake::text IN('NaN','Infinity','-Infinity')
 THEN RAISE EXCEPTION 'invalid_accounting_earning_contract' USING ERRCODE='22023'; END IF;
  SELECT count(*),(array_agg((uc.after_terms->>'union_id')::uuid))[1],
   (jsonb_agg(jsonb_build_object('history_id',uc.id,'observed_at',uc.observed_at,'terms',uc.after_terms)))->0
   INTO union_count,coordinator_union,union_agreement FROM (
    SELECT DISTINCT ON(h.entity_key) h.id,h.observed_at,h.after_terms FROM public.accounting_agreement_history h
     WHERE h.entity_type='union_clubs' AND h.club_id=p_club_id AND h.observed_at<=p_terms_at
     ORDER BY h.entity_key,h.observed_at DESC,h.id DESC) uc
    WHERE uc.after_terms IS NOT NULL AND uc.after_terms->>'club_id'=p_club_id::text;
  SELECT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_club_id AND c.is_union IS TRUE
   AND p_game_union_id IS NOT NULL AND (c.id=p_game_union_id OR c.union_id=p_game_union_id)) INTO union_house;
  IF union_house THEN coordinator_union:=p_game_union_id;union_agreement:=NULL; END IF;
  IF union_count>1 OR (p_game_union_id IS NOT NULL AND NOT union_house AND (union_count<>1 OR coordinator_union IS DISTINCT FROM p_game_union_id))
  THEN RAISE EXCEPTION 'cash_commission_earning_club_not_observed' USING ERRCODE='23514'; END IF;
  member:=public.fn_accounting_terms_at('club_members',p_club_id::text||':'||p_player_id::text,p_terms_at);
  terms:=member->'terms';
  IF terms IS NULL OR terms='null'::jsonb OR terms->>'club_id' IS DISTINCT FROM p_club_id::text OR terms->>'user_id' IS DISTINCT FROM p_player_id::text
   OR (terms->>'status' IS NULL OR terms->>'status' NOT IN('active','approved')) OR COALESCE((terms->>'is_active')::boolean,true)=false
  THEN RAISE EXCEPTION 'cash_commission_membership_not_active_at_earning' USING ERRCODE='23514'; END IF;
  direct_user:=NULLIF(terms->>'agent_id','')::uuid; agent:=NULL;
  -- An agent's own historical agreement covers their playing account too.
  -- A promotion without its observed agent row still uses the original upline.
  IF terms->>'role' IN ('super_agent','agent','sub_agent') AND NOT COALESCE(
    (terms->>'player_rakeback_pct')::numeric=0.70 AND EXISTS(SELECT 1 FROM public.clubs owner_club
      WHERE owner_club.id=p_club_id AND owner_club.owner_id=direct_user),false) THEN
   BEGIN agent:=public.fn_accounting_agent_terms_at(p_club_id,p_player_id,p_terms_at);
   EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM IN('accounting_terms_not_observed','accounting_terms_not_active') THEN agent:=NULL; ELSE RAISE; END IF;
   END;
  END IF;
  IF agent IS NOT NULL AND agent->'terms' IS NOT NULL AND agent->'terms'<>'null'::jsonb THEN
   NULL; -- The unchanged hierarchy loop validates the own agreement and parents.
  ELSIF (terms->>'player_rakeback_pct')::numeric=0.70 AND EXISTS(
    SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=p_club_id AND owner_club.owner_id=direct_user
  ) THEN
   -- Explicit direct-owner seventy percent deals are club-funded.
   agent:=NULL;
  ELSIF direct_user IS NOT NULL THEN
   BEGIN agent:=public.fn_accounting_agent_terms_at(p_club_id,direct_user,p_terms_at);
   EXCEPTION WHEN SQLSTATE '55000' THEN
    -- An owner is not required to carry an agent agreement. Retain the real
    -- observed player deal during reassignment as well as after its rate edit.
    IF SQLERRM IN('accounting_terms_not_observed','accounting_terms_not_active')
       AND EXISTS(SELECT 1 FROM public.clubs owner_club
         WHERE owner_club.id=p_club_id AND owner_club.owner_id=direct_user)
    THEN agent:=NULL; ELSE RAISE; END IF;
   END;
  ELSE
   BEGIN agent:=public.fn_accounting_agent_terms_at(p_club_id,p_player_id,p_terms_at);
   EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM IN('accounting_terms_not_observed','accounting_terms_not_active') THEN agent:=NULL; ELSE RAISE; END IF; END;
  END IF;
  remaining:=p_rake;chain:='[]';seen:=ARRAY[]::uuid[];
  WHILE agent IS NOT NULL AND agent->'terms' IS NOT NULL AND agent->'terms'<>'null'::jsonb LOOP
   terms:=agent->'terms'; agent_id:=(terms->>'id')::uuid;agent_user:=(terms->>'user_id')::uuid;
   IF agent_id IS NULL OR agent_user IS NULL OR agent_id=ANY(seen) OR cardinality(seen)>=64
    OR terms->>'club_id' IS DISTINCT FROM p_club_id::text OR terms->>'status' IS DISTINCT FROM 'active'
    OR terms->>'role' IS NULL OR terms->>'role' NOT IN('super_agent','agent','sub_agent')
   THEN RAISE EXCEPTION 'cash_commission_hierarchy_invalid_at_earning' USING ERRCODE='23514'; END IF;
   seen:=array_append(seen,agent_id);
   rate:=(terms->>'commission_rate')::numeric;
   IF rate>1 THEN rate:=rate/100; END IF;
   IF rate IS NULL OR rate<0 OR rate>1 OR rate::text IN('NaN','Infinity','-Infinity')
   THEN RAISE EXCEPTION 'cash_commission_rate_invalid_at_earning' USING ERRCODE='23514'; END IF;
   -- Preserve the installed agreement model: each upline rate applies to the
   -- remaining rake after the preceding tier. Round each payable to cents.
   amount:=round(remaining*rate,2);
   chain:=chain||jsonb_build_array(jsonb_build_object('agent_id',agent_id,'user_id',agent_user,
    'role',terms->>'role','depth',cardinality(seen),'rake_basis',p_rake,'remaining_basis',remaining,
    'rate',rate,'amount',amount,'agreement',agent));
   remaining:=remaining-amount;
   parent_id:=NULLIF(terms->>'parent_agent_id','')::uuid;
   IF parent_id IS NULL THEN agent:=NULL; ELSE agent:=public.fn_accounting_terms_at('agents',parent_id::text,p_terms_at); END IF;
  END LOOP;
 RETURN jsonb_build_object('player_id',p_player_id,'club_id',p_club_id,'union_id',p_game_union_id,
  'coordinator_union_id',coordinator_union,'rake_credit',p_rake,'membership',member,'tiers',chain,
  'club_residual',remaining,'union_agreement',union_agreement,'is_union_house',union_house,'terms_at',p_terms_at);
END $function$
