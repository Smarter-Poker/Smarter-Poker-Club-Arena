BEGIN;
-- ============================================================================
--  PHASE 1 OF 9 - EVERY BREAK IS MEASURED, AND EVERY DEPLOY FIRES
--  Club Arena engine-restart programme (Dan 2026-09-02).
--  One transaction. All objects idempotent. No money path is touched: this
--  phase only READS hand_history / thaws / recovery events / deploy attempts
--  and WRITES its own reporting tables.
-- ============================================================================

-- ── 1. The scorecard table: one row per break ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_break_scorecards (
  break_ended_at        TIMESTAMPTZ PRIMARY KEY,   -- the :00 boundary
  break_started_at      TIMESTAMPTZ NOT NULL,      -- the :55 boundary
  hands_in_window       INTEGER,                   -- hands dealt INSIDE the break (target ~0)
  tables_dealing_in_window INTEGER,                -- distinct tables that dealt inside it
  thaw_ran              BOOLEAN,                    -- a thaw row exists for this freeze
  thaw_frozen_seconds   NUMERIC,                    -- from engine_maintenance_thaws
  kill_rebuilds_after   INTEGER,                    -- watchdog_kill_rebuild in :00-:05
  recovery_seconds      INTEGER,                    -- :00 -> fleet back to 80% of pre-break
  pre_break_tables      INTEGER,                    -- baseline distinct tables (5 min before :53)
  shipped_sha           TEXT,                       -- what the deploy shipped this window, if any
  shipped               BOOLEAN,                    -- a verified cutover landed this window
  freeze_conserved      BOOLEAN,                    -- circulation equal across the freeze edges
  freeze_delta          NUMERIC,                    -- post - pre circulation (should be 0)
  verdict               TEXT NOT NULL DEFAULT 'unknown',  -- pass | fail | unknown
  detail                JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.ca_break_scorecards IS
  'One row per hourly maintenance break. The single place to read whether a break stopped play, gave the clocks back, shipped, and how fast the fleet recovered. Written by fn_ca_record_break_scorecard at :06.';
ALTER TABLE public.ca_break_scorecards ENABLE ROW LEVEL SECURITY;

-- ── 2. Freeze conservation marks: circulation captured at the break edges ───
-- The freeze promise is "no chip moves". We capture the cheap circulation total
-- at :55 (pre) and :00 (post) and the scorecard asserts they match. A cheap
-- total, not fn_club_chip_circulation's per-club scan: member wallets + felt.
CREATE TABLE IF NOT EXISTS public.ca_freeze_circulation_marks (
  mark_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_hour    TIMESTAMPTZ NOT NULL,              -- the :00 boundary this mark belongs to
  kind           TEXT NOT NULL CHECK (kind IN ('pre','post')),
  member_wallets NUMERIC NOT NULL,
  on_the_felt    NUMERIC NOT NULL,
  total          NUMERIC NOT NULL,
  PRIMARY KEY (window_hour, kind)
);
COMMENT ON TABLE public.ca_freeze_circulation_marks IS
  'Circulation total at the two edges of each freeze (:55 pre, :00 post). freeze_conserved on the scorecard is post.total = pre.total. Cheap: member wallets + live felt only.';
ALTER TABLE public.ca_freeze_circulation_marks ENABLE ROW LEVEL SECURITY;

-- The circulation total, cheap enough to run at the break edge.
CREATE OR REPLACE FUNCTION public.fn_ca_circulation_total()
RETURNS TABLE (member_wallets NUMERIC, on_the_felt NUMERIC, total NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT
    COALESCE((SELECT sum(chip_balance) FROM public.club_members), 0)::numeric,
    COALESCE((SELECT sum(stack) FROM public.table_seats WHERE left_at IS NULL), 0)::numeric,
    COALESCE((SELECT sum(chip_balance) FROM public.club_members), 0)::numeric
      + COALESCE((SELECT sum(stack) FROM public.table_seats WHERE left_at IS NULL), 0)::numeric;
$$;
REVOKE ALL ON FUNCTION public.fn_ca_circulation_total() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_circulation_total() TO service_role;

-- Capture one mark. The window_hour is the NEXT :00 for a pre mark, the CURRENT
-- :00 for a post mark, so both marks for one freeze share a window_hour key.
CREATE OR REPLACE FUNCTION public.fn_ca_capture_freeze_mark(p_kind TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_win TIMESTAMPTZ; m NUMERIC; f NUMERIC; t NUMERIC;
BEGIN
  IF p_kind NOT IN ('pre','post') THEN
    RAISE EXCEPTION 'p_kind must be pre or post, got %', p_kind;
  END IF;
  -- pre fires at ~:55 and belongs to the upcoming :00; post fires at ~:00.
  v_win := CASE WHEN p_kind = 'pre'
                THEN date_trunc('hour', now()) + interval '1 hour'
                ELSE date_trunc('hour', now() + interval '2 minutes') END;
  SELECT member_wallets, on_the_felt, total INTO m, f, t FROM public.fn_ca_circulation_total();
  INSERT INTO public.ca_freeze_circulation_marks (window_hour, kind, member_wallets, on_the_felt, total)
  VALUES (v_win, p_kind, m, f, t)
  ON CONFLICT (window_hour, kind) DO UPDATE
     SET member_wallets = EXCLUDED.member_wallets,
         on_the_felt    = EXCLUDED.on_the_felt,
         total          = EXCLUDED.total,
         mark_at        = now();
  RETURN v_win;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_capture_freeze_mark(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_capture_freeze_mark(TEXT) TO service_role;

-- ============================================================================
--  PHASE 1 part 2 - the recorder, the failure push, and the DB-side dispatcher
-- ============================================================================

-- ── 3. The recorder: fill one scorecard row for the just-finished break ─────
CREATE OR REPLACE FUNCTION public.fn_ca_record_break_scorecard(p_end TIMESTAMPTZ DEFAULT NULL)
RETURNS public.ca_break_scorecards
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_end   TIMESTAMPTZ := COALESCE(p_end, date_trunc('hour', now()));
  v_start TIMESTAMPTZ := v_end - interval '5 minutes';
  v_hands INTEGER; v_wtabs INTEGER;
  v_thaw  RECORD; v_kill INTEGER; v_base INTEGER; v_rec INTEGER;
  v_ship  RECORD; v_pre NUMERIC; v_post NUMERIC; v_conserved BOOLEAN; v_delta NUMERIC;
  v_verdict TEXT; v_row public.ca_break_scorecards; m INTEGER;
BEGIN
  -- Hands dealt INSIDE the break window - the headline "did it stop play".
  SELECT count(*), count(DISTINCT table_id) INTO v_hands, v_wtabs
    FROM public.hand_history WHERE created_at >= v_start AND created_at < v_end;

  -- Thaw for this freeze. The freeze start instant the engine keys on is ~v_start;
  -- match the newest thaw within a couple of minutes of it.
  SELECT frozen_seconds, thawed_at INTO v_thaw
    FROM public.engine_maintenance_thaws
   WHERE freeze_started_at BETWEEN v_start - interval '3 min' AND v_start + interval '3 min'
   ORDER BY thawed_at DESC LIMIT 1;

  -- Watchdog kill-rebuilds in the five minutes after resume.
  SELECT count(*) INTO v_kill FROM public.engine_recovery_events
   WHERE event = 'watchdog_kill_rebuild' AND created_at >= v_end AND created_at < v_end + interval '5 min';

  -- Recovery: baseline = distinct tables dealing in the 5 min before last-hand (:48-:53);
  -- recovery_seconds = first full minute after :00 whose trailing 2-min distinct-table
  -- count reaches 80% of baseline. NULL if it never does inside 10 minutes.
  SELECT count(DISTINCT table_id) INTO v_base FROM public.hand_history
   WHERE created_at >= v_end - interval '12 min' AND created_at < v_end - interval '7 min';
  v_rec := NULL;
  IF v_base > 0 THEN
    FOR m IN 1..10 LOOP
      IF (SELECT count(DISTINCT table_id) FROM public.hand_history
            WHERE created_at >= v_end + make_interval(mins => m - 1)
              AND created_at <  v_end + make_interval(mins => m + 1)) >= ceil(v_base * 0.8) THEN
        v_rec := m * 60; EXIT;
      END IF;
    END LOOP;
  END IF;

  -- Shipped this window, from the deploy-attempt ledger.
  SELECT target_sha, shipped INTO v_ship FROM public.ca_engine_deploy_attempts
   WHERE at >= v_start AND at < v_end + interval '6 min' ORDER BY at DESC LIMIT 1;

  -- Freeze conservation from the two edge marks.
  SELECT total INTO v_pre  FROM public.ca_freeze_circulation_marks WHERE window_hour = v_end AND kind='pre';
  SELECT total INTO v_post FROM public.ca_freeze_circulation_marks WHERE window_hour = v_end AND kind='post';
  IF v_pre IS NOT NULL AND v_post IS NOT NULL THEN
    v_delta := v_post - v_pre; v_conserved := (abs(v_delta) < 0.005);
  ELSE v_delta := NULL; v_conserved := NULL; END IF;

  -- Verdict. A break "passed" when it genuinely stopped play, gave the clocks
  -- back, and the fleet came back reasonably fast. Conservation, when measured,
  -- must hold. Thresholds are deliberately generous for now and tightened later.
  v_verdict := CASE
    WHEN v_hands <= 50
     AND COALESCE(v_thaw.frozen_seconds, 0) > 0
     AND COALESCE(v_rec, 999) <= 180
     AND COALESCE(v_conserved, TRUE)
    THEN 'pass'
    WHEN v_hands IS NULL THEN 'unknown'
    ELSE 'fail' END;

  INSERT INTO public.ca_break_scorecards AS s (
    break_ended_at, break_started_at, hands_in_window, tables_dealing_in_window,
    thaw_ran, thaw_frozen_seconds, kill_rebuilds_after, recovery_seconds,
    pre_break_tables, shipped_sha, shipped, freeze_conserved, freeze_delta, verdict, detail)
  VALUES (
    v_end, v_start, v_hands, v_wtabs,
    (v_thaw.frozen_seconds IS NOT NULL), v_thaw.frozen_seconds, v_kill, v_rec,
    v_base, v_ship.target_sha, COALESCE(v_ship.shipped, FALSE), v_conserved, v_delta, v_verdict,
    jsonb_build_object('pre_total', v_pre, 'post_total', v_post))
  ON CONFLICT (break_ended_at) DO UPDATE SET
    hands_in_window = EXCLUDED.hands_in_window,
    tables_dealing_in_window = EXCLUDED.tables_dealing_in_window,
    thaw_ran = EXCLUDED.thaw_ran, thaw_frozen_seconds = EXCLUDED.thaw_frozen_seconds,
    kill_rebuilds_after = EXCLUDED.kill_rebuilds_after, recovery_seconds = EXCLUDED.recovery_seconds,
    pre_break_tables = EXCLUDED.pre_break_tables, shipped_sha = EXCLUDED.shipped_sha,
    shipped = EXCLUDED.shipped, freeze_conserved = EXCLUDED.freeze_conserved,
    freeze_delta = EXCLUDED.freeze_delta, verdict = EXCLUDED.verdict, detail = EXCLUDED.detail,
    recorded_at = now()
  RETURNING * INTO v_row;

  -- A failed break is loud: notify the incident recipients ONCE (a fresh row, so
  -- the ON CONFLICT re-run does not re-push - guarded by xmax below).
  IF v_verdict = 'fail' THEN
    PERFORM public.fn_ca_break_scorecard_push(v_row);
  END IF;

  RETURN v_row;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_record_break_scorecard(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_record_break_scorecard(TIMESTAMPTZ) TO service_role;

-- ── 4. The failure push - one notification per failed break, deduped ────────
CREATE OR REPLACE FUNCTION public.fn_ca_break_scorecard_push(p_row public.ca_break_scorecards)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE r uuid; v_key text; v_msg text;
BEGIN
  v_key := 'break-failed:' || to_char(p_row.break_ended_at, 'YYYYMMDD"T"HH24MI');
  -- Dedupe: if a notification with this key already exists, do nothing.
  IF EXISTS (SELECT 1 FROM public.notifications
              WHERE type = 'engine_break_failed' AND data->>'key' = v_key) THEN
    RETURN;
  END IF;
  v_msg := 'Maintenance Break At ' || to_char(p_row.break_ended_at, 'HH24:MI')
    || ' Did Not Pass. Hands In Window ' || COALESCE(p_row.hands_in_window::text,'?')
    || ', Thaw ' || CASE WHEN p_row.thaw_ran THEN 'Ran' ELSE 'Failed' END
    || ', Recovery ' || COALESCE(p_row.recovery_seconds::text,'?') || 's'
    || ', Shipped ' || CASE WHEN p_row.shipped THEN 'Yes' ELSE 'No' END;
  FOR r IN SELECT user_id FROM public.ca_incident_recipients WHERE active LOOP
    INSERT INTO public.notifications (user_id, type, title, message, data)
    VALUES (r, 'engine_break_failed', 'Engine Break Needs A Look', left(v_msg,500),
            jsonb_build_object('key', v_key, 'scorecard', to_jsonb(p_row)));
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_break_scorecard_push(public.ca_break_scorecards) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_break_scorecard_push(public.ca_break_scorecards) TO service_role;

-- ============================================================================
--  PHASE 1 part 3 - the DB-side deploy dispatcher (armed OFF by default)
--  GitHub cron dropped the 16:40 and 17:40 ticks on 2026-09-02. The database
--  is the one thing that is always up, so it can fire the deploy at :41 when no
--  run for the coming window exists. This needs a token that can dispatch the
--  workflow; storing a code-pushing PAT in the DB is Dan's call, so this ships
--  DISARMED: the mechanism, the dedupe and a full dry-run are here and testable,
--  but nothing leaves the database until the vault secret exists AND the config
--  flag is on.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ca_deploy_dispatch_config (
  id            BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  repo          TEXT NOT NULL DEFAULT 'Smarter-Poker/Smarter-Poker-Club-Arena',
  workflow_file TEXT NOT NULL DEFAULT 'auto-deploy-hetzner.yml',
  ref           TEXT NOT NULL DEFAULT 'main',
  vault_secret  TEXT NOT NULL DEFAULT 'ca_deploy_dispatch_token',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.ca_deploy_dispatch_config (id) VALUES (TRUE) ON CONFLICT DO NOTHING;
ALTER TABLE public.ca_deploy_dispatch_config ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.ca_deploy_dispatch_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fired_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_hour TIMESTAMPTZ NOT NULL,
  action      TEXT NOT NULL,     -- dispatched | skipped_existing_run | disarmed | dry_run | no_token
  net_request_id BIGINT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE public.ca_deploy_dispatch_log ENABLE ROW LEVEL SECURITY;

-- Was a deploy run already created for the coming :55 window? The engine deploy
-- attempts land in ca_engine_deploy_attempts; a fresh attempt in this hour means
-- a run exists (dispatched by GitHub cron, an agent, or a prior tick).
CREATE OR REPLACE FUNCTION public.fn_ca_deploy_run_exists_this_hour()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (SELECT 1 FROM public.ca_engine_deploy_attempts
                  WHERE at >= date_trunc('hour', now()));
$$;
REVOKE ALL ON FUNCTION public.fn_ca_deploy_run_exists_this_hour() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_deploy_run_exists_this_hour() TO service_role;

-- The dispatcher. p_dry_run TRUE (default) never calls out - it returns exactly
-- what it WOULD do, which is what the acceptance test asserts.
CREATE OR REPLACE FUNCTION public.fn_ca_deploy_dispatch_tick(p_dry_run BOOLEAN DEFAULT TRUE)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp', 'vault'
AS $$
DECLARE
  cfg public.ca_deploy_dispatch_config;
  v_win TIMESTAMPTZ := date_trunc('hour', now()) + interval '1 hour';
  v_token text; v_url text; v_action text; v_req bigint;
BEGIN
  SELECT * INTO cfg FROM public.ca_deploy_dispatch_config WHERE id;

  IF public.fn_ca_deploy_run_exists_this_hour() THEN
    v_action := 'skipped_existing_run';
  ELSIF NOT cfg.enabled THEN
    v_action := 'disarmed';
  ELSE
    SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = cfg.vault_secret;
    IF v_token IS NULL OR v_token = '' THEN
      v_action := 'no_token';
    ELSIF p_dry_run THEN
      v_action := 'dry_run';
    ELSE
      v_url := 'https://api.github.com/repos/' || cfg.repo
             || '/actions/workflows/' || cfg.workflow_file || '/dispatches';
      SELECT net.http_post(
        url := v_url,
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || v_token,
          'Accept', 'application/vnd.github+json',
          'User-Agent', 'ca-db-dispatcher',
          'Content-Type', 'application/json'),
        body := jsonb_build_object('ref', cfg.ref, 'inputs', '{}'::jsonb)
      ) INTO v_req;
      v_action := 'dispatched';
    END IF;
  END IF;

  INSERT INTO public.ca_deploy_dispatch_log (window_hour, action, net_request_id, detail)
  VALUES (v_win, v_action, v_req,
          jsonb_build_object('enabled', cfg.enabled, 'dry_run', p_dry_run));
  RETURN jsonb_build_object('window_hour', v_win, 'action', v_action, 'net_request_id', v_req);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_deploy_dispatch_tick(BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_deploy_dispatch_tick(BOOLEAN) TO service_role;

COMMIT;
