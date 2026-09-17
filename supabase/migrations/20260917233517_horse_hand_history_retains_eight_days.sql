-- Owner instruction September 17: retain horse hand history for eight days.
-- Preserve all existing reported/human/terminal-protection and bounded pruning rules.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

DO $$ BEGIN
 IF (SELECT count(*) FROM public.hand_history_retention_policy)<>1 OR NOT EXISTS(SELECT 1 FROM public.hand_history_retention_policy WHERE id IS TRUE AND horse_retention_days=7) THEN RAISE EXCEPTION 'horse_retention_policy_predecessor_changed'; END IF;
END $$;

UPDATE public.hand_history_retention_policy SET horse_retention_days=8,updated_at=clock_timestamp(),note='Owner instruction September 17, 2026: retain horse hand history for eight days; immutable accounting receipts are retained independently.' WHERE id IS TRUE AND horse_retention_days=7;
ALTER TABLE public.hand_history_retention_policy ALTER COLUMN horse_retention_days SET DEFAULT 8;
ALTER TABLE public.hand_history_retention_policy ADD CONSTRAINT horse_history_minimum_eight_days CHECK(horse_retention_days>=8);

DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_detect_results_without_a_hand(integer)'::regprocedure)) IS DISTINCT FROM '8d5ff5a913a78e4e7677023ad7089fdb' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_detect_results_without_a_hand(integer)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'horse_retention_consumer_changed'; END IF; END $$;

CREATE OR REPLACE FUNCTION public.fn_detect_results_without_a_hand(p_since_days integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_retention integer;
  v_days      integer;
  v_since     timestamptz;
  v_flagged   integer := 0;
  v_alerts    integer := 0;
  v_chips     numeric := 0;
  v_parked    integer := 0;
  v_ids       uuid[] := ARRAY[]::uuid[];
  v_row       record;
BEGIN
  -- Never scan further back than the hand history is trusted to reach.
  SELECT COALESCE(horse_retention_days, 8) INTO v_retention
    FROM public.hand_history_retention_policy LIMIT 1;
  v_retention := GREATEST(COALESCE(v_retention, 8) - 1, 1);
  v_days := LEAST(GREATEST(COALESCE(p_since_days, v_retention), 1), v_retention);
  v_since := now() - make_interval(days => v_days);

  FOR v_row IN
    SELECT t.id,
           t.name,
           t.club_id,
           t.started_at,
           t.ended_at,
           EXTRACT(epoch FROM (t.ended_at - t.started_at))::integer AS secs,
           (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id)                          AS entrants,
           (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id AND tp.position IS NOT NULL) AS ranked,
           (SELECT COALESCE(sum(p.amount), 0) FROM public.tournament_payouts p
             WHERE p.tournament_id = t.id)                           AS paid
      FROM public.tournaments t
     WHERE t.status = 'COMPLETED'
       AND t.started_at IS NOT NULL
       AND t.started_at >= v_since
       AND NOT EXISTS (SELECT 1 FROM public.hand_history hh
                        WHERE hh.tournament_id = t.id)
       AND EXISTS (SELECT 1 FROM public.tournament_players tp
                    WHERE tp.tournament_id = t.id AND tp.position IS NOT NULL)
  LOOP
    v_flagged := v_flagged + 1;
    v_chips   := v_chips + COALESCE(v_row.paid, 0);
    v_ids     := v_ids || v_row.id;

    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'critical',
           'fn_detect_results_without_a_hand',
           format(
             'Tournament %s ranked %s of %s entrant(s) and paid %s chips, and not one hand was ever dealt in it',
             COALESCE(v_row.name, v_row.id::text), v_row.ranked, v_row.entrants,
             round(COALESCE(v_row.paid, 0), 2)),
           jsonb_build_object(
             'tournament_id',   v_row.id,
             'club_id',         v_row.club_id,
             'entrants',        v_row.entrants,
             'ranked',          v_row.ranked,
             'chips_paid',      round(COALESCE(v_row.paid, 0), 2),
             'started_at',      v_row.started_at,
             'ended_at',        v_row.ended_at,
             'seconds_to_end',  v_row.secs,
             'detail',          'no money was moved by this check; who is owed what on an event that never dealt is a human decision')
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'fn_detect_results_without_a_hand'
          AND fa.resolved IS NOT TRUE
          AND fa.context->>'tournament_id' = v_row.id::text);
    IF FOUND THEN v_alerts := v_alerts + 1; END IF;
  END LOOP;

  -- Informational, never alerted: events the engine guard is holding back from
  -- exactly this fate. A number climbing here is the guard working, not a leak.
  SELECT count(*) INTO v_parked
    FROM public.tournaments t
   WHERE t.status = 'COMPLETING'
     AND t.started_at IS NOT NULL
     AND t.started_at >= v_since
     AND NOT EXISTS (SELECT 1 FROM public.hand_history hh
                      WHERE hh.tournament_id = t.id);

  RETURN jsonb_build_object(
    'ok',                true,
    'since_days',        v_days,
    'flagged',           v_flagged,
    'alerts_raised',     v_alerts,
    'chips_paid',        round(v_chips, 2),
    'parked_completing', v_parked,
    'tournament_ids',    to_jsonb(v_ids));
END;
$function$
;

DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_prune_ca_hand_facts(integer)'::regprocedure)) IS DISTINCT FROM '0acdc161756e9a62b99c5d02854aa92d' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_prune_ca_hand_facts(integer)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'horse_retention_consumer_changed'; END IF; END $$;

CREATE OR REPLACE FUNCTION public.fn_prune_ca_hand_facts(p_limit integer DEFAULT 200000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_days    integer;
  v_cutoff  timestamptz;
  v_deleted integer;
  v_lim     integer;
BEGIN
  v_lim := GREATEST(COALESCE(p_limit, 200000), 1);

  SELECT COALESCE(horse_retention_days, 8) INTO v_days
    FROM public.hand_history_retention_policy LIMIT 1;
  v_days := GREATEST(COALESCE(v_days, 8), 1);
  v_cutoff := now() - make_interval(days => v_days);

  WITH doomed AS (
    SELECT f.hand_id, f.user_id
      FROM public.ca_hand_facts f
      JOIN public.profiles p ON p.id = f.user_id
     WHERE COALESCE(p.is_horse, false)
       AND f.played_at < v_cutoff
     LIMIT v_lim
  )
  DELETE FROM public.ca_hand_facts f
   USING doomed d
   WHERE f.hand_id = d.hand_id AND f.user_id = d.user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'deleted', v_deleted,
    'cutoff', v_cutoff,
    'retention_days', v_days,
    'more', v_deleted >= v_lim
  );
END;
$function$
;

DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_hand_history_prune_backlog()'::regprocedure)) IS DISTINCT FROM 'd41c2c0bbc8fe52e2079a58bc75e43b5' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_hand_history_prune_backlog()'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'horse_retention_consumer_changed'; END IF; END $$;

CREATE OR REPLACE FUNCTION public.fn_hand_history_prune_backlog()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH pol AS (
    SELECT greatest(coalesce(horse_retention_days, 8), 1) AS days
      FROM public.hand_history_retention_policy LIMIT 1
  ), cap AS (
    SELECT count(*) AS n
      FROM (
        SELECT 1
          FROM public.hand_history
         WHERE created_at < now() - make_interval(days => (SELECT days FROM pol))
           AND has_human IS DISTINCT FROM true
           AND reported IS NOT true
         LIMIT 200000
      ) z
  )
  SELECT jsonb_build_object(
    'retention_days',     (SELECT days FROM pol),
    'prunable_backlog',   (SELECT n FROM cap),
    'backlog_capped_at',  200000,
    'backlog_is_capped',  ((SELECT n FROM cap) >= 200000),
    'oldest_prunable',    (SELECT min(created_at) FROM public.hand_history
                            WHERE created_at < now() - make_interval(days => (SELECT days FROM pol))
                              AND has_human IS DISTINCT FROM true
                              AND reported IS NOT true),
    'measured_at',        now()
  );
$function$
;

DO $$ BEGIN IF md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure)) IS DISTINCT FROM '8a5858c8586296d772add9e233abc269' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.sp_prune_hand_history(integer)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'horse_retention_consumer_changed'; END IF; END $$;

CREATE OR REPLACE FUNCTION public.sp_prune_hand_history(p_batch integer DEFAULT 2500)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_budget constant interval := interval '20 seconds';
  v_deadline timestamptz := clock_timestamp()+v_budget;
  v_days integer;
  v_window interval;
  v_doomed uuid[];
  v_keepers uuid[];
  v_deleted integer := 0;
  v_round integer;
BEGIN
  SELECT greatest(coalesce(horse_retention_days,8),1)
    INTO v_days FROM public.hand_history_retention_policy LIMIT 1;
  IF v_days IS NULL THEN v_days := 8; END IF;
  v_window := make_interval(days=>v_days);

  LOOP
    v_doomed := NULL;
    v_keepers := NULL;
    WITH candidates AS (
      SELECT hh.id,hh.players
        FROM public.hand_history hh
       WHERE hh.has_human IS DISTINCT FROM true
         AND hh.reported IS NOT true
         AND hh.created_at<now()-v_window
         AND NOT EXISTS (
           SELECT 1 FROM public.bbj_payouts bp
            WHERE bp.table_id=hh.table_id AND bp.hand_number=hh.hand_number)
         AND NOT EXISTS (
           SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=hh.id)
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_knockout_candidates c
            WHERE c.hand_id=hh.id AND c.state='pending')
         -- Missing/blank classification or conflicting ownership stays retained.
         -- A known Spin's history remains evidence until canonical terminal
         -- state commits; do not require a first legacy receipt to exist.
         AND EXISTS (
           SELECT 1 FROM public.tables tb
           LEFT JOIN public.tournaments t ON t.id=tb.tournament_id
            WHERE tb.id=hh.table_id
              AND (hh.tournament_id IS NULL
                   OR hh.tournament_id=tb.tournament_id)
              AND (
                (hh.tournament_id IS NULL AND tb.tournament_id IS NULL)
                OR (
                  t.id IS NOT NULL
                  AND NULLIF(btrim(t.variant::text),'') IS NOT NULL
                  AND NULLIF(btrim(t.tournament_type::text),'') IS NOT NULL
                  AND (
                    (lower(t.variant::text)<>'spin'
                     AND upper(t.tournament_type::text)<>'SPIN')
                    OR (upper(COALESCE(t.status::text,''))='COMPLETED'
                        AND EXISTS (
                          SELECT 1 FROM public.tournament_terminal_settlements terminal
                           WHERE terminal.tournament_id=t.id))
                    OR (upper(COALESCE(t.status::text,'')) IN ('CANCELLED','CANCELED')
                        AND EXISTS (
                          SELECT 1 FROM public.tournament_cancellation_receipts cancellation
                           WHERE cancellation.tournament_id=t.id))
                  )
                )
              )
         )
       ORDER BY hh.created_at
       LIMIT p_batch
       FOR UPDATE SKIP LOCKED
    ), classified AS (
      SELECT c.id,
        CASE
          WHEN jsonb_typeof(c.players) IS DISTINCT FROM 'array' THEN true
          WHEN jsonb_array_length(c.players)=0 THEN true
          ELSE EXISTS (
            SELECT 1
              FROM jsonb_array_elements(c.players) e
              LEFT JOIN public.profiles p ON p.id=(CASE
                WHEN length(e.value->>'userId')=36
                 AND (e.value->>'userId') ~
                   '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN (e.value->>'userId')::uuid END)
             WHERE p.id IS NULL OR p.is_horse IS NOT true)
        END AS is_human
        FROM candidates c
    )
    SELECT array_agg(id) FILTER (WHERE is_human IS false),
           array_agg(id) FILTER (WHERE is_human IS DISTINCT FROM false)
      INTO v_doomed,v_keepers FROM classified;

    EXIT WHEN v_doomed IS NULL AND v_keepers IS NULL;
    IF v_keepers IS NOT NULL AND cardinality(v_keepers)>0 THEN
      UPDATE public.hand_history SET has_human=true WHERE id=ANY(v_keepers);
    END IF;
    IF v_doomed IS NOT NULL AND cardinality(v_doomed)>0 THEN
      DELETE FROM public.rake_attributions WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.hand_atomic_commits WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.hand_history WHERE id=ANY(v_doomed);
      GET DIAGNOSTICS v_round=ROW_COUNT;
      v_deleted := v_deleted+v_round;
    END IF;
    EXIT WHEN clock_timestamp()>=v_deadline;
  END LOOP;
  RETURN v_deleted;
END;
$function$
;

COMMIT;
