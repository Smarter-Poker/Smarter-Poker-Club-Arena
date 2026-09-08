-- 20260908050354_the_diamond_economy_has_a_report.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS BUILDS, AND WHY (docs/DIAMOND-ACCOUNTING-STANDARD.md; CLAUDE.md 10.86;
-- docs/changelog/2026-09-08-the-economy-has-a-report.md):
--
-- THE DIAMOND ECONOMY IN ONE READ. Every number below was discoverable before tonight and none
-- of it was visible: it took a session of ad-hoc queries to learn that the store has taken $2.00
-- in its lifetime, that one account holds 87 percent of all human diamonds, and that real player
-- spending over thirty days is about 370 diamonds against an issuance that is about to run at
-- 225,000 a day. A number nobody can see is a number nobody manages.
--
-- fn_ca_diamond_economy(p_days) returns one row per section with a value, a comparison and a
-- note, so the whole economy reads top to bottom:
--
--   supply / holders / concentration - who has the diamonds, and how unevenly
--   faucet_<engine>                  - issuance by engine over the window
--   sink_<type>                      - what was actually spent on, by type
--   faucet_total / sink_total        - and the ratio between them, which is the health number
--   liability_unclaimed              - completed challenges not yet claimed
--   liability_purchased              - unconsumed purchased lots (real customer money)
--   breakage_<bucket>                - purchased lots by age, so breakage is aged not guessed
--   revenue_lifetime / revenue_window- what the store has actually taken
--   arena                            - diamonds inside the Diamond Arena
--
-- fn_ca_diamond_breakage_aging() is the purchased-lot half on its own, because a refund window
-- is measured in days and a liability that is not aged is a liability that is not understood.
--
-- Read-only. Nothing here moves a diamond, and both functions are service_role only: this is
-- the house's own view of its currency, not a player-facing surface.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Purchased-lot breakage, by age.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_breakage_aging()
RETURNS TABLE(bucket text, lots bigint, issued numeric, consumed numeric, refunded numeric, outstanding numeric, note text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH aged AS (
    SELECT CASE
             WHEN l.settled_at IS NULL THEN 'unsettled'
             WHEN l.settled_at > now() - interval '14 days'  THEN 'age_0_14d'
             WHEN l.settled_at > now() - interval '90 days'  THEN 'age_15_90d'
             WHEN l.settled_at > now() - interval '365 days' THEN 'age_91_365d'
             ELSE 'age_over_365d'
           END AS bucket,
           l.issued, l.consumed, l.refunded,
           (l.issued - l.consumed - l.refunded) AS outstanding
      FROM public.diamond_purchase_lots l
  )
  SELECT a.bucket,
         count(*)::bigint,
         COALESCE(sum(a.issued), 0)::numeric,
         COALESCE(sum(a.consumed), 0)::numeric,
         COALESCE(sum(a.refunded), 0)::numeric,
         COALESCE(sum(a.outstanding), 0)::numeric,
         CASE a.bucket
           WHEN 'unsettled'     THEN 'settled_at is null: a lot the settle path never stamped. Should be zero.'
           WHEN 'age_0_14d'     THEN 'inside the arena settlement window (ruling 14) and inside most card dispute windows: this is the money a chargeback can still take back.'
           WHEN 'age_15_90d'    THEN 'past the arena window, still inside the usual 120-day card dispute reach.'
           WHEN 'age_91_365d'   THEN 'past most dispute windows; outstanding here is ageing toward breakage.'
           ELSE                      'over a year old and never spent: breakage in all but name. A candidate for a revenue recognition decision, which is Dan''s.'
         END::text
    FROM aged a
   GROUP BY a.bucket
   ORDER BY CASE a.bucket
              WHEN 'unsettled' THEN 0 WHEN 'age_0_14d' THEN 1 WHEN 'age_15_90d' THEN 2
              WHEN 'age_91_365d' THEN 3 ELSE 4 END;
$$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_breakage_aging() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_breakage_aging() TO service_role;
COMMENT ON FUNCTION public.fn_ca_diamond_breakage_aging() IS
  'Purchased diamond lots by age: what is still refundable, what is ageing, what is breakage in all but name.';

-- ---------------------------------------------------------------------------
-- 2. The economy in one read.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_economy(p_days integer DEFAULT 30)
RETURNS TABLE(section text, metric text, value numeric, comparison numeric, note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_from timestamptz := now() - make_interval(days => GREATEST(COALESCE(p_days, 30), 1));
  v_supply numeric; v_horses numeric; v_humans numeric; v_top numeric; v_holders bigint;
  v_faucet numeric; v_sink numeric; v_arena numeric;
BEGIN
  SELECT COALESCE(sum(p.diamonds), 0),
         COALESCE(sum(p.diamonds) FILTER (WHERE p.is_horse), 0),
         COALESCE(sum(p.diamonds) FILTER (WHERE NOT p.is_horse), 0),
         count(*) FILTER (WHERE p.diamonds > 0)
    INTO v_supply, v_horses, v_humans, v_holders
    FROM public.profiles p;
  SELECT COALESCE(max(p.diamonds), 0) INTO v_top FROM public.profiles p WHERE NOT p.is_horse;

  -- ── supply and who holds it ──────────────────────────────────────────────
  RETURN QUERY SELECT 'supply'::text, 'total_diamonds'::text, v_supply,
    (SELECT public.fn_ca_mint_supply('diamonds'))::numeric,
    'value is sum(profiles.diamonds); comparison is the Mint register. They must be equal.'::text;
  RETURN QUERY SELECT 'supply'::text, 'holders'::text, v_holders::numeric, NULL::numeric,
    'accounts holding more than zero.'::text;
  RETURN QUERY SELECT 'holders'::text, 'horses'::text, v_horses,
    CASE WHEN v_supply > 0 THEN round(100 * v_horses / v_supply, 1) ELSE NULL END,
    'comparison is percent of all diamonds. Horses are players (CLAUDE.md 10.5); this is not a deduction, it is a fact about who is playing.'::text;
  RETURN QUERY SELECT 'holders'::text, 'humans'::text, v_humans,
    CASE WHEN v_supply > 0 THEN round(100 * v_humans / v_supply, 1) ELSE NULL END,
    'comparison is percent of all diamonds.'::text;
  RETURN QUERY SELECT 'concentration'::text, 'largest_human_holder'::text, v_top,
    CASE WHEN v_humans > 0 THEN round(100 * v_top / v_humans, 1) ELSE NULL END,
    'comparison is percent of all HUMAN diamonds held by one account. Above about 50 means the currency is one person''s.'::text;
  RETURN QUERY SELECT 'concentration'::text, 'humans_excluding_largest'::text,
    GREATEST(v_humans - v_top, 0),
    (SELECT count(*)::numeric FROM public.profiles p WHERE NOT p.is_horse AND p.diamonds > 0) - 1,
    'value is what every other human holds together; comparison is how many of them there are.'::text;

  -- ── faucets ──────────────────────────────────────────────────────────────
  RETURN QUERY
  SELECT 'faucet'::text,
         public.fn_ca_diamond_engine_of(dt.type, dt.transaction_type, dt.source, dt.description, dt.reference_id),
         COALESCE(sum(dt.amount), 0)::numeric, count(*)::numeric,
         'diamonds issued over the window by engine; comparison is the number of credits.'::text
    FROM public.diamond_transactions dt
   WHERE dt.amount > 0 AND dt.created_at >= v_from
     AND NOT public.fn_ca_is_fixture_account(dt.user_id)
   GROUP BY 2
   ORDER BY 3 DESC;

  -- ── sinks ────────────────────────────────────────────────────────────────
  RETURN QUERY
  SELECT 'sink'::text,
         COALESCE(NULLIF(btrim(dt.transaction_type), ''), NULLIF(btrim(dt.type), ''), 'unknown'),
         COALESCE(sum(-dt.amount), 0)::numeric, count(*)::numeric,
         'diamonds spent over the window by kind; comparison is the number of debits.'::text
    FROM public.diamond_transactions dt
   WHERE dt.amount < 0 AND dt.created_at >= v_from
     AND NOT public.fn_ca_is_fixture_account(dt.user_id)
   GROUP BY 2
   ORDER BY 3 DESC;

  SELECT COALESCE(sum(dt.amount) FILTER (WHERE dt.amount > 0), 0),
         COALESCE(sum(-dt.amount) FILTER (WHERE dt.amount < 0), 0)
    INTO v_faucet, v_sink
    FROM public.diamond_transactions dt
   WHERE dt.created_at >= v_from AND NOT public.fn_ca_is_fixture_account(dt.user_id);

  RETURN QUERY SELECT 'flow'::text, 'faucet_total'::text, v_faucet, NULL::numeric,
    'everything issued to players over the window.'::text;
  RETURN QUERY SELECT 'flow'::text, 'sink_total'::text, v_sink, NULL::numeric,
    'everything spent by players over the window.'::text;
  RETURN QUERY SELECT 'flow'::text, 'faucet_over_sink'::text,
    CASE WHEN v_sink > 0 THEN round(v_faucet / v_sink, 2) ELSE NULL END, v_faucet - v_sink,
    'THE HEALTH NUMBER. Above 1 the currency inflates; comparison is the net added to supply over the window. A ratio in the hundreds means the faucet is priced above the store.'::text;

  -- ── liabilities ──────────────────────────────────────────────────────────
  RETURN QUERY SELECT 'liability'::text, 'unclaimed_challenges'::text,
    (SELECT COALESCE(sum(u.diamond_reward_snapshot), 0)::numeric FROM public.user_daily_challenges u
      WHERE u.completed AND NOT u.claimed AND u.expired_at IS NULL),
    (SELECT count(*)::numeric FROM public.user_daily_challenges u
      WHERE u.completed AND NOT u.claimed AND u.expired_at IS NULL),
    'promised and not yet paid; expires seven days after completion (ruling 3). Comparison is the row count.'::text;
  RETURN QUERY SELECT 'liability'::text, 'purchased_outstanding'::text,
    (SELECT COALESCE(sum(l.issued - l.consumed - l.refunded), 0)::numeric FROM public.diamond_purchase_lots l
      WHERE (l.issued - l.consumed - l.refunded) > 0),
    (SELECT COALESCE(sum(d.amount), 0)::numeric FROM public.diamond_debts d WHERE d.settled_at IS NULL),
    'real customer money still in wallets; comparison is open receivables from reversed purchases (ruling 2).'::text;

  RETURN QUERY
  SELECT 'breakage'::text, b.bucket, b.outstanding, b.lots::numeric, b.note
    FROM public.fn_ca_diamond_breakage_aging() b;

  -- ── revenue ──────────────────────────────────────────────────────────────
  RETURN QUERY SELECT 'revenue'::text, 'lifetime_usd'::text,
    (SELECT COALESCE(sum(dp.price_usd), 0)::numeric FROM public.diamond_purchases dp WHERE dp.status = 'completed'),
    (SELECT count(*)::numeric FROM public.diamond_purchases dp WHERE dp.status = 'completed'),
    'every completed diamond purchase, ever; comparison is how many. This is the number the whole economy is meant to serve.'::text;
  RETURN QUERY SELECT 'revenue'::text, 'window_usd'::text,
    (SELECT COALESCE(sum(dp.price_usd), 0)::numeric FROM public.diamond_purchases dp
      WHERE dp.status = 'completed' AND dp.completed_at >= v_from),
    (SELECT count(*)::numeric FROM public.diamond_purchases dp
      WHERE dp.status = 'completed' AND dp.completed_at >= v_from),
    'purchases inside the window.'::text;

  -- ── the arena ────────────────────────────────────────────────────────────
  v_arena := public.fn_ca_arena_diamonds();
  RETURN QUERY SELECT 'arena'::text, 'diamonds_inside'::text, v_arena,
    CASE WHEN v_supply > 0 THEN round(100 * v_arena / v_supply, 1) ELSE NULL END,
    'held in the platform club''s member wallets; comparison is percent of supply. Zero until the arena club exists.'::text;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_economy(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_economy(integer) TO service_role;
COMMENT ON FUNCTION public.fn_ca_diamond_economy(integer) IS
  'The whole diamond economy in one read: supply, who holds it, faucets by engine, sinks by kind, the faucet-over-sink health number, liabilities, breakage by age, revenue, and the arena.';

-- ---------------------------------------------------------------------------
-- 3. Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_rows integer; v_supply numeric; v_reg numeric;
BEGIN
  SELECT count(*) INTO v_rows FROM public.fn_ca_diamond_economy(30);
  IF v_rows < 12 THEN RAISE EXCEPTION 'the economy report returned only % rows', v_rows; END IF;

  SELECT value, comparison INTO v_supply, v_reg
    FROM public.fn_ca_diamond_economy(30) WHERE section = 'supply' AND metric = 'total_diamonds';
  IF v_supply IS DISTINCT FROM v_reg THEN
    RAISE EXCEPTION 'the report says supply % and register %', v_supply, v_reg;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.fn_ca_diamond_economy(30) WHERE section = 'flow' AND metric = 'faucet_over_sink') THEN
    RAISE EXCEPTION 'the health number is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fn_ca_diamond_economy(30) WHERE section = 'revenue' AND metric = 'lifetime_usd') THEN
    RAISE EXCEPTION 'revenue is missing';
  END IF;
  IF (SELECT count(*) FROM public.fn_ca_diamond_breakage_aging()) = 0
     AND (SELECT count(*) FROM public.diamond_purchase_lots) > 0 THEN
    RAISE EXCEPTION 'there are lots but the aging report is empty';
  END IF;

  -- neither function may be reachable by a browser: this is the house's view of its own currency
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, LATERAL aclexplode(p.proacl) a
              WHERE n.nspname = 'public' AND p.proname IN ('fn_ca_diamond_economy', 'fn_ca_diamond_breakage_aging')
                AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole)) THEN
    RAISE EXCEPTION 'the economy report is reachable from a browser';
  END IF;
END $$;

COMMIT;
