-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: 20260819e_fn_club_deletion_impact.sql   (applied to prod)
--
-- Authoritative "what would deleting this club destroy?" for the Club Settings
-- danger zone.
--
-- The client-side version (pass 7) queried club_members, tables and
-- club_wallets directly. Two of those work; the wallet one never did:
-- club_wallets has RLS ENABLED WITH ZERO POLICIES, so an owner's SELECT returns
-- no rows rather than an error. The guard therefore reported "0 chips" for
-- every club. Midway Union holds 40,352 chips at the time of writing, and
-- club_wallets.club_id is ON DELETE CASCADE — the wallet would have been
-- destroyed with the club by the very guard meant to prevent it.
--
-- SECURITY DEFINER so the owner can see the number without opening club_wallets
-- to client reads. Read-only (STABLE), owner-gated internally, counts BOTH
-- balance columns (chip_balance + insurance_balance).
--
-- Verified after applying: owner -> {members:327, running_tables:49,
-- wallet_chips:40352.78}; non-owner -> 'Only the club owner can inspect
-- deletion impact'; anon has no EXECUTE.
--
-- ROLLBACK: DROP FUNCTION IF EXISTS public.fn_club_deletion_impact(uuid);
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_club_deletion_impact(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_owner   uuid;
  v_members int;
  v_running int;
  v_chips   numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT owner_id INTO v_owner FROM public.clubs WHERE id = p_club_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Club not found';
  END IF;
  IF v_owner IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only the club owner can inspect deletion impact';
  END IF;

  SELECT count(*) INTO v_members
    FROM public.club_members WHERE club_id = p_club_id;

  SELECT count(*) INTO v_running
    FROM public.tables WHERE club_id = p_club_id AND COALESCE(status, '') <> 'closed';

  SELECT COALESCE(SUM(COALESCE(chip_balance, 0) + COALESCE(insurance_balance, 0)), 0)
    INTO v_chips
    FROM public.club_wallets WHERE club_id = p_club_id;

  RETURN jsonb_build_object(
    'members',        v_members,
    'running_tables', v_running,
    'wallet_chips',   v_chips
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_club_deletion_impact(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_club_deletion_impact(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_club_deletion_impact(uuid) TO authenticated;
