-- wallet_transactions.wallet_type is NOT NULL and I omitted it. The insert was
-- refused and the whole back-payment rolled back with nothing written, which
-- is exactly what a money migration should do when it is wrong. Every one of
-- the 83,568 existing prize and bounty rows carries 'PLAYER'; this now says so
-- rather than relying on a default that does not exist.
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
  t record; r record;
  v_short numeric; v_union uuid; v_bank numeric; v_from text;
  v_events int := 0; v_chips numeric := 0; v_credits int := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_basis numeric; v_amt numeric; v_paid_running numeric; v_rows int;
  v_struct jsonb;
BEGIN
  FOR t IN
    WITH candidates AS (
      SELECT tt.id, tt.name, tt.club_id, tt.guaranteed_prize, tt.prize_pool, tt.ended_at,
             COALESCE(tt.payout_percent, 10) AS pct,
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

    SELECT COALESCE(sum(w.amount),0) INTO v_basis
      FROM public.wallet_transactions w
     WHERE w.related_entity_id = t.id AND w.type='credit' AND w.category IN ('prize','bounty');

    v_paid_running := 0; v_rows := 0;

    IF v_basis > 0 THEN
      FOR r IN
        SELECT w.user_id, round(sum(w.amount),2) AS got,
               COALESCE((SELECT tp.club_id FROM public.tournament_players tp
                          WHERE tp.tournament_id=t.id AND tp.user_id=w.user_id LIMIT 1), t.club_id) AS club_id,
               (SELECT tp.position FROM public.tournament_players tp
                 WHERE tp.tournament_id=t.id AND tp.user_id=w.user_id LIMIT 1) AS position
          FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type='credit' AND w.category IN ('prize','bounty')
         GROUP BY w.user_id ORDER BY 2 DESC
      LOOP
        v_rows := v_rows + 1;
        v_amt := round(v_short * (r.got / v_basis), 2);
        v_paid_running := v_paid_running + v_amt;
        CONTINUE WHEN v_amt <= 0;

        PERFORM set_config('app.ledger_category', 'overlay', true);
        PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
        PERFORM set_config('app.ledger_counterparty_entity', t.id::text, true);
        UPDATE public.club_members SET chip_balance = chip_balance + v_amt
         WHERE club_id = r.club_id AND user_id = r.user_id;
        PERFORM set_config('app.ledger_category', '', true);
        PERFORM set_config('app.ledger_counterparty', '', true);

        INSERT INTO public.wallet_transactions
          (user_id, wallet_type, type, category, amount, description, related_entity_id)
        VALUES (r.user_id, 'PLAYER', 'credit', 'prize', v_amt,
                'Guarantee shortfall back-payment: ' || t.name, t.id);

        INSERT INTO public.tournament_payouts
          (tournament_id, user_id, position, amount, source, idempotency_key, recorded_by, metadata)
        VALUES (t.id, r.user_id, r.position, v_amt, 'overlay_backpay',
                'tourney:' || t.id::text || ':guarantee_backpay:' || r.user_id::text,
                'fn_ca_backpay_guarantee_shortfalls',
                jsonb_build_object('basis','pro_rata_to_paid','guarantee',t.guaranteed_prize))
        ON CONFLICT DO NOTHING;

        v_credits := v_credits + 1;
      END LOOP;
    ELSE
      v_struct := public.fn_ca_payout_structure(t.players::int, t.pct::int);
      FOR r IN
        SELECT tp.user_id, tp.position, tp.club_id, (e->>'percentage')::numeric AS pctg
          FROM jsonb_array_elements(v_struct) e
          JOIN public.tournament_players tp
            ON tp.tournament_id = t.id AND tp.position = (e->>'place')::int
         ORDER BY tp.position
      LOOP
        v_rows := v_rows + 1;
        v_amt := round(v_short * r.pctg / 100.0, 2);
        v_paid_running := v_paid_running + v_amt;
        CONTINUE WHEN v_amt <= 0;

        PERFORM set_config('app.ledger_category', 'overlay', true);
        PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
        PERFORM set_config('app.ledger_counterparty_entity', t.id::text, true);
        UPDATE public.club_members SET chip_balance = chip_balance + v_amt
         WHERE club_id = COALESCE(r.club_id, t.club_id) AND user_id = r.user_id;
        PERFORM set_config('app.ledger_category', '', true);
        PERFORM set_config('app.ledger_counterparty', '', true);

        INSERT INTO public.wallet_transactions
          (user_id, wallet_type, type, category, amount, description, related_entity_id)
        VALUES (r.user_id, 'PLAYER', 'credit', 'prize', v_amt,
                'Guarantee shortfall back-payment: ' || t.name, t.id);

        INSERT INTO public.tournament_payouts
          (tournament_id, user_id, position, amount, source, idempotency_key, recorded_by, metadata)
        VALUES (t.id, r.user_id, r.position, v_amt, 'overlay_backpay',
                'tourney:' || t.id::text || ':guarantee_backpay:' || r.user_id::text,
                'fn_ca_backpay_guarantee_shortfalls',
                jsonb_build_object('basis','payout_structure','guarantee',t.guaranteed_prize))
        ON CONFLICT DO NOTHING;

        v_credits := v_credits + 1;
      END LOOP;
    END IF;

    UPDATE public.tournaments
       SET prize_pool = round(GREATEST(COALESCE(prize_pool,0), t.guaranteed_prize), 2)
     WHERE id = t.id;

    INSERT INTO public.chip_ledger
      (amount, category, from_type, from_entity_id, to_type, to_entity_id,
       club_id, status, description, idempotency_key, metadata)
    VALUES (v_short, 'overlay',
            CASE WHEN v_from='union_bank' THEN 'union_bank' ELSE 'club_treasury' END,
            CASE WHEN v_from='union_bank' THEN v_union ELSE t.club_id END,
            'prize_liability', t.id, t.club_id, 'posted',
            format('Guarantee shortfall back-payment from the main bank: %s was %s short of its %s guarantee - players had been paid %s',
                   t.name, v_short, round(t.guaranteed_prize,2), round(t.paid_all,2)),
            'guarantee-backpay:' || t.id::text,
            jsonb_build_object('tournament_id', t.id, 'shortfall', v_short,
                               'guarantee', t.guaranteed_prize, 'already_paid', t.paid_all,
                               'credits', v_rows, 'distributed', v_paid_running))
    ON CONFLICT DO NOTHING;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
                            'events', v_events, 'chips', round(v_chips,2),
                            'credits', v_credits, 'skipped', v_skipped);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_backpay_guarantee_shortfalls(boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_backpay_guarantee_shortfalls(boolean, integer) TO service_role;
