-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902050642; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- 34 COMPLETED MTTs carry a guarantee that was never met: 12,893.70 chips
-- promised to players and never paid, between 2026-08-21 and 2026-09-01. All
-- of them predate zz_ca_fund_overlay_on_lock, which now funds the shortfall
-- from the main bank at the moment the field locks, so this is a closed
-- historical set rather than an ongoing one.
--
-- Spins and satellites are excluded on evidence, not assumption. A spin's
-- guaranteed_prize is buy_in x seats x multiplier while the winner is
-- correctly paid buy_in x multiplier ("1 Chip Spin NLH (3x)": guarantee reads
-- 9.00, prize pool 3, paid 3.00) - it is a derived display field, not a
-- promise, and treating it as one would have invented 3,050.00 of debt across
-- 538 events. Satellites award seats, not chips.
--
-- Bounty credits COUNT toward the guarantee here. Comparing only category
-- 'prize' overstated the debt by 900 chips across four progressive-bounty
-- events whose bounty pools were paid in full.
--
-- THE LESSON FROM MY OWN BUG, applied: this writes a tournament_payouts row
-- for every credit. The overlay back-payment earlier tonight moved 1,703.00
-- chips into wallets without one, so fn_tournament_payout_reconcile could not
-- see them and paid the same shortfall a second time. A payment the record
-- cannot see is a payment that gets made twice.

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
  v_struct jsonb; v_places int;
BEGIN
  FOR t IN
    SELECT tt.id, tt.name, tt.club_id, tt.guaranteed_prize, tt.prize_pool,
           COALESCE(tt.payout_percent, 10) AS pct,
           COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                      WHERE w.related_entity_id = tt.id AND w.type='credit'
                        AND w.category IN ('prize','bounty')),0) AS paid_all,
           (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id = tt.id) AS players
      FROM public.tournaments tt
     WHERE tt.status = 'COMPLETED'
       AND COALESCE(tt.tournament_type,'') = 'MTT'
       AND COALESCE(tt.variant,'') NOT IN ('satellite','spin')
       AND COALESCE(tt.guaranteed_prize,0) > 0
     ORDER BY tt.ended_at
     LIMIT GREATEST(p_limit,1)
  LOOP
    v_short := round(t.guaranteed_prize - t.paid_all, 2);
    CONTINUE WHEN v_short <= 0.01;

    IF t.players = 0 THEN
      v_skipped := v_skipped || jsonb_build_object('tournament', t.name, 'why', 'no finishers recorded');
      CONTINUE;
    END IF;

    v_events := v_events + 1;
    v_chips  := v_chips + v_short;

    IF NOT p_apply THEN CONTINUE; END IF;

    -- Fund from the main bank, all-or-nothing, exactly as the live trigger does.
    SELECT union_id INTO v_union FROM public.clubs WHERE id = t.club_id;
    v_from := 'union_bank';
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

    -- Distribution basis: pro-rata to what each player was already paid, so
    -- the shortfall lands in the same shape the event actually finished in.
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
         GROUP BY w.user_id
         ORDER BY 2 DESC
      LOOP
        v_rows := v_rows + 1;
        v_amt := round(v_short * (r.got / v_basis), 2);
        v_paid_running := v_paid_running + v_amt;
        IF v_amt <= 0 THEN CONTINUE; END IF;

        PERFORM set_config('app.ledger_category', 'overlay', true);
        PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
        PERFORM set_config('app.ledger_counterparty_entity', t.id::text, true);
        UPDATE public.club_members SET chip_balance = chip_balance + v_amt
         WHERE club_id = r.club_id AND user_id = r.user_id;
        PERFORM set_config('app.ledger_category', '', true);
        PERFORM set_config('app.ledger_counterparty', '', true);

        INSERT INTO public.wallet_transactions (user_id, type, category, amount, description, related_entity_id)
        VALUES (r.user_id, 'credit', 'prize', v_amt,
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
      -- Nothing was paid at all (a guaranteed freeroll). Use the event's own
      -- payout structure over the finishing order.
      v_struct := public.fn_ca_payout_structure(t.players::int, t.pct::int);
      FOR r IN
        SELECT tp.user_id, tp.position, tp.club_id,
               (e->>'percentage')::numeric AS pctg
          FROM jsonb_array_elements(v_struct) e
          JOIN public.tournament_players tp
            ON tp.tournament_id = t.id AND tp.position = (e->>'place')::int
         ORDER BY tp.position
      LOOP
        v_rows := v_rows + 1;
        v_amt := round(v_short * r.pctg / 100.0, 2);
        v_paid_running := v_paid_running + v_amt;
        IF v_amt <= 0 THEN CONTINUE; END IF;

        PERFORM set_config('app.ledger_category', 'overlay', true);
        PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
        PERFORM set_config('app.ledger_counterparty_entity', t.id::text, true);
        UPDATE public.club_members SET chip_balance = chip_balance + v_amt
         WHERE club_id = COALESCE(r.club_id, t.club_id) AND user_id = r.user_id;
        PERFORM set_config('app.ledger_category', '', true);
        PERFORM set_config('app.ledger_counterparty', '', true);

        INSERT INTO public.wallet_transactions (user_id, type, category, amount, description, related_entity_id)
        VALUES (r.user_id, 'credit', 'prize', v_amt,
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

    -- The pool must show the overlay it received, or every overpay detector
    -- reads correctly-paid money as excess (that mistake cost an hour tonight).
    UPDATE public.tournaments
       SET prize_pool = round(GREATEST(COALESCE(prize_pool,0), t.guaranteed_prize), 2)
     WHERE id = t.id;

    -- One descriptive row naming the event and the shortfall, per Dan's ruling
    -- that a bank-funded overlay must say which tournament and how much.
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

