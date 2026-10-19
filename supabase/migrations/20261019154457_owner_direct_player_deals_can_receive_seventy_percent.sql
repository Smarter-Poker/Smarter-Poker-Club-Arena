-- 20261019154457_owner_direct_player_deals_can_receive_seventy_percent.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- An explicit seventy percent direct-owner player deal is funded by the club.
-- Record its real earnings without a phantom owner agent agreement, and keep
-- the current helper and all period pricing/check/write paths on that same rate
-- and payer. Ordinary agent agreements and historical membership terms remain.
-- All five affected definitions and replacement anchors must match exactly.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
CREATE FUNCTION pg_temp.owner_deal_patch(sig text, expected text, old_parts text[], new_parts text[])
RETURNS void LANGUAGE plpgsql AS $patch$
DECLARE def text; i int;
BEGIN
 def:=pg_get_functiondef(sig::regprocedure);
 IF md5(def)<>expected THEN RAISE EXCEPTION 'definition drift: %',sig; END IF;
 FOR i IN 1..array_length(old_parts,1) LOOP
  IF (length(def)-length(replace(def,old_parts[i],'')))/length(old_parts[i])<>1 THEN
   RAISE EXCEPTION 'patch anchor drift: % part %',sig,i;
  END IF;
  def:=replace(def,old_parts[i],new_parts[i]);
 END LOOP;
 EXECUTE def;
END $patch$;
SELECT pg_temp.owner_deal_patch('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])','5b0c507615f6b63542a94364b8ad3c14',
 ARRAY['SELECT r.*,NULLIF(r.member->>''agent_id'','''')::uuid AS member_agent,',
 'CASE WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate'],
 ARRAY['SELECT r.*,CASE WHEN ((r.member->>''player_rakeback_pct'')::numeric=0.70 OR r.direct IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=p_club_id AND owner_club.owner_id=NULLIF(r.member->>''agent_id'','''')::uuid) THEN NULL::uuid
     ELSE NULLIF(r.member->>''agent_id'','''')::uuid END AS member_agent,',
 'CASE WHEN r.member_agent IS NULL AND r.deal=0.70 THEN r.deal WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate']);
SELECT pg_temp.owner_deal_patch('public.fn_player_rakeback_rate(uuid,uuid,numeric)','058661355117298921c4d77e07feeb4a',
 ARRAY['AND a.status = ''active'''],
 ARRAY['AND a.status = ''active''
     AND NOT (cm.player_rakeback_pct=0.70 AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=cm.club_id AND owner_club.owner_id=cm.agent_id))']);
SELECT pg_temp.owner_deal_patch('public.fn_rakeback_split_check(uuid,date,date,uuid[])','7a6e9f3f645a8a80a9fd3c08312deeda',
 ARRAY['SELECT r.*,NULLIF(r.member->>''agent_id'','''')::uuid AS member_agent,',
 'CASE WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate'],
 ARRAY['SELECT r.*,CASE WHEN ((r.member->>''player_rakeback_pct'')::numeric=0.70 OR r.direct IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=p_club_id AND owner_club.owner_id=NULLIF(r.member->>''agent_id'','''')::uuid) THEN NULL::uuid
     ELSE NULLIF(r.member->>''agent_id'','''')::uuid END AS member_agent,',
 'CASE WHEN r.member_agent IS NULL AND r.deal=0.70 THEN r.deal WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate']);
SELECT pg_temp.owner_deal_patch('public.fn_rakeback_split_write(uuid,date,date,uuid[])','b1e9a7c36647ada7f3f0796db657c7eb',
 ARRAY['SELECT r.*,NULLIF(r.member->>''agent_id'','''')::uuid AS member_agent,',
 'CASE WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate'],
 ARRAY['SELECT r.*,CASE WHEN ((r.member->>''player_rakeback_pct'')::numeric=0.70 OR r.direct IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=p_club_id AND owner_club.owner_id=NULLIF(r.member->>''agent_id'','''')::uuid) THEN NULL::uuid
     ELSE NULLIF(r.member->>''agent_id'','''')::uuid END AS member_agent,',
 'CASE WHEN r.member_agent IS NULL AND r.deal=0.70 THEN r.deal WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate']);


SELECT pg_temp.owner_deal_patch('public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamptz)','df9bfbca2abf9f596921ad60363abafe',
 ARRAY['  IF direct_user IS NOT NULL THEN','   agent:=public.fn_accounting_agent_terms_at(p_club_id,direct_user,p_terms_at);'],
 ARRAY['  IF (terms->>''player_rakeback_pct'')::numeric=0.70 AND EXISTS(
    SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=p_club_id AND owner_club.owner_id=direct_user
  ) THEN
   -- Explicit direct-owner seventy percent deals are club-funded.
   agent:=NULL;
  ELSIF direct_user IS NOT NULL THEN','   BEGIN agent:=public.fn_accounting_agent_terms_at(p_club_id,direct_user,p_terms_at);
   EXCEPTION WHEN SQLSTATE ''55000'' THEN
    -- An owner is not required to carry an agent agreement. Retain the real
    -- observed player deal during reassignment as well as after its rate edit.
    IF SQLERRM IN(''accounting_terms_not_observed'',''accounting_terms_not_active'')
       AND EXISTS(SELECT 1 FROM public.clubs owner_club
         WHERE owner_club.id=p_club_id AND owner_club.owner_id=direct_user)
    THEN agent:=NULL; ELSE RAISE; END IF;
   END;']);

COMMIT;
