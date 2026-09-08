-- 20260908025929_the_other_currencies_get_a_meter.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- PHASE 8 OF THE CHIP-ACCOUNTING PROGRAMME, roadmap 9.7:
-- "VIP points, rakeback and agent commissions have no journal, no meter and
--  no conservation check - they are liabilities the platform owes, tracked
--  only as counters. ... The chip standard should either extend to them or
--  say plainly that it does not, and why."
--
-- READ ON 2026-09-08 02:10 UTC, BEFORE ANYTHING WAS WRITTEN. The roadmap was
-- written on the 6th and is partly out of date: two of the three currencies
-- DO have a journal. What none of them has is a guard, a meter, or a
-- conservation check - so the identities below hold today by luck and
-- convention, and nothing would say so the morning one of them stopped.
--
--   VIP POINTS. vip_points (1,005 balances, 139,913,995 points outstanding)
--   and vip_points_ledger (5.75M legs, ~306k a day). Measured: every one of
--   the 1,005 balances equals the sum of its legs, and every lifetime equals
--   the sum of its positive legs. Two writers, both SECURITY DEFINER:
--   fn_award_vip_credit (engine only) and fn_redeem_vip_points (the caller's
--   own). But: the ledger has NO trigger of any kind, so any service-role
--   session can edit or delete a leg; the balance table has none either, so
--   a balance can move with no leg; and the award writer INSERTS a leg with
--   points = 0 and then UPDATES it with the real number - 1.69M updates
--   against 1.69M inserts since stats reset. A journal that rewrites its own
--   rows is not a journal, and a guard that forbids updates could not be
--   attached to it.
--
--   AGENT COMMISSIONS. agent_commissions (3.96M rows, one per raked hand per
--   agent) with agent_commission_unsettled_rollup kept by statement triggers.
--   Measured: all 239 (club, agent) rollups equal the sum of their unsettled
--   rows - 1,005,462.14 owed. The only legitimate update is settled_at going
--   from NULL to a time (fn_agent_claim_commission,
--   fn_settle_round2_club_to_agents). No guard: anon and authenticated hold
--   INSERT/UPDATE/DELETE grants (RLS refuses them), service_role can do
--   anything. Club Arena's AdminDashboardPage "pay" button DELETES rows from
--   the browser to mark them paid - RLS matches nothing, no error, the
--   operator is told it worked (n_tup_del = 1, ever).
--
--   RAKEBACK. Three sources, three totals: rakeback_periods says 329,180.89
--   paid over 3,357 periods; rakeback_period_payouts says 285,190.25 over
--   2,704 rows (653 paid periods have no payout row, and every payout row's
--   wallet_transaction_id is NULL); chip_ledger's rakeback legs, which began
--   today when another lane journaled the path, say 231,046.71 to players.
--   310,136.10 is pending across 2,763 periods. The payout path
--   (fn_close_settlement_period) inserts the payout row as 'paid' BEFORE
--   debiting the treasury and deletes it again on a shortfall - a
--   compensating delete inside one transaction, which is why this table
--   cannot simply refuse DELETE. That lane rewrote the path today
--   (20260907190300..193146); this migration does not touch it.
--
-- SPLIT IN TWO, AND WHY (2026-09-08 02:59). The first shape was one
-- migration. It could not be applied: CREATE TRIGGER needs ACCESS EXCLUSIVE
-- on vip_points_ledger and agent_commissions, and the proof inside the same
-- transaction scans 5.75M VIP legs (10.2 s measured) - so the lock would be
-- held for ten seconds against an engine whose service_role statement_timeout
-- is 8 s. VIP awards would have failed for that window, and a VIP award that
-- fails is points a player earned and did not get. The hourly :55 freeze does
-- not help: it guards seven money and seat tables, and vip_points_ledger is
-- not one of them, so awards keep landing right through it (measured: the
-- 8 s lock request timed out at 02:58 with the platform frozen).
--
-- So: THIS migration builds the meter and rewrites the VIP writer - no
-- trigger, no table lock, and its 10-second proof runs under ACCESS SHARE,
-- which blocks nobody. The guards, whose locks must be held for well under a
-- second, are 20260908030006_the_other_currencies_get_their_guards.
--
-- WHAT THIS ONE BUILDS:
--
--   1. fn_award_vip_credit inserts the leg final. The carry row is locked
--      first, the points are computed, the leg is written once with the
--      number it will always carry. Same idempotency key, same rounding,
--      same result, one write instead of two.
--      Both writers also declare themselves through
--      app.vip_points_writer, which is what the guard migration reads; a
--      declaration nothing is listening to yet is harmless, and it means the
--      guard can be attached afterwards without touching these functions
--      again.
--   2. ca_currency_meter + fn_ca_currency_meter(): one row per currency per
--      night - outstanding liability, journal total, accounts checked,
--      accounts drifted, worst drift, and for rakeback the three totals side
--      by side and the count of paid periods with no payout row. VIP and
--      commission drift is CRITICAL (an identity the guards now enforce;
--      seeing it means a guard was bypassed). Rakeback disagreement is a
--      WARNING with the numbers, because that path is another lane's live
--      rebuild and the disagreement predates this phase. It rides the
--      existing nightly replay job (ca-ledger-replay-nightly, 06:40 UTC, 600 s
--      statement timeout); no new trigger (CLAUDE.md 10.85).
--
-- WHAT IT SAYS PLAINLY IT DOES NOT DO: it does not make rakeback a journal.
-- rakeback_periods accrues during the period by design (rake_generated and
-- rakeback_earned are updated as rake lands), so it is a counter, and the
-- meter reads it as one. The payout row and the chip leg are the journal of
-- rakeback; the meter compares them and names the gap.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The award writer inserts the leg final, and declares itself.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_award_vip_credit(p_user_id uuid, p_credit numeric, p_source_type text, p_source_id uuid, p_reason text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_ledger_id uuid;
  v_carry numeric(14,4);
  v_total numeric(14,4);
  v_pts bigint;
BEGIN
  -- SERVER ONLY. A browser calling this would be minting its own points.
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_award_vip_credit is a server-side path' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR COALESCE(p_credit, 0) <= 0 THEN
    RETURN 0;
  END IF;

  /* The carry row first, locked for this transaction: it serialises awards
     per user, and it is what the points depend on. Before phase 8 the leg
     was inserted with points = 0 and rewritten after this step. */
  INSERT INTO public.vip_points_carry (user_id, carry)
  VALUES (p_user_id, 0)
  ON CONFLICT (user_id) DO UPDATE SET carry = public.vip_points_carry.carry
  RETURNING carry INTO v_carry;

  v_total := v_carry + round(p_credit, 4);
  v_pts   := floor(v_total)::bigint;

  /* The leg, once, final. The unique (user, source_type, source_id) key is
     the idempotency: a second award for the same source writes nothing and
     changes nothing - the carry above was only locked, not moved. */
  INSERT INTO public.vip_points_ledger (user_id, points, reason, source_type, source_id, credit)
  VALUES (p_user_id, v_pts, p_reason, p_source_type, p_source_id, round(p_credit, 4))
  ON CONFLICT (user_id, source_type, source_id) DO NOTHING
  RETURNING id INTO v_ledger_id;
  IF v_ledger_id IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.vip_points_carry SET carry = v_total - v_pts, updated_at = now() WHERE user_id = p_user_id;

  IF v_pts > 0 THEN
    PERFORM set_config('app.vip_points_writer', 'fn_award_vip_credit', true);
    INSERT INTO public.vip_points (user_id, current_points, lifetime_points)
    VALUES (p_user_id, v_pts, v_pts)
    ON CONFLICT (user_id) DO UPDATE
      SET current_points = public.vip_points.current_points + v_pts,
          lifetime_points = public.vip_points.lifetime_points + v_pts,
          updated_at = now();
    PERFORM set_config('app.vip_points_writer', '', true);
  END IF;
  RETURN v_pts;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. The redeem writer declares itself. Body otherwise unchanged from the
--    catalogue (read 2026-09-08); the two set_config calls bracket the one
--    balance write.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_redeem_vip_points(p_cost bigint, p_reason text DEFAULT 'Reward redemption'::text, p_reward_id text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_bal bigint;
  v_reward record;
  v_cost bigint;
  v_status text := 'pending';
  v_theme_id text;
  v_avatar_id text;
  v_granted jsonb := jsonb_build_object('type', 'none');
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF p_reward_id IS NOT NULL THEN
    SELECT * INTO v_reward FROM public.vip_reward_catalog WHERE id = p_reward_id AND is_active;
    IF v_reward.id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'unknown_reward');
    END IF;
    v_cost := v_reward.points_cost;
    IF v_reward.grant_type = 'theme' THEN
      v_theme_id := public.sp_resolve_theme_preset(v_reward.grant_ref);
      IF v_theme_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_reward_sku');
      END IF;
    ELSIF v_reward.grant_type = 'avatar' THEN
      v_avatar_id := public.sp_resolve_avatar_entitlement(v_reward.grant_ref);
      IF v_avatar_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_reward_sku');
      END IF;
    END IF;
  ELSE
    v_cost := p_cost;
  END IF;
  IF v_cost IS NULL OR v_cost <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_cost');
  END IF;
  IF p_reward_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('fn_redeem_vip_points:' || v_uid::text || ':' || p_reward_id, 0)
    );
    IF v_reward.stock IS NOT NULL AND v_reward.stock <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'sold_out');
    END IF;
    IF v_reward.grant_type = 'theme' AND EXISTS (
      SELECT 1 FROM public.theme_asset_unlocks
       WHERE user_id = v_uid AND category = 'theme_id' AND asset_id = v_theme_id
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_owned', 'already_owned', true);
    END IF;
    IF v_reward.grant_type = 'avatar' AND EXISTS (
      SELECT 1 FROM public.avatar_unlocks WHERE user_id = v_uid AND avatar_id = v_avatar_id
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_owned', 'already_owned', true);
    END IF;
  END IF;
  SELECT current_points INTO v_bal FROM public.vip_points WHERE user_id = v_uid FOR UPDATE;
  IF COALESCE(v_bal, 0) < v_cost THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'insufficient_points', 'balance', COALESCE(v_bal, 0)
    );
  END IF;
  PERFORM set_config('app.vip_points_writer', 'fn_redeem_vip_points', true);
  UPDATE public.vip_points SET current_points = current_points - v_cost, updated_at = now() WHERE user_id = v_uid;
  PERFORM set_config('app.vip_points_writer', '', true);
  INSERT INTO public.vip_points_ledger (user_id, points, reason, source_type, source_id)
  VALUES (v_uid, -v_cost, p_reason, 'redeem', gen_random_uuid());
  IF p_reward_id IS NOT NULL THEN
    IF v_reward.grant_type = 'theme' THEN
      PERFORM public.sp_grant_theme_preset(v_uid, v_theme_id, 'vip_points');
      v_status := 'granted';
      v_granted := jsonb_build_object('type', 'theme', 'theme_id', v_theme_id);
    ELSIF v_reward.grant_type = 'avatar' THEN
      INSERT INTO public.avatar_unlocks (user_id, avatar_id, unlock_method)
      VALUES (v_uid, v_avatar_id, 'vip_points')
      ON CONFLICT DO NOTHING;
      v_status := 'granted';
      v_granted := jsonb_build_object('type', 'avatar', 'avatar_id', v_avatar_id);
    END IF;
    IF v_reward.stock IS NOT NULL THEN
      UPDATE public.vip_reward_catalog SET stock = stock - 1 WHERE id = p_reward_id;
    END IF;
    INSERT INTO public.vip_reward_claims (user_id, reward_id, points_spent, status)
    VALUES (v_uid, p_reward_id, v_cost, v_status);
  END IF;
  RETURN jsonb_build_object(
    'success', true,
    'balance', COALESCE(v_bal, 0) - v_cost,
    'charged', v_cost,
    'status', CASE WHEN p_reward_id IS NULL THEN NULL ELSE v_status END,
    'granted', v_granted
  );
END;
$function$;

-- The [autorevoke] event trigger strips PUBLIC/anon EXECUTE on CREATE
-- FUNCTION; restate what each writer's callers need.
REVOKE ALL ON FUNCTION public.fn_award_vip_credit(uuid, numeric, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_award_vip_credit(uuid, numeric, text, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_redeem_vip_points(bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_redeem_vip_points(bigint, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. The meter.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ca_currency_meter (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  currency      text        NOT NULL,
  outstanding   numeric     NOT NULL,
  journal_total numeric,
  accounts      integer     NOT NULL DEFAULT 0,
  drifted       integer     NOT NULL DEFAULT 0,
  worst         numeric     NOT NULL DEFAULT 0,
  enforced      boolean     NOT NULL,
  detail        jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS ca_currency_meter_currency_at_idx ON public.ca_currency_meter (currency, at DESC);
ALTER TABLE public.ca_currency_meter ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_currency_meter FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_currency_meter TO service_role;
COMMENT ON TABLE public.ca_currency_meter IS
  'Phase 8 (roadmap 9.7). One row per currency per nightly reading: what the platform owes (outstanding), what its journal says (journal_total), how many accounts were compared and how many disagree. enforced=true means a guard makes the identity hold by construction and a drift is critical; enforced=false means the meter is reading counters it does not control and a disagreement is a warning with the numbers.';

CREATE OR REPLACE FUNCTION public.fn_ca_currency_meter()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_t0 timestamptz := clock_timestamp();
  v_out numeric; v_journal numeric; v_accounts int; v_drifted int; v_worst numeric; v_detail jsonb;
  v_res jsonb := '{}'::jsonb;
  v_rb_periods_paid numeric; v_rb_payout_rows numeric; v_rb_legs numeric; v_rb_pending numeric;
  v_rb_orphans int; v_rb_deletes int; v_rb_first_leg timestamptz;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'fn_ca_currency_meter is service only' USING ERRCODE = '42501';
  END IF;

  /* VIP POINTS: every balance against the sum of its legs. Enforced. */
  WITH j AS (SELECT user_id, sum(points) AS journal, sum(points) FILTER (WHERE points > 0) AS earned FROM public.vip_points_ledger GROUP BY 1)
  SELECT COALESCE(sum(v.current_points), 0), COALESCE(sum(j.journal), 0), count(*),
         count(*) FILTER (WHERE COALESCE(j.journal, 0) <> COALESCE(v.current_points, 0) OR COALESCE(j.earned, 0) <> COALESCE(v.lifetime_points, 0)),
         COALESCE(max(abs(COALESCE(j.journal, 0) - COALESCE(v.current_points, 0))), 0),
         jsonb_build_object(
           'balance_without_journal', count(*) FILTER (WHERE j.user_id IS NULL),
           'journal_without_balance', count(*) FILTER (WHERE v.user_id IS NULL),
           'sample', COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id', x.uid, 'balance', x.bal, 'journal', x.jr)) FROM (
              SELECT COALESCE(v2.user_id, j2.user_id) AS uid, v2.current_points AS bal, j2.journal AS jr
                FROM public.vip_points v2 FULL JOIN j j2 ON j2.user_id = v2.user_id
               WHERE COALESCE(j2.journal, 0) <> COALESCE(v2.current_points, 0) LIMIT 10) x), '[]'::jsonb))
    INTO v_out, v_journal, v_accounts, v_drifted, v_worst, v_detail
    FROM public.vip_points v FULL JOIN j ON j.user_id = v.user_id;
  INSERT INTO public.ca_currency_meter (currency, outstanding, journal_total, accounts, drifted, worst, enforced, detail)
  VALUES ('vip_points', v_out, v_journal, v_accounts, v_drifted, v_worst, true, v_detail);
  IF v_drifted > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_currency_meter', 'ledger_imbalance', 'critical', 'currency-drift:vip_points',
      v_out - v_journal, v_journal, v_out, 'ledger', 'vip_points',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      v_drifted || ' VIP balance(s) disagree with their own ledger (worst ' || v_worst || ' points). '
        || 'zz_vip_points_move_only_with_a_leg and the append-only guard on vip_points_ledger make this '
        || 'impossible through the doors; seeing it means a guard was bypassed or dropped.',
      false, v_detail);
  END IF;
  v_res := v_res || jsonb_build_object('vip_points', jsonb_build_object('outstanding', v_out, 'journal', v_journal, 'accounts', v_accounts, 'drifted', v_drifted, 'worst', v_worst));

  /* AGENT COMMISSIONS: every rollup against the sum of its unsettled rows. Enforced. */
  WITH u AS (SELECT club_id, user_id, sum(amount) AS owed FROM public.agent_commissions WHERE settled_at IS NULL GROUP BY 1, 2)
  SELECT COALESCE(sum(r.owed), 0), COALESCE(sum(u.owed), 0), count(*),
         count(*) FILTER (WHERE round(COALESCE(u.owed, 0), 2) <> round(COALESCE(r.owed, 0), 2)),
         COALESCE(max(abs(COALESCE(u.owed, 0) - COALESCE(r.owed, 0))), 0),
         jsonb_build_object(
           'journal_without_rollup', count(*) FILTER (WHERE r.club_id IS NULL),
           'rollup_without_journal', count(*) FILTER (WHERE u.club_id IS NULL))
    INTO v_out, v_journal, v_accounts, v_drifted, v_worst, v_detail
    FROM u FULL JOIN public.agent_commission_unsettled_rollup r ON r.club_id = u.club_id AND r.user_id = u.user_id;
  INSERT INTO public.ca_currency_meter (currency, outstanding, journal_total, accounts, drifted, worst, enforced, detail)
  VALUES ('agent_commissions', v_out, v_journal, v_accounts, v_drifted, v_worst, true, v_detail);
  IF v_drifted > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_currency_meter', 'ledger_imbalance', 'critical', 'currency-drift:agent_commissions',
      v_out - v_journal, v_journal, v_out, 'ledger', 'agent_commissions',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      v_drifted || ' agent(s) whose unsettled rollup disagrees with their commission rows (worst ' || round(v_worst, 2) || '). '
        || 'The rollup is kept by statement triggers and the rows are append-only; seeing it means one of those was bypassed.',
      false, v_detail);
  END IF;
  v_res := v_res || jsonb_build_object('agent_commissions', jsonb_build_object('outstanding', v_out, 'journal', v_journal, 'accounts', v_accounts, 'drifted', v_drifted, 'worst', v_worst));

  /* RAKEBACK: three sources side by side. NOT enforced - the period row is a
     counter that accrues by design, and the payout path is another lane's. */
  SELECT COALESCE(sum(rakeback_amount) FILTER (WHERE status = 'paid'), 0),
         COALESCE(sum(rakeback_amount) FILTER (WHERE status <> 'paid'), 0)
    INTO v_rb_periods_paid, v_rb_pending FROM public.rakeback_periods;
  SELECT COALESCE(sum(payout_amount), 0) INTO v_rb_payout_rows FROM public.rakeback_period_payouts WHERE status = 'paid';
  SELECT COALESCE(sum(amount), 0), min(created_at) INTO v_rb_legs, v_rb_first_leg
    FROM public.chip_ledger WHERE category = 'rakeback' AND to_type = 'player_wallet';
  SELECT count(*) INTO v_rb_orphans FROM public.rakeback_periods p
   WHERE p.status = 'paid' AND p.rakeback_amount > 0
     AND NOT EXISTS (SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id = p.id);
  SELECT count(*) INTO v_rb_deletes FROM public.ca_ledger_mutation_log
   WHERE source_table = 'rakeback_period_payouts' AND at > now() - interval '1 day';
  v_detail := jsonb_build_object(
    'periods_paid_total', v_rb_periods_paid, 'payout_rows_total', v_rb_payout_rows,
    'chip_legs_to_players_total', v_rb_legs, 'chip_journal_since', v_rb_first_leg,
    'paid_periods_without_payout_row', v_rb_orphans, 'payout_rows_deleted_24h', v_rb_deletes,
    'not_enforced_because', 'rakeback_periods accrues during the period by design and the payout path (fn_close_settlement_period) is another lane''s live rebuild as of 2026-09-07; the meter reads the three sources and names the gap');
  INSERT INTO public.ca_currency_meter (currency, outstanding, journal_total, accounts, drifted, worst, enforced, detail)
  VALUES ('rakeback', v_rb_pending, v_rb_payout_rows, 0,
          CASE WHEN round(v_rb_periods_paid, 2) <> round(v_rb_payout_rows, 2) THEN 1 ELSE 0 END,
          abs(v_rb_periods_paid - v_rb_payout_rows), false, v_detail);
  IF round(v_rb_periods_paid, 2) <> round(v_rb_payout_rows, 2) OR v_rb_orphans > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_currency_meter', 'ledger_imbalance', 'warning', 'currency-drift:rakeback',
      v_rb_periods_paid - v_rb_payout_rows, v_rb_payout_rows, v_rb_periods_paid, 'ledger', 'rakeback_periods',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'rakeback_periods says ' || v_rb_periods_paid || ' paid; rakeback_period_payouts says ' || v_rb_payout_rows
        || '; chip_ledger legs to players say ' || v_rb_legs || ' since ' || COALESCE(v_rb_first_leg::text, 'never')
        || '. ' || v_rb_orphans || ' paid period(s) have no payout row. Not enforced by this meter; see detail.',
      false, v_detail);
  END IF;
  v_res := v_res || jsonb_build_object('rakeback', v_detail || jsonb_build_object('pending', v_rb_pending));

  RETURN v_res || jsonb_build_object('at', now(), 'ms', round(extract(epoch from (clock_timestamp() - v_t0)) * 1000));
END $fn$;

REVOKE ALL ON FUNCTION public.fn_ca_currency_meter() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_currency_meter() TO service_role;

-- Rides the nightly replay job; its 600 s statement timeout covers the
-- 5.75M-row VIP sum. No new scheduled job anywhere (CLAUDE.md 10.85).
SELECT cron.alter_job(
  286,
  command := ' SET statement_timeout = ''600s'';
          SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
          SELECT CASE WHEN pg_try_advisory_lock(hashtext(''ca-ledger-replay''))
                      THEN (public.fn_ca_ledger_replay(5000))::text
                      ELSE ''locked'' END;
          SELECT public.fn_ca_currency_meter(); '
);

-- ---------------------------------------------------------------------------
-- 3. PROVE IT, in this transaction, or abort it. No table is locked here:
--    every read below is ACCESS SHARE and blocks no writer.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_uid uuid; v_bal bigint; v_life bigint; v_pts bigint; v_carry numeric; v_res jsonb; v_ms numeric;
BEGIN
  -- the writer inserts the leg once, final - the shape a guard can sit on
  IF pg_get_functiondef('public.fn_award_vip_credit(uuid, numeric, text, uuid, text)'::regprocedure) ~* 'UPDATE\s+public\.vip_points_ledger' THEN
    RAISE EXCEPTION 'VERIFY FAILED: the award writer still rewrites its own leg';
  END IF;
  -- both writers declare themselves for the guard that follows
  IF pg_get_functiondef('public.fn_award_vip_credit(uuid, numeric, text, uuid, text)'::regprocedure) !~ 'app\.vip_points_writer'
     OR pg_get_functiondef('public.fn_redeem_vip_points(bigint, text, text)'::regprocedure) !~ 'app\.vip_points_writer' THEN
    RAISE EXCEPTION 'VERIFY FAILED: a VIP writer does not declare itself';
  END IF;

  -- THE WRITER, END TO END, ROLLED BACK, on a COLD account (11.5)
  SELECT user_id INTO v_uid FROM public.vip_points WHERE current_points > 10 ORDER BY updated_at ASC LIMIT 1;
  SELECT current_points, lifetime_points INTO v_bal, v_life FROM public.vip_points WHERE user_id = v_uid;
  SELECT COALESCE(carry, 0) INTO v_carry FROM public.vip_points_carry WHERE user_id = v_uid;
  BEGIN
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    v_pts := public.fn_award_vip_credit(v_uid, 2.75, 'probe', gen_random_uuid(), 'phase 8 probe');
    IF v_pts <> floor(v_carry + 2.75)::bigint THEN
      RAISE EXCEPTION 'VERIFY FAILED: the writer returned % for carry % + 2.75', v_pts, v_carry;
    END IF;
    IF (SELECT count(*) FROM public.vip_points_ledger WHERE user_id = v_uid AND source_type = 'probe' AND points = v_pts AND credit = 2.75) <> 1 THEN
      RAISE EXCEPTION 'VERIFY FAILED: the probe leg was not written once, final';
    END IF;
    IF (SELECT current_points FROM public.vip_points WHERE user_id = v_uid) <> v_bal + v_pts
       OR (SELECT lifetime_points FROM public.vip_points WHERE user_id = v_uid) <> v_life + v_pts THEN
      RAISE EXCEPTION 'VERIFY FAILED: the balance did not move by the leg';
    END IF;
    IF public.fn_award_vip_credit(v_uid, 2.75, 'probe', (SELECT source_id FROM public.vip_points_ledger WHERE user_id = v_uid AND source_type = 'probe' LIMIT 1), 'phase 8 probe again') <> 0 THEN
      RAISE EXCEPTION 'VERIFY FAILED: a duplicate award was not idempotent';
    END IF;
    RAISE EXCEPTION 'PROBE_ROLLBACK' USING ERRCODE = 'P0999';
  EXCEPTION WHEN SQLSTATE 'P0999' THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.vip_points_ledger WHERE user_id = v_uid AND source_type = 'probe') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the probe leg survived the rollback';
  END IF;
  IF (SELECT current_points FROM public.vip_points WHERE user_id = v_uid) <> v_bal THEN
    RAISE EXCEPTION 'VERIFY FAILED: the probe balance survived the rollback';
  END IF;

  -- the meter reads, writes its three rows, and today VIP and commissions agree
  v_res := public.fn_ca_currency_meter();
  IF (v_res->'vip_points'->>'drifted')::int <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: VIP points drift on the day the meter is built: %', v_res->'vip_points';
  END IF;
  IF (v_res->'agent_commissions'->>'drifted')::int <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: commission drift on the day the meter is built: %', v_res->'agent_commissions';
  END IF;
  IF (SELECT count(DISTINCT currency) FROM public.ca_currency_meter WHERE at > now() - interval '5 minutes') <> 3 THEN
    RAISE EXCEPTION 'VERIFY FAILED: the meter did not write one row per currency';
  END IF;
  IF (SELECT command FROM cron.job WHERE jobid = 286) NOT LIKE '%fn_ca_ledger_replay(5000)%'
     OR (SELECT command FROM cron.job WHERE jobid = 286) NOT LIKE '%fn_ca_currency_meter()%' THEN
    RAISE EXCEPTION 'VERIFY FAILED: the nightly job lost the replay or did not gain the meter';
  END IF;
  v_ms := (v_res->>'ms')::numeric;
  IF v_ms > 120000 THEN
    RAISE EXCEPTION 'VERIFY FAILED: the meter took % ms; the nightly job allows 600 s for the replay AND this', v_ms;
  END IF;

  -- nothing new is reachable from a browser except the redeem door, which is the caller's own
  IF has_function_privilege('anon', 'public.fn_ca_currency_meter()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_currency_meter()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_award_vip_credit(uuid, numeric, text, uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_award_vip_credit(uuid, numeric, text, uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_redeem_vip_points(bigint, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: a phase 8 function is executable by a browser role it should not be';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fn_redeem_vip_points(bigint, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_award_vip_credit(uuid, numeric, text, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: a VIP writer lost the grant its caller needs';
  END IF;

  RAISE NOTICE 'the other currencies get a meter: % (% ms)', v_res - 'rakeback', v_ms;
END $verify$;

COMMIT;
