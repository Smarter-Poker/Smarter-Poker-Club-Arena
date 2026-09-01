-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828035014; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- THE SPIN WINNER WHO WAS NEVER PAID.
--
-- `spin_unpaid_settlement_detection` (2026-08-28 02:20) built
-- v_spin_unpaid_settlements, which compares what the reserve pool DREW for a
-- Spin against what actually reached a player's wallet. It found 52 events.
-- Detection without repair is where this estate keeps stopping: the same shape
-- as the rake attribution that was alerted for and never retried.
--
-- Every one of the 52 is seat_shape 'ranked_but_unpaid' - exactly one player
-- holds position 1. There is nothing ambiguous to decide:
--
--     nobody_paid   25 events   1,163.00 chips
--     under_paid    16 events     274.00 chips
--     over_paid     11 events    -293.00 chips
--
-- 1,437.00 chips are owed to identified winners. The reserve pool has ALREADY
-- been debited for every one of them (`jackpot_draw` in spin_reserve_ledger is
-- written per game against prize_pool), so these chips left the bank and landed
-- nowhere. Paying the winner does not mint anything - it completes a transfer
-- that was booked on one side only, and it moves each event's conservation
-- from short to square.
--
-- THE 11 OVERPAID EVENTS ARE LEFT ALONE. Same rule Dan set for the duplicate
-- finishing places earlier today: no clawback from players. They are reported,
-- not reversed.
--
-- WHY SPIN NEEDED A SEPARATE CHECK AT ALL. fn_tournament_money_conservation
-- excludes `variant IN ('spin','satellite')`, so the highest-volume format on
-- the platform has never been examined by the money sentinel. For a Spin the
-- naive delta is meaningless anyway - a 10x pays out far more than the game
-- collected, by design, with the reserve pool as counterparty. The identity
-- that DOES hold for a Spin is simply
--
--     prize drawn from the reserve == prize credited to players
--
-- which is what the view checks and what this repairs.
--
-- ROLLBACK
--   Credits are keyed `spin:{tournament}:prize:{winner}:unpaid_backpay` through
--   fn_credit_and_log, so re-running cannot double-pay. To reverse, debit the
--   same users for the amounts in spin_unpaid_backpay_log.

CREATE TABLE IF NOT EXISTS public.spin_unpaid_backpay_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL UNIQUE,
  user_id       uuid NOT NULL,
  amount        numeric NOT NULL,
  verdict       text,
  paid_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.spin_unpaid_backpay_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.spin_unpaid_backpay_log FROM PUBLIC;
GRANT SELECT ON public.spin_unpaid_backpay_log TO service_role;

CREATE OR REPLACE FUNCTION public.fn_backpay_spin_unpaid_winners(
  p_apply boolean DEFAULT false,
  p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record; v_ok boolean;
  v_paid integer := 0; v_chips numeric := 0; v_skipped integer := 0;
  v_owed_before numeric; v_owed_after numeric;
BEGIN
  SELECT COALESCE(sum(chips_short), 0) INTO v_owed_before
    FROM public.v_spin_unpaid_settlements
   WHERE chips_short > 0.01 AND seat_shape = 'ranked_but_unpaid';

  FOR r IN
    -- The debt is filtered in the query, and so is the "we can tell who won"
    -- condition. Nothing is selected that this function would then decline.
    SELECT v.tournament_id, v.chips_short, v.verdict,
           (SELECT tp.user_id FROM public.tournament_players tp
             WHERE tp.tournament_id = v.tournament_id AND tp.position = 1
             LIMIT 1) AS winner
      FROM public.v_spin_unpaid_settlements v
     WHERE v.chips_short > 0.01
       AND v.seat_shape = 'ranked_but_unpaid'
       AND v.seats_at_first = 1
       AND NOT EXISTS (SELECT 1 FROM public.spin_unpaid_backpay_log l
                        WHERE l.tournament_id = v.tournament_id)
     ORDER BY v.ended_at ASC NULLS LAST
     LIMIT GREATEST(p_limit, 1)
  LOOP
    IF r.winner IS NULL THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    IF p_apply THEN
      v_ok := public.fn_credit_and_log(
        r.winner, r.chips_short,
        'spin:' || r.tournament_id || ':prize:' || r.winner || ':unpaid_backpay',
        'prize',
        'Spin winner back-pay (prize drawn from the reserve but never credited)',
        r.tournament_id);

      IF COALESCE(v_ok, false) THEN
        UPDATE public.tournament_players
           SET prize = round(COALESCE(prize, 0) + r.chips_short, 2)
         WHERE tournament_id = r.tournament_id AND user_id = r.winner;

        INSERT INTO public.spin_unpaid_backpay_log
          (tournament_id, user_id, amount, verdict)
        VALUES (r.tournament_id, r.winner, r.chips_short, r.verdict)
        ON CONFLICT (tournament_id) DO NOTHING;

        v_paid := v_paid + 1;
        v_chips := v_chips + r.chips_short;
      END IF;
    ELSE
      v_paid := v_paid + 1;
      v_chips := v_chips + r.chips_short;
    END IF;
  END LOOP;

  -- Second measurement. The backlog itself must shrink; a count of rows
  -- processed proves nothing.
  SELECT COALESCE(sum(chips_short), 0) INTO v_owed_after
    FROM public.v_spin_unpaid_settlements
   WHERE chips_short > 0.01 AND seat_shape = 'ranked_but_unpaid';

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
    'winners_paid', v_paid, 'chips', round(v_chips, 2),
    'skipped_no_winner', v_skipped,
    'owed_before', round(v_owed_before, 2), 'owed_after', round(v_owed_after, 2));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_backpay_spin_unpaid_winners(boolean, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_backpay_spin_unpaid_winners(boolean, integer) TO service_role;

DO $post$
DECLARE v_n integer;
BEGIN
  IF to_regprocedure('public.fn_backpay_spin_unpaid_winners(boolean, integer)') IS NULL THEN
    RAISE EXCEPTION 'fn_backpay_spin_unpaid_winners was not created';
  END IF;
  -- The view this depends on must exist and must be non-empty in the shape we
  -- repair, or the sweep is decoration.
  SELECT count(*) INTO v_n FROM public.v_spin_unpaid_settlements
   WHERE chips_short > 0.01 AND seat_shape = 'ranked_but_unpaid';
  RAISE LOG 'spin unpaid winner backlog: % event(s)', v_n;
END
$post$;
