-- ═══════════════════════════════════════════════════════════════════════════
--  A BOUNTY POOL PAYS OUT WHAT IT COLLECTED (2026-09-01)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `tournaments.bounty_pool` is what the field paid IN for bounties.
-- `tournaments.bounty_pool_paid` is what went back OUT. Five writers move
-- them and NOTHING has ever asserted that they end up equal.
--
-- fn_finalize_bounty_pool is the function that is supposed to make them equal:
-- it reads what the LEDGER actually paid, pays the champion the residual, and
-- sets bounty_pool_paid = paid + residual = bounty_pool. It gets that right in
-- the ordinary case. What it does not do is notice when it CANNOT -- when the
-- residual is negative, it returns early and leaves the two columns unequal,
-- silently, forever.
--
-- ── THE HISTORICAL NUMBERS. THESE ARE DAN'S CALL, NOT THIS PR'S. ───────────
--
-- MEASURED IN PRODUCTION 2026-08-31, read-only, all 54,275 tournament rows:
--
--   COMPLETED, pool RETAINED (collected more than it paid out)
--     35 tournaments        1,730.16 chips still held
--       19 plain bounty       541.00   ended 2026-08-21 .. 2026-08-31
--       11 PKO                990.16   ended 2026-08-22 .. 2026-08-31
--        5 mystery bounty     199.00   ended 2026-08-15 .. 2026-08-23
--
--   COMPLETED, pool OVERPAID (paid out more than it collected)
--     10 tournaments          150.40 chips paid beyond the pool
--     EVERY ONE of them a mystery bounty, and every one ended inside a single
--     thirteen-hour window on 2026-08-29/30:
--        420.00 ->  459.00   +39.00   Union Mystery Bounty (PLO5)
--        420.00 ->  445.00   +25.00   Union Mystery Bounty (PLO5)
--        420.00 ->  439.00   +19.00   Union Mystery Bounty (PLO5)
--        174.00 ->  192.00   +18.00   Evening Mystery Bounty (PLO5)
--        180.00 ->  191.00   +11.00   Evening Mystery Bounty (PLO5)
--        180.00 ->  189.60    +9.60   Evening Mystery Bounty (PLO5)
--        180.00 ->  189.50    +9.50   Evening Mystery Bounty (PLO5)
--        180.00 ->  189.50    +9.50   Evening Mystery Bounty (PLO5)
--        776.00 ->  783.20    +7.20   Saturday Mystery
--         30.00 ->   32.60    +2.60   Pre-Dawn Mystery Bounty (PLO5)
--
--   Not COMPLETED, retained: 1 CANCELLED (42.00), 5 REGISTERING (1,011.00),
--   2 RUNNING (416.00). Those are live or reversed events, not drift.
--
-- The overpay is not spread across the product; it is one defect in the
-- mystery bounty path, in one window. That is a lead, and it is written down
-- here so whoever picks it up does not start from zero.
--
-- NO BACKFILL. Both directions move chips that are in players' wallets today.
-- Recovering 150.40 means debiting ten champions; releasing 1,730.16 means
-- crediting somebody. Both are Dan's decisions and neither is in this PR.
--
-- ── WHAT IS SHIPPED ────────────────────────────────────────────────────────
--
--   1. fn_bounty_pool_law_assert(tournament) -- the equality assertion. Called
--      at settlement, on BOTH exits of the funded path of
--      fn_finalize_bounty_pool.
--   2. fn_bounty_pool_law_check(window) -- a sweep, in case a settlement never
--      reached the assertion at all (a crash, a writer that is not this one).
--
-- ── WHY THE ASSERTION FILES INSTEAD OF RAISING ─────────────────────────────
--
-- A RAISE here would abort the caller's transaction, and the caller is
-- tournament settlement. The tournament would be left un-finalised, the
-- champion unpaid, and the operator holding a stuck event -- over a REPORTING
-- disagreement about money that has already moved. That is the same failure
-- mode as the spin pool's contradictory floors in 20260901100100: an assertion
-- that aborts a money transaction is a worse bug than the thing it asserts.
--
-- So the assertion RECORDS. It writes one row into ledger_reconcile_log at
-- 'critical' and returns, and settlement completes. The alarm is the point:
-- these 45 events drifted for eleven days with nobody knowing.
--
-- RECONCILIATION COVERAGE. This closes one more of the ten uncovered money
-- columns the sweep listed: `tournaments.bounty_pool` / `bounty_pool_paid`.
--
-- ROLLBACK:
--   SELECT cron.unschedule('bounty-pool-law-hourly');
--   DROP FUNCTION IF EXISTS public.fn_bounty_pool_law_check(interval);
--   and re-run section 2 of this migration with v_old/v_new swapped, then
--   DROP FUNCTION IF EXISTS public.fn_bounty_pool_law_assert(uuid);

SET lock_timeout = '4s';

-- ── 1. THE ASSERTION ───────────────────────────────────────────────────────
-- SECURITY DEFINER because ledger_reconcile_log carries RLS and the settling
-- session is not an operator. Revoked from every browser role below: nothing a
-- player can reach may file into the reconcile log.
CREATE OR REPLACE FUNCTION public.fn_bounty_pool_law_assert(p_tournament_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_pool numeric;
  v_paid numeric;
BEGIN
  SELECT COALESCE(bounty_pool,0), COALESCE(bounty_pool_paid,0)
    INTO v_pool, v_paid
    FROM public.tournaments
   WHERE id = p_tournament_id;

  IF NOT FOUND THEN RETURN true; END IF;
  IF round(v_pool,2) = round(v_paid,2) THEN RETURN true; END IF;

  INSERT INTO public.ledger_reconcile_log
    (run_date, run_ts, entity_type, entity_id, ledger_balance, stored_balance,
     drift, severity, metadata, notes)
  SELECT CURRENT_DATE, now(), 'bounty_pool_law', p_tournament_id,
         v_pool, v_paid, round(v_paid - v_pool, 2), 'critical',
         jsonb_build_object(
           'kind', CASE WHEN v_paid > v_pool THEN 'bounty_overpaid'
                                             ELSE 'bounty_retained' END,
           'tournament_id', p_tournament_id,
           'at', 'settlement'),
         CASE WHEN v_paid > v_pool
              THEN 'bounty_overpaid: paid ' || v_paid::text || ' out of a pool of ' || v_pool::text
              ELSE 'bounty_retained: pool of ' || v_pool::text || ' paid only ' || v_paid::text
         END
   WHERE NOT EXISTS (
     SELECT 1 FROM public.ledger_reconcile_log l
      WHERE l.entity_type = 'bounty_pool_law'
        AND l.entity_id   = p_tournament_id);

  RETURN false;
END;
$$;

COMMENT ON FUNCTION public.fn_bounty_pool_law_assert(uuid) IS
  'Asserts bounty_pool = bounty_pool_paid for one tournament. Returns true when they agree; otherwise files one critical row into ledger_reconcile_log and returns false. Never raises - it is called from inside settlement and must not abort it. Moves no chips.';

REVOKE ALL ON FUNCTION public.fn_bounty_pool_law_assert(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bounty_pool_law_assert(uuid) TO service_role;

-- ── 2. SETTLEMENT CALLS IT ─────────────────────────────────────────────────
--
-- Two single-substring insertions into fn_finalize_bounty_pool, each asserted
-- to match exactly once, rather than a hand re-emission of a ~90-line money
-- function (MIGRATION-LAW LAW 3 and LAW 7, and the same reasoning as
-- 20260831_tournament_fee_is_keyed_on_seats_not_on_the_word_sng).
--
-- The two sites are the only exits of the FUNDED path:
--   A  the early return when the residual is <= 0. This is the exit the ten
--      overpaid tournaments took, and the one that recorded nothing.
--   B  the return after the champion has been paid the residual.
-- The unfunded/legacy branch is not instrumented: it has no pool to reconcile
-- against (bounty_pool <= 0 is the condition it runs under).

DO $mig$
DECLARE
  v_src text;
  v_a_old text :=
'  IF v_residual <= 0 OR p_winner_user_id IS NULL THEN
    RETURN jsonb_build_object(''ok'', true, ''residual'', GREATEST(v_residual,0),
                              ''funded'', true, ''ledger_paid'', v_paid);
  END IF;';
  v_a_new text :=
'  IF v_residual <= 0 OR p_winner_user_id IS NULL THEN
    -- THE EQUALITY ASSERTION. A negative residual means the ledger paid out
    -- more bounty than the pool collected, and this exit used to record
    -- nothing at all. Ten tournaments left through here between 2026-08-29
    -- and 2026-08-30, 150.40 chips over, and nobody knew for two days.
    PERFORM public.fn_bounty_pool_law_assert(p_tournament_id);
    RETURN jsonb_build_object(''ok'', true, ''residual'', GREATEST(v_residual,0),
                              ''funded'', true, ''ledger_paid'', v_paid);
  END IF;';
  v_b_old text :=
'  RETURN jsonb_build_object(''ok'', true, ''residual'', v_residual, ''funded'', true,
                            ''ledger_paid'', v_paid, ''paid_to'', p_winner_user_id);';
  v_b_new text :=
'  -- THE EQUALITY ASSERTION. After paying the residual the two columns must be
  -- equal to the cent. If they are not, the pool moved under us mid-settlement.
  PERFORM public.fn_bounty_pool_law_assert(p_tournament_id);
  RETURN jsonb_build_object(''ok'', true, ''residual'', v_residual, ''funded'', true,
                            ''ledger_paid'', v_paid, ''paid_to'', p_winner_user_id);';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_finalize_bounty_pool';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_finalize_bounty_pool not found - nothing to instrument';
  END IF;

  IF position('fn_bounty_pool_law_assert' in v_src) > 0 THEN
    RAISE NOTICE 'fn_finalize_bounty_pool already asserts the bounty equality';
    RETURN;
  END IF;

  IF (length(v_src) - length(replace(v_src, v_a_old, ''))) / length(v_a_old) <> 1 THEN
    RAISE EXCEPTION 'fn_finalize_bounty_pool no longer contains the zero-residual exit exactly once; it has changed since this migration was written.';
  END IF;
  IF (length(v_src) - length(replace(v_src, v_b_old, ''))) / length(v_b_old) <> 1 THEN
    RAISE EXCEPTION 'fn_finalize_bounty_pool no longer contains the paid-residual exit exactly once; it has changed since this migration was written.';
  END IF;

  v_src := replace(v_src, v_a_old, v_a_new);
  v_src := replace(v_src, v_b_old, v_b_new);
  EXECUTE v_src;
END
$mig$;

-- ── 3. THE SWEEP ───────────────────────────────────────────────────────────
-- The assertion only fires when settlement runs. This catches a tournament
-- that ended without ever reaching it. Forward-only: 2026-09-01 onward, so it
-- says nothing about the 45 events above.
CREATE OR REPLACE FUNCTION public.fn_bounty_pool_law_check(
  p_window interval DEFAULT '6 hours'::interval)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_new integer;
BEGIN
  WITH v AS (
    SELECT t.id, t.club_id, t.ended_at,
           COALESCE(t.bounty_pool,0)      AS pool,
           COALESCE(t.bounty_pool_paid,0) AS paid
      FROM public.tournaments t
     WHERE t.status = 'COMPLETED'
       AND t.created_at >= TIMESTAMPTZ '2026-09-01 00:00:00+00'
       AND t.ended_at   >= now() - p_window
       AND (COALESCE(t.is_bounty,false) OR COALESCE(t.is_pko,false)
            OR COALESCE(t.is_mystery_bounty,false))
       AND round(COALESCE(t.bounty_pool,0),2) <> round(COALESCE(t.bounty_pool_paid,0),2)
  ), ins AS (
    INSERT INTO public.ledger_reconcile_log
      (run_date, run_ts, entity_type, entity_id, ledger_balance, stored_balance,
       drift, severity, metadata, notes)
    SELECT CURRENT_DATE, now(), 'bounty_pool_law', v.id,
           v.pool, v.paid, round(v.paid - v.pool, 2), 'critical',
           jsonb_build_object(
             'kind', CASE WHEN v.paid > v.pool THEN 'bounty_overpaid'
                                               ELSE 'bounty_retained' END,
             'tournament_id', v.id, 'club_id', v.club_id,
             'ended_at', v.ended_at, 'at', 'sweep'),
           CASE WHEN v.paid > v.pool
                THEN 'bounty_overpaid: paid ' || v.paid::text || ' out of a pool of ' || v.pool::text
                ELSE 'bounty_retained: pool of ' || v.pool::text || ' paid only ' || v.paid::text
           END
      FROM v
     WHERE NOT EXISTS (
       SELECT 1 FROM public.ledger_reconcile_log l
        WHERE l.entity_type = 'bounty_pool_law' AND l.entity_id = v.id)
    RETURNING 1
  )
  SELECT count(*) INTO v_new FROM ins;
  RETURN v_new;
END;
$$;

COMMENT ON FUNCTION public.fn_bounty_pool_law_check(interval) IS
  'Read-only alarm. Files bounty_pool <> bounty_pool_paid for tournaments completed in the window, once per tournament. Forward-only from 2026-09-01. Moves no chips.';

REVOKE ALL ON FUNCTION public.fn_bounty_pool_law_check(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bounty_pool_law_check(interval) TO service_role;

DO $sched$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('bounty-pool-law-hourly')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'bounty-pool-law-hourly');
    PERFORM cron.schedule('bounty-pool-law-hourly', '50 * * * *',
      $job$SELECT public.fn_bounty_pool_law_check('6 hours'::interval);$job$);
  ELSE
    RAISE NOTICE 'pg_cron not installed - fn_bounty_pool_law_check is unscheduled';
  END IF;
END
$sched$;

-- ── 4. POST-APPLY ASSERTIONS ───────────────────────────────────────────────
DO $verify$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_finalize_bounty_pool';

  IF (length(v_src) - length(replace(v_src, 'fn_bounty_pool_law_assert', '')))
       / length('fn_bounty_pool_law_assert') <> 2 THEN
    RAISE EXCEPTION 'fn_finalize_bounty_pool does not call the assertion on both funded exits';
  END IF;

  -- Settlement must still do its job: the ledger read and the residual payment
  -- are untouched by the two insertions above.
  IF v_src NOT LIKE '%Unclaimed bounty pool awarded to champion%' THEN
    RAISE EXCEPTION 'the residual payment leg did not survive the rewrite';
  END IF;
  IF v_src NOT LIKE '%wt.category = ''bounty''%' THEN
    RAISE EXCEPTION 'the ledger read did not survive the rewrite';
  END IF;

  IF pg_get_constraintdef((SELECT oid FROM pg_constraint
      WHERE conrelid = 'public.ledger_reconcile_log'::regclass
        AND conname = 'ledger_reconcile_log_entity_type_check'))
     NOT LIKE '%bounty_pool_law%' THEN
    RAISE EXCEPTION 'the reconcile log will not admit a bounty_pool_law finding - apply 20260901100200 first';
  END IF;
END
$verify$;
