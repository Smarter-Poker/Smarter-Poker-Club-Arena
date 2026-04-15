-- ═══════════════════════════════════════════════════════════════════════════════
-- Bible V8 §4.X — increment_club_chip_pool RPC (rake fallback path)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- The engine's logRakeCollection (server/src/services/supabase.ts:539) calls
-- supabase.rpc('increment_club_chip_pool', {p_club_id, p_amount}) as a
-- fallback when the club doesn't have a club_wallets row. Production was
-- missing the function entirely, so EVERY post-hand rake credit was failing
-- with "Could not find the function public.increment_club_chip_pool" and
-- spamming Sentry.
--
-- Implementation: atomic upsert that bumps both the per-club running total
-- (clubs.chip_treasury) and the running rake aggregate (clubs.total_rake).
-- Mirrors increment_club_rake's signature but writes to chip_treasury so the
-- club's bankroll display tracks rake collected.
--
-- Discovered 2026-04-14 during E2E single-table testing — postHandTasks was
-- failing on every hand on the live engine.

CREATE OR REPLACE FUNCTION public.increment_club_chip_pool(
  p_club_id uuid,
  p_amount numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_club_id IS NULL OR p_amount IS NULL OR p_amount = 0 THEN
    RETURN;
  END IF;

  UPDATE public.clubs
  SET chip_treasury = COALESCE(chip_treasury, 0) + p_amount,
      total_rake    = COALESCE(total_rake, 0) + p_amount,
      updated_at    = now()
  WHERE id = p_club_id;
END;
$$;

-- Service role uses this via PostgREST RPC; grant invocation explicitly.
GRANT EXECUTE ON FUNCTION public.increment_club_chip_pool(uuid, numeric)
  TO anon, authenticated, service_role;
