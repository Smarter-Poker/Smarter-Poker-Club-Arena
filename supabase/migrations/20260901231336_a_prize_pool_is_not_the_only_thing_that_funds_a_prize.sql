-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901231336; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 3: THE OVERPAY ALARM WAS COMPARING AGAINST THE WRONG NUMBER
--
-- FeeReconciler.prize_disbursement flags a completed tournament whose credits
-- exceed `prize_pool`. Over ten days that fires on 37 events for 20,085.58
-- chips, and most of it is by design:
--
--   * SATELLITES award SEATS at a fixed value, not a share of the pool. A 540
--     pool paying four 200 seats is the club funding the seats, exactly as
--     advertised. 9 events.
--   * SPINS pay a club-funded multiple of the buy-in. That is the whole game.
--     28,710 of the last ten days' events are Spins.
--   * GUARANTEES are a promise to top the pool up to a floor. An overlay is
--     the club paying what it said it would.
--
-- A detector that fires on all three teaches everyone to ignore it - the same
-- disease as the tournament conservation check in Phase 2 - and it hid the
-- part that is NOT explained.
--
-- CARE WITH THE SPIN TEST: `spin_type` is 'standard' on every row in the
-- table, including MTT freezeouts. Excluding on `spin_type IS NULL` reports
-- zero unexplained events and silently buries an 18,381.60 chip discrepancy
-- on an MTT. The honest discriminator is tournament_type = 'SPIN', which
-- matches spin_multiplier > 0 exactly (28,710 both ways).
--
-- With satellites, Spins and guarantees accounted for, TEN MTT events remain
-- unexplained for 18,899.68 chips, 97% of it a single event. Those are the
-- ones worth a person's attention, and now they are the only ones that will
-- reach one.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_ca_prize_overpay_unexplained(
  p_window interval DEFAULT '10 days'::interval
)
RETURNS TABLE(tournament_id uuid, name text, ended_at timestamptz,
              prize_pool numeric, guaranteed_prize numeric, paid numeric, excess numeric)
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
                        -- bounty money is funded by the bounty pool, not the
                        -- prize pool, and is reconciled by its own check
                        AND COALESCE(w.category, '') <> 'bounty'), 0) AS paid
      FROM public.tournaments t
     WHERE t.status = 'COMPLETED'
       AND COALESCE(t.prize_pool, 0) > 0
       AND t.ended_at > now() - p_window
  )
  SELECT id, name, ended_at, pool, guar, paid, round(paid - GREATEST(pool, guar), 2)
    FROM p
   WHERE paid > GREATEST(pool, guar) + 0.01
     AND seats = 0                       -- a seat is not a share of the pool
     AND tournament_type <> 'SPIN'       -- a Spin pays a club-funded multiple
   ORDER BY paid - GREATEST(pool, guar) DESC;
$fn$;

COMMENT ON FUNCTION public.fn_ca_prize_overpay_unexplained(interval) IS
  'Tournaments that paid out more than the pool AND more than any guarantee, excluding satellites (fixed seat value) and Spins (club-funded multiplier). These are the overpayments nothing accounts for. Do NOT filter Spins on spin_type: it is the string standard on every row in the table, MTTs included, and using it hides real discrepancies.';

REVOKE ALL ON FUNCTION public.fn_ca_prize_overpay_unexplained(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_prize_overpay_unexplained(interval) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_prize_overpay_count()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT count(*)::int FROM public.fn_ca_prize_overpay_unexplained('10 days'::interval);
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_prize_overpay_count() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_prize_overpay_count() TO service_role;

INSERT INTO public.ca_ratchet_baselines (ratchet, baseline, note)
SELECT 'prize_overpay_unexplained_10d',
       public.fn_ca_prize_overpay_count(),
       'Completed tournaments paying beyond both pool and guarantee, excluding satellites and Spins, in a rolling 10 days. 10 events / 18,899.68 chips on 2026-09-01, 97% of it one MTT (Sunday $200 Deep Stack: 115 entrants, 133 rebuys, pool 44,640, guarantee 20,000, paid 63,021.60). Rolling window, so this falls on its own as those events age out; a RISE means settlement is creating chips again.'
ON CONFLICT (ratchet) DO NOTHING;

