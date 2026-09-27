-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820003449 "fn_club_deletion_impact"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a07bb7b81154c5ec929c46b804532518 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Authoritative "what would deleting this club destroy?" for the Club Settings
-- danger zone.
--
-- The client-side version of this check (pass 7) queried club_members, tables
-- and club_wallets directly. Two of those work; the wallet one never did:
-- club_wallets has RLS ENABLED WITH ZERO POLICIES, so an owner's SELECT returns
-- no rows rather than an error. The guard therefore reported "0 chips" for
-- every club. Midway Union holds 40,258.57 chips at the time of writing, and
-- club_wallets.club_id is ON DELETE CASCADE — the wallet would have been
-- destroyed with the club by a guard that was supposed to stop exactly that.
--
-- SECURITY DEFINER so the owner can see the number without opening club_wallets
-- to client reads. Read-only (STABLE), owner-gated internally, and it counts
-- BOTH balance columns.
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

  -- Both columns: a club can hold chips in the insurance balance too.
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_club_deletion_impact'
  ) THEN
    RAISE EXCEPTION 'post-apply: fn_club_deletion_impact missing';
  END IF;
END $$;
