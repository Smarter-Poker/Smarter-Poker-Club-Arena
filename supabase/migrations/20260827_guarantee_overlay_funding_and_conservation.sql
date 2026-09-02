-- ═══════════════════════════════════════════════════════════════════════════════
--  GUARANTEE OVERLAY FUNDING + TOURNAMENT MONEY CONSERVATION (2026-08-27, ph. 3)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Phase 3 of the tournament-money deep audit. A full per-tournament
-- conservation sweep (money in via wallet debits vs money out via prize /
-- bounty / refund credits plus booked rake) over the last 30 days of
-- production found two enormous, symmetrical holes:
--
--  1. GUARANTEE OVERLAYS WERE MINTED — 265,209.30 chips in 30 days across
--     1,001 events. `effectivePrizePool = max(pool, guarantee)` raised the
--     pool and the payouts simply paid it, with NO funding debit anywhere: no
--     club paid for its own guarantee, the chips appeared from nothing, and
--     every reconciler was blind to it because the pool column itself was the
--     inflated number.
--     FIX: fn_apply_prize_guarantee — the ONLY way a guarantee becomes real
--     money. It funds the overlay from the hosting club's chip_treasury
--     (negative treasury allowed but LOUD), records it in
--     tournament_guarantee_overlays (PK = idempotency claim), and finalizes
--     the pool in the same transaction. The engine's three finalization
--     sites call it instead of writing max() themselves, and the recurring
--     generators STOP pre-applying guarantees at creation (the lobby already
--     displays max(pool, gtd) client-side).
--
--  2. HEADS-UP WINNERS WERE UNDERPAID A FULL BUY-IN — ~230,561 chips retained
--     across ~9,379 events. createSNG seats its opening horse (whose
--     registration bumps prize_pool by its prize share), then overwrote
--     prize_pool with `buyIn × registered` where registered = 0 for
--     seat-first games — erasing the horse's contribution microseconds after
--     it landed. The 2026-08-23 fix caught this exact overwrite for
--     current_players and left prize_pool in it. Every Heads-Up duel since
--     paid the winner ONE prize share instead of two (95 on a 100 duel that
--     Dan's own spec prices at 190).
--     FIX: the engine stops overwriting accumulated pools at creation
--     (register RPCs are the single source of pool truth), and
--     fn_backpay_hu_winner_shortfalls repays every underpaid winner,
--     evidence-based (per-event wallet-ledger delta), idempotent
--     (fn_credit_and_log key per tournament+winner), self-draining from the
--     engine loop. The same creation overwrite also set MTT pools from the
--     fee-INCLUSIVE buy-in (config.buyIn × horses), overstating pools by the
--     fee — also removed.
--
--  3. THE SENTINEL — fn_tournament_money_conservation. Per-event conservation
--     is now checked continuously: |money_in − refunds − booked_rake −
--     prizes − bounties − funded_overlay| beyond tolerance files a
--     financial_alert (deduped per tournament). This is the invariant that
--     would have caught BOTH holes above on day one, wired into the engine
--     discovery loop.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE OVERLAY LEDGER
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tournament_guarantee_overlays (
  tournament_id  uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE CASCADE,
  club_id        uuid REFERENCES public.clubs(id) ON DELETE SET NULL,
  amount         numeric(15,2) NOT NULL,
  pool_before    numeric(15,2) NOT NULL,
  pool_after     numeric(15,2) NOT NULL,
  treasury_after numeric(15,2),
  source         text NOT NULL DEFAULT 'engine',
  funded_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tournament_guarantee_overlays IS
  'One row per tournament whose advertised guarantee exceeded player contributions: the overlay the hosting club funded from chip_treasury. PK is the idempotency claim for fn_apply_prize_guarantee.';

ALTER TABLE public.tournament_guarantee_overlays ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE ONLY WAY A GUARANTEE BECOMES REAL MONEY
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_apply_prize_guarantee(
  p_tournament_id uuid,
  p_source text DEFAULT 'engine'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_overlay numeric; v_final numeric; v_claimed integer;
  v_treasury numeric;
BEGIN
  SELECT t.id, t.club_id, t.name, COALESCE(t.prize_pool, 0) AS pool,
         COALESCE(t.guaranteed_prize, 0) AS gtd, COALESCE(t.prize_pool_finalized, false) AS finalized
    INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_t.finalized THEN
    RETURN jsonb_build_object('ok', true, 'already_finalized', true, 'prize_pool', v_t.pool);
  END IF;

  v_final := GREATEST(v_t.pool, v_t.gtd);
  v_overlay := round(v_final - v_t.pool, 2);

  IF v_overlay > 0 THEN
    -- THE CLAIM: one overlay per tournament, ever. A second finalization path
    -- (start gate vs late-reg close vs add-on end vs a restart replaying one
    -- of them) conflicts here and leaves the money alone.
    INSERT INTO public.tournament_guarantee_overlays
      (tournament_id, club_id, amount, pool_before, pool_after, source)
    VALUES (p_tournament_id, v_t.club_id, v_overlay, v_t.pool, v_final, COALESCE(p_source, 'engine'))
    ON CONFLICT (tournament_id) DO NOTHING;
    GET DIAGNOSTICS v_claimed = ROW_COUNT;

    IF v_claimed = 0 THEN
      -- Overlay already funded by an earlier call; just make the flag true.
      UPDATE public.tournaments SET prize_pool_finalized = true WHERE id = p_tournament_id;
      RETURN jsonb_build_object('ok', true, 'already_funded', true, 'prize_pool', v_t.pool);
    END IF;

    -- The hosting club pays for its own guarantee. The balance may go
    -- negative — an advertised guarantee is honoured to players regardless —
    -- but a negative treasury is a debt the owner must see, so it alarms.
    UPDATE public.clubs
       SET chip_treasury = COALESCE(chip_treasury, 0) - v_overlay,
           updated_at = now()
     WHERE id = v_t.club_id
     RETURNING chip_treasury INTO v_treasury;

    UPDATE public.tournament_guarantee_overlays
       SET treasury_after = v_treasury
     WHERE tournament_id = p_tournament_id;

    IF v_treasury IS NOT NULL AND v_treasury < 0 THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES ('warning', 'fn_apply_prize_guarantee',
              'Guarantee overlay drove club treasury negative: ' || COALESCE(v_t.name, 'tournament'),
              jsonb_build_object('tournament_id', p_tournament_id, 'club_id', v_t.club_id,
                                 'overlay', v_overlay, 'treasury_after', v_treasury));
    END IF;
  END IF;

  UPDATE public.tournaments
     SET prize_pool = v_final, prize_pool_finalized = true
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'prize_pool', v_final,
    'overlay', COALESCE(v_overlay, 0), 'treasury_after', v_treasury);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_apply_prize_guarantee(uuid, text) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. BACK-PAY THE UNDERPAID HEADS-UP WINNERS
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_backpay_hu_winner_shortfalls(
  p_limit integer DEFAULT 100
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row record; v_winner uuid; v_winner_count integer;
  v_paid integer := 0; v_chips numeric := 0; v_scanned integer := 0; v_skipped integer := 0;
  v_ok boolean;
BEGIN
  FOR v_row IN
    SELECT t.id, t.name,
           round(
             COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                WHERE w.related_entity_id = t.id AND w.type = 'debit'
                  AND w.category IN ('tournament_buyin','rebuy','addon')), 0)
           - COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                WHERE w.related_entity_id = t.id AND w.type = 'credit'
                  AND w.category IN ('refund','prize','bounty')), 0)
           - COALESCE((SELECT sum(r.rake_amount) FROM public.rake_records r
                WHERE r.tournament_id = t.id AND r.is_tournament), 0)
           , 2) AS delta
      FROM public.tournaments t
     WHERE t.status = 'COMPLETED'
       AND COALESCE(t.variant, '') = 'sng'
       AND COALESCE(t.max_players, 0) <= 2
       AND COALESCE(t.guaranteed_prize, 0) = 0
       -- The creation-overwrite fix ships 2026-08-27; events finishing after
       -- the cutoff cannot carry the shortfall, so the scan never grows.
       AND t.ended_at < '2026-08-28T00:00:00Z'
       AND t.ended_at > '2026-08-01T00:00:00Z'
       AND NOT EXISTS (
         SELECT 1 FROM public.wallet_transactions w
          WHERE w.related_entity_id = t.id AND w.type = 'credit'
            AND w.category = 'prize'
            AND w.description LIKE 'Heads-Up winner shortfall%')
     ORDER BY t.ended_at ASC
     LIMIT GREATEST(p_limit, 1)
  LOOP
    v_scanned := v_scanned + 1;
    IF v_row.delta < 0.01 THEN v_skipped := v_skipped + 1; CONTINUE; END IF;

    SELECT count(*), (array_agg(tp.user_id ORDER BY tp.user_id))[1]
      INTO v_winner_count, v_winner
      FROM public.tournament_players tp
     WHERE tp.tournament_id = v_row.id
       AND (tp.status = 'winner' OR tp.position = 1);
    IF v_winner_count <> 1 OR v_winner IS NULL THEN
      v_skipped := v_skipped + 1;
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'warning', 'fn_backpay_hu_winner_shortfalls',
             'HU shortfall found but no unique winner: ' || COALESCE(v_row.name, 'sng'),
             jsonb_build_object('tournament_id', v_row.id, 'delta', v_row.delta,
                                'winners', v_winner_count)
       WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts
                          WHERE source = 'fn_backpay_hu_winner_shortfalls'
                            AND resolved IS NOT TRUE
                            AND context->>'tournament_id' = v_row.id::text);
      CONTINUE;
    END IF;

    v_ok := public.fn_credit_and_log(
      v_winner, v_row.delta,
      'tourney:' || v_row.id || ':prize:' || v_winner || ':hu_shortfall',
      'prize',
      'Heads-Up winner shortfall back-pay (' || COALESCE(v_row.name, 'sng') || ')',
      v_row.id);
    IF COALESCE(v_ok, false) THEN
      v_paid := v_paid + 1;
      v_chips := v_chips + v_row.delta;
      UPDATE public.tournament_players
         SET prize = round(COALESCE(prize, 0) + v_row.delta, 2)
       WHERE tournament_id = v_row.id AND user_id = v_winner;
      UPDATE public.tournaments
         SET prize_pool = round(COALESCE(prize_pool, 0) + v_row.delta, 2)
       WHERE id = v_row.id;
    ELSE
      v_skipped := v_skipped + 1;  -- key already used: paid on an earlier pass
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'scanned', v_scanned,
    'paid', v_paid, 'chips', round(v_chips, 2), 'skipped', v_skipped);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_backpay_hu_winner_shortfalls(integer) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. THE CONSERVATION SENTINEL
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_tournament_money_conservation(
  p_since_days integer DEFAULT 7,
  p_tolerance numeric DEFAULT 1.0,
  p_limit integer DEFAULT 500
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row record; v_flagged integer := 0; v_scanned integer := 0;
  v_retained numeric := 0; v_unfunded numeric := 0;
BEGIN
  FOR v_row IN
    SELECT t.id, t.name, t.variant,
           round(
             COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                WHERE w.related_entity_id = t.id AND w.type = 'debit'
                  AND w.category IN ('tournament_buyin','rebuy','addon')), 0)
           - COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                WHERE w.related_entity_id = t.id AND w.type = 'credit'
                  AND w.category IN ('refund','prize','bounty')), 0)
           - COALESCE((SELECT sum(r.rake_amount) FROM public.rake_records r
                WHERE r.tournament_id = t.id AND r.is_tournament), 0)
           + COALESCE((SELECT o.amount FROM public.tournament_guarantee_overlays o
                WHERE o.tournament_id = t.id), 0)
           , 2) AS delta
      FROM public.tournaments t
     WHERE t.status IN ('COMPLETED','CANCELLED')
       AND t.ended_at > now() - make_interval(days => GREATEST(p_since_days, 1))
       AND t.ended_at < now() - interval '30 minutes'
       AND COALESCE(t.variant, '') NOT IN ('spin', 'satellite')
     ORDER BY t.ended_at DESC
     LIMIT GREATEST(p_limit, 1)
  LOOP
    v_scanned := v_scanned + 1;
    IF abs(v_row.delta) <= GREATEST(p_tolerance, 0) THEN CONTINUE; END IF;
    IF v_row.delta > 0 THEN v_retained := v_retained + v_row.delta;
    ELSE v_unfunded := v_unfunded - v_row.delta; END IF;
    v_flagged := v_flagged + 1;

    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'warning', 'fn_tournament_money_conservation',
           CASE WHEN v_row.delta > 0
                THEN 'Tournament retained money it never paid out: '
                ELSE 'Tournament paid out money it never collected: ' END
             || COALESCE(v_row.name, v_row.id::text),
           jsonb_build_object('tournament_id', v_row.id, 'variant', v_row.variant,
                              'delta', v_row.delta)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts
        WHERE source = 'fn_tournament_money_conservation'
          AND resolved IS NOT TRUE
          AND context->>'tournament_id' = v_row.id::text);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'scanned', v_scanned, 'flagged', v_flagged,
    'retained_chips', round(v_retained, 2), 'unfunded_chips', round(v_unfunded, 2));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_money_conservation(integer, numeric, integer) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. ASSERTIONS
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.tournament_guarantee_overlays') IS NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: tournament_guarantee_overlays missing';
  END IF;
  IF to_regprocedure('public.fn_apply_prize_guarantee(uuid, text)') IS NULL
     OR to_regprocedure('public.fn_backpay_hu_winner_shortfalls(integer)') IS NULL
     OR to_regprocedure('public.fn_tournament_money_conservation(integer, numeric, integer)') IS NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: phase-3 functions missing';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_apply_prize_guarantee(uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_backpay_hu_winner_shortfalls(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_tournament_money_conservation(integer, numeric, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT FAILED: phase-3 functions leaked to authenticated';
  END IF;
END $$;

-- ROLLBACK:
--   DROP FUNCTION public.fn_tournament_money_conservation(integer, numeric, integer);
--   DROP FUNCTION public.fn_backpay_hu_winner_shortfalls(integer);
--   DROP FUNCTION public.fn_apply_prize_guarantee(uuid, text);
--   DROP TABLE public.tournament_guarantee_overlays;
--   -- and restore the engine's three effectivePrizePool sites from git.
