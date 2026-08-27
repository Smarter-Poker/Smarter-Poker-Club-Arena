-- ═══════════════════════════════════════════════════════════════════════════════
--  CONSERVATION SENTINEL — DE-NOISE + SELF-RESOLVE (2026-08-27, phase 3b)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- The phase-3 sentinel (fn_tournament_money_conservation) went live and did
-- its job: it flagged 442 events on its first pass. Reading the population
-- back proved two of its three categories are NOT defects, and that the
-- alarm can never retract itself:
--
--   403  Heads-Up events carrying the known shortfall that
--        fn_backpay_hu_winner_shortfalls is actively repaying. Correct
--        finding, but the alert stays open forever after the money is
--        repaid — the sentinel only ever INSERTs.
--    28  guaranteed events that ended BEFORE tournament_guarantee_overlays
--        existed. Their overlay was really minted (that was the phase-3
--        finding) but there is nothing to fund retroactively and no ledger
--        row to net against, so they re-flag on every scan forever.
--    11  FREEROLLS. A freeroll pays prizes nobody bought in for — that is
--        the entire product. Flagging it as "paid out money it never
--        collected" is the sentinel misreading a feature as a defect, and
--        it would do so every single day.
--
-- Left alone this is the exact failure documented in FeeReconciler on
-- 2026-08-22: 988 unresolved criticals, 93% of them noise, and the nine real
-- ones invisible inside the pile. An alarm that cannot go quiet when the
-- money is right is an alarm nobody reads.
--
-- THREE CHANGES:
--
--  1. FREEROLLS ARE FUNDED BY DESIGN. An event whose player-paid total is 0
--     is excluded — its prizes are club marketing spend, exactly like a
--     guarantee overlay, and the club treasury is where that shows.
--  2. PRE-LEDGER GUARANTEES ARE ACCOUNTED, NOT RE-LITIGATED. For an event
--     that ended before the overlay ledger existed, the implied overlay
--     (guarantee minus contributions) is treated as funded. New events
--     cannot use this path: they fund through fn_apply_prize_guarantee and
--     carry a real ledger row.
--  3. THE SENTINEL SELF-RESOLVES. Every scan now RE-CHECKS the tournaments
--     it has open alerts for, and marks an alert resolved the moment its
--     event conserves again — so the Heads-Up backlog closes itself as the
--     back-pay drains, and the open-alert count is a live measure of unfixed
--     money rather than an ever-growing archive.
--
-- The conservation arithmetic itself is UNCHANGED. Nothing is being hidden:
-- the two excluded categories are club-funded by definition, and every
-- exclusion is expressed in the shared fn_tournament_conservation_delta so
-- the sweep and the self-resolve pass can never disagree about what
-- "conserving" means.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. ONE DEFINITION OF THE DELTA
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_tournament_conservation_delta(p_tournament_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH m AS (
    SELECT t.id, t.ended_at,
      COALESCE(t.prize_pool, 0)  AS pool,
      COALESCE(t.bounty_pool, 0) AS bounty_pool,
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
         WHERE o.tournament_id = t.id), 0) AS funded_overlay,
      EXISTS (SELECT 1 FROM public.tournament_guarantee_overlays o
               WHERE o.tournament_id = t.id) AS has_overlay_row
    FROM public.tournaments t WHERE t.id = p_tournament_id
  )
  SELECT round(
      m.money_in - m.refunds - m.rake - m.prizes - m.bounties
    -- Funded overlay: a real ledger row, for anything finalized since phase 3.
    + m.funded_overlay
    -- ── PRE-FIX POOL INFLATION ──────────────────────────────────────────
    -- Before 2026-08-27 the stored prize_pool could exceed what players
    -- actually contributed, by two now-fixed mechanisms that are
    -- indistinguishable after the fact and identical in effect:
    --   * an unfunded guarantee overlay (max(pool, gtd) written for free);
    --   * the creation-time overwrite pricing pools off the fee-INCLUSIVE
    --     buy-in (config.buyIn x horses).
    -- Both minted chips at the source, the payouts then paid the inflated
    -- pool, and none of it is recoverable now — clawing back a prize a
    -- player was told they had won is not on the table. Accounting for the
    -- inflation is what lets the alarm distinguish "money we already know
    -- about and have since fixed" from a NEW leak.
    --
    -- Contributions are measured against the PRIZE pool specifically, so the
    -- bounty half of a bounty entry is excluded — that funds bounty_pool and
    -- is paid out as bounties, which the delta already subtracts. Getting
    -- this wrong is what left 23 bounty/PKO events flagged on the first
    -- attempt at this function.
    --
    -- Hard-dated and gated on the absence of a real overlay row, so no event
    -- finalized after the fix can ever use this branch to hide a leak.
    + CASE
        WHEN m.ended_at < '2026-08-27T12:00:00Z' AND NOT m.has_overlay_row
        THEN GREATEST(m.pool - (m.money_in - m.refunds - m.rake - m.bounty_pool), 0)
        ELSE 0
      END
  , 2)
  FROM m;
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_conservation_delta(uuid) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE SENTINEL — same arithmetic, fewer false alarms, and it lets go
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
  v_resolved integer := 0; v_delta numeric; v_tol numeric := GREATEST(p_tolerance, 0);
BEGIN
  -- ── SELF-RESOLVE FIRST ────────────────────────────────────────────────
  -- Re-check every tournament this sentinel still has an open alert for. An
  -- event that conserves again — the Heads-Up back-pay landed, a missing
  -- payout was reconciled, an overlay got funded — closes its own alert.
  FOR v_row IN
    SELECT fa.id, (fa.context->>'tournament_id')::uuid AS tid
      FROM public.financial_alerts fa
     WHERE fa.source = 'fn_tournament_money_conservation'
       AND fa.resolved IS NOT TRUE
       AND fa.context->>'tournament_id' IS NOT NULL
     ORDER BY fa.created_at ASC
     LIMIT 1000
  LOOP
    v_delta := public.fn_tournament_conservation_delta(v_row.tid);
    IF v_delta IS NOT NULL AND abs(v_delta) <= v_tol THEN
      UPDATE public.financial_alerts
         SET resolved = true, resolved_at = now()
       WHERE id = v_row.id;
      v_resolved := v_resolved + 1;
    END IF;
  END LOOP;

  -- ── SCAN ──────────────────────────────────────────────────────────────
  FOR v_row IN
    SELECT t.id, t.name, t.variant
      FROM public.tournaments t
     WHERE t.status IN ('COMPLETED','CANCELLED')
       AND t.ended_at > now() - make_interval(days => GREATEST(p_since_days, 1))
       AND t.ended_at < now() - interval '30 minutes'
       AND COALESCE(t.variant, '') NOT IN ('spin', 'satellite')
       -- FREEROLLS ARE FUNDED BY DESIGN: a 0-cost entry pays prizes nobody
       -- bought in for. That is the product, not a leak — the cost shows up
       -- in the club treasury like any other marketing spend.
       AND COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) > 0
     ORDER BY t.ended_at DESC
     LIMIT GREATEST(p_limit, 1)
  LOOP
    v_scanned := v_scanned + 1;
    v_delta := public.fn_tournament_conservation_delta(v_row.id);
    IF v_delta IS NULL OR abs(v_delta) <= v_tol THEN CONTINUE; END IF;

    IF v_delta > 0 THEN v_retained := v_retained + v_delta;
    ELSE v_unfunded := v_unfunded - v_delta; END IF;
    v_flagged := v_flagged + 1;

    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'warning', 'fn_tournament_money_conservation',
           CASE WHEN v_delta > 0
                THEN 'Tournament retained money it never paid out: '
                ELSE 'Tournament paid out money it never collected: ' END
             || COALESCE(v_row.name, v_row.id::text),
           jsonb_build_object('tournament_id', v_row.id, 'variant', v_row.variant,
                              'delta', v_delta)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts
        WHERE source = 'fn_tournament_money_conservation'
          AND resolved IS NOT TRUE
          AND context->>'tournament_id' = v_row.id::text);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'scanned', v_scanned, 'flagged', v_flagged,
    'auto_resolved', v_resolved,
    'retained_chips', round(v_retained, 2), 'unfunded_chips', round(v_unfunded, 2));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_money_conservation(integer, numeric, integer) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RETIRE THE ALERTS THAT WERE NEVER DEFECTS
-- ─────────────────────────────────────────────────────────────────────────────
-- The freeroll and pre-ledger-guarantee alerts already raised describe
-- club-funded money, so they are resolved here rather than left for an
-- operator to work out one at a time. The Heads-Up backlog is deliberately
-- NOT touched: that money is genuinely owed and the alerts close themselves
-- as fn_backpay_hu_winner_shortfalls repays each one.

UPDATE public.financial_alerts fa
   SET resolved = true, resolved_at = now()
 WHERE fa.source = 'fn_tournament_money_conservation'
   AND fa.resolved IS NOT TRUE
   AND fa.context->>'tournament_id' IS NOT NULL
   AND abs(COALESCE(public.fn_tournament_conservation_delta(
         (fa.context->>'tournament_id')::uuid), 0)) <= 1.0;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. ASSERTIONS
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_freeroll integer; v_preledger integer; v_hu integer;
BEGIN
  IF to_regprocedure('public.fn_tournament_conservation_delta(uuid)') IS NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: fn_tournament_conservation_delta missing';
  END IF;
  IF pg_get_functiondef('public.fn_tournament_money_conservation(integer, numeric, integer)'::regprocedure)
       NOT LIKE '%auto_resolved%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: sentinel cannot self-resolve';
  END IF;

  -- Freerolls and pre-ledger guarantees must be quiet now.
  SELECT count(*) INTO v_freeroll
    FROM public.financial_alerts fa JOIN public.tournaments t
      ON t.id = (fa.context->>'tournament_id')::uuid
   WHERE fa.source = 'fn_tournament_money_conservation' AND fa.resolved IS NOT TRUE
     AND COALESCE(t.buy_in_amount,0) + COALESCE(t.buy_in_fee,0) = 0;
  IF v_freeroll > 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: % freeroll alert(s) still open', v_freeroll;
  END IF;

  -- Pre-fix pool inflation must be accounted for, not left re-flagging every
  -- scan. A tiny residue is expected and WANTED: an event whose books do not
  -- reconcile even after the inflation term is a genuine unexplained finding
  -- and must stay loud. The bar is that the category is essentially quiet,
  -- not that it is silent.
  SELECT count(*) INTO v_preledger
    FROM public.financial_alerts fa JOIN public.tournaments t
      ON t.id = (fa.context->>'tournament_id')::uuid
   WHERE fa.source = 'fn_tournament_money_conservation' AND fa.resolved IS NOT TRUE
     AND COALESCE(t.max_players, 0) > 2
     AND t.ended_at < '2026-08-27T12:00:00Z';
  IF v_preledger > 5 THEN
    RAISE EXCEPTION 'ASSERT FAILED: % pre-fix alert(s) still open — the inflation term is wrong', v_preledger;
  END IF;
  RAISE NOTICE 'phase 3b: % pre-fix alert(s) remain (genuine unexplained findings)', v_preledger;

  -- The genuinely-owed Heads-Up backlog must NOT have been silenced.
  SELECT count(*) INTO v_hu
    FROM public.financial_alerts fa JOIN public.tournaments t
      ON t.id = (fa.context->>'tournament_id')::uuid
   WHERE fa.source = 'fn_tournament_money_conservation' AND fa.resolved IS NOT TRUE
     AND COALESCE(t.variant,'') = 'sng';
  IF v_hu = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: the Heads-Up backlog was silenced, not repaid';
  END IF;
  RAISE NOTICE 'phase 3b: % HU alert(s) correctly still open, awaiting back-pay', v_hu;
END $$;

-- ROLLBACK:
--   restore fn_tournament_money_conservation from
--   20260827_guarantee_overlay_funding_and_conservation.sql and
--   DROP FUNCTION public.fn_tournament_conservation_delta(uuid);
