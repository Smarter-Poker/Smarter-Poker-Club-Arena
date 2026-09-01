-- =============================================================================
-- who_sees_what_in_the_trade_ledger
-- Applied to production via Supabase MCP 2026-09-01 17:04 UTC.
--
-- Dan, 2026-09-01, verbatim: "all transactions records need to be the same
-- across the board for all wallets based on roles. Owners, co owners admin's
-- and super agents should be able to see all transactions. Agents and
-- players, just there own downlines, players only there transactions by
-- them or an agent/upline managers moves with there chips."
--
-- The Cashier's Trade Record hardcoded from/to = viewer, so the OWNER of a
-- club saw two rows while the club-bank modal (a bank-role RPC) showed all
-- 448. One server-side function now answers "which transactions may this
-- viewer see" for every surface:
--
--   owner / co_owner / admin / super_agent  -> every club transaction
--   agent / sub_agent                       -> rows where either party is
--                                              themselves or in their downline
--   player                                  -> rows where they are a party
--
-- SECURITY DEFINER, viewer from auth.uid() only, active membership required.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_club_trade_ledger(
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
  from_name text,
  to_name text
)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_role text;
  v_limit integer := least(greatest(coalesce(p_limit,50),1),200);
  v_offset integer := greatest(coalesce(p_offset,0),0);
BEGIN
  IF v_viewer IS NULL OR p_club_id IS NULL THEN RETURN; END IF;

  SELECT cm.role INTO v_role FROM club_members cm
   WHERE cm.club_id=p_club_id AND cm.user_id=v_viewer
     AND coalesce(cm.status,'active') IN ('active','approved');
  IF v_role IS NULL THEN RETURN; END IF;

  IF v_role IN ('owner','co_owner','admin','super_agent') THEN
    RETURN QUERY
    SELECT ct.id, ct.created_at, ct.transaction_type, ct.amount,
           ct.from_user_id, ct.to_user_id, ct.notes,
           coalesce(pf.alias, pf.display_name, pf.username),
           coalesce(pt.alias, pt.display_name, pt.username)
      FROM chip_transactions ct
      LEFT JOIN profiles pf ON pf.id=ct.from_user_id
      LEFT JOIN profiles pt ON pt.id=ct.to_user_id
     WHERE ct.club_id=p_club_id
     ORDER BY ct.created_at DESC
     LIMIT v_limit OFFSET v_offset;

  ELSIF v_role IN ('agent','sub_agent') THEN
    RETURN QUERY
    WITH RECURSIVE dl AS (
      SELECT v_viewer AS user_id
      UNION
      SELECT cm.user_id FROM club_members cm JOIN dl ON cm.agent_id=dl.user_id
       WHERE cm.club_id=p_club_id
    )
    SELECT ct.id, ct.created_at, ct.transaction_type, ct.amount,
           ct.from_user_id, ct.to_user_id, ct.notes,
           coalesce(pf.alias, pf.display_name, pf.username),
           coalesce(pt.alias, pt.display_name, pt.username)
      FROM chip_transactions ct
      LEFT JOIN profiles pf ON pf.id=ct.from_user_id
      LEFT JOIN profiles pt ON pt.id=ct.to_user_id
     WHERE ct.club_id=p_club_id
       AND (ct.from_user_id IN (SELECT dl.user_id FROM dl)
         OR ct.to_user_id   IN (SELECT dl.user_id FROM dl))
     ORDER BY ct.created_at DESC
     LIMIT v_limit OFFSET v_offset;

  ELSE
    RETURN QUERY
    SELECT ct.id, ct.created_at, ct.transaction_type, ct.amount,
           ct.from_user_id, ct.to_user_id, ct.notes,
           coalesce(pf.alias, pf.display_name, pf.username),
           coalesce(pt.alias, pt.display_name, pt.username)
      FROM chip_transactions ct
      LEFT JOIN profiles pf ON pf.id=ct.from_user_id
      LEFT JOIN profiles pt ON pt.id=ct.to_user_id
     WHERE ct.club_id=p_club_id
       AND (ct.from_user_id=v_viewer OR ct.to_user_id=v_viewer)
     ORDER BY ct.created_at DESC
     LIMIT v_limit OFFSET v_offset;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_club_trade_ledger(uuid,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_trade_ledger(uuid,integer,integer) TO authenticated, service_role;
