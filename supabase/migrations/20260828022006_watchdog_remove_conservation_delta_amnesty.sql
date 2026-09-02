-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828022006; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
-- watchdog_remove_conservation_delta_amnesty
-- ============================================================================
-- WHAT WAS WRONG
--
-- fn_tournament_conservation_delta is the single definition of "did this
-- tournament conserve money". It computes:
--
--     money_in - refunds - rake - prizes - bounties + funded_overlay
--
-- money_in is the sum of real player wallet debits (buy-ins, rebuys, add-ons).
-- prizes/bounties are real player wallet credits. funded_overlay is real club
-- money that was actually booked into tournament_guarantee_overlays. So the
-- expression above is a genuine ledger identity: it should be ~0 for a healthy
-- event, negative when the house paid out money nobody put in, positive when
-- the house kept money it never paid out.
--
-- On top of that identity the function carried a fourth term:
--
--     + CASE WHEN m.ended_at < '2026-08-27T12:00:00Z' AND NOT m.has_overlay_row
--            THEN GREATEST(m.pool - (m.money_in - m.refunds - m.rake - m.bounty_pool), 0)
--            ELSE 0 END
--
-- Read that carefully, because it is not a rounding allowance. It says: for any
-- event that ended before noon UTC on 2026-08-27 and that has NO overlay row --
-- i.e. no club actually funded the shortfall -- pretend the shortfall was
-- funded anyway, to exactly the amount needed to make the advertised prize_pool
-- add up. It manufactures the missing money out of nothing, purely inside the
-- watchdog's arithmetic, and only for events old enough to be embarrassing.
-- The NOT has_overlay_row guard makes it worse, not better: the fake credit is
-- applied precisely to the events where no real money was ever put in.
--
-- The effect is that unfunded guarantees -- money credited to players that the
-- platform never collected and never funded -- net to zero and stop being
-- flagged. Every historical overlay shortfall was invisible by construction.
--
-- MEASURED IMPACT (full 365-day window, tolerance 1.0, measured before this
-- migration, 14,491 qualifying tournaments):
--
--   with the amnesty term:      2,550 events outside tolerance
--   without the amnesty term:   1,581 events outside tolerance
--   of those 1,581:             1,548 are negative (paid out money never
--                               collected) totalling 269,975.29 chips
--                               33 are positive (retained and never paid out)
--                               totalling 2,086.01 chips
--
-- Note the counts move in both directions. The amnesty term is GREATEST(...,0),
-- so it can only ever push a delta more positive. For genuinely unfunded events
-- it cancelled a real negative delta and hid it; for events that were already
-- balanced it invented a positive delta and produced a false positive. It was
-- not a conservative safety margin in either direction -- it was noise that
-- happened to zero out the specific failure mode we most needed to see.
--
-- WHAT THIS MIGRATION DOES
--
-- Deletes the CASE term. Nothing else. The remaining expression is byte-for-byte
-- the original ledger identity, with the same rounding, the same COALESCEs, the
-- same category filters, the same volatility (STABLE), the same SECURITY DEFINER
-- and search_path, and the same signature and return type.
--
-- Three CTE columns become dead once the CASE is gone, and are dropped with it:
--   pool, bounty_pool  -- plain columns off tournaments, only read by the CASE
--   has_overlay_row    -- an EXISTS subquery, only read by the CASE
-- Dropping has_overlay_row removes one correlated subquery per tournament, which
-- matters now that the caller scans ~14k events per run instead of 500.
-- funded_overlay is KEPT and still added: that one is real club money.
--
-- This changes DETECTION ONLY. No money row is written, moved, or backfilled by
-- this migration. The 269,975.29 chips of unfunded liability it exposes are a
-- remediation question for a human, not something a watchdog should quietly fix.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_tournament_conservation_delta(p_tournament_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH m AS (
    SELECT t.id, t.ended_at,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'debit'
           AND w.category IN ('tournament_buyin','rebuy','addon')), 0) AS money_in,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'refund'), 0) AS refunds,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'prize'), 0) AS prizes,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'bounty'), 0) AS bounties,
      COALESCE((SELECT sum(r.rake_amount) FROM public.rake_records r
         WHERE r.tournament_id = t.id AND r.is_tournament), 0) AS rake,
      COALESCE((SELECT o.amount FROM public.tournament_guarantee_overlays o
         WHERE o.tournament_id = t.id), 0) AS funded_overlay
    FROM public.tournaments t WHERE t.id = p_tournament_id
  )
  SELECT round(
      m.money_in - m.refunds - m.rake - m.prizes - m.bounties
    + m.funded_overlay
  , 2)
  FROM m;
$fn$;

COMMENT ON FUNCTION public.fn_tournament_conservation_delta(uuid) IS
'True money-conservation delta for one tournament: money_in - refunds - rake - prizes - bounties + funded_overlay. Negative = paid out money never collected. Positive = retained money never paid out. The pre-2026-08-27 amnesty term that faked unfunded guarantee overlays back into the result was removed 2026-08-28 (migration watchdog_remove_conservation_delta_amnesty). Do not re-add it: if a guarantee was genuinely funded, book a row in tournament_guarantee_overlays instead.';

