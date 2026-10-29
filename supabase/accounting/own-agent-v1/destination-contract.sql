-- The explicit owner-funded seventy-percent benefit is retained in full.
-- An observed own-agent agreement selects its historical AGENT destination;
-- promotion before that agreement remains the original PLAYER destination.
CREATE OR REPLACE FUNCTION smarter_private.own_agent_destination_contract(
 p_contract jsonb,p_club uuid,p_player uuid,p_terms_at timestamptz
)RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $destination$
DECLARE member jsonb:=p_contract#>'{membership,terms}'; own jsonb; terms jsonb;
BEGIN
 IF member->>'role'NOT IN('super_agent','agent','sub_agent')OR member->>'role'IS NULL
  OR(member->>'player_rakeback_pct')::numeric IS DISTINCT FROM .70
  OR jsonb_array_length(p_contract->'tiers')<>0
  OR NOT EXISTS(SELECT FROM public.clubs c WHERE c.id=p_club AND c.owner_id=NULLIF(member->>'agent_id','')::uuid)
 THEN RETURN NULL;END IF;
 BEGIN own:=public.fn_accounting_agent_terms_at(p_club,p_player,p_terms_at);
 EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM IN('accounting_terms_not_observed','accounting_terms_not_active')THEN RETURN NULL;ELSE RAISE;END IF;
 END;
 terms:=own->'terms';
 IF terms IS NULL OR terms='null'::jsonb THEN RETURN NULL;END IF;
 IF terms->>'club_id'IS DISTINCT FROM p_club::text OR terms->>'user_id'IS DISTINCT FROM p_player::text
  OR terms->>'status'IS DISTINCT FROM'active'OR COALESCE(terms->>'role','')NOT IN('super_agent','agent','sub_agent')
  OR NULLIF(terms->>'id','')IS NULL OR(own->>'history_id')::bigint IS NULL OR(own->>'observed_at')::timestamptz>p_terms_at
 THEN RAISE EXCEPTION 'owner_agent_destination_contract_invalid' USING ERRCODE='55000';END IF;
 RETURN own;
END $destination$;
REVOKE ALL ON FUNCTION smarter_private.own_agent_destination_contract(jsonb,uuid,uuid,timestamptz)FROM PUBLIC,anon,authenticated,service_role;
