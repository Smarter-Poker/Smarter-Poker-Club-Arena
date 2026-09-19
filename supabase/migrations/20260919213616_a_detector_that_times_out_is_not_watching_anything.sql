-- 20260919213616_a_detector_that_times_out_is_not_watching_anything
--
-- Applied to production as version 20260919213405 (the apply transport stamps
-- its own version; match by name, never by version).
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- ca-pay-backed-payout-shortfalls-hourly is a DETECTOR. Its cron command calls
-- public.fn_pay_backed_payout_shortfalls() with no arguments, and the signature
-- is (p_apply boolean DEFAULT false, p_limit integer DEFAULT 500), so the money
-- branch guarded by IF p_apply never executes on the cron path. Its only writes
-- are deduped financial_alerts rows. Confirmed: the table it would pay into,
-- tournament_payout_backfill_log, holds 57 rows whose newest applied_at is
-- 2026-08-29, nothing in 21 days.
--
-- It was failing 21 runs out of 24, every failure at exactly 120.0s:
--
--   ERROR: canceling statement due to statement timeout
--   CONTEXT: SQL function "fn_tournament_conservation_delta" statement 1
--            PL/pgSQL function fn_pay_backed_payout_shortfalls(boolean,integer)
--            line 10 at FOR over SELECT rows
--
-- The candidate query applied fn_tournament_conservation_delta(t.id) per row
-- across every COMPLETED non-satellite non-spin tournament with NO TIME BOUND,
-- under a 120s statement_timeout. The ORDER BY ... LIMIT cannot help: the delta
-- sits in the WHERE, so it is evaluated before anything can be ordered or
-- limited.
--
-- So for 87.5% of its runs this detector produced no verdict at all. A detector
-- that times out is not watching anything, and it is worse than an absent one,
-- because the estate counts it as coverage.
--
-- MEASURED 2026-09-19 with EXPLAIN ANALYZE against production:
--
--   unbounded                          > 120,000 ms, cancelled
--   bounded to ended_at > now() - 30d     21,817 ms, 0 rows found
--
-- The bounded plan is an Index Scan Backward on
-- idx_tournaments_completed_ended_at and evaluates the delta across 191,881
-- rows in 21.8 seconds, comfortably inside the job's 120s budget.
--
-- ===========================================================================
-- THE BAND-AIDS THAT WERE REFUSED
--
-- Raising statement_timeout on the cron command. It is one word and it makes
-- the red job green. It is also how a detector becomes a thing that holds a
-- connection for ten minutes and still answers nothing useful, and it does not
-- address the reason the query is unbounded: nobody ever decided how far back
-- this question should reach. A timeout is a symptom of an unasked question.
--
-- Adding a p_since_days parameter. CREATE OR REPLACE cannot change a
-- function's argument list, so a third parameter would create an OVERLOAD
-- rather than a replacement, and the cron's zero-argument call would then match
-- both candidates and fail as ambiguous. This estate has already paid for that
-- lesson once, in
-- 20260831232524_spin_chip_conservation_check_rename_off_the_overload. The
-- signature is left exactly as it is and the window is a declared variable.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- One predicate and one declaration. The candidate set is bounded to
-- tournaments that ended within v_window_days, declared as 30 at the top of the
-- body where it can be read and argued with.
--
-- Why 30 days rather than something smaller and faster. A shortfall is created
-- at settlement, so it is detectable within hours of an event ending; 30 days
-- is roughly a 100x margin on that. The loop still runs OLDEST FIRST
-- (ORDER BY t.ended_at ASC NULLS LAST), so the oldest unresolved shortfall
-- inside the window is still the first thing it looks at, which is the
-- behaviour the LIMIT was written for.
--
-- What this gives up, said plainly: a tournament that ends up owing money more
-- than 30 days after it ended will not be seen by this job. That case has never
-- been observed, and the alternative on offer was seeing nothing at all 87.5%
-- of the time.
--
-- Everything else is byte-for-byte unchanged: the same satellite and spin
-- exclusions, the same refuse-already-disbursed branch, the same
-- withheld-unfunded-pool branch, the same deduped alerts, the same p_apply
-- gate. The return object gains one field, window_days, so a reader of the
-- result can see the bound rather than having to read the source.
--
--
-- ONE DIFFERENCE FROM THE APPLIED TEXT, DELIBERATE. The version applied to
-- production carried no REVOKE, because production's ACL was already
-- postgres|service_role and CREATE OR REPLACE preserves it - measured after
-- applying: has_function_privilege('anon', ...) false,
-- has_function_privilege('authenticated', ...) false. The REVOKE below is
-- therefore a no-op against production and is present for the REBUILD path,
-- where CREATE OR REPLACE is a CREATE and default privileges would hand the
-- function to anon. check-definer-authorization refused the push without it,
-- and it was right to.
--
-- @live-proof: (SELECT position('v_window_days' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_pay_backed_payout_shortfalls')
-- ===========================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '180s';

DO $guard$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_pay_backed_payout_shortfalls';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'failed: fn_pay_backed_payout_shortfalls does not exist';
  END IF;
  IF position('AND public.fn_tournament_conservation_delta(t.id) > 0.01' in v_src) = 0 THEN
    RAISE EXCEPTION 'failed: the delta predicate is not present; the body has changed';
  END IF;
  IF position('refused_already_disbursed' in v_src) = 0
     OR position('withheld_unfunded_pool' in v_src) = 0 THEN
    RAISE EXCEPTION 'failed: the refusal branches are missing; this is not the body that was read';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.fn_pay_backed_payout_shortfalls(
  p_apply boolean DEFAULT false,
  p_limit integer DEFAULT 500
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record; v_res jsonb;
  v_paid numeric := 0; v_events integer := 0;
  v_withheld numeric := 0; v_withheld_events integer := 0;
  v_refused integer := 0; v_refused_chips numeric := 0;
  v_alerts integer := 0;
  v_delta_after numeric;
  /* HOW FAR BACK THIS QUESTION REACHES (2026-09-19).
     There was no bound here, so fn_tournament_conservation_delta ran per row
     over every COMPLETED tournament and the job was cancelled at 120s on 21 of
     its last 24 runs. A shortfall is created at settlement and is detectable
     within hours; 30 days is about a 100x margin on that. Measured: bounded
     21,817 ms against production, unbounded over 120,000 ms and cancelled.
     Widen it deliberately if a shortfall is ever found older than this. */
  v_window_days integer := 30;
BEGIN
  FOR r IN
    SELECT t.id, t.name, t.club_id, t.prize_pool,
           COALESCE((public.fn_tournament_payout_reconcile(t.id, false)->>'total_top_up')::numeric, 0) AS topup,
           public.fn_tournament_conservation_delta(t.id) AS delta,
           COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                      WHERE w.related_entity_id = t.id AND w.type = 'credit'
                        AND w.category = 'prize'), 0) AS wallet_prizes
      FROM public.tournaments t
     WHERE t.status = 'COMPLETED'
       -- Satellites award seats, not cash. Reconciling them against a cash
       -- pool would invent prizes that do not exist.
       AND NOT (COALESCE(t.variant, '') = 'satellite' OR UPPER(COALESCE(t.tournament_type, '')) = 'SATELLITE' OR t.satellite_target_id IS NOT NULL)
       -- A Spin's pool is funded by the reserve, not by this game's own
       -- collections, so its delta does not mean what it means elsewhere.
       AND COALESCE(t.variant, '') <> 'spin'
       -- THE BOUND THAT MAKES THIS A DETECTOR RATHER THAN A TIMEOUT.
       -- Cheap, and it comes before the delta so the delta is only computed
       -- for rows inside the window. Uses idx_tournaments_completed_ended_at.
       AND t.ended_at > now() - make_interval(days => GREATEST(v_window_days, 1))
       /* THE LOG IS A RECEIPT, NOT A TOMBSTONE (2026-09-01).
          This clause used to be `NOT EXISTS (... backfill_log ...)`, so one
          pass over an event excluded it from every future pass, for good. That
          is wrong in principle rather than in practice today: an event can
          become payable AFTER its pass - a guarantee gets funded, a
          conservation baseline is acknowledged - and nothing would ever look
          at it again. Measured before that change, no logged event is payable
          right now (all 57 fail the conservation filter below on their own
          merits). "Nothing is owed" is the only correct exclusion, and it is
          computed below as `topup <= 0.005`. */
       AND public.fn_tournament_conservation_delta(t.id) > 0.01
     ORDER BY t.ended_at ASC NULLS LAST
     LIMIT GREATEST(p_limit, 1)
  LOOP
    CONTINUE WHEN r.topup <= 0.005;

    /* CONSERVATION REFUSES BEFORE THE POOL DOES (2026-09-01).
       The reconciler computes "already paid" from tournament_payouts, on
       purpose - counting ledger rows instead caused two real double-pays. The
       cost of that choice is that an event whose record is incomplete reports
       a debt it does not have, and 61 events on this platform hold 5,515.91
       chips of prizes that reached wallets and were never recorded. If such a
       pool is ever funded, this sweep would pay them a second time.

       An event that has already disbursed its whole pool to wallets owes
       nobody, whatever the paperwork says. Refuse, and say so, so the record
       gets fixed rather than paid twice. */
    IF r.wallet_prizes + 0.01 >= COALESCE(r.prize_pool, 0) AND COALESCE(r.prize_pool, 0) > 0 THEN
      v_refused := v_refused + 1;
      v_refused_chips := v_refused_chips + r.topup;
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'warning', 'fn_pay_backed_payout_shortfalls',
             format('%s already paid %s of its %s pool to wallets, so the %s the reconciler reports as owed is a missing tournament_payouts record, not a debt. Paying nothing.',
                    COALESCE(r.name, r.id::text), round(r.wallet_prizes,2),
                    round(COALESCE(r.prize_pool,0),2), round(r.topup,2))
           , jsonb_build_object('kind','refused_already_disbursed','tournament_id',r.id,
               'club_id',r.club_id,'wallet_prizes',round(r.wallet_prizes,2),
               'prize_pool',round(COALESCE(r.prize_pool,0),2),'reported_top_up',round(r.topup,2))
       WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                          WHERE fa.source='fn_pay_backed_payout_shortfalls'
                            AND fa.resolved IS NOT TRUE
                            AND fa.context->>'kind'='refused_already_disbursed'
                            AND fa.context->>'tournament_id' = r.id::text);
      IF FOUND THEN v_alerts := v_alerts + 1; END IF;
      CONTINUE;
    END IF;

    -- The event must be holding at least what it is about to pay out. Not
    -- `delta >= 0` - that would let an event with 3 chips spare pay out 300.
    IF r.delta < r.topup THEN
      v_withheld := v_withheld + r.topup;
      v_withheld_events := v_withheld_events + 1;
      /* WITHHOLDING IS NEVER SILENT (2026-09-01).
         This branch used to increment a counter that reached a console line
         and nothing else. Money owed to a player and not paid produced no
         durable record anywhere, so nobody could find it later, and nobody
         did. It is a deduped alert now, per event, naming the gap. */
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'critical', 'fn_pay_backed_payout_shortfalls',
             format('%s owes players %s and its pool holds %s, so nothing was paid. The shortfall needs funding before anyone can be paid.',
                    COALESCE(r.name, r.id::text), round(r.topup,2), round(r.delta,2))
           , jsonb_build_object('kind','withheld_unfunded_pool','tournament_id',r.id,
               'club_id',r.club_id,'owed',round(r.topup,2),'pool_holds',round(r.delta,2),
               'funding_gap',round(r.topup - r.delta,2),
               'detail','no money was moved; funding an advertised guarantee is a human decision')
       WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                          WHERE fa.source='fn_pay_backed_payout_shortfalls'
                            AND fa.resolved IS NOT TRUE
                            AND fa.context->>'kind'='withheld_unfunded_pool'
                            AND fa.context->>'tournament_id' = r.id::text);
      IF FOUND THEN v_alerts := v_alerts + 1; END IF;
      CONTINUE;
    END IF;

    IF p_apply THEN
      /* ONE SETTLE PATH (Lane A3, 2026-09-02): the reconciler settles every
         place through fn_settle_tournament_obligation. `total_settled` is what
         that path actually paid; `total_top_up` is what was wanted. */
      v_res := public.fn_tournament_payout_reconcile(r.id, true);
      v_delta_after := public.fn_tournament_conservation_delta(r.id);

      IF v_delta_after < -0.01 THEN
        RAISE EXCEPTION 'paying % would leave conservation at %; refusing', r.id, v_delta_after;
      END IF;

      INSERT INTO public.tournament_payout_backfill_log
        (tournament_id, top_up, delta_before, delta_after)
      VALUES (r.id, COALESCE((v_res->>'total_settled')::numeric, (v_res->>'total_top_up')::numeric, r.topup), r.delta, v_delta_after)
      ON CONFLICT (tournament_id) DO UPDATE
        SET top_up = EXCLUDED.top_up,
            delta_before = EXCLUDED.delta_before,
            delta_after = EXCLUDED.delta_after;

      v_paid := v_paid + COALESCE((v_res->>'total_settled')::numeric, (v_res->>'total_top_up')::numeric, 0);
    ELSE
      v_paid := v_paid + r.topup;
    END IF;
    v_events := v_events + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
    'events_paid', v_events, 'chips_paid', round(v_paid, 2),
    'events_withheld_unfunded_pool', v_withheld_events,
    'chips_withheld_unfunded_pool', round(v_withheld, 2),
    'events_refused_already_disbursed', v_refused,
    'chips_refused_already_disbursed', round(v_refused_chips, 2),
    'alerts_raised', v_alerts,
    'window_days', v_window_days,
    'money_path', 'fn_settle_tournament_obligation');
END;
$function$;

-- A REBUILD IS WHERE THIS FUNCTION BECOMES BROWSER-REACHABLE (2026-09-19).
-- On production this is a no-op: the live ACL is postgres|service_role and
-- has_function_privilege says anon and authenticated are both false. On a
-- FRESH rebuild, though, CREATE OR REPLACE is a CREATE, and this project
-- carries ALTER DEFAULT PRIVILEGES granting EXECUTE on new functions in schema
-- public to anon, authenticated and service_role. That is exactly how
-- fn_ca_cron_health was handed to anon earlier today, and it took
-- 20260919173340 to take it back. A SECURITY DEFINER function that writes and
-- never asks auth.uid() must name the roles, not just PUBLIC.
REVOKE ALL ON FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer) TO service_role;

DO $verify$
DECLARE
  v_src text; v_bound_pos int; v_delta_pos int;
  v_t0 timestamptz; v_ms numeric; v_n integer;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_pay_backed_payout_shortfalls';

  IF position('v_window_days' in v_src) = 0 THEN
    RAISE EXCEPTION 'failed: the window declaration did not take';
  END IF;

  -- The bound must come BEFORE the delta in the predicate, or the delta is
  -- still computed over everything and nothing has been fixed.
  v_bound_pos := position('t.ended_at > now() - make_interval' in v_src);
  v_delta_pos := position('AND public.fn_tournament_conservation_delta(t.id) > 0.01' in v_src);
  IF v_bound_pos = 0 THEN
    RAISE EXCEPTION 'failed: the time bound is not in the candidate query';
  END IF;
  IF v_bound_pos >= v_delta_pos THEN
    RAISE EXCEPTION 'failed: the bound does not precede the delta, so the delta is still unbounded';
  END IF;

  -- THE OTHER DIRECTION (the 7.2 rule). Deleting the delta predicate entirely
  -- would also make this fast, and would make it detect nothing.
  IF position('refused_already_disbursed' in v_src) = 0
     OR position('withheld_unfunded_pool' in v_src) = 0
     OR position('IF p_apply THEN' in v_src) = 0 THEN
    RAISE EXCEPTION 'failed: a refusal branch or the apply gate was lost';
  END IF;

  -- And it must actually fit the job's budget. The cron wraps this in
  -- SET LOCAL statement_timeout = '120s'. Skipped on an empty rebuild.
  IF EXISTS (SELECT 1 FROM public.tournaments WHERE status = 'COMPLETED' LIMIT 1) THEN
    v_t0 := clock_timestamp();
    SELECT count(*) INTO v_n FROM (
      SELECT t.id FROM public.tournaments t
       WHERE t.status = 'COMPLETED'
         AND NOT (COALESCE(t.variant,'') = 'satellite' OR UPPER(COALESCE(t.tournament_type,'')) = 'SATELLITE' OR t.satellite_target_id IS NOT NULL)
         AND COALESCE(t.variant,'') <> 'spin'
         AND t.ended_at > now() - make_interval(days => 30)
         AND public.fn_tournament_conservation_delta(t.id) > 0.01
       ORDER BY t.ended_at ASC NULLS LAST
       LIMIT 500) s;
    v_ms := extract(epoch FROM clock_timestamp() - v_t0) * 1000;
    RAISE NOTICE 'bounded candidate scan found % row(s) in % ms', v_n, round(v_ms);
    IF v_ms > 100000 THEN
      RAISE EXCEPTION 'failed: % ms will not fit the job 120s budget', round(v_ms);
    END IF;
  ELSE
    RAISE NOTICE 'no completed tournaments present; timing probe skipped (empty rebuild)';
  END IF;
END
$verify$;

COMMIT;
