-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902183553; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- TWO REPAIR PATHS, ONE OBLIGATION, PAID TWICE.
--
-- Found 2026-09-02 while investigating the PROFIT DRIFT that has had
-- settlement frozen since 2026-08-26. Tournament 9a7f48d2, place 1, one
-- player, three rows:
--
--   structure        70.20   tourney:<tid>:prize:place:1
--   overlay_backpay   4.80   tourney:<tid>:overlay_backpay:<uid>
--   reconcile         4.80   tourney:<tid>:prize:<uid>:1:reconcile
--
-- The second and third rows are THE SAME DEBT - this player's shortfall for
-- that place - discovered and paid by two different repair paths. They are not
-- caught by uq_tournament_payouts_idempotency_key because each path builds its
-- key out of its OWN name. The key is namespaced by the repairer instead of by
-- the thing being repaired, so two repairers can never see each other's work.
--
-- Measured over seven days: 57 completed tournaments paid out more prize money
-- than their prize pool, 3,808.52 chips in total. 56 of those obligations are
-- provably this exact pattern (1,964.90 chips where both rows carry the same
-- amount; the rest differ per player and are the same bug spread thinner).
--
-- WHAT THIS IS NOT: bounties are NOT involved. An early read of the alert
-- blamed the audit for ignoring bounty_pool, and that was wrong - bounty pays
-- into wallet_transactions.category = 'bounty', which the prize audit never
-- counts, and on the worst offender it reconciled exactly (1,020.00 paid
-- against a 1,020.00 pool). The excess is genuinely in the prize category.
--
-- WHY THIS DETECTS RATHER THAN BLOCKS. A BEFORE INSERT trigger could refuse
-- the second payment outright, and that is the wrong instinct here for the
-- same reason ca_seat_stack_exits does not block a seat exit (CLAUDE.md 11.5):
-- a guard that can refuse a payment can strand a player who is genuinely owed
-- money, and the failure would be silent and in the player's disfavour.
-- Over-payment is recoverable; a refused legitimate payout is a support
-- ticket. So this makes the condition LOUD and leaves the money alone.
--
-- Bounty sources are excluded by design: a player who knocks out four
-- opponents legitimately receives four equal payments at the same finishing
-- position, which is not a duplicate.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.fn_tournament_double_paid_obligations(integer);

CREATE OR REPLACE FUNCTION public.fn_tournament_double_paid_obligations(p_hours integer DEFAULT 24)
RETURNS TABLE (
  tournament_id   uuid,
  tournament_name text,
  player_id       uuid,
  finish_position integer,
  amount          numeric,
  payments        bigint,
  sources         text,
  excess_chips    numeric,
  last_paid_at    timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH prize_side AS (
    -- The prize ladder and the three paths that top it up. Bounty sources are
    -- deliberately absent: repeated equal bounty payments are correct.
    SELECT p.tournament_id, p.user_id, p.position, p.amount, p.source, p.paid_at
      FROM public.tournament_payouts p
      JOIN public.tournaments t ON t.id = p.tournament_id
     WHERE p.source IN ('structure', 'reconcile', 'overlay_backpay', 'spin_backpay')
       AND p.user_id IS NOT NULL
       AND t.ended_at > now() - make_interval(hours => GREATEST(COALESCE(p_hours, 24), 1))
  )
  SELECT ps.tournament_id,
         t.name,
         ps.user_id,
         ps.position,
         ps.amount,
         count(*)                                              AS payments,
         string_agg(DISTINCT ps.source, '+' ORDER BY ps.source) AS sources,
         round(ps.amount * (count(*) - 1), 2)                  AS excess_chips,
         max(ps.paid_at)                                       AS last_paid_at
    FROM prize_side ps
    JOIN public.tournaments t ON t.id = ps.tournament_id
   GROUP BY ps.tournament_id, t.name, ps.user_id, ps.position, ps.amount
  HAVING count(*) > 1
     -- More than one DISTINCT source is what makes it two repairers rather
     -- than one path legitimately paying an amount that happens to repeat.
     AND count(DISTINCT ps.source) > 1
   ORDER BY 8 DESC;
$fn$;

COMMENT ON FUNCTION public.fn_tournament_double_paid_obligations(integer) IS
  'Prize obligations paid by two different repair paths (structure/reconcile/overlay_backpay/spin_backpay). Each row is one debt settled more than once because the idempotency key is namespaced by the repairer, not by the debt. Bounty sources excluded - repeated equal bounty payments are correct.';

GRANT EXECUTE ON FUNCTION public.fn_tournament_double_paid_obligations(integer) TO service_role;
