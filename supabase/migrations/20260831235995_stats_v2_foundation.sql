-- Stats completion program, phase 1 of 10.
--
-- This migration does four foundational jobs:
--   1. makes the production Stats index/rake schema reproducible from git;
--   2. removes the legacy arbitrary-player RPCs from browser roles;
--   3. exposes versioned, owner-only browser entry points;
--   4. returns honest source/coverage metadata before later phases replace the
--      reconstructed cash-money source with exact settlement aggregates.

BEGIN;

-- These two index relations existed in production but their creating migration
-- was missing from the repository. CREATE IF NOT EXISTS is intentionally a
-- no-op in production and makes a clean schema replay deterministic.
CREATE TABLE IF NOT EXISTS public.ca_hand_player_idx (
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  hand_id uuid NOT NULL,
  PRIMARY KEY (user_id, hand_id)
);

CREATE INDEX IF NOT EXISTS idx_ca_hand_player_idx_hand_id
  ON public.ca_hand_player_idx (hand_id);
CREATE INDEX IF NOT EXISTS idx_ca_hand_player_idx_user_time
  ON public.ca_hand_player_idx (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ca_hand_player_idx_state (
  id boolean PRIMARY KEY DEFAULT true,
  watermark timestamptz NOT NULL DEFAULT now(),
  rows_indexed bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  idx_floor timestamptz,
  idx_ceil timestamptz,
  backfill_complete boolean NOT NULL DEFAULT false,
  CONSTRAINT ca_hand_player_idx_state_singleton CHECK (id)
);

INSERT INTO public.ca_hand_player_idx_state (id, watermark)
VALUES (true, now())
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.ca_hand_player_idx ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_hand_player_idx_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_hand_player_idx FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ca_hand_player_idx_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ca_hand_player_idx TO service_role;
GRANT ALL ON TABLE public.ca_hand_player_idx_state TO service_role;

ALTER TABLE public.ca_hand_player_idx SET (
  autovacuum_enabled = true,
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold = 5000,
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold = 5000,
  autovacuum_vacuum_insert_threshold = 20000,
  autovacuum_vacuum_insert_scale_factor = 0.0,
  autovacuum_vacuum_cost_delay = 2,
  autovacuum_vacuum_cost_limit = 2000
);

-- Exact production definition captured on 2026-08-31. The refresh is
-- resumable, serialised and service-only; page views never invoke it.
CREATE OR REPLACE FUNCTION public.ca_refresh_hand_player_index(p_max_hands integer DEFAULT 50000)
RETURNS TABLE(
  hands_indexed integer,
  rows_added integer,
  floor_at timestamptz,
  ceil_at timestamptz,
  complete boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10min'
AS $function$
DECLARE
  f timestamptz;
  c timestamptz;
  done boolean;
  new_floor timestamptz;
  new_ceil timestamptz;
  n_hands int := 0;
  n_rows int := 0;
  k int;
  kr int;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('ca_refresh_hand_player_index')) THEN
    RETURN QUERY SELECT 0, 0, NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;

  SELECT idx_floor, idx_ceil, backfill_complete INTO f, c, done
  FROM public.ca_hand_player_idx_state WHERE id;
  IF f IS NULL THEN f := now(); END IF;
  IF c IS NULL THEN c := now(); END IF;

  SELECT max(created_at) INTO new_ceil FROM public.hand_history WHERE created_at > c;
  IF new_ceil IS NOT NULL THEN
    WITH src AS (
      SELECT h.id, h.created_at, h.players FROM public.hand_history h
      WHERE h.created_at > c AND h.created_at <= new_ceil
    ), expanded AS (
      SELECT DISTINCT ((pl->>'userId')::uuid) AS user_id, s.created_at, s.id AS hand_id
      FROM src s, jsonb_array_elements(s.players) pl
      WHERE pl->>'userId' ~ '^[0-9a-fA-F-]{36}$'
    ), ins AS (
      INSERT INTO public.ca_hand_player_idx (user_id, created_at, hand_id)
      SELECT user_id, created_at, hand_id FROM expanded
      ON CONFLICT DO NOTHING RETURNING 1
    )
    SELECT (SELECT count(*) FROM src)::int, (SELECT count(*) FROM ins)::int INTO k, kr;
    n_hands := n_hands + coalesce(k, 0);
    n_rows := n_rows + coalesce(kr, 0);
    c := new_ceil;
  END IF;

  IF NOT done THEN
    SELECT min(created_at) INTO new_floor
    FROM (
      SELECT created_at FROM public.hand_history
      WHERE created_at < f ORDER BY created_at DESC LIMIT p_max_hands
    ) q;
    IF new_floor IS NULL THEN
      done := true;
    ELSE
      WITH src AS (
        SELECT h.id, h.created_at, h.players FROM public.hand_history h
        WHERE h.created_at < f AND h.created_at >= new_floor
      ), expanded AS (
        SELECT DISTINCT ((pl->>'userId')::uuid) AS user_id, s.created_at, s.id AS hand_id
        FROM src s, jsonb_array_elements(s.players) pl
        WHERE pl->>'userId' ~ '^[0-9a-fA-F-]{36}$'
      ), ins AS (
        INSERT INTO public.ca_hand_player_idx (user_id, created_at, hand_id)
        SELECT user_id, created_at, hand_id FROM expanded
        ON CONFLICT DO NOTHING RETURNING 1
      )
      SELECT (SELECT count(*) FROM src)::int, (SELECT count(*) FROM ins)::int INTO k, kr;
      n_hands := n_hands + coalesce(k, 0);
      n_rows := n_rows + coalesce(kr, 0);
      f := new_floor;
      IF NOT EXISTS (SELECT 1 FROM public.hand_history WHERE created_at < f) THEN
        done := true;
      END IF;
    END IF;
  END IF;

  UPDATE public.ca_hand_player_idx_state
  SET idx_floor = f,
      idx_ceil = c,
      backfill_complete = done,
      rows_indexed = rows_indexed + n_rows,
      updated_at = now()
  WHERE id;

  RETURN QUERY SELECT n_hands, n_rows, f, c, done;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_refresh_hand_player_index(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_refresh_hand_player_index(integer) TO service_role;

-- The rake migration previously contained only a notice saying these bodies
-- had been applied externally. Recording their exact live definitions here
-- closes that clean-replay gap.
CREATE OR REPLACE FUNCTION public.ca_player_rake_stats(
  p_user uuid DEFAULT NULL,
  p_days integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid;
  v_since timestamptz;
  v_hands bigint := 0;
  v_raked_hands bigint := 0;
  v_rake numeric := 0;
  v_bb numeric := 0;
  v_first timestamptz;
  v_last timestamptz;
BEGIN
  IF public.fn_caller_is_engine() THEN
    v_uid := coalesce(p_user, auth.uid());
  ELSE
    v_uid := auth.uid();
  END IF;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object(
      'hands', 0, 'raked_hands', 0, 'rake_paid', 0,
      'rake_per_100', 0, 'rake_in_bb', 0, 'days', p_days
    );
  END IF;

  v_since := CASE WHEN p_days IS NULL THEN '-infinity'::timestamptz
                  ELSE now() - make_interval(days => greatest(p_days, 1)) END;

  SELECT count(*),
         count(*) FILTER (WHERE coalesce(f.rake_paid, 0) > 0),
         coalesce(sum(f.rake_paid), 0),
         coalesce(sum(CASE WHEN f.big_blind > 0 THEN f.rake_paid / f.big_blind ELSE 0 END), 0),
         min(f.played_at),
         max(f.played_at)
  INTO v_hands, v_raked_hands, v_rake, v_bb, v_first, v_last
  FROM public.ca_hand_facts f
  WHERE f.user_id = v_uid
    AND f.played_at >= v_since
    AND f.tournament_id IS NULL;

  RETURN jsonb_build_object(
    'hands', v_hands,
    'raked_hands', v_raked_hands,
    'rake_paid', round(v_rake, 2),
    'rake_per_100', CASE WHEN v_hands > 0 THEN round(v_rake * 100.0 / v_hands, 2) ELSE 0 END,
    'rake_in_bb', round(v_bb, 2),
    'bb_per_100', CASE WHEN v_hands > 0 THEN round(v_bb * 100.0 / v_hands, 2) ELSE 0 END,
    'avg_rake_per_raked_hand',
      CASE WHEN v_raked_hands > 0 THEN round(v_rake / v_raked_hands, 4) ELSE 0 END,
    'first_hand_at', v_first,
    'last_hand_at', v_last,
    'days', p_days
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_player_hand_rake_share(p_hand_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rr record;
  v_ra record;
BEGIN
  IF v_uid IS NULL OR p_hand_id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT rake_amount, bbj_contribution, pot_size, rake_method, player_contributions
  INTO v_rr
  FROM public.rake_records
  WHERE hand_id = p_hand_id
  ORDER BY created_at
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT eligible_contribution, returned_uncalled, contribution_weight,
         weighted_rake_credit, bbj_attributed_contribution
  INTO v_ra
  FROM public.rake_attributions
  WHERE hand_id = p_hand_id AND player_id = v_uid;

  IF NOT FOUND THEN
    IF v_rr.player_contributions ? v_uid::text THEN
      RETURN (
        SELECT jsonb_build_object(
          'found', true,
          'hand_id', p_hand_id,
          'rake_method', coalesce(v_rr.rake_method, 'DEALT_EQUAL'),
          'pot_size', v_rr.pot_size,
          'hand_rake', round(v_rr.rake_amount, 2),
          'hand_bbj', round(coalesce(v_rr.bbj_contribution, 0), 2),
          'your_contribution', round((v_rr.player_contributions->>v_uid::text)::numeric, 2),
          'your_returned_uncalled', 0,
          'your_share_pct', round(a.weight * 100, 2),
          'your_rake', round(a.credit, 2),
          'your_bbj', 0,
          'from_ledger', false
        )
        FROM public.fn_allocate_rake_credits(
          v_rr.rake_amount,
          v_rr.player_contributions,
          coalesce(v_rr.rake_method, 'DEALT_EQUAL')
        ) a
        WHERE a.user_id = v_uid
      );
    END IF;
    RETURN jsonb_build_object('found', false);
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'hand_id', p_hand_id,
    'rake_method', coalesce(v_rr.rake_method, 'DEALT_EQUAL'),
    'pot_size', v_rr.pot_size,
    'hand_rake', round(v_rr.rake_amount, 2),
    'hand_bbj', round(coalesce(v_rr.bbj_contribution, 0), 2),
    'your_contribution', round(coalesce(v_ra.eligible_contribution, 0), 2),
    'your_returned_uncalled', round(coalesce(v_ra.returned_uncalled, 0), 2),
    'your_share_pct', round(coalesce(v_ra.contribution_weight, 0) * 100, 2),
    'your_rake', round(coalesce(v_ra.weighted_rake_credit, 0), 2),
    'your_bbj', round(coalesce(v_ra.bbj_attributed_contribution, 0), 2),
    'from_ledger', true
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_player_rake_stats(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ca_player_hand_rake_share(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_player_rake_stats(uuid, integer)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ca_player_hand_rake_share(uuid)
  TO authenticated, service_role;

-- The two legacy RPCs accepted an arbitrary target UUID while running as the
-- function owner. They remain service-only for compatibility with maintenance
-- and are no longer direct browser APIs.
REVOKE ALL ON FUNCTION public.ca_player_stats_full(uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ca_player_hands(uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_full(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ca_player_hands(uuid, text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.ca_player_stats_overview_v2(
  p_user uuid,
  p_days integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_result jsonb;
  v_days integer := CASE
    WHEN p_days IS NULL THEN NULL
    ELSE least(greatest(p_days, 1), 3650)
  END;
BEGIN
  PERFORM public.ca_assert_self(p_user);
  v_result := public.ca_player_stats_full(p_user, v_days);

  RETURN coalesce(v_result, '{}'::jsonb) || jsonb_build_object(
    'contract_version', 2,
    'scope', jsonb_build_object(
      'target_user_id', p_user,
      'club_id', NULL,
      'range_days', v_days,
      'visibility', 'owner'
    ),
    'quality', jsonb_build_object(
      'cash_money_source', 'reconstructed_actions',
      'cash_money_exact', false,
      'advanced_facts_source', 'ca_hand_facts',
      'historical_club_breakdown_available', false
    ),
    'coverage', jsonb_build_object(
      'analysis_hand_cap', coalesce((v_result #>> '{overall,hand_cap}')::integer, 750),
      'analysis_hands_capped', coalesce((v_result #>> '{overall,hands_capped}')::boolean, false),
      'lifetime_index_complete', coalesce((v_result #>> '{lifetime,indexed_complete}')::boolean, false),
      'first_hand_at', v_result #> '{lifetime,first_hand_at}',
      'last_hand_at', v_result #> '{lifetime,last_hand_at}'
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_player_hands_v2(
  p_user uuid,
  p_mode text DEFAULT 'recent',
  p_limit integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  PERFORM public.ca_assert_self(p_user);
  RETURN public.ca_player_hands(p_user, p_mode, p_limit);
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_player_stats_overview_v2(uuid, integer)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ca_player_hands_v2(uuid, text, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_overview_v2(uuid, integer)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ca_player_hands_v2(uuid, text, integer)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ca_player_stats_overview_v2(uuid, integer) IS
  'Stats contract v2 phase-1 owner-only overview. Returns explicit scope, source quality and coverage metadata.';
COMMENT ON FUNCTION public.ca_player_hands_v2(uuid, text, integer) IS
  'Owner-only notable-hand evidence wrapper. Club/range filtering arrives with the club-scoped v2 fact contract.';

DO $assert$
BEGIN
  IF has_function_privilege('authenticated', 'public.ca_player_stats_full(uuid,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ca_player_hands(uuid,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'legacy arbitrary-target Stats RPC remains reachable by authenticated';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.ca_player_stats_overview_v2(uuid,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.ca_player_hands_v2(uuid,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'versioned owner-only Stats RPC is not reachable by authenticated';
  END IF;
END;
$assert$;

COMMIT;
