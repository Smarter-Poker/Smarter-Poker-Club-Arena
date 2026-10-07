-- UNQUALIFIED SOURCE CANDIDATE. Not a reserved migration. DO NOT execute on source.
-- Root must qualify this on the faithful disposable schema before integration.
-- No payout, wallet, program, existing batch, cron command or schedule is changed.
-- Installed predecessor: producer prosrc MD5 958a10d01583508e525523fc17a6cda1.
-- Applied stats, not accepted-hand reconstruction; preserve existing daily product.
-- The first existing producer invocation is the origin. This does NOT prove that
-- invocation was pg_cron rather than an authorized direct/recovery invocation.
-- Record actual time and timezone, never synthesize a midnight capture time.
-- Future payout/ranking consumers still require separately qualified integration.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF current_user <> 'postgres' OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'public.fn_snapshot_player_stats()'::regprocedure
      AND p.proowner = 'postgres'::regrole AND p.prosecdef
      AND p.proconfig = ARRAY['search_path=public']::text[]
  ) OR has_function_privilege('anon', 'public.fn_snapshot_player_stats()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.fn_snapshot_player_stats()', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.fn_snapshot_player_stats()', 'EXECUTE') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'LEADERBOARD_CAPTURE_SECURITY_PREDECESSOR_MISMATCH';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = 'public.fn_snapshot_player_stats()'::regprocedure)
      IS DISTINCT FROM '958a10d01583508e525523fc17a6cda1' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'LEADERBOARD_CAPTURE_PREDECESSOR_MISMATCH';
  END IF;
  IF to_regclass('public.leaderboard_complete_captures') IS NOT NULL
     OR to_regclass('public.leaderboard_capture_counters') IS NOT NULL
     OR to_regclass('public.leaderboard_basis_rollout') IS NOT NULL
     OR to_regclass('public.leaderboard_basis_existing_clubs') IS NOT NULL
     OR to_regclass('public.leaderboard_round_basis_receipts') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'LEADERBOARD_CAPTURE_CANDIDATE_ALREADY_PRESENT';
  END IF;
END;
$guard$;

CREATE TABLE public.leaderboard_complete_captures (
  capture_date date PRIMARY KEY,
  captured_at timestamptz NOT NULL,
  capture_timezone text NOT NULL,
  origin text NOT NULL CHECK (origin = 'fn_snapshot_player_stats'),
  source_contract text NOT NULL CHECK (source_contract = 'applied_player_stats_v1'),
  row_count bigint NOT NULL CHECK (row_count >= 0),
  counter_hash text NOT NULL CHECK (counter_hash ~ '^[0-9a-f]{32}$'),
  complete boolean NOT NULL CHECK (complete)
);

-- No references to hot source tables. The only FK is to the new capture header.
CREATE TABLE public.leaderboard_capture_counters (
  snapshot_date date NOT NULL REFERENCES public.leaderboard_complete_captures(capture_date),
  user_id uuid NOT NULL,
  club_id uuid NOT NULL,
  hands_played bigint NOT NULL,
  hands_dealt bigint NOT NULL,
  sum_big_blind numeric NOT NULL,
  total_winnings numeric NOT NULL,
  total_losses numeric NOT NULL,
  total_rake numeric NOT NULL,
  tournaments_played bigint NOT NULL,
  tournaments_won bigint NOT NULL,
  PRIMARY KEY (snapshot_date, club_id, user_id)
);

CREATE TABLE public.leaderboard_basis_rollout (
  singleton boolean PRIMARY KEY CHECK (singleton),
  installed_at timestamptz NOT NULL,
  weekly_v2_from date NOT NULL,
  monthly_v2_from date NOT NULL,
  contract_version text NOT NULL CHECK (contract_version = 'complete_capture_v2'),
  CHECK (extract(dow FROM weekly_v2_from) = 0),
  CHECK (extract(day FROM monthly_v2_from) = 1)
);

-- Immutable installation inventory, no FK to hot clubs. Only these clubs can
-- have an already-open promised legacy round when this contract is installed.
-- Actual publication for a new club already starts at its next canonical
-- weekly/monthly boundary, so a club absent here uses v2 from its first round.
-- This is production compatibility metadata, not an admin/test escape hatch.
CREATE TABLE public.leaderboard_basis_existing_clubs (
  club_id uuid PRIMARY KEY
);

-- Payout-owned immutable receipt; no FK to clubs, programs or payout batches.
-- Insert AFTER round lock, historic batch replay, plan/basis/ranking/winner
-- resolution and BEFORE funds, inside the SAME payout transaction. Never upsert.
-- On underfunding/credit failure/crash the receipt rolls back with all money.
-- Historical batches without this new receipt retain their existing replay path.
-- selected_board freezes ALL active ranked rows (including qualified=false and
-- actual legacy baseline_date), not only paid/qualified winners. Legacy basis is
-- explicitly incomplete; no inferred legacy opening/closing completeness.
CREATE TABLE public.leaderboard_round_basis_receipts (
  club_id uuid NOT NULL,
  period text NOT NULL CHECK (period IN ('weekly', 'monthly')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  program_id uuid NOT NULL,
  program_version integer NOT NULL CHECK (program_version > 0),
  program_hash text NOT NULL CHECK (program_hash ~ '^[0-9a-f]{32}$'),
  metric text NOT NULL CHECK (metric IN ('profit', 'hands_played', 'tournaments_won', 'roi')),
  basis_version text NOT NULL CHECK (basis_version IN ('legacy_v1', 'complete_capture_v2')),
  basis jsonb NOT NULL CHECK (
    jsonb_typeof(basis) = 'object' AND basis ? 'basis_version' AND basis ? 'complete'
    AND basis ->> 'basis_version' = basis_version
    AND basis -> 'complete' = to_jsonb(basis_version = 'complete_capture_v2')
  ),
  basis_hash text NOT NULL CHECK (basis_hash = md5(basis::text)),
  selected_board jsonb NOT NULL CHECK (jsonb_typeof(selected_board) = 'array'),
  selected_board_hash text NOT NULL CHECK (selected_board_hash = md5(selected_board::text)),
  winners jsonb NOT NULL CHECK (jsonb_typeof(winners) = 'array'),
  winners_hash text NOT NULL CHECK (winners_hash = md5(winners::text)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (club_id, period, period_start),
  CHECK (
    (period = 'weekly' AND extract(dow FROM period_start) = 0
      AND period_end = period_start + 7)
    OR (period = 'monthly' AND extract(day FROM period_start) = 1
      AND period_end = (period_start + interval '1 month')::date)
  )
);

-- Independent weekly/monthly cutoffs, not settlement-time selection. Published
-- program IDs, terms, hashes and effective dates stay untouched. Current open
-- rounds remain legacy-v1; an unchanged enabled program uses v2 in future rounds.
INSERT INTO public.leaderboard_basis_rollout
SELECT true, statement_timestamp(), weekly.end_date, monthly.end_date, 'complete_capture_v2'
FROM public.fn_leaderboard_period_window('weekly', 0) weekly
CROSS JOIN public.fn_leaderboard_period_window('monthly', 0) monthly;

INSERT INTO public.leaderboard_basis_existing_clubs (club_id)
SELECT id FROM public.clubs;
-- A faithful empty isolated schema can install this exact candidate before
-- synthetic clubs are created. Their constrained historical test programs and
-- explicitly synthetic captures then exercise v2 without editing immutable
-- rollout metadata, time-warping, production overrides or migration variants.

CREATE FUNCTION public.fn_refuse_leaderboard_basis_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'LEADERBOARD_BASIS_IMMUTABLE';
END;
$body$;

CREATE TRIGGER leaderboard_capture_header_immutable
BEFORE UPDATE OR DELETE ON public.leaderboard_complete_captures
FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_leaderboard_basis_mutation();
CREATE TRIGGER leaderboard_capture_header_no_truncate
BEFORE TRUNCATE ON public.leaderboard_complete_captures
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_refuse_leaderboard_basis_mutation();
CREATE TRIGGER leaderboard_capture_counter_immutable
BEFORE UPDATE OR DELETE ON public.leaderboard_capture_counters
FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_leaderboard_basis_mutation();
CREATE TRIGGER leaderboard_capture_counter_no_truncate
BEFORE TRUNCATE ON public.leaderboard_capture_counters
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_refuse_leaderboard_basis_mutation();
CREATE TRIGGER leaderboard_rollout_immutable
BEFORE UPDATE OR DELETE ON public.leaderboard_basis_rollout
FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_leaderboard_basis_mutation();
CREATE TRIGGER leaderboard_rollout_no_truncate
BEFORE TRUNCATE ON public.leaderboard_basis_rollout
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_refuse_leaderboard_basis_mutation();
CREATE TRIGGER leaderboard_existing_club_inventory_immutable
BEFORE INSERT OR UPDATE OR DELETE ON public.leaderboard_basis_existing_clubs
FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_leaderboard_basis_mutation();
CREATE TRIGGER leaderboard_existing_club_inventory_no_truncate
BEFORE TRUNCATE ON public.leaderboard_basis_existing_clubs
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_refuse_leaderboard_basis_mutation();
CREATE TRIGGER leaderboard_round_basis_receipt_immutable
BEFORE UPDATE OR DELETE ON public.leaderboard_round_basis_receipts
FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_leaderboard_basis_mutation();
CREATE TRIGGER leaderboard_round_basis_receipt_no_truncate
BEFORE TRUNCATE ON public.leaderboard_round_basis_receipts
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_refuse_leaderboard_basis_mutation();

ALTER TABLE public.leaderboard_complete_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leaderboard_capture_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leaderboard_basis_rollout ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leaderboard_basis_existing_clubs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leaderboard_round_basis_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.leaderboard_complete_captures,
  public.leaderboard_capture_counters, public.leaderboard_basis_rollout,
  public.leaderboard_basis_existing_clubs, public.leaderboard_round_basis_receipts
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_snapshot_player_stats()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
  v_date date := CURRENT_DATE;
  v_new_capture boolean;
  v_capture_at timestamptz;
BEGIN
  -- Serializes the existing producer's concurrent calls without locking stats
  -- writers. Statement MVCC reads the applied projection atomically.
  PERFORM pg_advisory_xact_lock(hashtextextended('leaderboard-capture:' || v_date::text, 0));
  SELECT NOT EXISTS (
    SELECT 1 FROM public.leaderboard_complete_captures WHERE capture_date = v_date
  ) INTO v_new_capture;
  v_capture_at := clock_timestamp();
  -- Shared legacy semantics remain CURRENT_DATE in the caller's timezone.
  -- Ranking boundaries are UTC dates and the actual scheduled producer is GMT.
  -- A first capture whose caller date disagrees with its actual UTC capture day
  -- cannot prove that boundary. Refuse before ANY legacy/capture write, without
  -- silently changing session timezone or relabeling shared snapshot dates.
  -- Equivalent-date non-UTC callers remain supported. Repeated legacy upserts
  -- retain their existing date/return contract and never replace a capture.
  IF v_new_capture AND v_date <> (v_capture_at AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'LEADERBOARD_CAPTURE_DATE_CONTRACT_MISMATCH';
  END IF;

  WITH applied AS MATERIALIZED (
    SELECT user_id, club_id,
      COALESCE(hands_played, 0) AS hands_played,
      COALESCE(hands_dealt, 0) AS hands_dealt,
      COALESCE(sum_big_blind, 0) AS sum_big_blind,
      COALESCE(total_winnings, 0) AS total_winnings,
      COALESCE(total_losses, 0) AS total_losses,
      COALESCE(total_rake, 0) AS total_rake,
      COALESCE(tournaments_played, 0) AS tournaments_played,
      COALESCE(tournaments_won, 0) AS tournaments_won
    FROM public.player_stats WHERE club_id IS NOT NULL
  ), legacy AS (
    INSERT INTO public.player_stats_snapshots
      (user_id, club_id, snapshot_date, hands_played, hands_dealt, sum_big_blind,
       total_winnings, total_losses, total_rake, tournaments_played, tournaments_won)
    SELECT user_id, club_id, v_date, hands_played, hands_dealt, sum_big_blind,
      total_winnings, total_losses, total_rake, tournaments_played, tournaments_won
    FROM applied
    ON CONFLICT (user_id, club_id, snapshot_date) DO UPDATE SET
      hands_played = EXCLUDED.hands_played, hands_dealt = EXCLUDED.hands_dealt,
      sum_big_blind = EXCLUDED.sum_big_blind,
      total_winnings = EXCLUDED.total_winnings, total_losses = EXCLUDED.total_losses,
      total_rake = EXCLUDED.total_rake, tournaments_played = EXCLUDED.tournaments_played,
      tournaments_won = EXCLUDED.tournaments_won
    RETURNING 1
  ), header AS (
    INSERT INTO public.leaderboard_complete_captures
      (capture_date, captured_at, capture_timezone, origin, source_contract,
       row_count, counter_hash, complete)
    SELECT v_date, v_capture_at, current_setting('TimeZone'),
      'fn_snapshot_player_stats', 'applied_player_stats_v1', count(*),
      md5(COALESCE(string_agg(to_jsonb(applied)::text, E'\n' ORDER BY club_id, user_id), '')), true
    FROM applied HAVING v_new_capture
    RETURNING capture_date
  ), immutable AS (
    INSERT INTO public.leaderboard_capture_counters
      (snapshot_date, user_id, club_id, hands_played, hands_dealt, sum_big_blind,
       total_winnings, total_losses, total_rake, tournaments_played, tournaments_won)
    SELECT header.capture_date, applied.* FROM applied CROSS JOIN header
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM legacy;
  -- Same public return keys and legacy row count on repeated calls. Immutable
  -- copies are first-complete-capture only; later calls still update shared rows.
  RETURN jsonb_build_object('success', true, 'rows', v_count, 'date', v_date);
END;
$function$;

CREATE FUNCTION public.fn_leaderboard_complete_round_basis(
  p_club_id uuid, p_period text, p_start date, p_end date
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $body$
DECLARE
  v_cutoff date;
  v_open public.leaderboard_complete_captures%ROWTYPE;
  v_close public.leaderboard_complete_captures%ROWTYPE;
  v_count bigint;
  v_hash text;
  v_rows jsonb;
  v_capture public.leaderboard_complete_captures%ROWTYPE;
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
  RETURN jsonb_build_object('basis_version', 'complete_capture_v2', 'complete', true,
    'source_contract', 'applied_player_stats_v1', 'club_id', p_club_id,
    'opening_date', p_start, 'closing_date', p_end,
    'opening_captured_at', v_open.captured_at, 'closing_captured_at', v_close.captured_at,
    'opening_hash', v_open.counter_hash, 'closing_hash', v_close.counter_hash,
    'rows', v_rows);
END;
$body$;

REVOKE ALL ON FUNCTION public.fn_refuse_leaderboard_basis_mutation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_leaderboard_complete_round_basis(uuid, text, date, date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_leaderboard_complete_round_basis(uuid, text, date, date) TO service_role;
-- CREATE OR REPLACE preserves producer owner/ACL; qualify exact postgres owner,
-- SECURITY DEFINER/search_path and postgres+service-only execute before promotion.
-- No invocation here: rollout metadata does NOT seed a fabricated capture.
COMMIT;
