-- ═══════════════════════════════════════════════════════════════════════════════
-- WHOLE-DOLLAR TOURNAMENT BUY-INS
-- Dan 2026-08-20: "buy ins should always be whole dollars. 20 10 50 5 etc not
-- 19.8 or weird numbers."
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS WRONG
-- Tournament configs authored TWO numbers — `buyIn: 18, rake: 1.8` — stored as
-- buy_in_amount / buy_in_fee. A player pays the SUM, so the advertised price
-- was 19.80. Same shape everywhere: 5 + 0.50 = 5.50, 10 + 1 = 11, 20 + 2 = 22.
-- Rake is a cut OF the buy-in, not a surcharge ON TOP of it; adding it outward
-- means the total is 1.1x a round number, which is essentially never round.
--
-- The code fix (src/utils/buyIn.ts + server/src/config/buyIn.ts) makes the
-- whole-dollar TOTAL the input and derives prize + fee from it. This migration
-- is the backstop: a constraint, so a third writer that has not read either
-- file fails loudly at the INSERT instead of quietly listing another 19.80 game.
--
-- WHAT THIS DELIBERATELY DOES **NOT** DO
-- It does not rewrite the 9,814 historical rows that carry non-whole totals.
-- Those columns are the record of what real players were actually charged.
-- Rewriting them would falsify the financial history that prize-pool and
-- rakeback reconciliation read back. History stays as it happened; only games
-- that have not yet taken a player's money are corrected, and only new writes
-- are constrained.
--
-- TIER 2 (adds a constraint; touches rows only where nothing has been paid).
-- ROLLBACK:
--   ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_whole_dollar_buyin;

BEGIN;

-- ── Pre-flight: the columns must be what we think they are ─────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tournaments'
       AND column_name IN ('buy_in_amount','buy_in_fee')
     GROUP BY table_name HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION 'tournaments.buy_in_amount / buy_in_fee not found - schema drift, aborting';
  END IF;
END $$;

-- ── Repair: only games that have NOT collected an entry fee ────────────────
-- REGISTERING with zero entries means no chips have moved. Snap the total to
-- the nearest whole dollar and re-split it 90/10, so the ladder the generator
-- now emits also applies to anything already sitting in the lobby.
WITH repairable AS (
  SELECT t.id,
         GREATEST(1, round(t.buy_in_amount + COALESCE(t.buy_in_fee, 0)))::numeric AS total
    FROM public.tournaments t
   WHERE t.status = 'REGISTERING'
     AND COALESCE(t.buy_in_fee, 0) > 0
     AND (t.buy_in_amount + COALESCE(t.buy_in_fee, 0)) <> round(t.buy_in_amount + COALESCE(t.buy_in_fee, 0))
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_registrations r WHERE r.tournament_id = t.id
     )
     AND COALESCE(t.current_players, 0) = 0
)
UPDATE public.tournaments t
   SET buy_in_fee    = round(r.total * 0.10, 2),
       buy_in_amount = round(r.total - round(r.total * 0.10, 2), 2)
  FROM repairable r
 WHERE t.id = r.id;

-- ── Constraint: NOT VALID on purpose ───────────────────────────────────────
-- NOT VALID applies to every INSERT and UPDATE from here on but does not
-- re-check the existing 9,814 historical rows — which is the entire point.
-- Validating it would fail on, and demand the falsification of, settled
-- financial history.
ALTER TABLE public.tournaments
  DROP CONSTRAINT IF EXISTS tournaments_whole_dollar_buyin;

ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_whole_dollar_buyin
  CHECK (
    buy_in_amount + COALESCE(buy_in_fee, 0)
      = round(buy_in_amount + COALESCE(buy_in_fee, 0))
  ) NOT VALID;

COMMENT ON CONSTRAINT tournaments_whole_dollar_buyin ON public.tournaments IS
  'Dan 2026-08-20: the advertised buy-in (buy_in_amount + buy_in_fee) is what a '
  'player pays and must be a whole number. Rake is cut OUT of the total, never '
  'added on top. Derive both columns with buyInFor() - src/utils/buyIn.ts or '
  'server/src/config/buyIn.ts. NOT VALID: pre-2026-08-20 rows are settled '
  'financial history and are deliberately left as they were charged.';

-- ── Post-apply assertions ──────────────────────────────────────────────────
DO $$
DECLARE v_bad int; v_con int;
BEGIN
  SELECT count(*) INTO v_con
    FROM pg_constraint
   WHERE conname = 'tournaments_whole_dollar_buyin'
     AND conrelid = 'public.tournaments'::regclass;
  IF v_con <> 1 THEN
    RAISE EXCEPTION 'constraint tournaments_whole_dollar_buyin was not created';
  END IF;

  SELECT count(*) INTO v_bad
    FROM public.tournaments
   WHERE status = 'REGISTERING'
     AND COALESCE(current_players, 0) = 0
     AND (buy_in_amount + COALESCE(buy_in_fee,0)) <> round(buy_in_amount + COALESCE(buy_in_fee,0));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'still % unpaid REGISTERING tournaments with a non-whole buy-in', v_bad;
  END IF;
END $$;

COMMIT;
