BEGIN;
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
