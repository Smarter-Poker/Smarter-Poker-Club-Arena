-- ============================================================================
-- 20260822220000_retire_500x_reserve_health_columns.sql
-- TIER: 3  |  AFFECTS: public.v_spin_reserve_health (three columns dropped)
--
-- WHY
--
-- The 500x Spin tier was retired on 2026-08-21. Migration 20260821g rebuilt
-- v_spin_tier_availability without can_draw_500x; these three columns on
-- v_spin_reserve_health outlived it:
--
--   top_jackpot     highest_stake * 500      the prize of a tier nobody can win
--   need_for_500x   highest_stake * 500 * 2  the reserve needed to offer it
--   can_draw_500x   balance >= need_for_500x  whether it may be offered
--
-- They were left deliberately, and the reason is worth repeating because it is
-- the whole shape of this change. PostgREST does not quietly drop an unknown
-- column from a select - it refuses the ENTIRE request with 42703. On
-- 2026-08-21 can_draw_500x was dropped from the availability view while a
-- deployed bundle still selected it, and the Spin badge went dark for every
-- club at once, from a failure that looked nothing like its cause.
--
-- v_spin_reserve_health had exactly one reader: pages/api/cron/spin-sweep.js in
-- the World Hub, which named can_draw_500x in its select and never read the
-- value. Dropping these while that cron asked for one would have blinded the
-- operator dashboard on every reserve pool - the same incident, one layer down,
-- on the surface whose entire job is to notice when a pool cannot pay.
--
-- SO THE READER WENT FIRST, AND IT IS LIVE:
--
--   World Hub 0162ff08da removed the column from the select
--   merged into main, and production /api/health served 80a29487
--   (which contains it) at 2026-08-22 19:57 UTC.
--
-- Nothing else in any of the seven repos selects these three. The only other
-- occurrences are prose: a comment in src/hooks/useSpinTierAvailability.ts
-- explaining why it stopped asking, and the sourcemap that quotes it.
--
-- WHAT
--
-- The view is recreated without the three columns. Everything else - including
-- need_for_100x, can_draw_100x and the four counters spin-sweep alerts on - is
-- reproduced byte for byte from the live definition. CREATE OR REPLACE VIEW
-- cannot drop a column, so this is DROP + CREATE; the view is not depended on
-- by any other view or function (checked: zero dependents).
--
-- ROLLBACK
--
--   Re-add the three expressions to the SELECT below and rerun. They are pure
--   arithmetic over columns that still exist, so nothing is lost by dropping
--   them and nothing needs backfilling to bring them back:
--
--     round(p.highest_stake * 500::numeric, 2)                   AS top_jackpot,
--     round(p.highest_stake * 500::numeric * 2.0, 2)             AS need_for_500x,
--     p.balance >= (p.highest_stake * 500::numeric * 2.0)        AS can_draw_500x,
--
--   A rollback would also have to precede any client that selects them again -
--   for the same reason this migration had to follow the reader's removal.
-- ============================================================================

-- ── Pre-flight ──────────────────────────────────────────────────────────────
DO $$
DECLARE v_dependents int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'v_spin_reserve_health' AND c.relkind = 'v'
  ) THEN
    RAISE EXCEPTION 'v_spin_reserve_health does not exist - nothing to retire';
  END IF;

  -- Something built on top of this view would break on the DROP, and the
  -- CASCADE that "fixes" that is how a dependent object disappears silently.
  SELECT count(*) INTO v_dependents
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('v', 'm')
     AND c.relname <> 'v_spin_reserve_health'
     AND pg_get_viewdef(c.oid) ILIKE '%v_spin_reserve_health%';
  IF v_dependents > 0 THEN
    RAISE EXCEPTION 'v_spin_reserve_health has % dependent view(s) - recreate them too', v_dependents;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'v_spin_reserve_health'
       AND column_name = 'can_draw_100x'
  ) THEN
    RAISE EXCEPTION 'can_draw_100x is already gone - the live view is not what this migration expects';
  END IF;
END $$;

-- ── The view, minus the retired tier ────────────────────────────────────────
DROP VIEW IF EXISTS public.v_spin_reserve_health;

CREATE VIEW public.v_spin_reserve_health AS
 SELECT p.club_id,
    COALESCE(c.name, u.name) AS club_name,
    p.balance,
    p.seeded_amount,
    p.highest_stake,
    p.ceiling_amount,
    p.spin_count,
    p.total_deposited,
    p.total_drawn,
    round(p.highest_stake * 100::numeric * 1.5, 2) AS need_for_100x,
    p.balance >= (p.highest_stake * 100::numeric * 1.5) AS can_draw_100x,
    p.balance < (p.highest_stake * 10::numeric) AS is_thin,
    ( SELECT count(*) AS count
           FROM spin_reserve_ledger l
          WHERE fn_spin_reserve_owner(l.club_id) = p.club_id AND l.kind = 'adjustment'::text) AS shortfall_events,
    ( SELECT count(*) AS count
           FROM tournaments t
          WHERE fn_spin_reserve_owner(t.club_id) = p.club_id AND t.variant = 'spin'::text AND (t.status = ANY (ARRAY['RUNNING'::text, 'COMPLETED'::text])) AND COALESCE(t.buy_in_fee, 0::numeric) = 0::numeric AND t.started_at > (now() - '24:00:00'::interval) AND NOT (EXISTS ( SELECT 1
                   FROM spin_reserve_ledger l2
                  WHERE l2.tournament_id = t.id))) AS unbooked_24h,
    ( SELECT count(*) AS count
           FROM tournaments t
          WHERE fn_spin_reserve_owner(t.club_id) = p.club_id AND t.variant = 'spin'::text AND (t.status = ANY (ARRAY['RUNNING'::text, 'COMPLETED'::text])) AND COALESCE(t.spin_multiplier, 0::numeric) <= 0::numeric AND t.started_at > (now() - '24:00:00'::interval)) AS null_multiplier_24h
   FROM spin_bonus_pools p
     LEFT JOIN clubs c ON c.id = p.club_id
     LEFT JOIN unions u ON u.id = p.club_id;

COMMENT ON VIEW public.v_spin_reserve_health IS
  'Per-pool solvency for the operator dashboard: balance, the 100x affordability gate, the thin-pool flag, and the four counters /api/cron/spin-sweep alerts on. The 500x tier was retired 2026-08-21 and its three columns were dropped 2026-08-22, after the last reader had shipped without them.';

-- The view was never public and must not become public by being recreated.
-- v_spin_tier_availability exists precisely so a client never needs this one.
REVOKE ALL ON public.v_spin_reserve_health FROM PUBLIC;
REVOKE ALL ON public.v_spin_reserve_health FROM anon, authenticated;
GRANT SELECT ON public.v_spin_reserve_health TO service_role;

-- ── Post-apply assertions ───────────────────────────────────────────────────
DO $$
DECLARE
  v_cols text[];
  v_col  text;
BEGIN
  SELECT array_agg(column_name::text ORDER BY ordinal_position) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'v_spin_reserve_health';

  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'v_spin_reserve_health was dropped and not recreated';
  END IF;

  IF 'top_jackpot' = ANY(v_cols) OR 'need_for_500x' = ANY(v_cols) OR 'can_draw_500x' = ANY(v_cols) THEN
    RAISE EXCEPTION 'a retired 500x column survived: %', v_cols;
  END IF;

  -- Every column spin-sweep.js selects must still be here. Losing one of these
  -- is the failure this migration is trying to avoid, not cause.
  FOREACH v_col IN ARRAY ARRAY['club_id','club_name','balance','highest_stake',
                               'can_draw_100x','is_thin','shortfall_events',
                               'unbooked_24h','null_multiplier_24h']
  LOOP
    IF NOT (v_col = ANY(v_cols)) THEN
      RAISE EXCEPTION 'v_spin_reserve_health lost %, which /api/cron/spin-sweep selects', v_col;
    END IF;
  END LOOP;

  IF has_table_privilege('anon', 'public.v_spin_reserve_health', 'SELECT')
     OR has_table_privilege('authenticated', 'public.v_spin_reserve_health', 'SELECT') THEN
    RAISE EXCEPTION 'v_spin_reserve_health became readable by a client role';
  END IF;
END $$;
