-- CLOSE THE ANONYMOUS ROLE ORACLES, AND STAND A GUARD OVER THE MONEY RPCs.
--
-- The Supabase security advisor reports 79 SECURITY DEFINER functions callable
-- by `anon` and 609 by `authenticated`. Two findings came from reading them
-- rather than counting them.
--
-- 1. THE MONEY MUTATORS ARE ACTUALLY GATED — NOTHING IS MASS-REVOKED.
-- fn_mint_club_chips raises unless the caller is union-authorised;
-- fn_admin_remove_player_chips and fn_cashout_approve return
-- {success:false,'Not Authenticated'} then role-check; the three settlement
-- round functions are already revoked from anon and authenticated alike.
-- Revoking EXECUTE from `authenticated` on functions the staff console
-- legitimately calls would break the console to fix a finding that is not true.
-- What is missing is not a grant change but a GUARD - built below.
--
-- 2. THE ROLE ORACLES ARE GENUINELY OPEN. These answer questions about other
-- people's roles and relationships without a login: fn_has_club_role,
-- fn_is_agent_of_player (maps the agent/downline tree), fn_is_union_overseer,
-- fn_is_any_union_overseer, fn_union_oversees_club, fn_is_horse_admin. None
-- moves a chip, so this is enumeration rather than theft - but there is no
-- legitimate anonymous caller, and an agent tree is exactly what a competitor
-- enumerates.
--
-- BOTH GRANTS HAVE TO GO. Each ACL reads `=X/postgres | anon=X/postgres | ...`.
-- The bare `=X/postgres` is the grant to PUBLIC, which anon inherits, so
-- REVOKE FROM anon alone changes nothing - the first cut of this migration did
-- exactly that and its own assertion caught it.
--
-- is_admin() IS DELIBERATELY LEFT ALONE: three RLS policies whose roles include
-- anon/public call it, and a policy expression is evaluated as the querying
-- role, so revoking would make those policies ERROR for logged-out visitors
-- rather than merely deny. Verified first: the six above appear in ZERO
-- anon-applicable policies. Closing is_admin needs those policies rewritten.

REVOKE EXECUTE ON FUNCTION public.fn_has_club_role(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_is_agent_of_player(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_is_union_overseer(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_is_any_union_overseer(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_union_oversees_club(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_is_horse_admin() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_has_club_role(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_is_agent_of_player(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_is_union_overseer(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_is_any_union_overseer(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_union_oversees_club(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_is_horse_admin() TO authenticated, service_role;

-- THE GUARD. A money-mutating SECURITY DEFINER function that `authenticated`
-- can call with no authorization gate is one missing line away from letting any
-- registered account mint chips. Nothing checked for that; this checks
-- continuously rather than the once I read them by hand.
--
-- RETURNS trigger is excluded (see 20260828082130): trigger functions have no
-- API caller and no caller to authorize, and four of them made the first run
-- report false positives. A check that always shows noise is a check nobody
-- reads - the exact failure that let 3,753 alerts pile up.
CREATE OR REPLACE FUNCTION public.fn_ungated_money_rpcs()
RETURNS TABLE(fn text, args text, reason text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p.proname::text,
         pg_get_function_identity_arguments(p.oid),
         'SECURITY DEFINER, executable by authenticated, writes to a money table, '
         || 'and never establishes who is asking'
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.prosecdef
     AND p.prokind = 'f'
     AND p.prorettype <> 'pg_catalog.trigger'::regtype
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
     AND p.prosrc ~* '(club_members|union_wallets|club_wallets|chip_treasury|wallet_transactions|chip_transactions|rake_records|spin_bonus_pools|bbj_)'
     AND p.prosrc ~* '(INSERT[[:space:]]+INTO|UPDATE[[:space:]]+|DELETE[[:space:]]+FROM)'
     AND p.prosrc !~* '(is_admin|is_club_admin|fn_has_club_role|fn_is_platform_admin|fn_is_union_overseer|fn_union_oversees_club|fn_actor_can_manage|fn_caller_is_engine|fn_is_horse_admin|auth\.uid)'
   ORDER BY 1;
$function$;

REVOKE ALL ON FUNCTION public.fn_ungated_money_rpcs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ungated_money_rpcs() TO service_role;

DO $post$
DECLARE v_n int; v_list text;
BEGIN
  IF has_function_privilege('anon', 'public.fn_is_agent_of_player(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_has_club_role(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_is_horse_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION 'the anon revokes did not take';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fn_has_club_role(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_is_union_overseer(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost a grant it needs; the revoke was too broad';
  END IF;
  IF NOT has_function_privilege('anon', 'public.is_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon lost is_admin(), which three anon-applicable RLS policies call';
  END IF;

  SELECT count(*), string_agg(fn, ', ') INTO v_n, v_list FROM public.fn_ungated_money_rpcs();
  IF v_n > 0 THEN
    RAISE EXCEPTION 'the guard reports % ungated money RPC(s), triage before landing: %', v_n, v_list;
  END IF;
  -- And it must still be capable of finding one.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_mint_club_chips'
                    AND p.prosrc ~* '(club_members|club_wallets|chip_treasury)'
                    AND p.prosrc ~* '(INSERT[[:space:]]+INTO|UPDATE[[:space:]]+)') THEN
    RAISE EXCEPTION 'the money-table/write predicate no longer matches fn_mint_club_chips; the guard is broken';
  END IF;
END
$post$;
