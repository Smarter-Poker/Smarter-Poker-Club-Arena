-- 20261010005048_a_cashier_list_names_a_member_by_the_arena_name.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (cashier launch audit C6-04, 2026-10-09):
--
-- In the Club Arena a member is called by their poker alias, never by the
-- World Hub name (tests/theArenaIsAlwaysTheAlias.law.test.ts). The one rule
-- is public.fn_arena_name: the alias, then the username, then a display name
-- that is not the member's real name, then 'Player'. Two cashier lists still
-- name people their own way:
--
--   fn_agent_wallet_reversible, the claim-back list (Trade page, wallet
--   cashier, agent management), names the recipient by display_name FIRST.
--   On production (read 2026-10-09) that prints the World Hub name instead of
--   the alias for 940 of the 1,011 profiles that belong to a club, and a
--   member's real name for 2 of them.
--
--   fn_club_trade_ledger, the Trade record and its export, names each side
--   coalesce(alias, display_name, username): with no alias it prints the
--   display name ahead of the username (1 club member today, and 594 profiles
--   the day they join a club).
--
-- Both now name a profile with public.fn_arena_name, the rule every other
-- arena surface and the chip statement (20261009223439) use. A side with no
-- profile is named as before: NULL on the Trade record (the screen prints
-- Club Bank or A Member), 'Member' on the claim-back list.
--
-- Not changed: which rows each role sees, their order and page bounds, every
-- other column, SECURITY DEFINER, search_path, lock_timeout and grants
-- (authenticated and service_role EXECUTE, never anon). Proved on PostgreSQL
-- 17 against production's live bodies (md5 ea5a5a57ec31f396958246def887e5e6 and
-- 61b3478f0332f8ee7945d6eb2810bb71, reproduced byte for byte) and production's
-- fn_arena_name, fn_club_bank_role and fn_club_active_cashier_edges
-- (scripts/ci/test-cashier-arena-names-db-postgres.py,
-- tests/fixtures/cashier-arena-names-db/scenario.sql: it fails before and
-- passes after). The release contract
-- (scripts/verification-harness/cashier-release-contract.sql) accepts the
-- installed bodies and, until they are installed, the live ones.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure)) = 'd489a8b997a25320b0b4ec8b14a43587')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_agent_wallet_reversible(uuid)'::regprocedure)) = '3cc86bbb6317359a7b43fc34524d5876')

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure)) IS DISTINCT FROM 'ea5a5a57ec31f396958246def887e5e6' THEN
    RAISE EXCEPTION 'fn_club_trade_ledger is not the live text this migration was written against (md5 %)',
      md5(pg_get_functiondef('public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure)) USING ERRCODE = '55000';
  END IF;
  IF md5(pg_get_functiondef('public.fn_agent_wallet_reversible(uuid)'::regprocedure)) IS DISTINCT FROM '61b3478f0332f8ee7945d6eb2810bb71' THEN
    RAISE EXCEPTION 'fn_agent_wallet_reversible is not the live text this migration was written against (md5 %)',
      md5(pg_get_functiondef('public.fn_agent_wallet_reversible(uuid)'::regprocedure)) USING ERRCODE = '55000';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.fn_club_trade_ledger(p_club_id uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, created_at timestamp with time zone, transaction_type text, amount numeric, from_user_id uuid, to_user_id uuid, notes text, metadata jsonb, from_name text, to_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_role text;
  -- Cashier exposes 250 rows and requests one sentinel row to decide whether
  -- another page exists. Preserve the established bounded RPC contract.
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 251);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  IF v_viewer IS NULL OR p_club_id IS NULL THEN RETURN; END IF;
  v_role := public.fn_club_bank_role(p_club_id, v_viewer);
  IF v_role IS NULL THEN RETURN; END IF;

  IF v_role IN ('owner', 'co_owner', 'admin', 'super_agent') THEN
    RETURN QUERY
    SELECT ct.id, ct.created_at, ct.transaction_type, ct.amount,
           ct.from_user_id, ct.to_user_id, ct.notes, ct.metadata,
           CASE WHEN pf.id IS NOT NULL THEN public.fn_arena_name(pf.alias, pf.username, pf.display_name, pf.first_name, pf.last_name, pf.full_name) END,
           CASE WHEN pt.id IS NOT NULL THEN public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name) END
      FROM public.chip_transactions ct
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
     WHERE ct.club_id = p_club_id
     ORDER BY ct.created_at DESC, ct.id DESC LIMIT v_limit OFFSET v_offset;
  ELSIF v_role IN ('agent', 'sub_agent') THEN
    RETURN QUERY
    WITH RECURSIVE dl AS (
      SELECT v_viewer AS user_id
      UNION
      SELECT edge.child
        FROM public.fn_club_active_cashier_edges(p_club_id) edge
        JOIN dl ON edge.parent = dl.user_id
    )
    SELECT ct.id, ct.created_at, ct.transaction_type, ct.amount,
           ct.from_user_id, ct.to_user_id, ct.notes, ct.metadata,
           CASE WHEN pf.id IS NOT NULL THEN public.fn_arena_name(pf.alias, pf.username, pf.display_name, pf.first_name, pf.last_name, pf.full_name) END,
           CASE WHEN pt.id IS NOT NULL THEN public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name) END
      FROM public.chip_transactions ct
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
     WHERE ct.club_id = p_club_id
       AND (ct.from_user_id IN (SELECT user_id FROM dl)
         OR ct.to_user_id IN (SELECT user_id FROM dl))
     ORDER BY ct.created_at DESC, ct.id DESC LIMIT v_limit OFFSET v_offset;
  ELSE
    RETURN QUERY
    SELECT ct.id, ct.created_at, ct.transaction_type, ct.amount,
           ct.from_user_id, ct.to_user_id, ct.notes, ct.metadata,
           CASE WHEN pf.id IS NOT NULL THEN public.fn_arena_name(pf.alias, pf.username, pf.display_name, pf.first_name, pf.last_name, pf.full_name) END,
           CASE WHEN pt.id IS NOT NULL THEN public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name) END
      FROM public.chip_transactions ct
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
     WHERE ct.club_id = p_club_id
       AND (ct.from_user_id = v_viewer OR ct.to_user_id = v_viewer)
     ORDER BY ct.created_at DESC, ct.id DESC LIMIT v_limit OFFSET v_offset;
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_agent_wallet_reversible(p_club_id uuid)
 RETURNS TABLE(transaction_id uuid, to_user_id uuid, to_name text, amount numeric, claimed_back numeric, remaining numeric, destination text, created_at timestamp with time zone, reversible_until timestamp with time zone, seconds_left integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select t.id,
         t.to_user_id,
         CASE WHEN pr.id IS NULL THEN 'Member'
              ELSE public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                        pr.first_name, pr.last_name, pr.full_name)
         END::text,
         t.amount,
         coalesce((t.metadata ->> 'claimed_back')::numeric, 0),
         t.amount - coalesce((t.metadata ->> 'claimed_back')::numeric, 0),
         coalesce(t.metadata ->> 'destination', 'player_wallet'),
         t.created_at,
         t.reversible_until,
         greatest(0, ceil(extract(epoch from (t.reversible_until - now()))))::int
    from chip_transactions t
    left join profiles pr on pr.id = t.to_user_id
   where t.club_id = p_club_id
     and t.transaction_type = 'agent_wallet_send'
     and t.from_user_id = auth.uid()
     and coalesce(t.is_reversed, false) = false
     and t.reversible_until is not null
     and t.reversible_until > now()
     and t.amount - coalesce((t.metadata ->> 'claimed_back')::numeric, 0) > 0
   order by t.created_at desc
   limit 50;
$function$;

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure)) IS DISTINCT FROM 'd489a8b997a25320b0b4ec8b14a43587' THEN
    RAISE EXCEPTION 'fn_club_trade_ledger is not the reviewed text (md5 %)',
      md5(pg_get_functiondef('public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure)) USING ERRCODE = '55000';
  END IF;
  IF md5(pg_get_functiondef('public.fn_agent_wallet_reversible(uuid)'::regprocedure)) IS DISTINCT FROM '3cc86bbb6317359a7b43fc34524d5876' THEN
    RAISE EXCEPTION 'fn_agent_wallet_reversible is not the reviewed text (md5 %)',
      md5(pg_get_functiondef('public.fn_agent_wallet_reversible(uuid)'::regprocedure)) USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure
       AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig @> ARRAY['search_path=public, pg_temp', 'lock_timeout=5s']
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_agent_wallet_reversible(uuid)'::regprocedure
       AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ) OR has_function_privilege('anon', 'public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure, 'EXECUTE')
    OR has_function_privilege('anon', 'public.fn_agent_wallet_reversible(uuid)'::regprocedure, 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure, 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.fn_agent_wallet_reversible(uuid)'::regprocedure, 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure, 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.fn_agent_wallet_reversible(uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'a cashier list lost its definer posture or its grants' USING ERRCODE = '55000';
  END IF;
END $post$;

COMMIT;
