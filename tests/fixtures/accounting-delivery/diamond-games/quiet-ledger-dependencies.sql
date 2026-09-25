-- Current installed definitions of the accounting roster gate, September 21.
-- Source: supabase/migrations/20260921052548_payee_documents_are_private_to_their_payee_and_rosters_are_n.sql
-- (section D3), copied verbatim. The captured invoice-functions.sql predates that
-- migration and still carries the ungated roster, so the reproduction of the
-- live defect (an authenticated player's union prize raising
-- accounting_invoice_recipient_missing) needs the gated body installed first.
-- No production player data. quiet-ledger-provenance.json carries the witnesses.
SET check_function_bodies=off;
CREATE OR REPLACE FUNCTION public.fn_union_overseer_of_record(p_union_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_union_id IS NOT NULL AND p_user_id IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.unions u WHERE u.id = p_union_id AND u.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.union_admins a WHERE a.union_id = p_union_id AND a.user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.clubs c
                WHERE c.id = p_union_id AND COALESCE(c.is_union, false) AND c.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.club_members m
                WHERE m.club_id = p_union_id AND m.user_id = p_user_id
                  AND m.role IN ('owner','co_owner','admin')
                  AND m.status IN ('active','approved'))
  );
$function$;
REVOKE ALL ON FUNCTION public.fn_union_overseer_of_record(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_overseer_of_record(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_accounting_party_users(p_kind text, p_id uuid)
 RETURNS TABLE(user_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 WITH party AS (
  SELECT DISTINCT p.id FROM public.profiles p WHERE p.id IN (
   SELECT p_id WHERE p_kind IN('agent','player')
   UNION SELECT c.owner_id FROM public.clubs c WHERE p_kind='club' AND c.id=p_id
   UNION SELECT m.user_id FROM public.club_members m WHERE p_kind='club' AND m.club_id=p_id
    AND m.role IN('owner','co_owner','admin') AND COALESCE(m.status,'active') IN('active','approved')
   UNION SELECT u.owner_id FROM public.unions u WHERE p_kind='union' AND u.id=p_id
   UNION SELECT a.user_id FROM public.union_admins a WHERE p_kind='union' AND a.union_id=p_id
    AND public.fn_union_overseer_of_record(p_id,a.user_id)
  )
 )
 SELECT party.id FROM party
 WHERE public.fn_caller_is_engine()
    OR EXISTS(SELECT 1 FROM party self WHERE self.id = auth.uid());
$function$;
ALTER FUNCTION public.fn_accounting_party_users(text,uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.fn_accounting_party_users(text,uuid) FROM PUBLIC,"anon","authenticated";
GRANT EXECUTE ON FUNCTION public.fn_accounting_party_users(text,uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_accounting_party_users(text,uuid) TO "service_role";
DO $w$ BEGIN
 IF md5(pg_get_functiondef('public.fn_accounting_party_users(text,uuid)'::regprocedure))<>'dd8941d9caba28d258313dfdb0499c82'
  OR md5(pg_get_functiondef('public.fn_union_overseer_of_record(uuid,uuid)'::regprocedure))<>'7f892f09fed9a0a768b2741a69ddf6b2' THEN
  RAISE EXCEPTION 'Quiet ledger fixture witness failed: the roster gate is not the 20260921052548 definition';
 END IF;
END $w$;
