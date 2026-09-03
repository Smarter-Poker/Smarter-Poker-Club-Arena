-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902010204; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- THE GUARANTEE OVERLAY IS NOT BEING FUNDED
--
-- Dan asked the right question: "we never have to worry about wrong amounts
-- getting paid out or users not getting paid out?!" The honest answer was no,
-- and the reason the platform could not answer it is that every settlement
-- check built so far - mine included - only looked at OVERpayment. Nothing
-- watched the direction that hurts a player.
--
-- Measured over 48 hours, excluding satellites (they pay in seats) and Spins
-- (club-funded multiplier): 8,380 completed events, 4 overpaid, and SIX
-- UNDERPAID by 1,703.00 chips. All six have the same signature -
--
--   credited == prize_pool exactly, and guaranteed_prize > prize_pool
--
--   Union Grand Championship  pool 1,860  guarantee 2,500  paid 1,860  -640
--   Union Grand Championship  pool 2,040  guarantee 2,500  paid 2,040  -460
--   Union Mystery Bounty      pool   450  guarantee   800  paid   450  -350
--   Evening Mystery Bounty    pool   225  guarantee   400  paid   225  -175
--   Afternoon Bounty          pool   138  guarantee   200  paid   138   -62
--   Turbo Tuesday Opener      pool   234  guarantee   250  paid   234   -16
--
-- A guarantee is a promise that the pool will be topped up to a floor if the
-- field falls short. These events paid out only what the field put in. The
-- advertised number and the paid number are different, and the difference is
-- owed to players.
--
-- financial_alerts already has a Tournament.guarantee_not_met source. It fired
-- once, on 2026-08-31, and nothing acted on it. A detector nobody reads is the
-- theme of this whole sweep, which is why this becomes a ratchet instead.
--
-- WHAT THIS DOES: measures settlement in BOTH directions and makes the
-- underpaid side a critical. It moves no money - funding the overlay is Dan's
-- call, the same way the over-rake was.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_settlement_mismatch(
  p_window interval DEFAULT '48 hours'::interval
)
RETURNS TABLE(kind text, tournament_id uuid, name text, ended_at timestamptz,
              prize_pool numeric, guaranteed_prize numeric, paid numeric, delta numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH p AS (
    SELECT t.id, t.name, t.ended_at, t.tournament_type,
           round(COALESCE(t.prize_pool, 0), 2)       AS pool,
           round(COALESCE(t.guaranteed_prize, 0), 2) AS guar,
           COALESCE(t.satellite_seats, 0)            AS seats,
           COALESCE((SELECT round(sum(w.amount), 2)
                       FROM public.wallet_transactions w
                      WHERE w.related_entity_id = t.id
                        AND w.type = 'credit'
                        AND COALESCE(w.category, '') <> 'bounty'), 0) AS paid
      FROM public.tournaments t
     WHERE t.status = 'COMPLETED'
       AND COALESCE(t.prize_pool, 0) > 0
       AND t.ended_at > now() - p_window
       -- a satellite pays in SEATS and a Spin pays a club-funded multiple;
       -- neither is measurable against the pool. Do NOT use spin_type here:
       -- it is the string 'standard' on every row in the table, MTTs included.
       AND COALESCE(t.satellite_seats, 0) = 0
       AND t.tournament_type <> 'SPIN'
  )
  SELECT 'underpaid', id, name, ended_at, pool, guar, paid,
         round(GREATEST(pool, guar) - paid, 2)
    FROM p WHERE paid + 0.01 < GREATEST(pool, guar)
  UNION ALL
  SELECT 'overpaid', id, name, ended_at, pool, guar, paid,
         round(paid - GREATEST(pool, guar), 2)
    FROM p WHERE paid > GREATEST(pool, guar) + 0.01
   ORDER BY 8 DESC;
$fn$;

COMMENT ON FUNCTION public.fn_ca_tournament_settlement_mismatch(interval) IS
  'Completed tournaments where the credits do not match what the event owed: GREATEST(prize_pool, guaranteed_prize). Reports BOTH directions - underpaid is a player who did not get what was promised, overpaid is chips created. Excludes satellites (paid in seats) and Spins (club-funded multiplier).';

REVOKE ALL ON FUNCTION public.fn_ca_tournament_settlement_mismatch(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_settlement_mismatch(interval) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_underpaid_count()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT count(*)::int
    FROM public.fn_ca_tournament_settlement_mismatch('48 hours'::interval)
   WHERE kind = 'underpaid';
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_underpaid_count() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_underpaid_count() TO service_role;

INSERT INTO public.ca_ratchet_baselines (ratchet, baseline, note)
SELECT 'tournament_underpaid_48h',
       public.fn_ca_tournament_underpaid_count(),
       'Completed tournaments in the last 48h that paid players LESS than the event owed - GREATEST(prize_pool, guaranteed_prize) - excluding satellites and Spins. Every one found on 2026-09-02 was a guarantee that was never topped up: 6 events, 1,703.00 chips owed to players. This is the direction that hurts a player, and until now nothing watched it.'
ON CONFLICT (ratchet) DO NOTHING;

