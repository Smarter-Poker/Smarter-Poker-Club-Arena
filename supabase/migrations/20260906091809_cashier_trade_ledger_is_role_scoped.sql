-- 20260906091809_cashier_trade_ledger_is_role_scoped
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-06 09:18:09 UTC.
--
-- The database has exposed fn_club_trade_ledger since 2026-09-01, with the
-- intended role matrix (club-wide for owner/co_owner/admin/super_agent,
-- recursive downline for agent/sub_agent, self for player). The Cashier UI
-- never called it: it selected chip_transactions directly and hard-filtered
-- every role to auth.uid(), so elevated staff could not see the history the
-- product and database promised. The old function also omitted metadata,
-- preventing the UI from naming the source and destination wallets.
--
-- Recreate the same RPC signature with metadata in its returned row, retain
-- auth.uid() as the only viewer identity, require an active membership, and
-- filter the recursive downline to active memberships too. A canonical own-row
-- SELECT policy is also recorded here because production had one that was never
-- represented in migrations; clean schema replay must not make the remaining
-- self-history readers fail differently from production.

BEGIN;

-- Do not wait behind a long-running ledger query while replacing its function
-- or policy. A bounded, retryable deploy failure is safer than wedging DDL.
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.fn_club_trade_ledger(uuid, integer, integer);

CREATE FUNCTION public.fn_club_trade_ledger(
  p_club_id uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
) RETURNS TABLE (
  id uuid,
  created_at timestamptz,
  transaction_type text,
  amount numeric,
  from_user_id uuid,
  to_user_id uuid,
  notes text,
  metadata jsonb,
  from_name text,
  to_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_role text;
  -- The UI exposes up to 250 rows and asks for one sentinel row to prove that
  -- another page exists. A cap of 200 made the 200 -> 250 control disappear:
  -- p_limit=201 was silently reduced to 200, so the browser concluded there
  -- was no 201st row. Keep the endpoint bounded while honoring that contract.
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 251);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  IF v_viewer IS NULL OR p_club_id IS NULL THEN
    RETURN;
  END IF;

  SELECT cm.role
    INTO v_role
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id
     AND cm.user_id = v_viewer
     AND coalesce(cm.status::text, 'active') IN ('active', 'approved')
   LIMIT 1;

  IF v_role IS NULL THEN
    RETURN;
  END IF;

  IF v_role IN ('owner', 'co_owner', 'admin', 'super_agent') THEN
    RETURN QUERY
    SELECT ct.id, ct.created_at, ct.transaction_type, ct.amount,
           ct.from_user_id, ct.to_user_id, ct.notes, ct.metadata,
           coalesce(pf.alias, pf.display_name, pf.username),
           coalesce(pt.alias, pt.display_name, pt.username)
      FROM public.chip_transactions ct
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
     WHERE ct.club_id = p_club_id
     ORDER BY ct.created_at DESC, ct.id DESC
     LIMIT v_limit OFFSET v_offset;
  ELSIF v_role IN ('agent', 'sub_agent') THEN
    RETURN QUERY
    WITH RECURSIVE downline AS (
      SELECT v_viewer AS user_id
      UNION
      SELECT cm.user_id
        FROM public.club_members cm
        JOIN downline d ON cm.agent_id = d.user_id
       WHERE cm.club_id = p_club_id
         AND coalesce(cm.status::text, 'active') IN ('active', 'approved')
    )
    SELECT ct.id, ct.created_at, ct.transaction_type, ct.amount,
           ct.from_user_id, ct.to_user_id, ct.notes, ct.metadata,
           coalesce(pf.alias, pf.display_name, pf.username),
           coalesce(pt.alias, pt.display_name, pt.username)
      FROM public.chip_transactions ct
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
     WHERE ct.club_id = p_club_id
       AND (ct.from_user_id IN (SELECT d.user_id FROM downline d)
         OR ct.to_user_id IN (SELECT d.user_id FROM downline d))
     ORDER BY ct.created_at DESC, ct.id DESC
     LIMIT v_limit OFFSET v_offset;
  ELSE
    RETURN QUERY
    SELECT ct.id, ct.created_at, ct.transaction_type, ct.amount,
           ct.from_user_id, ct.to_user_id, ct.notes, ct.metadata,
           coalesce(pf.alias, pf.display_name, pf.username),
           coalesce(pt.alias, pt.display_name, pt.username)
      FROM public.chip_transactions ct
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
     WHERE ct.club_id = p_club_id
       AND (ct.from_user_id = v_viewer OR ct.to_user_id = v_viewer)
     ORDER BY ct.created_at DESC, ct.id DESC
     LIMIT v_limit OFFSET v_offset;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_club_trade_ledger(uuid, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_trade_ledger(uuid, integer, integer)
  TO authenticated, service_role;

ALTER TABLE public.chip_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chip_transactions_select_own ON public.chip_transactions;
CREATE POLICY chip_transactions_select_own
  ON public.chip_transactions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = from_user_id OR auth.uid() = to_user_id);

-- The browser may keep its own ledger rows. Pre-login callers have no reason
-- to read a financial journal, even if RLS would currently return zero rows.
REVOKE SELECT ON TABLE public.chip_transactions FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.chip_transactions TO authenticated, service_role;

DO $post_apply$
DECLARE
  v_function oid := to_regprocedure(
    'public.fn_club_trade_ledger(uuid,integer,integer)'
  );
  v_authenticated oid := to_regrole('authenticated');
  v_anon oid := to_regrole('anon');
  v_service_role oid := to_regrole('service_role');
  v_own pg_catalog.pg_policy%ROWTYPE;
  v_union pg_catalog.pg_policy%ROWTYPE;
  v_qual text;
BEGIN
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'POST-APPLY: fn_club_trade_ledger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = v_function
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
       AND p.proconfig @> ARRAY['lock_timeout=5s']::text[]
  ) THEN
    RAISE EXCEPTION 'POST-APPLY: ledger RPC lost SECURITY DEFINER, STABLE, search_path, or lock_timeout';
  END IF;

  IF has_function_privilege('anon', v_function, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_function, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_function, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-APPLY: ledger RPC execute roles are wrong';
  END IF;

  -- No explicit EXECUTE grantee except the owner and the two intended roles.
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        coalesce(p.proacl, acldefault('f', p.proowner))
      ) acl
     WHERE p.oid = v_function
       AND acl.privilege_type = 'EXECUTE'
       AND acl.grantee <> ALL (
         ARRAY[p.proowner, v_authenticated, v_service_role]::oid[]
       )
  ) THEN
    RAISE EXCEPTION 'POST-APPLY: ledger RPC has an unexpected EXECUTE grantee';
  END IF;

  IF has_table_privilege('anon', 'public.chip_transactions', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.chip_transactions', 'SELECT') THEN
    RAISE EXCEPTION 'POST-APPLY: chip_transactions browser SELECT grants are wrong';
  END IF;

  SELECT p.* INTO v_own
    FROM pg_policy p
   WHERE p.polrelid = 'public.chip_transactions'::regclass
     AND p.polname = 'chip_transactions_select_own';
  IF NOT FOUND
     OR NOT v_own.polpermissive
     OR v_own.polcmd <> 'r'
     OR v_own.polroles <> ARRAY[v_authenticated]::oid[]
     OR v_own.polwithcheck IS NOT NULL THEN
    RAISE EXCEPTION 'POST-APPLY: own-row ledger policy shape or roles are wrong';
  END IF;
  v_qual := regexp_replace(
    lower(pg_get_expr(v_own.polqual, v_own.polrelid)), '\s+', '', 'g'
  );
  IF v_qual <> '((auth.uid()=from_user_id)or(auth.uid()=to_user_id))' THEN
    RAISE EXCEPTION 'POST-APPLY: own-row ledger policy has unexpected scope: %', v_qual;
  END IF;

  -- Production also has one legitimate union-scoped read arm. Preserve it,
  -- but do not trust the name alone: its command, role, mode and both union
  -- authorization predicates must still be present.
  SELECT p.* INTO v_union
    FROM pg_policy p
   WHERE p.polrelid = 'public.chip_transactions'::regclass
     AND p.polname = 'union_overseer_read';
  IF FOUND THEN
    v_qual := regexp_replace(
      lower(pg_get_expr(v_union.polqual, v_union.polrelid)), '\s+', '', 'g'
    );
    IF NOT v_union.polpermissive
       OR v_union.polcmd <> 'r'
       OR v_union.polroles <> ARRAY[v_authenticated]::oid[]
       OR v_union.polwithcheck IS NOT NULL
       OR position('fn_is_any_union_overseer' IN v_qual) = 0
       OR position('fn_union_oversees_club' IN v_qual) = 0
       OR position('auth.uid()' IN v_qual) = 0 THEN
      RAISE EXCEPTION 'POST-APPLY: union_overseer_read has unexpected scope';
    END IF;
  END IF;

  -- Permissive policies are ORed. Any other policy addressed to PUBLIC, anon,
  -- or authenticated could silently broaden the own-row boundary.
  IF EXISTS (
    SELECT 1
      FROM pg_policy p
     WHERE p.polrelid = 'public.chip_transactions'::regclass
       AND p.polpermissive
       AND p.polcmd IN ('r', '*')
       AND p.polname NOT IN ('chip_transactions_select_own', 'union_overseer_read')
       AND (
         0::oid = ANY(p.polroles)
         OR v_anon = ANY(p.polroles)
         OR v_authenticated = ANY(p.polroles)
         OR EXISTS (
           SELECT 1
             FROM unnest(p.polroles) scoped_role(role_oid)
            WHERE CASE
              WHEN scoped_role.role_oid = 0 THEN false
              ELSE pg_has_role(v_anon, scoped_role.role_oid, 'MEMBER')
                OR pg_has_role(v_authenticated, scoped_role.role_oid, 'MEMBER')
            END
         )
       )
  ) THEN
    RAISE EXCEPTION 'POST-APPLY: an unknown browser SELECT policy can broaden chip_transactions';
  END IF;
END;
$post_apply$;

COMMIT;
