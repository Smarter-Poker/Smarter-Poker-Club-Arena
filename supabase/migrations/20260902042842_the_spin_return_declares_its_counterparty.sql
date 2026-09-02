-- My own two spin-return functions wrote spin_bonus_pools.balance with no
-- counterparty declared, so the auto-journal filed the 8.00 return against
-- settlement_suspense - I closed one undeclared money path tonight and opened
-- another in the same hour. Both now declare prize_liability against the
-- tournament, which is where the draw was held.
--
-- NOT FIXED HERE, and recorded so it is not lost: fn_spin_settle_game has the
-- same omission on its jackpot-draw leg. It sets app.ledger_category to
-- 'spin_prize' and, unlike the spin_entry block above it and the
-- treasury_transfer block below it, sets no app.ledger_counterparty before its
-- UPDATE public.spin_bonus_pools. That single missing line is the whole of the
-- spin_reserve -> settlement_suspense flow on the board: 243 rows and 15,378.00
-- chips in 90 minutes, the largest remaining undeclared path. The money is
-- journalled and not lost - this is a classification defect, not a leak - and
-- the fix is to add the counterparty declaration to that block. Left for a
-- rested pass rather than reconstructing a live settlement function tonight.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_spin_cancel_returns_draw()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_owed numeric; v_bal numeric;
BEGIN
  IF NOT (NEW.status IN ('CANCELLED','CANCELED')
          AND COALESCE(OLD.status,'') NOT IN ('CANCELLED','CANCELED')) THEN
    RETURN NEW;
  END IF;

  SELECT round(sum(CASE WHEN kind='jackpot_draw'   THEN -amount
                        WHEN kind='surplus_return' THEN -amount ELSE 0 END), 2)
    INTO v_owed
    FROM public.spin_reserve_ledger WHERE tournament_id = NEW.id;

  IF COALESCE(v_owed,0) <= 0 THEN RETURN NEW; END IF;

  IF EXISTS (SELECT 1 FROM public.wallet_transactions w
              WHERE w.related_entity_id = NEW.id
                AND w.type='credit' AND w.category='prize') THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('app.ledger_category', 'refund', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', NEW.id::text, true);

  UPDATE public.spin_bonus_pools
     SET balance = balance + v_owed
   WHERE club_id = NEW.club_id
  RETURNING balance INTO v_bal;

  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);

  IF FOUND THEN
    INSERT INTO public.spin_reserve_ledger
      (club_id, tournament_id, kind, amount, balance_after, note)
    VALUES (NEW.club_id, NEW.id, 'surplus_return', v_owed, v_bal,
            'spin cancelled without awarding a prize; jackpot draw returned in the cancel');
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_ca_return_unawarded_spin_draws(
  p_apply boolean DEFAULT false,
  p_limit integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  r record; v_n int := 0; v_chips numeric := 0; v_bal numeric;
BEGIN
  FOR r IN
    SELECT l.tournament_id, l.club_id,
           round(sum(CASE WHEN l.kind = 'jackpot_draw' THEN -l.amount ELSE 0 END), 2) AS drawn,
           round(sum(CASE WHEN l.kind = 'surplus_return' THEN l.amount ELSE 0 END), 2) AS returned
      FROM public.spin_reserve_ledger l
      JOIN public.tournaments t ON t.id = l.tournament_id
     WHERE t.status IN ('CANCELLED','CANCELED')
       AND l.tournament_id IS NOT NULL
     GROUP BY l.tournament_id, l.club_id
    HAVING round(sum(CASE WHEN l.kind = 'jackpot_draw' THEN -l.amount ELSE 0 END), 2)
         > round(sum(CASE WHEN l.kind = 'surplus_return' THEN l.amount ELSE 0 END), 2)
       AND NOT EXISTS (SELECT 1 FROM public.wallet_transactions w
                        WHERE w.related_entity_id = l.tournament_id
                          AND w.type = 'credit' AND w.category = 'prize')
     ORDER BY 3 DESC
     LIMIT GREATEST(p_limit, 1)
  LOOP
    v_n := v_n + 1;
    v_chips := v_chips + (r.drawn - r.returned);

    IF p_apply THEN
      PERFORM set_config('app.ledger_category', 'refund', true);
      PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
      PERFORM set_config('app.ledger_counterparty_entity', r.tournament_id::text, true);

      UPDATE public.spin_bonus_pools
         SET balance = balance + (r.drawn - r.returned)
       WHERE club_id = r.club_id
      RETURNING balance INTO v_bal;

      PERFORM set_config('app.ledger_category', '', true);
      PERFORM set_config('app.ledger_counterparty', '', true);
      PERFORM set_config('app.ledger_counterparty_entity', '', true);

      IF FOUND THEN
        INSERT INTO public.spin_reserve_ledger
          (club_id, tournament_id, kind, amount, balance_after, note)
        VALUES (r.club_id, r.tournament_id, 'surplus_return',
                (r.drawn - r.returned), v_bal,
                'spin cancelled without awarding a prize; jackpot draw returned to the reserve');
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
                            'spins', v_n, 'chips_returned', round(v_chips,2));
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_return_unawarded_spin_draws(boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_return_unawarded_spin_draws(boolean, integer) TO service_role;

COMMIT;
