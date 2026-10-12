-- UNQUALIFIED consolidated candidate. Not reserved or installed.
BEGIN;
-- UNQUALIFIED SOURCE CANDIDATE. Not a reserved migration. DO NOT execute on source.
-- Root must qualify this on the faithful disposable schema before integration.
-- No payout, wallet, program, existing batch, cron command or schedule is changed.
-- Installed predecessor: producer prosrc MD5 958a10d01583508e525523fc17a6cda1.
-- Applied stats, not accepted-hand reconstruction; preserve existing daily product.
-- The first existing producer invocation is the origin. This does NOT prove that
-- invocation was pg_cron rather than an authorized direct/recovery invocation.
-- Record actual time and timezone, never synthesize a midnight capture time.
-- Future payout/ranking consumers still require separately qualified integration.
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

-- UNQUALIFIED source proposal; no migration version or runtime proof.
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_club_leaderboard_by_dates(uuid,text,date,date,integer,integer)')
    AND md5(p.prosrc)='00824a10870941337666dea8adcaa39c' AND md5(pg_get_functiondef(p.oid))='b0efe3c4e9f3f7aac7c6cf9a6985ea6c'
    AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
    AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
    AND (SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END||':'||a.privilege_type,',' ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END||':'||a.privilege_type) FROM aclexplode(p.proacl) a)='authenticated:EXECUTE,postgres:EXECUTE,service_role:EXECUTE') THEN
    RAISE EXCEPTION 'Exact club ranking predecessor drift';
  END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_club_leaderboard_by_dates(
  p_club_id uuid,
  p_metric text DEFAULT 'profit'::text,
  p_start_date date DEFAULT NULL::date,
  p_end_date date DEFAULT NULL::date,
  p_limit integer DEFAULT 10,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  user_id uuid, hands_played numeric, total_winnings numeric, total_losses numeric,
  tournaments_won numeric, total_rake numeric, sum_big_blind numeric,
  rank_change integer, qualified boolean, rank integer, total_ranked integer,
  baseline_date date
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_today date := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date;
  v_start date := COALESCE(p_start_date, v_today - 7);
  v_end date := COALESCE(p_end_date, v_today);
  v_span integer;
  v_baseline date;
  v_end_snap date;
  v_prev_start date;
  v_use_live boolean;
  v_min_hands integer := 20;
  v_period text;
  v_basis jsonb;
  v_previous jsonb;
  v_previous_start date;
BEGIN
  -- Only closed canonical product rounds can select prospective V2.
  IF v_end <= v_today AND EXTRACT(DOW FROM v_start)=0 AND v_end=v_start+7 THEN
    v_period:='weekly';
  ELSIF v_end <= v_today AND EXTRACT(DAY FROM v_start)=1 AND v_end=(v_start+interval '1 month')::date THEN
    v_period:='monthly';
  END IF;
  IF v_period IS NOT NULL THEN
    v_basis:=public.fn_leaderboard_complete_round_basis(p_club_id,v_period,v_start,v_end);
    IF v_basis->>'basis_version'='complete_capture_v2' AND v_basis->'complete'='true'::jsonb THEN
      v_previous_start:=CASE v_period WHEN 'weekly' THEN v_start-7 ELSE (v_start-interval '1 month')::date END;
      BEGIN
        v_previous:=public.fn_leaderboard_complete_round_basis(p_club_id,v_period,v_previous_start,v_start);
        IF v_previous->>'basis_version'<>'complete_capture_v2' OR v_previous->'complete'<>'true'::jsonb THEN v_previous:=NULL; END IF;
      EXCEPTION WHEN SQLSTATE '55000' THEN
        -- Only genuinely unavailable previous complete capture means unknown.
        IF SQLERRM='LEADERBOARD_CAPTURE_UNAVAILABLE' THEN v_previous:=NULL; ELSE RAISE; END IF;
      END;
      RETURN QUERY
      WITH inputs AS (
        SELECT false AS previous,d.* FROM jsonb_to_recordset(v_basis->'rows') AS d(
          user_id uuid,hands_played numeric,total_winnings numeric,total_losses numeric,
          tournaments_won numeric,total_rake numeric,sum_big_blind numeric)
        UNION ALL
        SELECT true AS previous,d.* FROM jsonb_to_recordset(COALESCE(v_previous->'rows','[]'::jsonb)) AS d(
          user_id uuid,hands_played numeric,total_winnings numeric,total_losses numeric,
          tournaments_won numeric,total_rake numeric,sum_big_blind numeric)
      ), scored AS (
        SELECT d.*,CASE p_metric
          WHEN 'hands_played' THEN d.hands_played
          WHEN 'tournaments_won' THEN d.tournaments_won
          WHEN 'roi' THEN CASE WHEN d.total_losses>0 AND d.hands_played>=v_min_hands THEN (d.total_winnings-d.total_losses)/d.total_losses END
          WHEN 'bb100' THEN CASE WHEN d.sum_big_blind>0 AND d.hands_played>=v_min_hands THEN 100*(d.total_winnings-d.total_losses)/d.sum_big_blind END
          ELSE d.total_winnings-d.total_losses END AS score
        FROM inputs d
      ), ranked AS (
        SELECT s.*,rank() OVER(PARTITION BY s.previous ORDER BY s.score DESC NULLS LAST)::integer AS position,
          row_number() OVER(PARTITION BY s.previous ORDER BY s.score DESC NULLS LAST,s.user_id) AS ordinal,
          count(*) OVER(PARTITION BY s.previous)::integer AS total
        FROM scored s WHERE (s.hands_played>0 OR s.tournaments_won>0 OR s.total_winnings<>0 OR s.total_losses<>0)
      )
      SELECT r.user_id,r.hands_played,r.total_winnings,r.total_losses,r.tournaments_won,r.total_rake,r.sum_big_blind,
        CASE WHEN v_previous IS NULL OR old.score IS NULL THEN NULL ELSE old.position-r.position END,
        (p_metric NOT IN('roi','bb100') OR (r.hands_played>=v_min_hands AND
          (CASE WHEN p_metric='roi' THEN r.total_losses ELSE r.sum_big_blind END)>0)),
        r.position,r.total,v_start
      FROM ranked r LEFT JOIN ranked old ON old.previous AND old.user_id=r.user_id
      WHERE NOT r.previous ORDER BY r.ordinal LIMIT p_limit OFFSET GREATEST(COALESCE(p_offset,0),0);
      RETURN;
    ELSIF v_basis->>'basis_version' IS DISTINCT FROM 'legacy_v1' THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='LEADERBOARD_COMPLETE_BASIS_REQUIRED';
    END IF;
  END IF;
  IF v_end < v_start THEN
    RAISE EXCEPTION 'end date % precedes start date %', v_end, v_start
      USING ERRCODE = '22023';
  END IF;
  v_span := GREATEST(v_end - v_start, 1);

  SELECT max(snapshot_date) INTO v_baseline
    FROM public.player_stats_snapshots
   WHERE club_id = p_club_id AND snapshot_date <= v_start;

  -- end_date is exclusive. A window ending today closed at 00:00 UTC and must
  -- not consume today's mutable totals.
  v_use_live := (v_end > v_today);
  IF NOT v_use_live THEN
    SELECT max(snapshot_date) INTO v_end_snap
      FROM public.player_stats_snapshots
     WHERE club_id = p_club_id AND snapshot_date <= v_end;
    IF v_end_snap IS NULL OR (v_baseline IS NOT NULL AND v_end_snap <= v_baseline) THEN
      RETURN;
    END IF;
  END IF;

  SELECT max(snapshot_date) INTO v_prev_start
    FROM public.player_stats_snapshots
   WHERE club_id = p_club_id AND snapshot_date <= v_start - v_span;

  RETURN QUERY
  WITH end_s AS (
    SELECT ps.user_id AS uid, ps.hands_dealt::numeric AS h,
           ps.total_winnings AS w, ps.total_losses AS l,
           ps.tournaments_won::numeric AS t, ps.total_rake AS rk,
           ps.sum_big_blind AS bb
      FROM public.player_stats ps
     WHERE v_use_live AND ps.club_id = p_club_id
    UNION ALL
    SELECT s.user_id, s.hands_dealt::numeric, s.total_winnings, s.total_losses,
           s.tournaments_won::numeric, s.total_rake, s.sum_big_blind
      FROM public.player_stats_snapshots s
     WHERE NOT v_use_live AND s.club_id = p_club_id AND s.snapshot_date = v_end_snap
  ),
  base_s AS (
    SELECT s.user_id AS uid, s.hands_dealt::numeric AS h,
           s.total_winnings AS w, s.total_losses AS l,
           s.tournaments_won::numeric AS t, s.total_rake AS rk,
           s.sum_big_blind AS bb
      FROM public.player_stats_snapshots s
     WHERE s.club_id = p_club_id
       AND v_baseline IS NOT NULL
       AND s.snapshot_date = v_baseline
  ),
  prev_s AS (
    SELECT s.user_id AS uid, s.hands_dealt::numeric AS h,
           s.total_winnings AS w, s.total_losses AS l,
           s.tournaments_won::numeric AS t, s.sum_big_blind AS bb
      FROM public.player_stats_snapshots s
     WHERE s.club_id = p_club_id
       AND v_prev_start IS NOT NULL
       AND s.snapshot_date = v_prev_start
  ),
  cur AS (
    SELECT e.uid,
           GREATEST(e.h - COALESCE(b.h, 0), 0) AS d_hands,
           e.w - COALESCE(b.w, 0) AS d_win,
           e.l - COALESCE(b.l, 0) AS d_loss,
           GREATEST(e.t - COALESCE(b.t, 0), 0) AS d_twon,
           GREATEST(e.rk - COALESCE(b.rk, 0), 0) AS d_rake,
           GREATEST(e.bb - COALESCE(b.bb, 0), 0) AS d_bb,
           CASE WHEN b.uid IS NULL THEN NULL ELSE GREATEST(b.h - COALESCE(p.h, 0), 0) END AS p_hands,
           CASE WHEN b.uid IS NULL THEN NULL ELSE b.w - COALESCE(p.w, 0) END AS p_win,
           CASE WHEN b.uid IS NULL THEN NULL ELSE b.l - COALESCE(p.l, 0) END AS p_loss,
           CASE WHEN b.uid IS NULL THEN NULL ELSE GREATEST(b.t - COALESCE(p.t, 0), 0) END AS p_twon,
           CASE WHEN b.uid IS NULL THEN NULL ELSE GREATEST(b.bb - COALESCE(p.bb, 0), 0) END AS p_bb
      FROM end_s e
      LEFT JOIN base_s b ON b.uid = e.uid
      LEFT JOIN prev_s p ON p.uid = e.uid
  ),
  scored AS (
    SELECT c.*,
           CASE p_metric
             WHEN 'hands_played' THEN c.d_hands
             WHEN 'tournaments_won' THEN c.d_twon
             WHEN 'roi' THEN CASE WHEN c.d_loss > 0 AND c.d_hands >= v_min_hands
                                  THEN (c.d_win-c.d_loss)/c.d_loss END
             WHEN 'bb100' THEN CASE WHEN c.d_bb > 0 AND c.d_hands >= v_min_hands
                                    THEN 100*(c.d_win-c.d_loss)/c.d_bb END
             ELSE c.d_win-c.d_loss
           END AS score,
           CASE p_metric
             WHEN 'hands_played' THEN c.p_hands
             WHEN 'tournaments_won' THEN c.p_twon
             WHEN 'roi' THEN CASE WHEN c.p_loss > 0 AND c.p_hands >= v_min_hands
                                  THEN (c.p_win-c.p_loss)/c.p_loss END
             WHEN 'bb100' THEN CASE WHEN c.p_bb > 0 AND c.p_hands >= v_min_hands
                                    THEN 100*(c.p_win-c.p_loss)/c.p_bb END
             ELSE c.p_win-c.p_loss
           END AS prev_score
      FROM cur c
  ),
  ranked AS (
    SELECT s.*,
           row_number() OVER (ORDER BY s.score DESC NULLS LAST, s.uid) AS rn_now,
           rank() OVER (ORDER BY s.score DESC NULLS LAST) AS rk_now,
           count(*) OVER () AS total_active,
           CASE WHEN s.prev_score IS NULL THEN NULL
                ELSE rank() OVER (ORDER BY s.prev_score DESC NULLS LAST) END AS rk_old
      FROM scored s
     WHERE (s.d_hands > 0 OR s.d_twon > 0 OR s.d_win <> 0 OR s.d_loss <> 0)
  )
  SELECT r.uid, r.d_hands, r.d_win, r.d_loss, r.d_twon, r.d_rake, r.d_bb,
         COALESCE((r.rk_old - r.rk_now)::integer, 0),
         (p_metric NOT IN ('roi','bb100') OR
          (r.d_hands >= v_min_hands AND
           (CASE WHEN p_metric='roi' THEN r.d_loss ELSE r.d_bb END) > 0)),
         r.rk_now::integer, r.total_active::integer, v_baseline
    FROM ranked r
   ORDER BY r.rn_now
   LIMIT p_limit OFFSET GREATEST(COALESCE(p_offset,0),0);
END;
$function$;

-- UNQUALIFIED disposable-only proposal; no migration version or installation.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_payout_leaderboard(uuid,text,text,timestamptz,timestamptz)')
    AND md5(p.prosrc)='2ba8db49240eac826b2f3efe0e262648'
    AND md5(pg_get_functiondef(p.oid))='42b7add95575407dcc35229c3741bd4f'
    AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
    AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
    AND (SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ',' ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type) FROM aclexplode(p.proacl) a)='postgres:EXECUTE,service_role:EXECUTE') THEN
    RAISE EXCEPTION 'Exact payout predecessor security/body drift';
  END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_payout_leaderboard(
  p_club_id uuid,
  p_period text,
  p_metric text,
  p_start_date timestamptz,
  p_end_date timestamptz
)
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
      'total_paid', v_existing.total_paid,
      'seed_funded', v_existing.seed_funded,
      'promo_funded', v_existing.promo_funded,
      'overlay_funded', v_existing.overlay_funded,
      'winner_count', v_existing.winner_count,
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
$function$;
-- CREATE OR REPLACE retains existing ownership and execute ACL.

-- UNQUALIFIED proposal; no installed migration version.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN

  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_enforce_leaderboard_program_funding()')
    AND md5(p.prosrc)='82d95908883bb20269653a348eae124e' AND md5(pg_get_functiondef(p.oid))='5e9daeca352e313dfd03ff960e5316b4'
    AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
    AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
    AND (SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ',' ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type) FROM aclexplode(p.proacl) a)='postgres:EXECUTE,service_role:EXECUTE') THEN
    RAISE EXCEPTION 'Exact Promo configuration predecessor drift';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_publish_leaderboard_reward_program(uuid,boolean,text,jsonb,jsonb,text,integer,uuid,boolean)')
    AND md5(p.prosrc)='ef4ab9935eb3681ba4f1ab068a8b65fd' AND md5(pg_get_functiondef(p.oid))='897cb1df3bb6cf38e2bb4847f3658c43'
    AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
    AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
    AND (SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ',' ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type) FROM aclexplode(p.proacl) a)='postgres:EXECUTE,service_role:EXECUTE') THEN
    RAISE EXCEPTION 'Exact Promo configuration predecessor drift';
  END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_enforce_leaderboard_program_funding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_balance numeric := 0;
  v_other_commitments numeric := 0;
  v_requested_commitment numeric := 0;
BEGIN
  v_requested_commitment := public.fn_leaderboard_program_commitment(
    NEW.rewards_enabled,
    NEW.weekly_prizes,
    NEW.monthly_prizes
  );

  IF NOT NEW.rewards_enabled THEN
    RETURN NEW;
  END IF;

  IF NEW.funding_owner_type = 'union' THEN
    IF NEW.funding_union_id IS NULL THEN
      RAISE EXCEPTION 'A Union-Funded Leaderboard Requires A Funding Union'
        USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(wallet.promo_wallet, 0)
      INTO v_balance
      FROM public.union_wallets wallet
     WHERE wallet.union_id = NEW.funding_union_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Leaderboard Funding Union Has No Promo Wallet'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.funding_owner_type = 'club' THEN
    IF NEW.funding_union_id IS NOT NULL THEN
      RAISE EXCEPTION 'A Standalone Club Leaderboard Cannot Name A Funding Union'
        USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(club.promo_balance, 0)
      INTO v_balance
      FROM public.clubs club
     WHERE club.id = NEW.club_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002';
    END IF;

    -- Only the actual Promo Wallet contributes publication capacity.
  ELSE
    RAISE EXCEPTION 'Leaderboard Funding Owner Must Be A Union Or Club'
      USING ERRCODE = '23514';
  END IF;

  WITH latest AS MATERIALIZED (
    SELECT DISTINCT ON (program.club_id)
      program.club_id,
      program.rewards_enabled,
      program.weekly_prizes,
      program.monthly_prizes,
      program.funding_owner_type,
      program.funding_union_id
    FROM public.leaderboard_reward_program_versions program
    WHERE program.club_id <> NEW.club_id
    ORDER BY program.club_id, program.version DESC
  )
  SELECT COALESCE(sum(public.fn_leaderboard_program_commitment(
    latest.rewards_enabled,
    latest.weekly_prizes,
    latest.monthly_prizes
  )), 0)
  INTO v_other_commitments
  FROM latest
  WHERE NEW.funding_owner_type = 'union'
    AND latest.funding_owner_type = 'union'
    AND latest.funding_union_id = NEW.funding_union_id;

  IF v_requested_commitment + v_other_commitments > v_balance THEN
    RAISE EXCEPTION
      'Leaderboard Prize Program Requires % Promo Chips But Only % Are Available After Other Published Commitments',
      round(v_requested_commitment, 2),
      round(GREATEST(v_balance - v_other_commitments, 0), 2)
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_publish_leaderboard_reward_program(
  p_club_id uuid,
  p_rewards_enabled boolean,
  p_metric text,
  p_weekly_prizes jsonb,
  p_monthly_prizes jsonb,
  p_suggestion_key text,
  p_expected_version integer,
  p_operation_id uuid,
  p_overlay_enabled boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_club record;
  v_union_id uuid;
  v_can_manage boolean := false;
  v_current_version integer;
  v_previous_id uuid;
  v_existing public.leaderboard_reward_program_versions%ROWTYPE;
  v_weekly_effective date;
  v_monthly_effective date;
  v_next_version integer;
  v_hash text;
  v_requested_hash text;
  v_overlay boolean := COALESCE(p_overlay_enabled, false);
  v_overlay_terms jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not Authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'A Publication Retry Key Is Required' USING ERRCODE = '22023';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 0 THEN
    RAISE EXCEPTION 'A Valid Current Program Version Is Required' USING ERRCODE = '22023';
  END IF;

  SELECT club.id, club.owner_id INTO v_club
    FROM public.clubs club WHERE club.id = p_club_id FOR UPDATE;
  IF v_club.id IS NULL THEN
    RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002';
  END IF;

  v_union_id := public.fn_leaderboard_funding_union_id(p_club_id);
  IF v_union_id IS NOT NULL THEN
    v_can_manage := public.fn_union_can_manage_wallets(v_union_id, v_actor);
  ELSE
    v_can_manage := v_club.owner_id = v_actor OR EXISTS (
      SELECT 1 FROM public.club_members member
       WHERE member.club_id = p_club_id
         AND member.user_id = v_actor
         AND member.role IN ('owner', 'co_owner')
         AND COALESCE(member.status, 'active') IN ('active', 'approved')
    );
  END IF;
  IF NOT v_can_manage THEN
    RAISE EXCEPTION 'Only The Funding Owner Can Manage Leaderboard Rewards'
      USING ERRCODE = '42501';
  END IF;

  IF p_metric NOT IN ('profit', 'hands_played', 'tournaments_won', 'roi') THEN
    RAISE EXCEPTION 'Choose A Supported Prize Metric' USING ERRCODE = '22023';
  END IF;
  IF p_suggestion_key NOT IN ('balanced', 'top_heavy', 'even', 'custom') THEN
    RAISE EXCEPTION 'Choose A Supported Prize Plan' USING ERRCODE = '22023';
  END IF;
  IF NOT public.fn_leaderboard_prizes_are_valid(COALESCE(p_weekly_prizes, '[]'::jsonb))
     OR NOT public.fn_leaderboard_prizes_are_valid(COALESCE(p_monthly_prizes, '[]'::jsonb)) THEN
    RAISE EXCEPTION 'Prize Rows Must Use Unique Ranks 1 Through 10 And Positive Amounts With At Most Two Decimals'
      USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_rewards_enabled, false)
     AND jsonb_array_length(COALESCE(p_weekly_prizes, '[]'::jsonb)) = 0
     AND jsonb_array_length(COALESCE(p_monthly_prizes, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Add A Weekly Or Monthly Prize Before Enabling Rewards'
      USING ERRCODE = '22023';
  END IF;

  -- THE CLUB BANK OVERLAY IS AN EXPLICIT, PER-PROGRAM OWNER OPT-IN (2026-09-23).
  -- OFF unless the caller says ON. It exists only on a paid standalone club
  -- program: a union's programs are paid by the union Promo Wallet alone and
  -- never by any bank.
  IF v_overlay AND NOT COALESCE(p_rewards_enabled, false) THEN
    RAISE EXCEPTION 'A Club Bank Overlay Needs A Paid Leaderboard' USING ERRCODE = '22023';
  END IF;
  IF v_overlay AND v_union_id IS NOT NULL THEN
    RAISE EXCEPTION 'A Club Bank Overlay Is Only Available To A Standalone Club'
      USING ERRCODE = '22023';
  END IF;
  -- The opt-in joins the hashed program terms only when it is ON, so every
  -- program without it hashes exactly as before, and a retry that changes the
  -- answer is refused as a different program.
  v_overlay_terms := CASE WHEN v_overlay
    THEN jsonb_build_object('overlay_enabled', true) ELSE '{}'::jsonb END;

  SELECT existing.* INTO v_existing
    FROM public.leaderboard_reward_program_versions existing
   WHERE existing.club_id = p_club_id
     AND existing.operation_id = p_operation_id;
  IF v_existing.id IS NOT NULL THEN
    v_requested_hash := md5((jsonb_build_object(
      'club_id', p_club_id,
      'version', v_existing.version,
      'rewards_enabled', COALESCE(p_rewards_enabled, false),
      'payout_metric', p_metric,
      'weekly_prizes', COALESCE(p_weekly_prizes, '[]'::jsonb),
      'monthly_prizes', COALESCE(p_monthly_prizes, '[]'::jsonb),
      'funding_owner_type', CASE WHEN v_union_id IS NULL THEN 'club' ELSE 'union' END,
      'funding_union_id', v_union_id,
      'weekly_effective_from', v_existing.weekly_effective_from,
      'monthly_effective_from', v_existing.monthly_effective_from
    ) || v_overlay_terms)::text);
    IF v_existing.program_hash <> v_requested_hash
       OR v_existing.suggestion_key <> p_suggestion_key
       OR v_existing.version <> p_expected_version + 1 THEN
      RAISE EXCEPTION 'Leaderboard Publication Retry Key Was Reused For Different Prize Rules'
        USING ERRCODE = '22023';
    END IF;
    RETURN public.fn_get_leaderboard_reward_setup(p_club_id) || jsonb_build_object(
      'rewards_enabled', v_existing.rewards_enabled,
      'payout_metric', v_existing.payout_metric,
      'weekly_prizes', v_existing.weekly_prizes,
      'monthly_prizes', v_existing.monthly_prizes,
      'suggestion_key', v_existing.suggestion_key,
      'program_version', v_existing.version,
      'program_hash', v_existing.program_hash,
      'program_status', v_existing.status,
      'weekly_effective_from', v_existing.weekly_effective_from,
      'monthly_effective_from', v_existing.monthly_effective_from,
      'published_at', v_existing.published_at,
      'program_funding_owner_type', v_existing.funding_owner_type,
      'program_funding_union_id', v_existing.funding_union_id,
      'overlay_enabled', v_existing.overlay_enabled,
      'program_funding_label', CASE
        WHEN v_existing.funding_owner_type = 'union' THEN COALESCE(
          (SELECT union_row.name FROM public.unions union_row
            WHERE union_row.id = v_existing.funding_union_id),
          'Recorded Union'
        ) || ' Promo Wallet'
        ELSE (SELECT club.name FROM public.clubs club WHERE club.id = p_club_id)
             || ' Promo Wallet'
      END
    );
  END IF;

  -- Exact historical operation replay above never creates a new program.
  -- Preserve that immutable response; refuse overlays for new publications.
  IF COALESCE(p_overlay_enabled, false) THEN
    RAISE EXCEPTION 'LEADERBOARD_PROMO_ONLY|Club Bank Overlay Is Not Allowed For Leaderboard Prizes'
      USING ERRCODE = '22023';
  END IF;

  SELECT program.version, program.id INTO v_current_version, v_previous_id
    FROM public.leaderboard_reward_program_versions program
   WHERE program.club_id = p_club_id
   ORDER BY program.version DESC
   LIMIT 1;
  v_current_version := COALESCE(v_current_version, 0);
  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'Leaderboard Prize Setup Changed In Another Session'
      USING ERRCODE = '40001',
            DETAIL = format('Expected Version %s But Found Version %s',
                            p_expected_version, v_current_version);
  END IF;

  SELECT bounds.end_date INTO v_weekly_effective
    FROM public.fn_leaderboard_period_window('weekly', 0) bounds;
  SELECT bounds.end_date INTO v_monthly_effective
    FROM public.fn_leaderboard_period_window('monthly', 0) bounds;
  v_next_version := v_current_version + 1;
  v_hash := md5((jsonb_build_object(
    'club_id', p_club_id,
    'version', v_next_version,
    'rewards_enabled', COALESCE(p_rewards_enabled, false),
    'payout_metric', p_metric,
    'weekly_prizes', COALESCE(p_weekly_prizes, '[]'::jsonb),
    'monthly_prizes', COALESCE(p_monthly_prizes, '[]'::jsonb),
    'funding_owner_type', CASE WHEN v_union_id IS NULL THEN 'club' ELSE 'union' END,
    'funding_union_id', v_union_id,
    'weekly_effective_from', v_weekly_effective,
    'monthly_effective_from', v_monthly_effective
  ) || v_overlay_terms)::text);

  INSERT INTO public.leaderboard_reward_program_versions (
    club_id, version, operation_id, rewards_enabled, payout_metric,
    weekly_prizes, monthly_prizes, suggestion_key,
    funding_owner_type, funding_union_id,
    weekly_effective_from, monthly_effective_from,
    published_by, supersedes_program_id, program_hash, overlay_enabled
  ) VALUES (
    p_club_id, v_next_version, p_operation_id, COALESCE(p_rewards_enabled, false), p_metric,
    COALESCE(p_weekly_prizes, '[]'::jsonb), COALESCE(p_monthly_prizes, '[]'::jsonb),
    p_suggestion_key, CASE WHEN v_union_id IS NULL THEN 'club' ELSE 'union' END, v_union_id,
    v_weekly_effective, v_monthly_effective, v_actor, v_previous_id, v_hash, v_overlay
  );

  INSERT INTO public.club_leaderboard_settings (
    club_id, payout_currency, weekly_prizes, monthly_prizes,
    rewards_enabled, payout_metric, funding_owner_type, funding_union_id,
    suggestion_key, setup_completed_at, setup_completed_by, updated_by, updated_at
  ) VALUES (
    p_club_id, 'chips', COALESCE(p_weekly_prizes, '[]'::jsonb),
    COALESCE(p_monthly_prizes, '[]'::jsonb), COALESCE(p_rewards_enabled, false),
    p_metric, CASE WHEN v_union_id IS NULL THEN 'club' ELSE 'union' END, v_union_id,
    p_suggestion_key, now(), v_actor, v_actor, now()
  )
  ON CONFLICT (club_id) DO UPDATE SET
    payout_currency = EXCLUDED.payout_currency,
    weekly_prizes = EXCLUDED.weekly_prizes,
    monthly_prizes = EXCLUDED.monthly_prizes,
    rewards_enabled = EXCLUDED.rewards_enabled,
    payout_metric = EXCLUDED.payout_metric,
    funding_owner_type = EXCLUDED.funding_owner_type,
    funding_union_id = EXCLUDED.funding_union_id,
    suggestion_key = EXCLUDED.suggestion_key,
    setup_completed_at = COALESCE(public.club_leaderboard_settings.setup_completed_at, now()),
    setup_completed_by = COALESCE(public.club_leaderboard_settings.setup_completed_by, v_actor),
    updated_by = v_actor,
    updated_at = now();

  RETURN public.fn_get_leaderboard_reward_setup(p_club_id);
END;
$function$;
-- CREATE OR REPLACE retains original owners and execute ACLs.

-- UNQUALIFIED proposal; no installed migration version.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric,boolean)')
    AND md5(p.prosrc)='578960fee3c325b9c724e976bed968f4'
    AND md5(pg_get_functiondef(p.oid))='2c731edde57e2ec7d867108a3caf64fb'
    AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
    AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
    AND (SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ',' ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type) FROM aclexplode(p.proacl) a)='authenticated:EXECUTE,postgres:EXECUTE,service_role:EXECUTE') THEN
    RAISE EXCEPTION 'Exact opening setup predecessor drift';
  END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_complete_club_opening_setup(
  p_club_id uuid,
  p_operation_id uuid,
  p_tagline text,
  p_rake_percent numeric,
  p_rake_cap_bb numeric,
  p_bbj_enabled boolean,
  p_bbj_seed numeric,
  p_spins_enabled boolean,
  p_spin_seed numeric,
  p_spin_max_stake numeric,
  p_promo_enabled boolean,
  p_promo_type text,
  p_promo_name text,
  p_promo_description text,
  p_promo_budget numeric,
  p_leaderboard_rewards_enabled boolean,
  p_leaderboard_metric text,
  p_leaderboard_prize_budget numeric,
  p_leaderboard_overlay_enabled boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_club public.clubs%ROWTYPE;
  v_existing public.club_opening_setups%ROWTYPE;
  v_rake numeric := round(COALESCE(p_rake_percent, -1), 2);
  v_cap numeric := round(COALESCE(p_rake_cap_bb, -1), 2);
  v_bbj_seed numeric := round(COALESCE(p_bbj_seed, 0), 2);
  v_spin_seed numeric := round(COALESCE(p_spin_seed, 0), 2);
  v_promo_budget numeric := round(COALESCE(p_promo_budget, 0), 2);
  v_leaderboard_budget numeric := round(COALESCE(p_leaderboard_prize_budget, 0), 2);
  v_spin_required numeric := 0;
  v_other_allocation numeric := 0;
  v_total_allocation numeric := 0;
  v_spin_result jsonb := '{}'::jsonb;
  v_pool_id uuid;
  v_bbj_after numeric := 0;
  v_promo_after numeric := 0;
  v_promotion_id uuid;
  v_leaderboard_result jsonb := '{}'::jsonb;
  v_program_version integer := 0;
  v_leaderboard_overlay boolean := COALESCE(p_leaderboard_rewards_enabled, false)
    AND COALESCE(p_leaderboard_overlay_enabled, false);
  v_bank_after numeric := 0;
  v_result jsonb;
  v_tagline text := left(regexp_replace(btrim(COALESCE(p_tagline, '')), '\s+', ' ', 'g'), 72);
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication Required';
  END IF;
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'Operation ID Is Required';
  END IF;

  SELECT * INTO v_club FROM public.clubs WHERE id = p_club_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Club Not Found';
  END IF;

  -- ONLY THE OWNER CAN COMPLETE IT, AND EVERYONE ELSE IS REFUSED HERE
  -- (2026-09-23). Every setup publishes a leaderboard program, and
  -- publication accepts only the club's owner or co-owner. The
  -- platform-admin branch that used to pass this check could never commit:
  -- it activated Spins and debited the Club Bank, then the publish refused
  -- it with 42501 and rolled all of it back. A co-owner never passed here.
  -- The one actor who can complete the whole setup is the owner, so the
  -- owner is the rule, and the refusal comes before anything moves.
  IF v_club.owner_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only The Club Owner Can Complete Opening Setup'
      USING ERRCODE = '42501';
  END IF;
  IF COALESCE(v_club.is_union, false) OR v_club.union_id IS NOT NULL THEN
    RAISE EXCEPTION 'Union-Owned Economics Must Be Configured By The Union Lead';
  END IF;

  IF char_length(v_tagline) < 3 THEN
    RAISE EXCEPTION 'Write A Custom Club Tag Line Before Completing Setup';
  END IF;
  IF v_tagline ILIKE '%all fish of all shapes and sizes are welcome%'
     AND v_club.club_id <> 25450 THEN
    RAISE EXCEPTION 'That Tag Line Belongs To Shark Club';
  END IF;

  SELECT * INTO v_existing
  FROM public.club_opening_setups
  WHERE club_id = p_club_id
  FOR UPDATE;

  IF FOUND THEN
    v_result := jsonb_build_object(
      'success', true,
      'already_completed', true,
      'club_id', p_club_id,
      'club_bank_after', v_club.chip_treasury,
      'completed_at', v_existing.completed_at,
      'operation_id', v_existing.last_operation_id
    );
    RETURN v_result;
  END IF;

  IF COALESCE(p_leaderboard_overlay_enabled, false) THEN
    RAISE EXCEPTION 'LEADERBOARD_PROMO_ONLY|Club Bank Overlay Is Not Allowed For Leaderboard Prizes'
      USING ERRCODE = '22023';
  END IF;

  IF v_rake <> -1 AND (v_rake < 0 OR v_rake > 10) THEN
    RAISE EXCEPTION 'Rake Must Use The House Schedule Or Be Between 0 And 10 Percent';
  END IF;
  IF v_cap <> -1 AND (v_cap < 0 OR v_cap > 10) THEN
    RAISE EXCEPTION 'Rake Cap Must Use The House Schedule Or Be Between 0 And 10 Big Blinds';
  END IF;

  IF p_bbj_enabled AND v_bbj_seed < 100 THEN
    RAISE EXCEPTION 'BBJ Requires A Minimum 100-Chip Seed';
  END IF;
  IF NOT p_bbj_enabled THEN
    v_bbj_seed := 0;
  END IF;

  IF p_spins_enabled THEN
    IF p_spin_max_stake NOT IN (1, 2, 3, 5, 10, 20, 50, 100) THEN
      RAISE EXCEPTION 'Spin Maximum Stake Is Not A Supported Board Stake';
    END IF;
    v_spin_required := public.fn_spin_required_seed(p_spin_max_stake);
    IF v_spin_seed < GREATEST(100, v_spin_required) THEN
      RAISE EXCEPTION 'Spin Seed Must Be At Least % Chips For The Selected Board',
        GREATEST(100, v_spin_required);
    END IF;
  ELSE
    v_spin_seed := 0;
  END IF;

  IF p_promo_enabled THEN
    IF p_promo_type NOT IN ('leaderboard', 'rake_race', 'milestone', 'mystery', 'high_hand') THEN
      RAISE EXCEPTION 'Promotion Type Is Not Supported';
    END IF;
    IF length(btrim(COALESCE(p_promo_name, ''))) < 3 THEN
      RAISE EXCEPTION 'Promotion Name Must Be At Least 3 Characters';
    END IF;
    IF v_promo_budget < 100 THEN
      RAISE EXCEPTION 'A New Promotion Requires A Minimum 100-Chip Budget';
    END IF;
  ELSE
    v_promo_budget := 0;
  END IF;

  IF p_leaderboard_metric NOT IN ('profit', 'hands_played', 'tournaments_won', 'roi') THEN
    RAISE EXCEPTION 'Leaderboard Metric Is Not Supported';
  END IF;
  IF p_leaderboard_rewards_enabled THEN
    IF v_leaderboard_budget < 100 THEN
      RAISE EXCEPTION 'A Prize Leaderboard Requires A Minimum 100-Chip Budget';
    END IF;
  ELSE
    v_leaderboard_budget := 0;
  END IF;

  v_other_allocation := v_bbj_seed + v_promo_budget + v_leaderboard_budget;
  v_total_allocation := v_other_allocation + v_spin_seed;
  IF COALESCE(v_club.chip_treasury, 0) < v_total_allocation THEN
    RAISE EXCEPTION 'Club Bank Has % Chips But Setup Requires %',
      COALESCE(v_club.chip_treasury, 0), v_total_allocation;
  END IF;

  -- Spin activation owns its wallet debit, reserve credit, repayment metadata,
  -- and reserve ledger. Calling it inside this function keeps all setup steps
  -- in the same database transaction.
  IF p_spins_enabled THEN
    v_spin_result := public.fn_spin_activate(
      p_club_id,
      v_spin_seed,
      p_spin_max_stake,
      'chip_treasury',
      v_actor
    );
    IF NOT COALESCE((v_spin_result ->> 'ok')::boolean, false) THEN
      RAISE EXCEPTION 'Spin Setup Failed: %', COALESCE(v_spin_result ->> 'reason', 'Unknown Reason');
    END IF;

    INSERT INTO public.club_opening_setup_funding
      (club_id, operation_id, destination, amount, balance_after, created_by)
    VALUES (
      p_club_id, p_operation_id, 'spin_reserve', v_spin_seed,
      COALESCE((v_spin_result ->> 'balance')::numeric, v_spin_seed), v_actor
    );
  END IF;

  PERFORM set_config('app.ledger_category', 'club_opening_allocation', true);
  PERFORM set_config('app.ledger_counterparty', 'opening_setup', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_club_id::text, true);

  UPDATE public.clubs
  SET chip_treasury = COALESCE(chip_treasury, 0) - v_other_allocation,
      promo_balance = COALESCE(promo_balance, 0) + v_promo_budget + v_leaderboard_budget,
      tagline = v_tagline,
      default_rake_percent = v_rake,
      rake_cap = v_cap,
      bbj_enabled = p_bbj_enabled,
      bbj_rake_enabled = p_bbj_enabled,
      spins_enabled = p_spins_enabled,
      spins_preseed_amount = v_spin_seed,
      spins_wallet_funding = 'CHIP_TREASURY',
      updated_at = now()
  WHERE id = p_club_id
  RETURNING chip_treasury, promo_balance INTO v_bank_after, v_promo_after;

  IF p_bbj_enabled THEN
    SELECT pool.id INTO v_pool_id
    FROM public.bbj_pools pool
    WHERE pool.club_id = p_club_id AND pool.union_id IS NULL
    ORDER BY (pool.status = 'active') DESC, pool.created_at
    LIMIT 1
    FOR UPDATE;

    IF v_pool_id IS NULL THEN
      INSERT INTO public.bbj_pools
        (club_id, main_balance, backup_balance, promo_balance, pool_amount, status)
      VALUES (p_club_id, v_bbj_seed, 0, 0, 0, 'active')
      RETURNING id, main_balance INTO v_pool_id, v_bbj_after;
    ELSE
      UPDATE public.bbj_pools
      SET main_balance = main_balance + v_bbj_seed,
          status = 'active',
          updated_at = now()
      WHERE id = v_pool_id
      RETURNING main_balance INTO v_bbj_after;
    END IF;

    INSERT INTO public.club_opening_setup_funding
      (club_id, operation_id, destination, amount, balance_after, created_by)
    VALUES (p_club_id, p_operation_id, 'bbj_main', v_bbj_seed, v_bbj_after, v_actor);
  END IF;

  IF p_promo_enabled THEN
    INSERT INTO public.promotions (
      club_id, name, description, type, start_date, end_date, status,
      prize_pool, requirements, opt_in_required
    ) VALUES (
      p_club_id,
      left(btrim(p_promo_name), 80),
      left(btrim(COALESCE(p_promo_description, '')), 500),
      p_promo_type,
      now(),
      now() + interval '30 days',
      'active',
      v_promo_budget,
      'Created During Club Opening Setup',
      true
    ) RETURNING id INTO v_promotion_id;

    INSERT INTO public.club_opening_setup_funding
      (club_id, operation_id, destination, amount, balance_after, created_by)
    VALUES (p_club_id, p_operation_id, 'promo_wallet', v_promo_budget, v_promo_after, v_actor);
  END IF;

  -- New prize allocation is held in actual Promo; no new opening seed.
  INSERT INTO public.club_opening_setups (
    club_id, owner_id, rake_mode, rake_percent, rake_cap_bb,
    bbj_enabled, bbj_seeded_amount,
    spins_enabled, spin_seeded_amount, spin_max_stake,
    promo_enabled, promo_budget, promotion_id,
    leaderboard_rewards_enabled, leaderboard_metric, leaderboard_prize_budget,
    leaderboard_seed_remaining,
    last_operation_id
  ) VALUES (
    p_club_id, v_club.owner_id,
    CASE WHEN v_rake = -1 AND v_cap = -1 THEN 'house_schedule' ELSE 'custom' END,
    v_rake, v_cap,
    p_bbj_enabled, v_bbj_seed,
    p_spins_enabled, v_spin_seed, CASE WHEN p_spins_enabled THEN p_spin_max_stake ELSE 0 END,
    p_promo_enabled, v_promo_budget, v_promotion_id,
    p_leaderboard_rewards_enabled, p_leaderboard_metric, v_leaderboard_budget,
    0,
    p_operation_id
  );

  -- The program's current version, read under the club lock taken above.
  -- Publication locks this same club row, so nothing can publish between
  -- this read and the publish below. The hard-coded 0 this replaces refused
  -- (40001) every club that already had a program, even for Display Only.
  SELECT COALESCE(max(program.version), 0)
    INTO v_program_version
    FROM public.leaderboard_reward_program_versions program
   WHERE program.club_id = p_club_id;

  -- Leaderboards always receive an explicit program. Display-only is the
  -- safe launch default; a paid program publishes a balanced weekly
  -- top-three plan that sums exactly to the new actual Promo allocation.
  -- New Club Bank overlays are refused before allocations.
  v_leaderboard_result := public.fn_publish_leaderboard_reward_program(
    p_club_id,
    p_leaderboard_rewards_enabled,
    p_leaderboard_metric,
    CASE WHEN p_leaderboard_rewards_enabled THEN jsonb_build_array(
      jsonb_build_object('rank', 1, 'amount', round(v_leaderboard_budget * 0.50, 2)),
      jsonb_build_object('rank', 2, 'amount', round(v_leaderboard_budget * 0.30, 2)),
      jsonb_build_object('rank', 3, 'amount', v_leaderboard_budget
        - round(v_leaderboard_budget * 0.50, 2)
        - round(v_leaderboard_budget * 0.30, 2))
    ) ELSE '[]'::jsonb END,
    '[]'::jsonb,
    'balanced',
    v_program_version,
    p_operation_id,
    v_leaderboard_overlay
  );

  IF p_leaderboard_rewards_enabled THEN
    INSERT INTO public.club_opening_setup_funding
      (club_id, operation_id, destination, amount, balance_after, created_by)
    VALUES (
      p_club_id, p_operation_id, 'leaderboard_prizes',
      v_leaderboard_budget, v_promo_after, v_actor
    );
  END IF;


  v_result := jsonb_build_object(
    'success', true,
    'already_completed', false,
    'club_id', p_club_id,
    'club_bank_after', v_bank_after,
    'allocated', v_total_allocation,
    'bbj_seeded', v_bbj_seed,
    'spin_seeded', v_spin_seed,
    'promo_budget', v_promo_budget,
    'promotion_id', v_promotion_id,
    'leaderboard_rewards_enabled', p_leaderboard_rewards_enabled,
    'leaderboard_prize_budget', v_leaderboard_budget,
    'leaderboard_overlay_enabled', v_leaderboard_overlay,
    'leaderboard', v_leaderboard_result,
    'spin', v_spin_result,
    'operation_id', p_operation_id
  );
  RETURN v_result;
END;
$function$;
-- Existing owner and execute ACL retained by CREATE OR REPLACE.
COMMIT;
