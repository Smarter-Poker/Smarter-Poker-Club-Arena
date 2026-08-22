-- ============================================================================
-- 20260822230000_spin_no_extra_rake.sql
-- TIER: 3  |  AFFECTS: public.tournaments (CHECK constraint, NOT VALID)
--                      public.v_spin_reserve_health (one column added)
--
-- WHY
--
-- src/config/spinSpec.ts states the rule in capitals, quoting Dan:
--
--   "A Spin is NOT priced like an MTT. There is no '10 + 1': the player pays
--    the listed buy-in and nothing else, and the rake is engineered into the
--    multiplier distribution. THEY ARE STRAIGHT JUST 10 BUY IN... NO
--    ADDITIONAL RAKE IS ADDED. ... So the buy-in is the whole charge, and
--    buy_in_fee MUST be 0 on a Spin."
--
-- and spells out the cost of getting it wrong: "Had the player been charged
-- buy-in PLUS 8% on top, the true edge would have been 14.7%, which is not
-- what any room advertises."
--
-- Every layer BELIEVED that rule. None of them ENFORCED it. And believing it
-- was worse than not knowing it, because both the backstop and the alarm were
-- written to skip anything that broke it:
--
--   fn_spin_sweep_unbooked ... AND COALESCE(t.buy_in_fee, 0) = 0
--   v_spin_reserve_health  ... AND COALESCE(t.buy_in_fee, 0) = 0   (unbooked_24h)
--
-- So a Spin created with a fee was double-raked AND invisible: the sweep would
-- not settle it, and the counter that exists to notice unsettled games did not
-- count it. Measured on 2026-08-22:
--
--   9,603 spins all time, 7,120 of them carrying a fee (every spin before
--   2026-08-20 19:23 UTC, when the fee was fixed at the spinSpec cutover)
--
--   2,116 of those RAN and were never booked to spin_reserve_ledger:
--     13,512.00 collected from players
--      1,351.20 charged as fee ON TOP of a buy-in that already contained the rake
--     12,431.04 that should have entered the reserve and never did
--     11,488.00 of prizes that never left it
--
-- Nothing said a word about any of it, for months.
--
-- WHAT THIS DOES, AND DOES NOT DO
--
--   1. Refuses the NEXT one. A CHECK constraint, NOT VALID, so the 7,120
--      historical rows are left exactly as they are and no table scan is taken.
--      New and updated rows must satisfy it.
--
--   2. Makes the exclusion LOUD. v_spin_reserve_health gains
--      fee_violations_24h. The sweep keeps skipping fee-bearing spins - settling
--      one against economics it does not match would be worse than leaving it -
--      but the operator dashboard now reports that it happened instead of
--      swallowing it.
--
--   3. Does NOT touch the 2,116 historical games. Booking them retroactively
--      moves real money in the reserve pool, and that is a decision for Dan,
--      not a side effect of a schema migration.
--
-- The constraint tests BOTH `variant` and `tournament_type`. They agree on
-- every row in the table today, but src/utils/spinReveal.ts checks both on
-- purpose, and the union-reserve audit records that reading only one "is how it
-- quietly returns false for half the Spins in the system".
--
-- ROLLBACK
--
--   ALTER TABLE public.tournaments DROP CONSTRAINT tournaments_spin_no_extra_rake;
--
--   DROP VIEW IF EXISTS public.v_spin_reserve_health;
--   -- then recreate it from 20260822220000_retire_500x_reserve_health_columns.sql
--   -- (the definition immediately before fee_violations_24h was added).
-- ============================================================================

-- ── Pre-flight ──────────────────────────────────────────────────────────────
DO $$
DECLARE v_recent int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tournaments' AND column_name='buy_in_fee'
  ) THEN
    RAISE EXCEPTION 'tournaments.buy_in_fee does not exist';
  END IF;

  -- A constraint that today's writers would immediately violate is a broken
  -- deploy, not a guard. Prove the fee stopped before adding it.
  SELECT count(*) INTO v_recent
    FROM public.tournaments
   WHERE (variant = 'spin' OR upper(coalesce(tournament_type,'')) = 'SPIN')
     AND COALESCE(buy_in_fee, 0) <> 0
     AND created_at > now() - interval '24 hours';
  IF v_recent > 0 THEN
    RAISE EXCEPTION
      'a spin was created WITH A FEE in the last 24h (% rows) - fix the writer before adding the constraint',
      v_recent;
  END IF;
END $$;

-- ── 1. Refuse the next one ──────────────────────────────────────────────────
ALTER TABLE public.tournaments
  DROP CONSTRAINT IF EXISTS tournaments_spin_no_extra_rake;

ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_spin_no_extra_rake
  CHECK (
    (variant IS DISTINCT FROM 'spin' AND upper(coalesce(tournament_type, '')) <> 'SPIN')
    OR COALESCE(buy_in_fee, 0) = 0
  )
  NOT VALID;

COMMENT ON CONSTRAINT tournaments_spin_no_extra_rake ON public.tournaments IS
  'A Spin charges the buy-in and nothing else - the rake is engineered into the multiplier distribution (src/config/spinSpec.ts). NOT VALID on purpose: 7,120 rows from before 2026-08-20 carry a fee and are left as historical fact.';

-- ── 2. Make the exclusion loud ──────────────────────────────────────────────
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
          WHERE fn_spin_reserve_owner(t.club_id) = p.club_id AND t.variant = 'spin'::text AND (t.status = ANY (ARRAY['RUNNING'::text, 'COMPLETED'::text])) AND COALESCE(t.spin_multiplier, 0::numeric) <= 0::numeric AND t.started_at > (now() - '24:00:00'::interval)) AS null_multiplier_24h,
    -- A Spin carrying a fee is double-raked, and BOTH the sweep and
    -- unbooked_24h above skip it on exactly that condition. Without this
    -- column the games the backstop refuses to touch are the same games
    -- nothing reports. 2,116 of them accumulated before anyone noticed.
    ( SELECT count(*) AS count
           FROM tournaments t
          WHERE fn_spin_reserve_owner(t.club_id) = p.club_id AND t.variant = 'spin'::text AND (t.status = ANY (ARRAY['RUNNING'::text, 'COMPLETED'::text])) AND COALESCE(t.buy_in_fee, 0::numeric) <> 0::numeric AND t.started_at > (now() - '24:00:00'::interval)) AS fee_violations_24h
   FROM spin_bonus_pools p
     LEFT JOIN clubs c ON c.id = p.club_id
     LEFT JOIN unions u ON u.id = p.club_id;

COMMENT ON VIEW public.v_spin_reserve_health IS
  'Per-pool solvency for the operator dashboard: balance, the 100x affordability gate, the thin-pool flag, and the counters /api/cron/spin-sweep alerts on. The 500x tier was retired 2026-08-21 and its three columns dropped 2026-08-22. fee_violations_24h was added the same day, because a Spin with a fee is skipped by the sweep AND by unbooked_24h, so the one shape of broken game nothing could fix was also the one nothing could see.';

REVOKE ALL ON public.v_spin_reserve_health FROM PUBLIC;
REVOKE ALL ON public.v_spin_reserve_health FROM anon, authenticated;
GRANT SELECT ON public.v_spin_reserve_health TO service_role;

-- ── 3. Post-apply assertions ────────────────────────────────────────────────
DO $$
DECLARE v_cols text[]; v_col text;
BEGIN
  SELECT array_agg(column_name::text ORDER BY ordinal_position) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='v_spin_reserve_health';

  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'v_spin_reserve_health was dropped and not recreated';
  END IF;
  IF NOT ('fee_violations_24h' = ANY(v_cols)) THEN
    RAISE EXCEPTION 'fee_violations_24h was not added';
  END IF;
  IF 'top_jackpot' = ANY(v_cols) OR 'need_for_500x' = ANY(v_cols) OR 'can_draw_500x' = ANY(v_cols) THEN
    RAISE EXCEPTION 'a retired 500x column came back: %', v_cols;
  END IF;

  -- Everything the deployed cron selects today must still be here. Adding a
  -- column is safe for an existing reader; losing one is the outage.
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

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.tournaments'::regclass
       AND conname = 'tournaments_spin_no_extra_rake'
  ) THEN
    RAISE EXCEPTION 'tournaments_spin_no_extra_rake was not created';
  END IF;

  -- That the constraint EXISTS is not that it REFUSES. Its definition is
  -- checked here; the refusal itself is proven against production in a
  -- transaction that is then rolled back, recorded under APPLY HISTORY below.
  -- A probe INSERT does not belong inside the migration: if the constraint
  -- were missing the insert would SUCCEED, and a migration that leaves a
  -- '__constraint_probe__' tournament behind on the one path where something
  -- is already wrong is not a check, it is a second bug.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'public.tournaments'::regclass
         AND conname = 'tournaments_spin_no_extra_rake') NOT LIKE '%buy_in_fee%' THEN
    RAISE EXCEPTION 'tournaments_spin_no_extra_rake does not mention buy_in_fee';
  END IF;
END $$;

-- ============================================================================
-- APPLY HISTORY
--
-- Applied to production 2026-08-22 as `spin_no_extra_rake`.
--
-- BEHAVIOURAL CHECK, run against production inside a transaction that was then
-- rolled back by RAISE. The constraint's existence is not its behaviour, and
-- this is the part that proves it:
--
--   spin given a fee            -> REFUSED (check_violation)
--   spin kept fee-free          -> ACCEPTED
--   non-spin with a fee         -> ACCEPTED  (unaffected, as intended)
--   historical fee-bearing spins-> 7,120 still present (NOT VALID left them)
--   fee_violations_24h          -> 0
--
-- The fee case deliberately uses 0.90 + 0.10 rather than 1.00 + 0.10. There is
-- already a trigger, fn_enforce_whole_dollar_buyin, that refuses a fee which
-- does not sum to a whole total - and triggers fire BEFORE check constraints,
-- so a 1.00 + 0.10 probe proves only that the older guard works. Splitting a
-- whole total is precisely the shape that trigger permits and this constraint
-- must not: for a Spin, 0.90 + 0.10 is still a fee, and a fee is still what
-- makes the sweep and unbooked_24h look straight past the game.
-- ============================================================================
