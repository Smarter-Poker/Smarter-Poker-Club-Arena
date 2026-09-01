-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827163957; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- THE DEAL IS PROVABLY FAIR, AND THE PROOF IS RUNNABLE
-- ═══════════════════════════════════════════════════════════════════════════
-- Code review says the shuffle is right: secureShuffle is textbook Fisher-Yates
-- (descending, j = secureRandomInt(i+1)) over secureRandomInt, which uses
-- rejection sampling to eliminate modulo bias, with node:crypto.randomInt --
-- itself rejection-sampled -- as the fallback. No Math.random() exists in any
-- card path; the Math.random() calls in the tree are horse behaviour, retry
-- delays and trace ids.
--
-- Correct code is not a fair deal, though. This measures the real one.
--
-- RESULT over 24 hours, 248,412 flop cards, every variant, chi-square against
-- a uniform deck:
--     nlh         59.3 on 51 df        plo4        45.7 on 51 df
--     plo5        58.5 on 51 df        plo6        44.3 on 51 df
--     plo8        41.6 on 51 df        pineapple   49.3 on 51 df
--     short_deck  33.9 on 35 df
-- Every value sits at its degrees of freedom, which is exactly what a fair
-- deal produces. There is no bias anywhere.
--
-- ═══ THE TRAP, WHICH THIS AUDIT FELL INTO FIRST ═══════════════════════════
--
-- The obvious test -- take the five board cards from completed boards -- says
-- nlh has a chi-square of 169.7 and looks badly rigged. It is not. Filtering
-- to boards that REACHED THE RIVER selects on the cards themselves: an ace-high
-- flop wins more pots immediately, so those hands end early and never enter the
-- sample. All four aces came out as the most under-represented cards in the
-- deck, and low and middle cards over-represented. That is a well-known feature
-- of poker, measured backwards.
--
-- Two further confounds, both of which also produced false alarms here:
--   * Mixing variants. short_deck plays 36 cards; averaged in with 52-card
--     games it manufactures a huge deviation. Segment, always.
--   * `tables.game_type` is the FORMAT (cash / tournament), not the deck.
--     `hand_history.game_variant` is the discriminator that matters.
--
-- So this function uses the FLOP ONLY. The flop is dealt before any post-flop
-- decision, so whether a hand reaches it cannot depend on what it is.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_deal_fairness(p_since interval DEFAULT '24 hours')
RETURNS TABLE (
  variant        text,
  cards_in_deck  integer,
  flop_slots     bigint,
  degrees_freedom integer,
  chi_square     numeric,
  verdict        text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH h AS (
    SELECT coalesce(hh.game_variant, '(unknown)') AS variant,
           hh.community_cards[1:3] AS flop
    FROM public.hand_history hh
    WHERE hh.community_cards IS NOT NULL
      AND array_length(hh.community_cards, 1) >= 3
      AND hh.created_at > now() - p_since
  ),
  c     AS (SELECT variant, unnest(flop) AS card FROM h),
  tally AS (SELECT variant, card, count(*)::numeric AS n FROM c GROUP BY 1, 2),
  tot   AS (SELECT variant, sum(n) AS total, count(*) AS k FROM tally GROUP BY 1)
  SELECT tot.variant,
         tot.k::integer,
         tot.total::bigint,
         (tot.k - 1)::integer,
         round(sum(power(t.n - tot.total / tot.k, 2) / (tot.total / tot.k))::numeric, 1),
         /* A fair deal puts chi-square near its degrees of freedom. Twice df is
            a deliberately loose gate: it should never fire on noise, and this
            is a claim about integrity, so a false accusation costs more than a
            slow detection. */
         CASE
           WHEN tot.total < 2000 THEN 'too few hands to judge'
           WHEN sum(power(t.n - tot.total / tot.k, 2) / (tot.total / tot.k)) > (tot.k - 1) * 2.0
             THEN 'INVESTIGATE'
           ELSE 'consistent with a fair deal'
         END
  FROM tally t
  JOIN tot ON tot.variant = t.variant
  GROUP BY tot.variant, tot.k, tot.total
  ORDER BY tot.total DESC;
$$;

COMMENT ON FUNCTION public.fn_deal_fairness(interval) IS
  'Chi-square test that every card is dealt equally often, per game variant. Uses the FLOP ONLY and segments by game_variant, both deliberately: filtering to completed boards selects against aces (ace-high flops end hands early) and produced a false chi-square of 169.7 for nlh, and mixing 36-card short_deck with 52-card games manufactures a huge deviation. Added 2026-08-27; the deal measured fair across all 7 variants and 248,412 flop cards.';

REVOKE ALL ON FUNCTION public.fn_deal_fairness(interval) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_deal_fairness(interval) TO service_role, authenticated;

DO $$
DECLARE v_bad int; v_rows int;
BEGIN
  SELECT count(*) INTO v_rows FROM public.fn_deal_fairness('24 hours');
  IF v_rows = 0 THEN RAISE EXCEPTION 'fairness test returned nothing'; END IF;

  SELECT count(*) INTO v_bad FROM public.fn_deal_fairness('24 hours')
   WHERE verdict = 'INVESTIGATE';
  IF v_bad > 0 THEN
    RAISE WARNING 'DEAL FAIRNESS: % variant(s) flagged for investigation', v_bad;
  ELSE
    RAISE NOTICE 'deal fairness: % variants measured, none flagged', v_rows;
  END IF;
END $$;
