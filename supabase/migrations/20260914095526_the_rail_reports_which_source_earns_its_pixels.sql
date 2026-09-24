-- 20260914095526_the_rail_reports_which_source_earns_its_pixels
--
-- EIGHT SOURCES, NO DATA (2026-09-14)
--
-- The live message rail carries eight sources - overlays, starting soon,
-- registration closing, guarantees, table openings, winner results, maintenance
-- and custom messages - each with an operator switch. Nothing has ever measured
-- any of them. "Is the guarantees source worth its pixels" has had no answer,
-- and every decision about the bar's content since it was built has been taste.
--
-- WHAT THIS COUNTS, and why those three.
--
--   shown      an announcement OWNED THE BAR, counted once per announcement per
--              tab. Not once per poll and not once per render: the strip
--              repaints constantly and the meaningful unit is "this player was
--              told this thing".
--   opened     the player pressed it and went to the event.
--   dismissed  the player closed it.
--
-- Two of those make the ratio that matters. A source with impressions and no
-- opens is a source spending the most valuable pixels on the platform to say
-- nothing; a source with a high dismiss rate is one players are actively
-- pushing away.
--
-- WHY A DAILY ROLLUP AND NOT EVENTS. An impression happens whenever a
-- tournament is inside its last call, on every seated player. An event row per
-- impression would out-write hand_history for a number that is only ever read
-- as a ratio. This is the same shape as public.card_slide_usage, for the same
-- reason, and the client batches into it at most once a minute per tab.
--
-- COUNTERS ARE ADDITIVE. A retry double-counts at worst, which is the right
-- failure for a product signal; losing the day is not.
--
-- ONE TRANSACTION, per CLAUDE.md's production DDL policy - every DDL event
-- reloads PostgREST's schema cache and one reload costs ~28 seconds.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ca_ticker_usage_daily (
  day date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source text NOT NULL,
  shown integer NOT NULL DEFAULT 0,
  opened integer NOT NULL DEFAULT 0,
  dismissed integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, user_id, source),
  CONSTRAINT ca_ticker_usage_source_known CHECK (
    source IN (
      'overlays',
      'starting_soon',
      'registration_closing',
      'guarantees',
      'table_openings',
      'winner_results',
      'maintenance',
      'custom_messages'
    )
  ),
  CONSTRAINT ca_ticker_usage_counts_sane CHECK (
    shown >= 0 AND opened >= 0 AND dismissed >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_ca_ticker_usage_day_source
  ON public.ca_ticker_usage_daily(day DESC, source);

ALTER TABLE public.ca_ticker_usage_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_ticker_usage_daily FROM PUBLIC, anon, authenticated;

-- No policy for `authenticated` on purpose. A player writes through the
-- function below, which pins the row to their own auth.uid(); nothing about
-- another player's reading habits is theirs to select.
DROP POLICY IF EXISTS ca_ticker_usage_service_all ON public.ca_ticker_usage_daily;
CREATE POLICY ca_ticker_usage_service_all
  ON public.ca_ticker_usage_daily FOR ALL TO service_role
  USING (true) WITH CHECK (true);

/*
 * The client sends one batch per minute per tab:
 *   { "starting_soon": { "shown": 3, "opened": 1 }, "overlays": { "shown": 1 } }
 *
 * SECURITY DEFINER and the row is pinned to auth.uid() inside, so a caller
 * cannot write a count against anybody else. An unknown source key is ignored
 * rather than raising: a client one deploy ahead of the database must not throw
 * inside a fire-and-forget metric on a poker table.
 */
CREATE OR REPLACE FUNCTION public.fn_record_ticker_usage(p_counts jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_source text;
  v_entry jsonb;
  v_shown int;
  v_opened int;
  v_dismissed int;
  v_written int := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  IF p_counts IS NULL OR jsonb_typeof(p_counts) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;

  FOR v_source, v_entry IN SELECT * FROM jsonb_each(p_counts) LOOP
    CONTINUE WHEN jsonb_typeof(v_entry) <> 'object';
    CONTINUE WHEN v_source NOT IN (
      'overlays', 'starting_soon', 'registration_closing', 'guarantees',
      'table_openings', 'winner_results', 'maintenance', 'custom_messages'
    );

    v_shown     := GREATEST(0, COALESCE((v_entry->>'shown')::int, 0));
    v_opened    := GREATEST(0, COALESCE((v_entry->>'opened')::int, 0));
    v_dismissed := GREATEST(0, COALESCE((v_entry->>'dismissed')::int, 0));
    CONTINUE WHEN v_shown + v_opened + v_dismissed = 0;

    INSERT INTO public.ca_ticker_usage_daily AS u
      (day, user_id, source, shown, opened, dismissed)
    VALUES
      ((now() AT TIME ZONE 'utc')::date, v_uid, v_source, v_shown, v_opened, v_dismissed)
    ON CONFLICT (day, user_id, source) DO UPDATE
      SET shown      = u.shown + EXCLUDED.shown,
          opened     = u.opened + EXCLUDED.opened,
          dismissed  = u.dismissed + EXCLUDED.dismissed,
          updated_at = now();
    v_written := v_written + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'sources', v_written);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_record_ticker_usage(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_record_ticker_usage(jsonb) TO authenticated, service_role;

DO $$
DECLARE
  v_uid uuid;
  v_first jsonb;
  v_second jsonb;
  v_shown int;
BEGIN
  SELECT id INTO v_uid FROM auth.users LIMIT 1;
  IF v_uid IS NULL THEN
    RAISE NOTICE 'no auth users; behavioural check skipped';
    RETURN;
  END IF;

  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text,
    true
  );

  -- Two batches, because ADDITIVE is the property that matters.
  v_first  := public.fn_record_ticker_usage(
    '{"starting_soon": {"shown": 2, "opened": 1}, "not_a_source": {"shown": 99}}'::jsonb
  );
  v_second := public.fn_record_ticker_usage('{"starting_soon": {"shown": 3}}'::jsonb);
  RESET ROLE;

  IF (v_first->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'VERIFY FAILED: a player could not record usage: %', v_first;
  END IF;
  -- The unknown key was ignored, not counted and not raised.
  IF (v_first->>'sources')::int <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED: an unknown source was not ignored: %', v_first;
  END IF;

  SELECT shown INTO v_shown
  FROM public.ca_ticker_usage_daily
  WHERE user_id = v_uid AND source = 'starting_soon'
    AND day = (now() AT TIME ZONE 'utc')::date;
  IF v_shown <> 5 THEN
    RAISE EXCEPTION 'VERIFY FAILED: counters are not additive, shown=%', v_shown;
  END IF;

  -- Leave the table as it was found.
  DELETE FROM public.ca_ticker_usage_daily WHERE user_id = v_uid;
  IF EXISTS (SELECT 1 FROM public.ca_ticker_usage_daily WHERE user_id = v_uid) THEN
    RAISE EXCEPTION 'VERIFY FAILED: the probe row survived';
  END IF;
END $$;

COMMIT;
