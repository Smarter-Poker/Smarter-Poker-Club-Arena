-- 20261003142109_stats_exact_cash_sessions.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.cash_player_session
  ADD COLUMN IF NOT EXISTS final_stack numeric(14,2),
  ADD COLUMN IF NOT EXISTS final_stack_captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS financial_capture_status text NOT NULL DEFAULT 'legacy_unavailable',
  ADD COLUMN IF NOT EXISTS close_table_id uuid;

ALTER TABLE public.cash_player_session
  DROP CONSTRAINT IF EXISTS cash_player_session_final_stack_nonnegative,
  DROP CONSTRAINT IF EXISTS cash_player_session_capture_status_valid,
  DROP CONSTRAINT IF EXISTS cash_player_session_exact_capture_complete;
ALTER TABLE public.cash_player_session
  ADD CONSTRAINT cash_player_session_final_stack_nonnegative
    CHECK (final_stack IS NULL OR final_stack >= 0),
  ADD CONSTRAINT cash_player_session_capture_status_valid
    CHECK (financial_capture_status IN ('open','exact','partial','legacy_unavailable')),
  ADD CONSTRAINT cash_player_session_exact_capture_complete
    CHECK (financial_capture_status <> 'exact' OR
      (closed_at IS NOT NULL AND final_stack IS NOT NULL AND final_stack_captured_at IS NOT NULL));

COMMENT ON COLUMN public.cash_player_session.final_stack IS
  'Authoritative chips remaining at the original close event. Never inferred from hands or wallet deltas.';
COMMENT ON COLUMN public.cash_player_session.financial_capture_status IS
  'open for a post-migration live session, exact only when the close owner captured final_stack, partial when the close event lacked a seat stack, legacy_unavailable for earlier rows.';

CREATE OR REPLACE FUNCTION public.trg_fn_cash_session_capture_open()
RETURNS trigger LANGUAGE plpgsql SET search_path='public' AS $function$
BEGIN
  NEW.financial_capture_status := 'open';
  NEW.final_stack := NULL;
  NEW.final_stack_captured_at := NULL;
  NEW.close_table_id := NULL;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS aa_cash_session_capture_open ON public.cash_player_session;
CREATE TRIGGER aa_cash_session_capture_open
  BEFORE INSERT ON public.cash_player_session
  FOR EACH ROW EXECUTE FUNCTION public.trg_fn_cash_session_capture_open();

-- Patch the current close owner instead of copying its security and rathole
-- logic. Refuse source drift so a later close implementation is never silently
-- replaced by an outdated body.
DO $migration$
DECLARE
  v_def text;
  v_anchor text := 'SET closed_at = v_now, closed_reason = COALESCE(p_reason, ''leave'')';
  v_replacement text := 'SET closed_at = v_now, closed_reason = COALESCE(p_reason, ''leave''),'
    || ' final_stack = CASE WHEN p_stack IS NULL THEN NULL ELSE round(greatest(p_stack, 0), 2) END,'
    || ' final_stack_captured_at = CASE WHEN p_stack IS NULL THEN NULL ELSE v_now END,'
    || ' financial_capture_status = CASE WHEN p_stack IS NULL THEN ''partial'' ELSE ''exact'' END,'
    || ' close_table_id = p_table_id';
BEGIN
  v_def := pg_get_functiondef('public.fn_cash_session_close(uuid,uuid,numeric,text)'::regprocedure);
  IF (length(v_def)-length(replace(v_def,v_anchor,''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'fn_cash_session_close source drift: exact capture anchor missing or repeated';
  END IF;
  EXECUTE replace(v_def,v_anchor,v_replacement);
END;
$migration$;

CREATE OR REPLACE FUNCTION public.trg_fn_close_session_when_seat_vacated()
RETURNS trigger LANGUAGE plpgsql SET search_path='public' AS $function$
BEGIN
  IF OLD.left_at IS NULL AND NEW.left_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.tables t WHERE t.id=NEW.table_id AND t.tournament_id IS NULL) THEN
    UPDATE public.cash_player_session
       SET closed_at=clock_timestamp(), closed_reason='seat_vacated',
           final_stack=round(greatest(coalesce(NEW.stack,0),0),2),
           final_stack_captured_at=clock_timestamp(), financial_capture_status='exact',
           close_table_id=NEW.table_id
     WHERE player_id=NEW.user_id AND scope_type='table'
       AND scope_id=NEW.table_id AND closed_at IS NULL;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_fn_close_sessions_when_table_closes()
RETURNS trigger LANGUAGE plpgsql SET search_path='public' AS $function$
BEGIN
  IF (NEW.status='closed' AND OLD.status IS DISTINCT FROM 'closed')
     OR (coalesce(NEW.is_deleted,false) AND NOT coalesce(OLD.is_deleted,false)) THEN
    UPDATE public.cash_player_session s
       SET closed_at=clock_timestamp(), closed_reason='table_closed',
           final_stack=(SELECT round(greatest(ts.stack,0),2)
             FROM public.table_seats ts
            WHERE ts.table_id=NEW.id AND ts.user_id=s.player_id AND ts.left_at IS NULL
            ORDER BY ts.joined_at DESC NULLS LAST,ts.id DESC LIMIT 1),
           final_stack_captured_at=clock_timestamp(),
           financial_capture_status='exact', close_table_id=NEW.id
     WHERE s.scope_type='table' AND s.scope_id=NEW.id AND s.closed_at IS NULL
       AND EXISTS (SELECT 1 FROM public.table_seats ts
         WHERE ts.table_id=NEW.id AND ts.user_id=s.player_id AND ts.left_at IS NULL);

    -- FROM LATERAL does not update a row when its seat is already gone.
    UPDATE public.cash_player_session s
       SET closed_at=clock_timestamp(), closed_reason='table_closed',
           final_stack=NULL, final_stack_captured_at=NULL,
           financial_capture_status='partial', close_table_id=NEW.id
     WHERE s.scope_type='table' AND s.scope_id=NEW.id AND s.closed_at IS NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE INDEX IF NOT EXISTS cash_player_session_player_window
  ON public.cash_player_session(player_id, opened_at DESC, id);

CREATE OR REPLACE FUNCTION public.ca_player_stats_cash_sessions(
  p_user uuid,
  p_club_id uuid DEFAULT NULL,
  p_days integer DEFAULT NULL,
  p_tz text DEFAULT 'UTC',
  p_asset text DEFAULT 'chips',
  p_limit integer DEFAULT 100
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='public'
AS $function$
DECLARE
  v_days integer;
  v_tz text;
  v_from timestamptz;
  v_to timestamptz;
  v_limit integer := least(greatest(coalesce(p_limit,100),1),250);
  v_total integer;
  v_exact integer;
  v_partial integer;
  v_rows jsonb;
BEGIN
  PERFORM public.ca_assert_self(p_user);
  IF p_asset IS NULL OR p_asset NOT IN ('chips','diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %',p_asset USING ERRCODE='22023';
  END IF;
  IF p_club_id IS NOT NULL THEN
    PERFORM public.ca_assert_player_stats_club(p_user,p_club_id,p_asset);
  END IF;
  SELECT range_days,range_tz,from_at,to_at INTO v_days,v_tz,v_from,v_to
    FROM public.ca_stats_calendar_bounds(p_days,p_tz,now());

  WITH eligible AS MATERIALIZED (
    SELECT c.id
      FROM public.club_members m JOIN public.clubs c ON c.id=m.club_id
     WHERE m.user_id=p_user AND m.status IN ('active','approved')
       AND coalesce(c.lifecycle_status,'active')<>'retired'
       AND coalesce(c.asset,'chips')=p_asset
       AND (p_club_id IS NULL OR c.id=p_club_id)
  ), scoped AS MATERIALIZED (
    SELECT s.*
      FROM public.cash_player_session s JOIN eligible e ON e.id=s.club_id
     WHERE s.player_id=p_user
       AND (v_from IS NULL OR coalesce(s.closed_at,s.opened_at)>=v_from)
       AND (v_to IS NULL OR s.opened_at<v_to)
  ) SELECT count(*)::integer,
      count(*) FILTER (WHERE financial_capture_status='exact')::integer,
      count(*) FILTER (WHERE financial_capture_status IN ('partial','legacy_unavailable'))::integer
    INTO v_total,v_exact,v_partial FROM scoped;

  WITH eligible AS MATERIALIZED (
    SELECT c.id
      FROM public.club_members m JOIN public.clubs c ON c.id=m.club_id
     WHERE m.user_id=p_user AND m.status IN ('active','approved')
       AND coalesce(c.lifecycle_status,'active')<>'retired'
       AND coalesce(c.asset,'chips')=p_asset
       AND (p_club_id IS NULL OR c.id=p_club_id)
  ), scoped AS MATERIALIZED (
    SELECT s.*
      FROM public.cash_player_session s JOIN eligible e ON e.id=s.club_id
     WHERE s.player_id=p_user
       AND (v_from IS NULL OR coalesce(s.closed_at,s.opened_at)>=v_from)
       AND (v_to IS NULL OR s.opened_at<v_to)
     ORDER BY s.opened_at DESC,s.id DESC LIMIT v_limit
  ), measured AS (
    SELECT s.*,
      (SELECT count(*)::integer FROM public.cash_player_session o
        WHERE o.player_id=s.player_id AND o.id<>s.id AND o.club_id=s.club_id
          AND ((s.cluster_id IS NOT NULL AND o.cluster_id=s.cluster_id)
               OR (s.cluster_id IS NULL AND o.cluster_id IS NULL AND o.table_id=s.table_id))
          AND tstzrange(o.opened_at,coalesce(o.closed_at,'infinity'),'[)') &&
              tstzrange(s.opened_at,coalesce(s.closed_at,'infinity'),'[)')) overlap_count,
      (SELECT count(*)::integer FROM public.ca_hand_facts f
         LEFT JOIN public.tables ft ON ft.id=f.table_id
        WHERE f.user_id=s.player_id AND f.club_id=s.club_id AND f.tournament_id IS NULL
          AND f.played_at>=s.opened_at AND f.played_at<coalesce(s.closed_at,'infinity')
          AND ((s.cluster_id IS NOT NULL AND ft.cluster_id=s.cluster_id)
               OR (s.cluster_id IS NULL AND f.table_id=s.table_id))) fact_hands,
      (SELECT coalesce(sum(f.net),0) FROM public.ca_hand_facts f
         LEFT JOIN public.tables ft ON ft.id=f.table_id
        WHERE f.user_id=s.player_id AND f.club_id=s.club_id AND f.tournament_id IS NULL
          AND f.played_at>=s.opened_at AND f.played_at<coalesce(s.closed_at,'infinity')
          AND ((s.cluster_id IS NOT NULL AND ft.cluster_id=s.cluster_id)
               OR (s.cluster_id IS NULL AND f.table_id=s.table_id))) fact_net
      FROM scoped s
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'session_id',id,'club_id',club_id,'table_id',table_id,'cluster_id',cluster_id,
    'variant',variant,'small_blind',sb,'big_blind',bb,
    'opened_at',opened_at,'closed_at',closed_at,'closed_reason',closed_reason,
    'duration_seconds',CASE WHEN closed_at IS NULL THEN NULL ELSE greatest(extract(epoch from closed_at-opened_at)::bigint,0) END,
    'buyin_and_rebuys',baseline,
    'final_cashout',CASE WHEN financial_capture_status='exact' THEN final_stack ELSE NULL END,
    'session_result',CASE WHEN financial_capture_status='exact' THEN final_stack-baseline ELSE NULL END,
    'capture_status',financial_capture_status,
    'capture_reason',CASE financial_capture_status WHEN 'open' THEN 'session_open' WHEN 'partial' THEN 'close_stack_unavailable' WHEN 'legacy_unavailable' THEN 'legacy_session_predates_exact_capture' ELSE NULL END,
    'hand_count',CASE WHEN overlap_count=0 THEN fact_hands ELSE NULL END,
    'hand_net',CASE WHEN overlap_count=0 THEN fact_net ELSE NULL END,
    'hand_evidence_status',CASE WHEN overlap_count>0 THEN 'overlap_unavailable' ELSE 'exact_facts' END,
    'overlap',overlap_count>0,'overlap_count',overlap_count,
    'evidence',jsonb_build_object('kind','cash_session','session_id',id)
  ) ORDER BY opened_at DESC,id DESC),'[]'::jsonb) INTO v_rows FROM measured;

  RETURN jsonb_build_object(
    'contract_version',2,
    'scope',jsonb_build_object('target_user_id',p_user,'club_id',p_club_id,'asset',p_asset,
      'range_days',v_days,'range_tz',v_tz,'from',v_from,'to',v_to,'visibility','owner'),
    'coverage',jsonb_build_object('source','cash_player_session+ca_hand_facts',
      'total_sessions',v_total,'returned_sessions',jsonb_array_length(v_rows),
      'capped',v_total>v_limit,
      'exact_sessions',v_exact,
      'legacy_or_partial_sessions',v_partial),
    'sessions',v_rows,'generated_at',now());
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_player_stats_cash_sessions(uuid,uuid,integer,text,text,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_cash_sessions(uuid,uuid,integer,text,text,integer)
  TO authenticated,service_role;

COMMIT;
