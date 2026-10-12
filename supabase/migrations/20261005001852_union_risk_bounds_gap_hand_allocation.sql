-- 20261005001852_union_risk_bounds_gap_hand_allocation.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A first cold production Risk call still crossed its eight-second request
-- budget after the pair-keyed commission correction. The remaining dominant
-- path was the raw-rake gap reader: three actual missing club-days were
-- estimated as 2,995 rows, flattening the date join into a 4.3-million-row
-- scan. An exact per-gap-day LATERAL range probe with an OFFSET 0 planner
-- boundary returned the same 104,736 rows and 269,604.82000000 total while
-- avoiding the flattened 4.3-million-row scan.
--
-- Positive hand-backed gap rows already have immutable per-player
-- rake_attributions. Allocating those rows from rake_amount times each
-- eligible_contribution share avoids expanding their JSON a second time. A
-- same-snapshot production comparison returned zero differing player/club
-- pairs; all handless rows, generic JSON categories and signed negative rows
-- remain on the historical contribution-weighted path unchanged. A recent
-- hand-backed row with no positive attribution is detected by the same indexed
-- allocation probe and routed back through that JSON path, so an incomplete
-- producer cannot make rake disappear. The combined exact raw component
-- measured 3.479 seconds versus 7.307 seconds. Three
-- covering indexes remove the remaining heap reads from the bounded record
-- and attribution probes; each is built online before the one DDL transaction.
--
-- This is a read-only function replacement. It moves no money and changes no
-- authorization, roster choice, signature, output, rounding, chip-flow or
-- commission semantics. The migration refuses an unexpected function,
-- security posture, dependent table shape or index definition.
--
-- @qualified-postimage: definition md5 = 0215c54b5f864825dbb2502092551f14
-- @qualified-postimage: body md5 = 3f3d7262515c97429543f5488b395637
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure)) = '0215c54b5f864825dbb2502092551f14')
-- @live-proof: pg_get_indexdef('public.idx_rake_records_union_gap_hand_window'::regclass) = 'CREATE INDEX idx_rake_records_union_gap_hand_window ON public.rake_records USING btree (club_id, created_at) INCLUDE (id, rake_amount) WHERE ((hand_id IS NOT NULL) AND (rake_amount > (0)::numeric) AND (player_contributions IS NOT NULL))'
-- @live-proof: pg_get_indexdef('public.idx_rake_records_union_gap_handless_window'::regclass) = 'CREATE INDEX idx_rake_records_union_gap_handless_window ON public.rake_records USING btree (club_id, created_at) INCLUDE (id, rake_amount, player_contributions) WHERE ((hand_id IS NULL) AND (rake_amount > (0)::numeric) AND (player_contributions IS NOT NULL))'
-- @live-proof: pg_get_indexdef('public.idx_rake_attributions_union_gap_record_player'::regclass) = 'CREATE INDEX idx_rake_attributions_union_gap_record_player ON public.rake_attributions USING btree (rake_record_id, player_id) INCLUDE (eligible_contribution) WHERE (eligible_contribution > (0)::numeric)'

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rake_records_union_gap_hand_window
  ON public.rake_records (club_id, created_at)
  INCLUDE (id, rake_amount)
  WHERE hand_id IS NOT NULL
    AND rake_amount > 0
    AND player_contributions IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rake_records_union_gap_handless_window
  ON public.rake_records (club_id, created_at)
  INCLUDE (id, rake_amount, player_contributions)
  WHERE hand_id IS NULL
    AND rake_amount > 0
    AND player_contributions IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rake_attributions_union_gap_record_player
  ON public.rake_attributions (rake_record_id, player_id)
  INCLUDE (eligible_contribution)
  WHERE eligible_contribution > 0;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $migration$
DECLARE
  v_definition text;
  v_body text;
  v_rewritten text;
  v_old_gap text := $old$
  gap_days AS MATERIALIZED (
    SELECT c.club_id, g::date AS day
      FROM unnest(v_clubs) c(club_id)
      CROSS JOIN generate_series(v_day_lo, v_today::date - 1, interval '1 day') g
     WHERE v_day_lo < v_today::date
       AND NOT EXISTS (
         SELECT 1 FROM ok_days o
          WHERE o.club_id = c.club_id AND o.day = g::date)
  ),
  rollup_rake AS ($old$;
  v_new_gap text := $new$
  gap_days AS MATERIALIZED (
    SELECT c.club_id, g::date AS day
      FROM unnest(v_clubs) c(club_id)
      CROSS JOIN generate_series(v_day_lo, v_today::date - 1, interval '1 day') g
     WHERE v_day_lo < v_today::date
       AND NOT EXISTS (
         SELECT 1 FROM ok_days o
          WHERE o.club_id = c.club_id AND o.day = g::date)
  ),
  gap_hand_records AS MATERIALIZED (
    SELECT r.id, r.rake_amount
      FROM gap_days gd
      CROSS JOIN LATERAL (
        SELECT rr.id, rr.rake_amount
          FROM public.rake_records rr
         WHERE v_from >= v_today - interval '7 days'
           AND rr.club_id = gd.club_id
           AND rr.created_at >= gd.day::timestamptz
           AND rr.created_at < (gd.day + 1)::timestamptz
           AND rr.hand_id IS NOT NULL
           AND rr.rake_amount > 0
           AND rr.player_contributions IS NOT NULL
         OFFSET 0
      ) r
  ),
  gap_hand_fallback_records AS MATERIALIZED (
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM gap_hand_records x
      JOIN public.rake_records r ON r.id = x.id
     WHERE NOT EXISTS (
       SELECT 1
         FROM public.rake_attributions a
        WHERE a.rake_record_id = x.id
          AND a.eligible_contribution > 0)
  ),
  rollup_rake AS ($new$;
  v_old_raw_gap text := $old$
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM gap_days gd
      JOIN public.rake_records r
        ON r.club_id = gd.club_id
       AND r.created_at >= gd.day::timestamptz
       AND r.created_at < (gd.day + 1)::timestamptz
     WHERE r.rake_amount > 0 AND r.player_contributions IS NOT NULL
    UNION ALL$old$;
  v_new_raw_gap text := $new$
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM gap_days gd
      CROSS JOIN LATERAL (
        SELECT rr.id, rr.rake_amount, rr.player_contributions
          FROM public.rake_records rr
         WHERE v_from < v_today - interval '7 days'
           AND rr.club_id = gd.club_id
           AND rr.created_at >= gd.day::timestamptz
           AND rr.created_at < (gd.day + 1)::timestamptz
           AND rr.rake_amount > 0
           AND rr.player_contributions IS NOT NULL
         OFFSET 0
      ) r
    UNION ALL
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM gap_days gd
      CROSS JOIN LATERAL (
        SELECT rr.id, rr.rake_amount, rr.player_contributions
          FROM public.rake_records rr
         WHERE v_from >= v_today - interval '7 days'
           AND rr.club_id = gd.club_id
           AND rr.created_at >= gd.day::timestamptz
           AND rr.created_at < (gd.day + 1)::timestamptz
           AND rr.hand_id IS NULL
           AND rr.rake_amount > 0
           AND rr.player_contributions IS NOT NULL
         OFFSET 0
      ) r
    UNION ALL
    SELECT r.id, r.rake_amount, r.player_contributions
      FROM gap_hand_fallback_records r
    UNION ALL$new$;
  v_old_raw_rake text := $old$
  raw_rake AS (
    SELECT rr.player_id, rr.club_id,
           SUM(x.rake_amount * split.contribution / NULLIF(split.total, 0)) AS amount
      FROM raw_records x
      CROSS JOIN LATERAL (
        SELECT (e.key)::uuid AS player_id,
               e.value::numeric AS contribution,
               SUM(e.value::numeric) OVER () AS total
          FROM jsonb_each_text(x.player_contributions) e(key, value)
         WHERE e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           AND e.value::numeric > 0
      ) split
      JOIN rake_roster rr ON rr.player_id = split.player_id
     WHERE split.total > 0
     GROUP BY rr.player_id, rr.club_id
  ),
  rake AS (
    SELECT q.player_id, q.club_id, SUM(q.amount) AS rake_generated
      FROM (
        SELECT * FROM rollup_rake
        UNION ALL SELECT * FROM edge_attribution_rake
        UNION ALL SELECT * FROM raw_rake
      ) q$old$;
  v_new_raw_rake text := $new$
  raw_rake AS (
    SELECT rr.player_id, rr.club_id,
           SUM(x.rake_amount * split.contribution / NULLIF(split.total, 0)) AS amount
      FROM raw_records x
      CROSS JOIN LATERAL (
        SELECT (e.key)::uuid AS player_id,
               e.value::numeric AS contribution,
               SUM(e.value::numeric) OVER () AS total
          FROM jsonb_each_text(x.player_contributions) e(key, value)
         WHERE e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           AND e.value::numeric > 0
      ) split
      JOIN rake_roster rr ON rr.player_id = split.player_id
     WHERE split.total > 0
     GROUP BY rr.player_id, rr.club_id
  ),
  gap_hand_rake AS (
    SELECT rr.player_id, rr.club_id,
           SUM(x.rake_amount * split.eligible_contribution
               / NULLIF(split.total, 0)) AS amount
      FROM gap_hand_records x
      CROSS JOIN LATERAL (
        SELECT a.player_id,
               a.eligible_contribution,
               SUM(a.eligible_contribution) OVER (
                 PARTITION BY a.rake_record_id) AS total
          FROM public.rake_attributions a
         WHERE a.rake_record_id = x.id
           AND a.eligible_contribution > 0
      ) split
      JOIN rake_roster rr ON rr.player_id = split.player_id
     WHERE split.total > 0
     GROUP BY rr.player_id, rr.club_id
  ),
  rake AS (
    SELECT q.player_id, q.club_id, SUM(q.amount) AS rake_generated
      FROM (
        SELECT * FROM rollup_rake
        UNION ALL SELECT * FROM edge_attribution_rake
        UNION ALL SELECT * FROM raw_rake
        UNION ALL SELECT * FROM gap_hand_rake
      ) q$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid), p.prosrc
    INTO v_definition, v_body
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure;

  IF md5(v_definition) IS DISTINCT FROM '01baaad80223fe3364d9cf90da0076ae'
     OR md5(v_body) IS DISTINCT FROM '5fc4d72c95f2b58ab61c783e800e0327' THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_GAP_HAND_PREIMAGE_CHANGED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid =
       'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig IS NOT DISTINCT FROM
           ARRAY['search_path=public','jit=off']::text[]
       AND p.proacl::text IS NOT DISTINCT FROM
           '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
  ) THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_GAP_HAND_SECURITY_CHANGED';
  END IF;

  IF (SELECT jsonb_agg(jsonb_build_array(
                 a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull)
               ORDER BY a.attname)
        FROM pg_attribute a
       WHERE a.attrelid = 'public.rake_attributions'::regclass
         AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attname IN (
           'eligible_contribution','player_id','rake_record_id'))
       IS DISTINCT FROM
       '[["eligible_contribution","numeric",false],
         ["player_id","uuid",true],
         ["rake_record_id","uuid",false]]'::jsonb THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_GAP_HAND_ATTRIBUTION_SHAPE_CHANGED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid =
           'public.idx_rake_attributions_union_gap_record_player'::regclass
       AND i.indisvalid AND i.indisready AND i.indislive)
     OR pg_get_indexdef(
          'public.idx_rake_attributions_union_gap_record_player'::regclass)
        IS DISTINCT FROM
          'CREATE INDEX idx_rake_attributions_union_gap_record_player ON public.rake_attributions USING btree (rake_record_id, player_id) INCLUDE (eligible_contribution) WHERE (eligible_contribution > (0)::numeric)'
     OR NOT EXISTS (
       SELECT 1 FROM pg_index i
        WHERE i.indexrelid =
              'public.idx_rake_records_union_gap_hand_window'::regclass
          AND i.indisvalid AND i.indisready AND i.indislive)
     OR pg_get_indexdef(
          'public.idx_rake_records_union_gap_hand_window'::regclass)
        IS DISTINCT FROM
          'CREATE INDEX idx_rake_records_union_gap_hand_window ON public.rake_records USING btree (club_id, created_at) INCLUDE (id, rake_amount) WHERE ((hand_id IS NOT NULL) AND (rake_amount > (0)::numeric) AND (player_contributions IS NOT NULL))'
     OR NOT EXISTS (
       SELECT 1 FROM pg_index i
        WHERE i.indexrelid =
              'public.idx_rake_records_union_gap_handless_window'::regclass
          AND i.indisvalid AND i.indisready AND i.indislive)
     OR pg_get_indexdef(
          'public.idx_rake_records_union_gap_handless_window'::regclass)
        IS DISTINCT FROM
          'CREATE INDEX idx_rake_records_union_gap_handless_window ON public.rake_records USING btree (club_id, created_at) INCLUDE (id, rake_amount, player_contributions) WHERE ((hand_id IS NULL) AND (rake_amount > (0)::numeric) AND (player_contributions IS NOT NULL))'
     OR NOT EXISTS (
       SELECT 1 FROM pg_index i
        WHERE i.indexrelid = 'public.idx_rake_records_club_created'::regclass
          AND i.indisvalid AND i.indisready AND i.indislive)
     OR pg_get_indexdef('public.idx_rake_records_club_created'::regclass)
        IS DISTINCT FROM
          'CREATE INDEX idx_rake_records_club_created ON public.rake_records USING btree (club_id, created_at) WHERE (rake_amount > (0)::numeric)'
     OR NOT EXISTS (
       SELECT 1 FROM pg_index i
        WHERE i.indexrelid =
              'public.idx_rake_records_union_null_hand_window'::regclass
          AND i.indisvalid AND i.indisready AND i.indislive)
     OR pg_get_indexdef(
          'public.idx_rake_records_union_null_hand_window'::regclass)
        IS DISTINCT FROM
          'CREATE INDEX idx_rake_records_union_null_hand_window ON public.rake_records USING btree (club_id, created_at) WHERE ((hand_id IS NULL) AND (player_contributions IS NOT NULL))'
     OR NOT EXISTS (
       SELECT 1 FROM pg_index i
        WHERE i.indexrelid =
              'public.idx_rake_records_union_negative_window'::regclass
          AND i.indisvalid AND i.indisready AND i.indislive)
     OR pg_get_indexdef(
          'public.idx_rake_records_union_negative_window'::regclass)
        IS DISTINCT FROM
          'CREATE INDEX idx_rake_records_union_negative_window ON public.rake_records USING btree (club_id, created_at) WHERE ((rake_amount < (0)::numeric) AND (player_contributions IS NOT NULL))' THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_GAP_HAND_INDEX_CHANGED';
  END IF;

  IF (length(v_definition) - length(replace(v_definition, v_old_gap, '')))
       / length(v_old_gap) IS DISTINCT FROM 1
     OR (length(v_body) - length(replace(v_body, v_old_gap, '')))
       / length(v_old_gap) IS DISTINCT FROM 1
     OR (length(v_definition) - length(replace(v_definition, v_old_raw_gap, '')))
       / length(v_old_raw_gap) IS DISTINCT FROM 1
     OR (length(v_body) - length(replace(v_body, v_old_raw_gap, '')))
       / length(v_old_raw_gap) IS DISTINCT FROM 1
     OR (length(v_definition) - length(replace(v_definition, v_old_raw_rake, '')))
       / length(v_old_raw_rake) IS DISTINCT FROM 1
     OR (length(v_body) - length(replace(v_body, v_old_raw_rake, '')))
       / length(v_old_raw_rake) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_GAP_HAND_SOURCE_CHANGED';
  END IF;

  v_rewritten := replace(
    replace(
      replace(v_definition, v_old_gap, v_new_gap),
      v_old_raw_gap, v_new_raw_gap),
    v_old_raw_rake, v_new_raw_rake);
  EXECUTE v_rewritten;
END
$migration$;

ALTER FUNCTION public.fn_union_agent_risk_report(uuid,timestamptz)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_union_agent_risk_report(uuid,timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_agent_risk_report(uuid,timestamptz)
  TO authenticated, service_role;

DO $postimage$
DECLARE
  v_source text := pg_get_functiondef(
    'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure);
  v_body text := (
    SELECT p.prosrc
      FROM pg_proc p
     WHERE p.oid =
       'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure);
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid =
       'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig IS NOT DISTINCT FROM
           ARRAY['search_path=public','jit=off']::text[]
       AND p.proacl::text IS NOT DISTINCT FROM
           '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
  ) OR md5(v_source) IS DISTINCT FROM '0215c54b5f864825dbb2502092551f14'
     OR md5(v_body) IS DISTINCT FROM '3f3d7262515c97429543f5488b395637'
     OR position('gap_hand_records AS MATERIALIZED' in v_source) = 0
     OR position('gap_hand_fallback_records AS MATERIALIZED' in v_source) = 0
     OR position('gap_hand_rake AS' in v_source) = 0
     OR position('PARTITION BY a.rake_record_id' in v_source) = 0
     OR position('a.eligible_contribution > 0' in v_source) = 0
     OR position('WHERE NOT EXISTS (' in v_source) = 0
     OR (length(v_source) - length(replace(
           v_source, 'a.rake_record_id = x.id', '')))
        / length('a.rake_record_id = x.id') IS DISTINCT FROM 2
     OR position('JOIN public.rake_records r ON r.id = x.id' in v_source) = 0
     OR position('UNION ALL SELECT * FROM gap_hand_rake' in v_source) = 0
     OR position(E'FROM gap_days gd\n      JOIN public.rake_records r' in v_source) <> 0
     OR position('v_from >= v_today - interval ''7 days''' in v_source) = 0
     OR position('v_from < v_today - interval ''7 days''' in v_source) = 0
     OR (length(v_source) - length(replace(v_source, 'OFFSET 0', '')))
        / length('OFFSET 0') IS DISTINCT FROM 3
     OR position('LEFT JOIN LATERAL (' in v_source) <> 0
     OR (length(v_source) - length(replace(
           v_source, 'jsonb_each_text(x.player_contributions)', '')))
        / length('jsonb_each_text(x.player_contributions)') IS DISTINCT FROM 1
     THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_GAP_HAND_POSTIMAGE_CHANGED';
  END IF;
END
$postimage$;

COMMIT;
