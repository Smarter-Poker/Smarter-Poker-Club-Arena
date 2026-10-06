-- 20261006044028_a_players_own_transfer_reaches_the_club_it_pays.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (found 2026-10-06 while proving the club-leave
-- fixes against production):
--
-- No member holding chips could leave any club. Measured in a rolled-back
-- probe as the member: zero chips leaves; 5,000.00 chips in an ordinary club
-- and 10,038.65 in Deep Stack Society both raise
--   23514 accounting_invoice_recipient_missing
-- and the whole leave rolls back. The client shows "Failed to leave club -
-- please try again", which cannot work.
--
-- The cause is one function doing two jobs. fn_accounting_party_users answers
-- "who are the people behind this party" and, because browsers may call it,
-- answers only to the engine or to someone who IS one of those people. That
-- filter is right for a browser asking. fn_deliver_accounting_invoice uses
-- the same function to address an invoice to BOTH sides of a transfer. When a
-- player moves their own chips to their club (leaving is exactly that: wallet
-- to treasury) the caller is the issuer and is, by definition, not one of the
-- club's officers, so the recipient side comes back empty and delivery
-- refuses a transfer that has two perfectly good parties.
--
-- Delivery now resolves the parties of record through its own resolver: the
-- same people, by the same rule, with no question about who is asking,
-- executable by no browser role. fn_accounting_party_users is not changed, so
-- what a browser may see is exactly what it was.
--
-- fn_deliver_accounting_invoice is rewritten FROM ITS INSTALLED DEFINITION
-- with those two calls re-pointed and nothing else touched; the migration
-- refuses a definition it was not written against.
--
-- @live-proof: position('fn_accounting_invoice_party_users' in pg_get_functiondef('public.fn_deliver_accounting_invoice(uuid)'::regprocedure)) > 0 AND NOT has_function_privilege('authenticated', 'public.fn_accounting_invoice_party_users(text,uuid)', 'EXECUTE')

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_accounting_invoice_party_users(p_kind text, p_id uuid)
 RETURNS TABLE(user_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 -- The people of record behind one party of an accounting transfer: the same
 -- rule as fn_accounting_party_users, without its caller filter. For invoice
 -- delivery only; no browser role may execute it.
 SELECT DISTINCT p.id FROM public.profiles p WHERE p.id IN (
  SELECT p_id WHERE p_kind IN('agent','player')
  UNION SELECT c.owner_id FROM public.clubs c WHERE p_kind='club' AND c.id=p_id
  UNION SELECT m.user_id FROM public.club_members m WHERE p_kind='club' AND m.club_id=p_id
   AND m.role IN('owner','co_owner','admin') AND COALESCE(m.status,'active') IN('active','approved')
  UNION SELECT u.owner_id FROM public.unions u WHERE p_kind='union' AND u.id=p_id
  UNION SELECT a.user_id FROM public.union_admins a WHERE p_kind='union' AND a.union_id=p_id
   AND public.fn_union_overseer_of_record(p_id,a.user_id)
 );
$function$;

REVOKE ALL ON FUNCTION public.fn_accounting_invoice_party_users(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_accounting_invoice_party_users(text, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accounting_invoice_party_users(text, uuid) TO service_role;

COMMENT ON FUNCTION public.fn_accounting_invoice_party_users(text, uuid) IS
  'The users of record behind one party of an accounting transfer, for invoice delivery. Same rule as fn_accounting_party_users without the caller filter; not executable by browser roles.';

DO $do$
DECLARE
  c_fn    constant regprocedure := 'public.fn_deliver_accounting_invoice(uuid)'::regprocedure;
  c_from  constant text := 'INTO issuer_users FROM public.fn_accounting_party_users(inv.from_entity_type,issuer_id);';
  c_to    constant text := 'INTO recipient_users FROM public.fn_accounting_party_users(inv.to_entity_type,recipient_id);';
  v_def   text := pg_get_functiondef(c_fn);
  v_new   text;
BEGIN
  -- Applying this twice changes nothing the second time.
  IF position('fn_accounting_invoice_party_users' in v_def) > 0 THEN
    RETURN;
  END IF;
  IF md5(v_def) <> '4c24964a287ef93afd2e56f866416b17' THEN
    RAISE EXCEPTION 'fn_deliver_accounting_invoice is not the definition this migration was written against (md5 %); re-read it first', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, c_from, ''))) <> length(c_from)
     OR (length(v_def) - length(replace(v_def, c_to, ''))) <> length(c_to) THEN
    RAISE EXCEPTION 'the two party lookups were not each found exactly once';
  END IF;

  v_new := replace(v_def, c_from,
    'INTO issuer_users FROM public.fn_accounting_invoice_party_users(inv.from_entity_type,issuer_id);');
  v_new := replace(v_new, c_to,
    'INTO recipient_users FROM public.fn_accounting_invoice_party_users(inv.to_entity_type,recipient_id);');

  EXECUTE v_new;

  v_def := pg_get_functiondef(c_fn);
  IF position('fn_accounting_party_users(' in v_def) > 0
     OR (length(v_def) - length(replace(v_def, 'fn_accounting_invoice_party_users(', '')))
        <> 2 * length('fn_accounting_invoice_party_users(') THEN
    RAISE EXCEPTION 'invoice delivery still resolves a party through the caller filter';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_accounting_invoice_party_users(text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_accounting_invoice_party_users(text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can execute the delivery resolver';
  END IF;
END
$do$;

COMMIT;
