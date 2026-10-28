-- Deep Stack Society's Oct18-25 complete captures contain union-root play,
-- but prize settlement read only its now-idle standalone club counters.
-- The Oct25 batch and basis receipt therefore froze zero winners incorrectly.
-- Open union rankings already use earliest-joined home-club attribution.
-- Closed complete-capture rankings now use that same physical union scope,
-- with the exact date captures and frozen roster preserved in the receipt.
-- Already settled history remains immutable. A separately linked correction
-- records the known missed awards without replacing the original empty batch.
-- No horse/human exclusion, prize change, bank overlay or scheduled repair.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
CREATE TABLE public.leaderboard_payout_corrections (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL UNIQUE,
  club_id uuid NOT NULL,
  period text NOT NULL CHECK(period IN('weekly','monthly')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  reason text NOT NULL,
  funding_union_id uuid NOT NULL,
  total_paid numeric(18,2) NOT NULL CHECK(total_paid>0),
  winner_count integer NOT NULL CHECK(winner_count>0),
  basis jsonb NOT NULL,
  basis_hash text NOT NULL CHECK(basis_hash=md5(basis::text)),
  winners jsonb NOT NULL,
  winners_hash text NOT NULL CHECK(winners_hash=md5(winners::text)),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(club_id,period,period_start)
);
ALTER TABLE public.leaderboard_payout_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.leaderboard_payout_corrections FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.leaderboard_payout_corrections TO service_role;
CREATE TRIGGER leaderboard_payout_correction_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.leaderboard_payout_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_refuse_leaderboard_basis_mutation();

DO $leaderboard_union_basis$
DECLARE v_def text:=pg_get_functiondef('public.fn_leaderboard_complete_round_basis(uuid,text,date,date)'::regprocedure);
BEGIN
  IF md5(v_def) IS DISTINCT FROM 'ac6e41f58116769e1ab11ae0564f8ab6' THEN
    RAISE EXCEPTION 'leaderboard_union_basis_preimage_changed';
  END IF;
  EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_leaderboard_complete_round_basis(p_club_id uuid, p_period text, p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cutoff date;
  v_open public.leaderboard_complete_captures%ROWTYPE;
  v_close public.leaderboard_complete_captures%ROWTYPE;
  v_count bigint;
  v_hash text;
  v_rows jsonb;
  v_capture public.leaderboard_complete_captures%ROWTYPE;
  v_union uuid;
  v_union_basis jsonb;
  v_frozen jsonb;
BEGIN
  IF p_club_id IS NULL OR p_start IS NULL OR p_end IS NULL
     OR p_period NOT IN ('weekly', 'monthly') OR p_period IS NULL
     OR p_end > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
     OR (p_period = 'weekly' AND
         (extract(dow FROM p_start) <> 0 OR p_end <> p_start + 7))
     OR (p_period = 'monthly' AND
         (extract(day FROM p_start) <> 1 OR p_end <> (p_start + interval '1 month')::date)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'LEADERBOARD_BASIS_WINDOW_INVALID';
  END IF;
  -- A receipt is the witness for a settled round. Corrections append a new
  -- witness; they never rewrite the original captured inputs or empty batch.
  SELECT c.basis INTO v_frozen FROM public.leaderboard_payout_corrections c
    WHERE c.club_id=p_club_id AND c.period=p_period AND c.period_start=p_start;
  IF FOUND THEN RETURN v_frozen; END IF;
  SELECT r.basis INTO v_frozen FROM public.leaderboard_round_basis_receipts r
    WHERE r.club_id=p_club_id AND r.period=p_period AND r.period_start=p_start;
  IF FOUND THEN RETURN v_frozen; END IF;
  SELECT CASE p_period WHEN 'weekly' THEN weekly_v2_from ELSE monthly_v2_from END
    INTO v_cutoff FROM public.leaderboard_basis_rollout WHERE singleton;
  IF v_cutoff IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'LEADERBOARD_BASIS_ROLLOUT_MISSING';
  END IF;
  IF p_start < v_cutoff AND EXISTS (
    SELECT 1 FROM public.leaderboard_basis_existing_clubs WHERE club_id = p_club_id
  ) THEN
    -- Caller must run/freeze legacy semantics, not claim these inputs complete.
    RETURN jsonb_build_object('basis_version', 'legacy_v1', 'complete', false);
  END IF;

  SELECT * INTO v_open FROM public.leaderboard_complete_captures WHERE capture_date = p_start;
  SELECT * INTO v_close FROM public.leaderboard_complete_captures WHERE capture_date = p_end;
  IF v_open.capture_date IS NULL OR v_close.capture_date IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'LEADERBOARD_CAPTURE_UNAVAILABLE';
  END IF;
  -- Exact dates, never max(date)<=boundary. Validate the complete global domain:
  -- any club with zero rows is genuinely empty within the applied-stats capture.
  FOR v_capture IN SELECT * FROM public.leaderboard_complete_captures
    WHERE capture_date IN (p_start, p_end)
  LOOP
    SELECT count(*), md5(COALESCE(string_agg(
      (to_jsonb(c) - 'snapshot_date')::text, E'\n' ORDER BY c.club_id, c.user_id), ''))
    INTO v_count, v_hash FROM public.leaderboard_capture_counters c
    WHERE c.snapshot_date = v_capture.capture_date;
    IF NOT v_capture.complete OR v_count <> v_capture.row_count
       OR v_hash <> v_capture.counter_hash
       OR (v_capture.captured_at AT TIME ZONE 'UTC')::date <> v_capture.capture_date THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'LEADERBOARD_CAPTURE_INVALID';
    END IF;
  END LOOP;

  -- Same closing roster and delta arithmetic as authoritative ranking. Individual
  -- absence in a proven complete opening capture is legitimate zero, not failure.
  -- Return raw deltas; no invented score/tie/qualification or previous-rank rule.
  SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.user_id), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT closing.user_id,
      GREATEST(closing.hands_dealt - COALESCE(opening.hands_dealt, 0), 0)::numeric AS hands_played,
      closing.total_winnings - COALESCE(opening.total_winnings, 0) AS total_winnings,
      closing.total_losses - COALESCE(opening.total_losses, 0) AS total_losses,
      GREATEST(closing.tournaments_won - COALESCE(opening.tournaments_won, 0), 0)::numeric AS tournaments_won,
      GREATEST(closing.total_rake - COALESCE(opening.total_rake, 0), 0) AS total_rake,
      GREATEST(closing.sum_big_blind - COALESCE(opening.sum_big_blind, 0), 0) AS sum_big_blind
    FROM public.leaderboard_capture_counters closing
    LEFT JOIN public.leaderboard_capture_counters opening
      ON opening.snapshot_date = p_start AND opening.club_id = closing.club_id
      AND opening.user_id = closing.user_id
    WHERE closing.snapshot_date = p_end AND closing.club_id = p_club_id
  ) d;
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc
    WHERE uc.club_id=p_club_id
      AND uc.joined_at < p_end::timestamp AT TIME ZONE 'UTC';
  IF FOUND THEN
    IF EXISTS(SELECT 1 FROM public.club_members cm JOIN public.union_clubs uc ON uc.club_id=cm.club_id
      WHERE uc.union_id=v_union AND cm.joined_at IS NULL) THEN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='LEADERBOARD_UNION_MEMBERSHIP_DATE_UNAVAILABLE';
    END IF;
WITH membership AS MATERIALIZED (
  SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id, cm.joined_at
  FROM public.club_members cm JOIN public.union_clubs uc ON uc.club_id=cm.club_id
  WHERE uc.union_id=v_union AND cm.joined_at < p_end::timestamp AT TIME ZONE 'UTC'
    AND uc.joined_at < p_end::timestamp AT TIME ZONE 'UTC'
  ORDER BY cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id
), home AS MATERIALIZED (
  SELECT * FROM membership WHERE club_id=p_club_id
), scope AS MATERIALIZED (
  SELECT v_union AS club_id UNION
  SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=v_union
    AND uc.joined_at < p_end::timestamp AT TIME ZONE 'UTC'
), deltas AS (
  SELECT closing.user_id,
    sum(GREATEST(closing.hands_dealt-COALESCE(opening.hands_dealt,0),0))::numeric AS hands_played,
    sum(closing.total_winnings-COALESCE(opening.total_winnings,0)) AS total_winnings,
    sum(closing.total_losses-COALESCE(opening.total_losses,0)) AS total_losses,
    sum(GREATEST(closing.tournaments_won-COALESCE(opening.tournaments_won,0),0))::numeric AS tournaments_won,
    sum(GREATEST(closing.total_rake-COALESCE(opening.total_rake,0),0)) AS total_rake,
    sum(GREATEST(closing.sum_big_blind-COALESCE(opening.sum_big_blind,0),0)) AS sum_big_blind
  FROM public.leaderboard_capture_counters closing
  JOIN scope s ON s.club_id=closing.club_id
  JOIN home h ON h.user_id=closing.user_id
  LEFT JOIN public.leaderboard_capture_counters opening
    ON opening.snapshot_date=p_start AND opening.club_id=closing.club_id
    AND opening.user_id=closing.user_id
  WHERE closing.snapshot_date=p_end
  GROUP BY closing.user_id
)
SELECT jsonb_build_object(
  'rows',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.user_id) FROM deltas d),'[]'::jsonb),
  'attribution_contract','union_home_join_order_v1',
  'attribution_union_id',v_union,
  'attribution_scope',(SELECT jsonb_agg(s.club_id ORDER BY s.club_id) FROM scope s),
  'attribution_roster',(SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.user_id),'[]'::jsonb) FROM home h)
) INTO v_union_basis;
    v_rows:=v_union_basis->'rows';
  END IF;
  RETURN jsonb_build_object('basis_version', 'complete_capture_v2', 'complete', true,
    'source_contract', 'applied_player_stats_v1', 'club_id', p_club_id,
    'opening_date', p_start, 'closing_date', p_end,
    'opening_captured_at', v_open.captured_at, 'closing_captured_at', v_close.captured_at,
    'opening_hash', v_open.counter_hash, 'closing_hash', v_close.counter_hash,
    'rows', v_rows) || COALESCE(v_union_basis-'rows','{}'::jsonb);
END;
$function$$definition$;
END;
$leaderboard_union_basis$;

DO $leaderboard_union_status$
DECLARE v_def text:=pg_get_functiondef('public.fn_get_leaderboard_settlement_status(uuid,text,date)'::regprocedure);
BEGIN
  IF md5(v_def) IS DISTINCT FROM '0b7d6d13a78da9f3f541bb6401bb1fc8' THEN
    RAISE EXCEPTION 'leaderboard_union_status_preimage_changed';
  END IF;
  EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_get_leaderboard_settlement_status(p_club_id uuid, p_period text, p_period_start date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_club record;
  v_is_member boolean := false;
  v_can_manage boolean := false;
  v_is_platform_admin boolean := false;
  v_period_end date;
  v_plan jsonb;
  v_batch public.leaderboard_payout_batches%ROWTYPE;
  v_failure public.leaderboard_payout_failures%ROWTYPE;
  v_receipts jsonb := '[]'::jsonb;
  v_state text;
  v_planned_total numeric(18,2) := 0;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication Required' USING ERRCODE = '42501';
  END IF;
  IF p_period NOT IN ('weekly', 'monthly') OR p_period_start IS NULL THEN
    RAISE EXCEPTION 'A Canonical Weekly Or Monthly Period Is Required' USING ERRCODE = '22023';
  END IF;

  SELECT club.id, club.owner_id, club.union_id
  INTO v_club
  FROM public.clubs club
  WHERE club.id = p_club_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.club_members member
    WHERE member.club_id = p_club_id AND member.user_id = v_actor
  ) INTO v_is_member;
  SELECT EXISTS (
    SELECT 1 FROM public.profiles profile
    WHERE profile.id = v_actor AND profile.role IN ('admin', 'superadmin', 'god')
  ) INTO v_is_platform_admin;

  v_can_manage := v_is_platform_admin
    OR v_club.owner_id = v_actor
    OR EXISTS (
      SELECT 1 FROM public.club_members member
      WHERE member.club_id = p_club_id
        AND member.user_id = v_actor
        AND member.role IN ('owner', 'co_owner')
    )
    OR (
      v_club.union_id IS NOT NULL
      AND public.fn_union_can_manage_wallets(v_club.union_id, v_actor)
    );

  IF NOT v_is_member AND NOT v_can_manage THEN
    RAISE EXCEPTION 'Leaderboard Access Denied' USING ERRCODE = '42501';
  END IF;

  v_period_end := CASE p_period
    WHEN 'weekly' THEN p_period_start + 7
    ELSE (p_period_start + interval '1 month')::date
  END;
  IF (p_period = 'weekly' AND EXTRACT(DOW FROM p_period_start) <> 0)
     OR (p_period = 'monthly' AND EXTRACT(DAY FROM p_period_start) <> 1) THEN
    RAISE EXCEPTION 'A Canonical Weekly Or Monthly Period Is Required' USING ERRCODE = '22023';
  END IF;

  v_plan := public.fn_get_leaderboard_reward_plan(p_club_id, p_period, p_period_start);
  IF v_plan IS NOT NULL THEN
    SELECT COALESCE(sum((prize ->> 'amount')::numeric), 0)
    INTO v_planned_total
    FROM jsonb_array_elements(COALESCE(v_plan -> 'prizes', '[]'::jsonb)) prize;
  END IF;

  SELECT batch.* INTO v_batch
  FROM public.leaderboard_payout_batches batch
  WHERE batch.club_id = p_club_id
    AND batch.period = p_period
    AND batch.period_start = p_period_start;

  IF v_batch.id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', payout.id,
      'batch_id', payout.batch_id,
      'user_id', payout.user_id,
      'rank', payout.rank,
      'payout_amount', payout.payout_amount,
      'payout_currency', payout.payout_currency,
      'awarded_at', payout.awarded_at
    ) ORDER BY payout.rank, payout.user_id), '[]'::jsonb)
    INTO v_receipts
    FROM public.leaderboard_payouts payout
    WHERE payout.batch_id = v_batch.id;
  END IF;

  SELECT failure.* INTO v_failure
  FROM public.leaderboard_payout_failures failure
  WHERE failure.club_id = p_club_id
    AND failure.period = p_period
    AND failure.period_start = p_period_start
    AND failure.resolved_at IS NULL;

  v_state := CASE
    WHEN v_batch.id IS NOT NULL THEN 'paid'
    WHEN v_plan IS NULL THEN 'not_published'
    WHEN NOT COALESCE((v_plan ->> 'rewards_enabled')::boolean, false) THEN 'disabled'
    WHEN v_period_end > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date THEN 'open'
    WHEN v_failure.id IS NOT NULL THEN 'failed'
    ELSE 'pending'
  END;

  RETURN jsonb_build_object(
    'club_id', p_club_id,
    'period', p_period,
    'period_start', p_period_start,
    'period_end', v_period_end,
    'state', v_state,
    'can_manage', v_can_manage,
    'planned_total', round(v_planned_total, 2),
    'program', v_plan,
    'batch', CASE WHEN v_batch.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_batch.id,
      'program_id', v_batch.program_id,
      'program_version', v_batch.program_version,
      'program_hash', v_batch.program_hash,
      'metric', v_batch.metric,
      'funding_owner_type', CASE WHEN EXISTS(SELECT 1 FROM public.leaderboard_payout_corrections c WHERE c.batch_id=v_batch.id) THEN 'union' ELSE v_batch.funding_owner_type END,
      'funding_union_id', COALESCE((SELECT c.funding_union_id FROM public.leaderboard_payout_corrections c WHERE c.batch_id=v_batch.id),v_batch.funding_union_id),
      'total_paid', v_batch.total_paid+COALESCE((SELECT c.total_paid FROM public.leaderboard_payout_corrections c WHERE c.batch_id=v_batch.id),0),
      'seed_funded', v_batch.seed_funded,
      'promo_funded', v_batch.promo_funded+COALESCE((SELECT c.total_paid FROM public.leaderboard_payout_corrections c WHERE c.batch_id=v_batch.id),0),
      'overlay_funded', v_batch.overlay_funded,
      'winner_count', v_batch.winner_count+COALESCE((SELECT c.winner_count FROM public.leaderboard_payout_corrections c WHERE c.batch_id=v_batch.id),0),
      'correction', (SELECT to_jsonb(c)-'basis' FROM public.leaderboard_payout_corrections c WHERE c.batch_id=v_batch.id),
      'tie_policy', v_batch.tie_policy,
      'settled_at', v_batch.settled_at
    ) END,
    'failure', CASE WHEN v_failure.id IS NULL THEN NULL ELSE jsonb_build_object(
      'error_code', v_failure.error_code,
      'attempt_count', v_failure.attempt_count,
      'first_failed_at', v_failure.first_failed_at,
      'last_failed_at', v_failure.failed_at,
      'automatic_retry', true,
      'owner_message', CASE WHEN v_can_manage THEN CASE v_failure.error_code
        WHEN 'promo_wallet_underfunded' THEN 'Add Promo Chips To Cover The Published Prize Pool. Automatic Retry Is Active.'
        WHEN 'promo_wallet_missing' THEN 'The Recorded Promo Wallet Could Not Be Found. Automatic Retry Is Active.'
        WHEN 'credit_conflict' THEN 'A Payout Receipt Conflict Needs Platform Review. No Duplicate Credit Was Issued.'
        ELSE 'Settlement Needs Platform Review. Automatic Retry Is Active.'
      END ELSE NULL END
    ) END,
    'receipts', v_receipts
  );
END;
$function$$definition$;
END;
$leaderboard_union_status$;

DO $leaderboard_union_replay$
DECLARE v_def text:=pg_get_functiondef('public.fn_payout_leaderboard(uuid,text,text,timestamptz,timestamptz)'::regprocedure);
BEGIN
  IF md5(v_def) IS DISTINCT FROM 'c9360b6f765d9ac17ca6d3a5f07194cb' THEN
    RAISE EXCEPTION 'leaderboard_union_replay_preimage_changed';
  END IF;
  EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_payout_leaderboard(p_club_id uuid, p_period text, p_metric text, p_start_date timestamp with time zone, p_end_date timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_start date := (p_start_date AT TIME ZONE 'UTC')::date;
  v_end date := (p_end_date AT TIME ZONE 'UTC')::date;
  v_plan jsonb;
  v_basis jsonb;
  v_board jsonb;
  v_existing public.leaderboard_payout_batches%ROWTYPE;
  v_winners jsonb := '[]'::jsonb;
  v_winner jsonb;
  v_total numeric(18,2) := 0;
  v_promo_available numeric(18,2) := 0;
  v_promo_debit numeric(18,2) := 0;
  v_union_id uuid;
  v_batch_id uuid;
  v_credited boolean;
BEGIN
  IF p_period NOT IN ('weekly', 'monthly') THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|Only Weekly And Monthly Leaderboards Can Be Settled';
  END IF;
  IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|Leaderboard Settlement Requires A Closed Date Range';
  END IF;
  IF v_end > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|An Open Leaderboard Round Cannot Be Paid';
  END IF;
  IF (p_period = 'weekly' AND (EXTRACT(DOW FROM v_start) <> 0 OR v_end <> v_start + 7))
     OR (p_period = 'monthly' AND (
       EXTRACT(DAY FROM v_start) <> 1
       OR v_end <> (v_start + interval '1 month')::date
     )) THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|Leaderboard Settlement Must Use A Canonical UTC Round';
  END IF;

  -- Serialize the exact historical round identity BEFORE replay lookup.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    format('leaderboard-round:%s:%s:%s', p_club_id, p_period, v_start), 0));

  SELECT batch.* INTO v_existing
  FROM public.leaderboard_payout_batches batch
  WHERE batch.club_id = p_club_id
    AND batch.period = p_period
    AND batch.period_start = v_start;
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_settled', true,
      'batch_id', v_existing.id,
      'total_paid', v_existing.total_paid+COALESCE((SELECT c.total_paid FROM public.leaderboard_payout_corrections c WHERE c.batch_id=v_existing.id),0),
      'seed_funded', v_existing.seed_funded,
      'promo_funded', v_existing.promo_funded+COALESCE((SELECT c.total_paid FROM public.leaderboard_payout_corrections c WHERE c.batch_id=v_existing.id),0),
      'overlay_funded', v_existing.overlay_funded,
      'winner_count', v_existing.winner_count+COALESCE((SELECT c.winner_count FROM public.leaderboard_payout_corrections c WHERE c.batch_id=v_existing.id),0),
      'correction', (SELECT to_jsonb(c)-'basis' FROM public.leaderboard_payout_corrections c WHERE c.batch_id=v_existing.id),
      'tie_policy', v_existing.tie_policy
    );
  END IF;

  v_plan := public.fn_get_leaderboard_reward_plan(p_club_id, p_period, v_start);
  IF v_plan IS NULL OR NOT COALESCE((v_plan ->> 'rewards_enabled')::boolean, false) THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|No Paid Leaderboard Program Applies To This Round';
  END IF;
  IF p_metric IS DISTINCT FROM v_plan ->> 'payout_metric' THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|Leaderboard Metric Does Not Match The Published Program';
  END IF;

  v_basis := public.fn_leaderboard_complete_round_basis(p_club_id, p_period, v_start, v_end);
  IF NOT (v_basis ->> 'basis_version' = 'legacy_v1'
    OR (v_basis ->> 'basis_version' = 'complete_capture_v2'
      AND v_basis -> 'complete' = 'true'::jsonb)) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='LEADERBOARD_COMPLETE_BASIS_REQUIRED';
  END IF;
  -- The public club board and settlement use ONE maintained ranking owner.
  -- That owner selects the same complete basis for closed canonical V2 rounds;
  -- existing promised legacy rounds retain their unchanged selection.
  SELECT COALESCE(jsonb_agg(to_jsonb(ranked) ORDER BY ranked.rank, ranked.user_id), '[]'::jsonb)
    INTO v_board
  FROM public.fn_club_leaderboard_by_dates(p_club_id, p_metric, v_start, v_end, 1000000, 0) ranked;

  WITH board AS MATERIALIZED (
    SELECT ranked.user_id, ranked.rank
    FROM jsonb_to_recordset(v_board) AS ranked(user_id uuid, rank integer, qualified boolean)
    WHERE ranked.qualified
  ), tied AS MATERIALIZED (
    SELECT
      board.user_id,
      board.rank,
      count(*) OVER (PARTITION BY board.rank)::integer AS tie_count,
      row_number() OVER (PARTITION BY board.rank ORDER BY board.user_id)::integer AS tie_order
    FROM board
  ), prizes AS MATERIALIZED (
    SELECT prize.rank, round(prize.amount, 2) AS amount
    FROM jsonb_to_recordset(COALESCE(v_plan -> 'prizes', '[]'::jsonb))
      AS prize(rank integer, amount numeric)
    WHERE prize.amount > 0
  ), pooled AS MATERIALIZED (
    SELECT
      tied.user_id,
      tied.rank,
      tied.tie_count,
      tied.tie_order,
      COALESCE(sum(prizes.amount), 0)::numeric(18,2) AS pool_amount
    FROM tied
    LEFT JOIN prizes
      ON prizes.rank >= tied.rank
     AND prizes.rank < tied.rank + tied.tie_count
    GROUP BY tied.user_id, tied.rank, tied.tie_count, tied.tie_order
  ), winners AS (
    SELECT
      pooled.user_id,
      pooled.rank,
      (
        trunc(pooled.pool_amount / pooled.tie_count, 2)
        + CASE
            WHEN pooled.tie_order <= mod((pooled.pool_amount * 100)::bigint, pooled.tie_count)
              THEN 0.01
            ELSE 0
          END
      )::numeric(18,2) AS amount
    FROM pooled
    WHERE pooled.pool_amount > 0
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'user_id', winners.user_id,
      'rank', winners.rank,
      'amount', winners.amount
    ) ORDER BY winners.rank, winners.user_id), '[]'::jsonb),
    COALESCE(round(sum(winners.amount), 2), 0)
  INTO v_winners, v_total
  FROM winners
  WHERE winners.amount > 0;

  -- Freeze the exact resolved program, selected inputs and awards before funds.
  -- A failed settlement rolls this receipt back; no historical row is rewritten.
  INSERT INTO public.leaderboard_round_basis_receipts (
    club_id, period, period_start, period_end, metric,
    program_id, program_version, program_hash, basis_version,
    basis, basis_hash, selected_board, selected_board_hash, winners, winners_hash
  ) VALUES (
    p_club_id, p_period, v_start, v_end, p_metric,
    (v_plan ->> 'program_id')::uuid, (v_plan ->> 'program_version')::integer,
    v_plan ->> 'program_hash', v_basis ->> 'basis_version',
    v_basis, md5(v_basis::text), v_board, md5(v_board::text), v_winners, md5(v_winners::text)
  );

  IF v_plan ->> 'funding_owner_type' = 'union' THEN
    v_union_id := (v_plan ->> 'funding_union_id')::uuid;
    SELECT COALESCE(wallet.promo_wallet, 0) INTO v_promo_available
    FROM public.union_wallets wallet WHERE wallet.union_id = v_union_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'LEADERBOARD_PROMO_WALLET_MISSING|Leaderboard Funding Union Has No Promo Wallet';
    END IF;
  ELSE
    SELECT COALESCE(club.promo_balance, 0) INTO v_promo_available
    FROM public.clubs club WHERE club.id = p_club_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'LEADERBOARD_PROMO_WALLET_MISSING|Leaderboard Club Not Found';
    END IF;
  END IF;
  IF v_promo_available < v_total THEN
    RAISE EXCEPTION
      'LEADERBOARD_PROMO_UNDERFUNDED|Leaderboard Requires % Promo Chips But The Recorded Promo Wallet Holds %',
      v_total, v_promo_available;
  END IF;
  v_promo_debit := v_total;

  PERFORM set_config('app.ledger_category', 'leaderboard_payout', true);
  PERFORM set_config('app.ledger_counterparty', 'leaderboard_round', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_club_id::text, true);

  IF v_plan ->> 'funding_owner_type' = 'union' THEN
    UPDATE public.union_wallets
    SET promo_wallet = promo_wallet - v_promo_debit,
        updated_at = now()
    WHERE union_id = v_union_id;
  ELSE
    UPDATE public.clubs
    SET promo_balance = promo_balance - v_promo_debit,
        updated_at = now()
    WHERE id = p_club_id;
  END IF;

  INSERT INTO public.leaderboard_payout_batches (
    club_id, period, period_start, period_end, metric,
    program_id, program_version, program_hash,
    funding_owner_type, funding_union_id,
    total_paid, seed_funded, promo_funded, overlay_funded, winner_count, tie_policy
  ) VALUES (
    p_club_id, p_period, v_start, v_end, p_metric,
    (v_plan ->> 'program_id')::uuid,
    (v_plan ->> 'program_version')::integer,
    v_plan ->> 'program_hash',
    v_plan ->> 'funding_owner_type', v_union_id,
    v_total, 0, v_promo_debit, 0, jsonb_array_length(v_winners),
    'split_occupied_places'
  ) RETURNING id INTO v_batch_id;

  FOR v_winner IN SELECT value FROM jsonb_array_elements(v_winners)
  LOOP
    v_credited := public.fn_credit_and_log(
      (v_winner ->> 'user_id')::uuid,
      (v_winner ->> 'amount')::numeric,
      format('leaderboard:%s:%s:%s:%s', p_club_id, p_period, v_start, v_winner ->> 'user_id'),
      'leaderboard_payout',
      format('%s Leaderboard, Rank %s', initcap(p_period), v_winner ->> 'rank'),
      (v_plan ->> 'program_id')::uuid
    );
    IF NOT v_credited THEN
      RAISE EXCEPTION 'LEADERBOARD_CREDIT_CONFLICT|Leaderboard Credit Key Already Exists Without A Batch Receipt';
    END IF;

    INSERT INTO public.leaderboard_payouts (
      club_id, period, metric, start_date, end_date, user_id, rank,
      payout_amount, payout_currency, awarded_at, batch_id
    ) VALUES (
      p_club_id, p_period, p_metric, v_start, v_end,
      (v_winner ->> 'user_id')::uuid,
      (v_winner ->> 'rank')::integer,
      (v_winner ->> 'amount')::numeric,
      'chips', now(), v_batch_id
    );
  END LOOP;

  UPDATE public.leaderboard_payout_failures
  SET resolved_at = now(),
      resolution = 'Settlement Completed Automatically'
  WHERE club_id = p_club_id
    AND period = p_period
    AND period_start = v_start
    AND resolved_at IS NULL;

  RETURN jsonb_build_object(
    'success', true,
    'already_settled', false,
    'batch_id', v_batch_id,
    'total_paid', v_total,
    'seed_funded', 0,
    'promo_funded', v_promo_debit,
    'overlay_funded', 0,
    'winner_count', jsonb_array_length(v_winners),
    'tie_policy', 'split_occupied_places'
  );
END;
$function$$definition$;
END;
$leaderboard_union_replay$;

-- The affiliated club's future rounds use its union Promo Wallet. Append a
-- funding-only program version; keep original published prizes and version1.
DO $funding$
DECLARE
  v_old public.leaderboard_reward_program_versions%ROWTYPE;
  v_new public.leaderboard_reward_program_versions%ROWTYPE;
  v_union constant uuid:='fade0000-0000-0000-0000-000000000001';
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('leaderboard-funding:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',0));
  SELECT * INTO STRICT v_old FROM public.leaderboard_reward_program_versions
    WHERE club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3' ORDER BY version DESC LIMIT 1;
  IF v_old.id<>'cf1e2a57-83f8-4241-977f-5d7b5fd870d6' OR v_old.version<>1
    OR v_old.program_hash<>'6cccd5b70afc93983c8419ec15c2f707'
    OR NOT EXISTS(SELECT 1 FROM public.union_clubs WHERE club_id=v_old.club_id AND union_id=v_union AND joined_at<'2026-10-18 00:00Z'::timestamptz) THEN
    RAISE EXCEPTION 'leaderboard_union_funding_preimage_changed';
  END IF;
  v_new:=v_old;
  v_new.id:='d850f094-844d-4179-809e-00b1fda9bf6f';
  v_new.version:=2;
  v_new.operation_id:='0c2ff9c8-64f3-4a70-b677-cf6c637bde64';
  v_new.funding_owner_type:='union';v_new.funding_union_id:=v_union;
  v_new.weekly_effective_from:='2026-10-25';v_new.monthly_effective_from:='2026-11-01';
  v_new.published_at:=now();v_new.published_by:=NULL;
  v_new.supersedes_program_id:=v_old.id;
  v_new.program_hash:=md5(jsonb_build_object('club_id',v_new.club_id,'version',v_new.version,
    'rewards_enabled',v_new.rewards_enabled,'payout_metric',v_new.payout_metric,
    'weekly_prizes',v_new.weekly_prizes,'monthly_prizes',v_new.monthly_prizes,
    'funding_owner_type',v_new.funding_owner_type,'funding_union_id',v_new.funding_union_id,
    'weekly_effective_from',v_new.weekly_effective_from,'monthly_effective_from',v_new.monthly_effective_from)::text);
  INSERT INTO public.leaderboard_reward_program_versions SELECT v_new.*;
  UPDATE public.club_leaderboard_settings SET funding_owner_type='union',funding_union_id=v_union,updated_at=now()
    WHERE club_id=v_old.club_id AND funding_owner_type='club' AND funding_union_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'leaderboard_union_settings_preimage_changed';END IF;
END;
$funding$;

DO $awards$
DECLARE
  p_club_id constant uuid:='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  p_start constant date:='2026-10-18';
  p_end constant date:='2026-10-25';
  v_union constant uuid:='fade0000-0000-0000-0000-000000000001';
  v_union_basis jsonb;
  v_basis jsonb;
  v_winners jsonb;
  v_top jsonb;
  v_batch public.leaderboard_payout_batches%ROWTYPE;
  v_winner jsonb;
  v_balance numeric;
  v_credit_key text;
  v_receipt_id constant uuid:='41f625bd-f65d-4fc6-9aaa-7c32f047ca67';
BEGIN
  IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'leaderboard_union_awards_platform_frozen'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(format('leaderboard-round:%s:weekly:%s',p_club_id,p_start),0));
  SELECT * INTO STRICT v_batch FROM public.leaderboard_payout_batches
    WHERE club_id=p_club_id AND period='weekly' AND period_start=p_start FOR UPDATE;
  IF v_batch.id<>'0b5cebb0-96a4-4163-8d53-2f5f6e482cd2'
    OR v_batch.total_paid<>0 OR v_batch.winner_count<>0
    OR v_batch.program_hash<>'6cccd5b70afc93983c8419ec15c2f707'
    OR EXISTS(SELECT 1 FROM public.leaderboard_payouts WHERE batch_id=v_batch.id) THEN
    RAISE EXCEPTION 'leaderboard_union_awards_original_batch_changed';
  END IF;
  SELECT r.basis INTO STRICT v_basis FROM public.leaderboard_round_basis_receipts r
    WHERE r.club_id=p_club_id AND r.period='weekly' AND r.period_start=p_start;
  IF md5(v_basis::text)<>'fa19da096e2fb86cf1edbf78832057e3' THEN
    RAISE EXCEPTION 'leaderboard_union_awards_original_basis_changed';
  END IF;
WITH membership AS MATERIALIZED (
  SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id, cm.joined_at
  FROM public.club_members cm JOIN public.union_clubs uc ON uc.club_id=cm.club_id
  WHERE uc.union_id=v_union AND cm.joined_at < p_end::timestamp AT TIME ZONE 'UTC'
    AND uc.joined_at < p_end::timestamp AT TIME ZONE 'UTC'
  ORDER BY cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id
), home AS MATERIALIZED (
  SELECT * FROM membership WHERE club_id=p_club_id
), scope AS MATERIALIZED (
  SELECT v_union AS club_id UNION
  SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=v_union
    AND uc.joined_at < p_end::timestamp AT TIME ZONE 'UTC'
), deltas AS (
  SELECT closing.user_id,
    sum(GREATEST(closing.hands_dealt-COALESCE(opening.hands_dealt,0),0))::numeric AS hands_played,
    sum(closing.total_winnings-COALESCE(opening.total_winnings,0)) AS total_winnings,
    sum(closing.total_losses-COALESCE(opening.total_losses,0)) AS total_losses,
    sum(GREATEST(closing.tournaments_won-COALESCE(opening.tournaments_won,0),0))::numeric AS tournaments_won,
    sum(GREATEST(closing.total_rake-COALESCE(opening.total_rake,0),0)) AS total_rake,
    sum(GREATEST(closing.sum_big_blind-COALESCE(opening.sum_big_blind,0),0)) AS sum_big_blind
  FROM public.leaderboard_capture_counters closing
  JOIN scope s ON s.club_id=closing.club_id
  JOIN home h ON h.user_id=closing.user_id
  LEFT JOIN public.leaderboard_capture_counters opening
    ON opening.snapshot_date=p_start AND opening.club_id=closing.club_id
    AND opening.user_id=closing.user_id
  WHERE closing.snapshot_date=p_end
  GROUP BY closing.user_id
)
SELECT jsonb_build_object(
  'rows',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.user_id) FROM deltas d),'[]'::jsonb),
  'attribution_contract','union_home_join_order_v1',
  'attribution_union_id',v_union,
  'attribution_scope',(SELECT jsonb_agg(s.club_id ORDER BY s.club_id) FROM scope s),
  'attribution_roster',(SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.user_id),'[]'::jsonb) FROM home h)
) INTO v_union_basis;

  IF md5((v_union_basis->'rows')::text)<>'a8fac2d3d785bd50a57f020e750476b9'
    OR md5((v_union_basis->'attribution_roster')::text)<>'479b1709aa68e35d315dd0425c40849d' THEN
    RAISE EXCEPTION 'leaderboard_union_awards_inputs_changed';
  END IF;
  SELECT jsonb_agg(to_jsonb(x) ORDER BY x.rank,x.user_id) INTO v_top FROM (
    SELECT d.user_id,d.hands_played,rank()OVER(ORDER BY d.hands_played DESC)::integer rank
    FROM jsonb_to_recordset(v_union_basis->'rows') d(user_id uuid,hands_played numeric)
    WHERE d.hands_played>0 AND NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=d.user_id AND p.status='deleted')
    ORDER BY d.hands_played DESC,d.user_id LIMIT 4
  ) x;
  IF v_top->0 IS DISTINCT FROM '{"user_id":"d712fcf0-3741-461d-9617-8cb68fb1c54c","hands_played":24786,"rank":1}'::jsonb
    OR v_top->1 IS DISTINCT FROM '{"user_id":"d33a878b-e189-4bd4-aeb8-d9d4acf6cb34","hands_played":22889,"rank":2}'::jsonb
    OR v_top->2 IS DISTINCT FROM '{"user_id":"c401b45c-8a60-4480-9900-f452454d77be","hands_played":22647,"rank":3}'::jsonb
    OR (v_top->3->>'hands_played')::numeric>=22647 THEN
    RAISE EXCEPTION 'leaderboard_union_awards_winners_changed';
  END IF;
  v_winners:='[{"user_id":"d712fcf0-3741-461d-9617-8cb68fb1c54c","rank":1,"amount":250},{"user_id":"d33a878b-e189-4bd4-aeb8-d9d4acf6cb34","rank":2,"amount":150},{"user_id":"c401b45c-8a60-4480-9900-f452454d77be","rank":3,"amount":100}]';
  -- echobellamy:24,786 hands/250 Chips; jasperjamison:22,889/150;
  -- runequintero:22,647/100. All are horses and receive the same prizes.
  -- The same original per-player keys prevent any duplicate historical credit.
  FOR v_winner IN SELECT value FROM jsonb_array_elements(v_winners) LOOP
    v_credit_key:=format('leaderboard:%s:weekly:%s:%s',p_club_id,p_start,v_winner->>'user_id');
    IF EXISTS(SELECT 1 FROM public.wallet_credit_idempotency WHERE key=v_credit_key) THEN
      RAISE EXCEPTION 'leaderboard_union_awards_credit_already_exists';
    END IF;
  END LOOP;
  SELECT promo_wallet INTO STRICT v_balance FROM public.union_wallets WHERE union_id=v_union FOR UPDATE;
  IF v_balance<500 THEN RAISE EXCEPTION 'leaderboard_union_awards_promo_underfunded'; END IF;
  PERFORM set_config('app.ledger_category','leaderboard_payout',true);
  PERFORM set_config('app.ledger_counterparty','leaderboard_round',true);
  PERFORM set_config('app.ledger_counterparty_entity',p_club_id::text,true);
  UPDATE public.union_wallets SET promo_wallet=promo_wallet-500,updated_at=now() WHERE union_id=v_union;
  FOR v_winner IN SELECT value FROM jsonb_array_elements(v_winners) LOOP
    v_credit_key:=format('leaderboard:%s:weekly:%s:%s',p_club_id,p_start,v_winner->>'user_id');
    IF public.fn_credit_and_log((v_winner->>'user_id')::uuid,(v_winner->>'amount')::numeric,
      v_credit_key,'leaderboard_payout','Deep Stack Society weekly prize Oct18-25: union attribution correction',v_batch.program_id) IS NOT TRUE THEN
      RAISE EXCEPTION 'leaderboard_union_awards_credit_conflict';
    END IF;
    INSERT INTO public.leaderboard_payouts(club_id,period,metric,start_date,end_date,user_id,rank,payout_amount,payout_currency,batch_id)
    VALUES(p_club_id,'weekly','hands_played',p_start::timestamp AT TIME ZONE 'UTC',p_end::timestamp AT TIME ZONE 'UTC',
      (v_winner->>'user_id')::uuid,(v_winner->>'rank')::integer,(v_winner->>'amount')::numeric,'chips',v_batch.id);
  END LOOP;
  v_basis:=v_basis||v_union_basis;
  INSERT INTO public.leaderboard_payout_corrections(id,batch_id,club_id,period,period_start,period_end,
    reason,funding_union_id,total_paid,winner_count,basis,basis_hash,winners,winners_hash)
  VALUES(v_receipt_id,v_batch.id,p_club_id,'weekly',p_start,p_end,
    'Original empty batch omitted union-root hands after Deep Stack joined Midway; paid published 250/150/100 Chips from Midway Promo.',
    v_union,500,3,v_basis,md5(v_basis::text),v_winners,md5(v_winners::text));
  IF (SELECT sum(payout_amount) FROM public.leaderboard_payouts WHERE batch_id=v_batch.id)<>500
    OR (SELECT count(*) FROM public.leaderboard_payouts WHERE batch_id=v_batch.id)<>3 THEN
    RAISE EXCEPTION 'leaderboard_union_awards_receipts_disagree';
  END IF;

END;

$awards$;
COMMIT;
