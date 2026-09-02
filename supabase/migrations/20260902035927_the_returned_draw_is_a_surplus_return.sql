-- The reserve ledger's `kind` vocabulary already had the right word and I
-- invented one anyway: 'draw_returned' is not in the CHECK constraint, which
-- refused the insert and rolled the whole repair back. 'surplus_return' is the
-- existing term for chips going back into the reserve, and it is exactly what
-- an unawarded draw is.
--
-- Second time tonight the schema already knew the vocabulary and I reached for
-- a new one (the first was prize_liability / overlay in chip_ledger). Both
-- times the CHECK constraint caught it. Worth writing down: read the
-- constraint before naming a new enum value in this database.
--
-- Superseded in part by 20260902042842, which adds the counterparty
-- declaration this version was missing.

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
      UPDATE public.spin_bonus_pools
         SET balance = balance + (r.drawn - r.returned)
       WHERE club_id = r.club_id
      RETURNING balance INTO v_bal;

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
