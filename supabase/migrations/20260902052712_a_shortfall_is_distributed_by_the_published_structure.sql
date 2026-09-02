-- Preventing the recurrence of the shape error above. The back-payment no
-- longer distributes a shortfall itself. It funds the pool from the main bank,
-- raises prize_pool to the guarantee, writes the descriptive ledger row, and
-- then hands distribution to fn_tournament_payout_reconcile - the one function
-- that reads tournaments.payout_structure, which is what the player was
-- actually promised and what every payout detector measures against.
--
-- The pro-rata basis I invented was wrong twice over: it distributed by what
-- had already been paid rather than by the structure, and it counted bounty
-- credits, which are funded from bounty_pool and are not prize money at all.
--
-- The reconciler also writes its own tournament_payouts rows and carries a
-- per-place idempotency key, so a second run cannot double-pay - which is the
-- other mistake this function made tonight.

CREATE OR REPLACE FUNCTION public.fn_ca_backpay_guarantee_shortfalls(
  p_apply boolean DEFAULT false,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  t record;
  v_short numeric; v_union uuid; v_bank numeric; v_from text; v_actor uuid;
  v_events int := 0; v_chips numeric := 0; v_distributed numeric := 0;
  v_skipped jsonb := '[]'::jsonb; v_rec jsonb;
BEGIN
  SELECT performed_by INTO v_actor
    FROM public.chip_ledger
   WHERE category = 'overlay' AND performed_by IS NOT NULL
   ORDER BY created_at DESC LIMIT 1;
  IF v_actor IS NULL THEN
    SELECT id INTO v_actor FROM public.profiles WHERE role = 'god' ORDER BY created_at LIMIT 1;
  END IF;
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no operator account to attribute the back-payment to');
  END IF;

  FOR t IN
    WITH candidates AS (
      SELECT tt.id, tt.name, tt.club_id, tt.guaranteed_prize, tt.prize_pool, tt.ended_at,
             COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                        WHERE w.related_entity_id = tt.id AND w.type='credit'
                          AND w.category IN ('prize','bounty')),0) AS paid_all,
             (SELECT count(*) FROM public.tournament_players tp
               WHERE tp.tournament_id = tt.id) AS players
        FROM public.tournaments tt
       WHERE tt.status = 'COMPLETED'
         AND COALESCE(tt.tournament_type,'') = 'MTT'
         AND COALESCE(tt.variant,'') NOT IN ('satellite','spin')
         AND COALESCE(tt.guaranteed_prize,0) > 0
    )
    SELECT * FROM candidates
     WHERE paid_all < guaranteed_prize - 0.01
     ORDER BY ended_at
     LIMIT GREATEST(p_limit,1)
  LOOP
    v_short := round(t.guaranteed_prize - t.paid_all, 2);

    IF t.players = 0 THEN
      v_skipped := v_skipped || jsonb_build_object('tournament', t.name, 'why', 'no finishers recorded');
      CONTINUE;
    END IF;

    v_events := v_events + 1;
    v_chips  := v_chips + v_short;

    IF NOT p_apply THEN CONTINUE; END IF;

    SELECT union_id INTO v_union FROM public.clubs WHERE id = t.club_id;
    v_from := 'union_bank'; v_bank := NULL;
    IF v_union IS NOT NULL THEN
      SELECT chip_balance INTO v_bank FROM public.union_wallets
       WHERE union_id = v_union FOR UPDATE;
    END IF;
    IF v_union IS NULL OR COALESCE(v_bank,0) < v_short THEN
      SELECT chip_treasury INTO v_bank FROM public.clubs WHERE id = t.club_id FOR UPDATE;
      v_from := 'club_treasury';
    END IF;
    IF COALESCE(v_bank,0) < v_short THEN
      v_skipped := v_skipped || jsonb_build_object('tournament', t.name,
                     'why', 'bank short', 'needed', v_short, 'bank', COALESCE(v_bank,0));
      v_events := v_events - 1; v_chips := v_chips - v_short;
      CONTINUE;
    END IF;

    IF v_from = 'union_bank' THEN
      PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
      UPDATE public.union_wallets SET chip_balance = chip_balance - v_short
       WHERE union_id = v_union;
      PERFORM set_config('app.ledger_autoskip_union_wallets', '0', true);
    ELSE
      PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
      UPDATE public.clubs SET chip_treasury = chip_treasury - v_short WHERE id = t.club_id;
      PERFORM set_config('app.ledger_autoskip_clubs', '0', true);
    END IF;

    -- The pool must show the overlay before the reconciler reads it: expected
    -- is pool x structure, so raising the pool IS what makes each place's
    -- entitlement come out at the guaranteed level.
    UPDATE public.tournaments
       SET prize_pool = round(GREATEST(COALESCE(prize_pool,0), t.guaranteed_prize), 2)
     WHERE id = t.id;

    INSERT INTO public.chip_ledger
      (amount, category, from_type, from_entity_id, to_type, to_entity_id,
       club_id, status, performed_by, description, idempotency_key, metadata)
    VALUES (v_short, 'overlay',
            CASE WHEN v_from='union_bank' THEN 'union_bank' ELSE 'club_treasury' END,
            CASE WHEN v_from='union_bank' THEN v_union ELSE t.club_id END,
            'prize_liability', t.id, t.club_id, 'posted', v_actor,
            format('Guarantee shortfall back-payment from the main bank: %s was %s short of its %s guarantee - players had been paid %s',
                   t.name, v_short, round(t.guaranteed_prize,2), round(t.paid_all,2)),
            'guarantee-backpay:' || t.id::text,
            jsonb_build_object('tournament_id', t.id, 'shortfall', v_short,
                               'guarantee', t.guaranteed_prize, 'already_paid', t.paid_all,
                               'distributed_by', 'fn_tournament_payout_reconcile'))
    ON CONFLICT DO NOTHING;

    -- DISTRIBUTION IS NOT THIS FUNCTION'S JOB. The reconciler owns the
    -- structure, tops up each place to its entitlement, writes its own
    -- tournament_payouts rows, and never claws back.
    v_rec := public.fn_tournament_payout_reconcile(t.id, true);
    v_distributed := v_distributed + COALESCE((v_rec->>'total_top_up')::numeric, 0);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
                            'events', v_events, 'funded', round(v_chips,2),
                            'distributed', round(v_distributed,2), 'skipped', v_skipped);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_backpay_guarantee_shortfalls(boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_backpay_guarantee_shortfalls(boolean, integer) TO service_role;
