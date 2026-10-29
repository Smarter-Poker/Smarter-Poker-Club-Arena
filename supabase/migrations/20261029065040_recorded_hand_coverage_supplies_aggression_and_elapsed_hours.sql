-- Retained public evidence is read at request time; historical facts are never rewritten.
-- Cold interval storage has no foreign key to a live table.
-- @live-proof: to_regclass('public.ca_hand_stat_intervals') IS NOT NULL AND position('ca_player_recorded_hand_coverage' in pg_get_functiondef('public.ca_player_stats_overview_v2_by_club(uuid,integer,text,text,uuid)'::regprocedure))>0 AND position('ca_player_recorded_hand_coverage' in pg_get_functiondef('public.ca_player_stats_overview_v2(uuid,integer,text,text)'::regprocedure))>0 AND position('ca_hand_stat_intervals' in pg_get_functiondef('public.ca_capture_fact_aggression_counts()'::regprocedure))>0
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
CREATE TABLE public.ca_hand_stat_intervals (
 hand_id uuid PRIMARY KEY,
 started_at timestamptz NOT NULL,
 ended_at timestamptz NOT NULL,
 CHECK (isfinite(started_at) AND isfinite(ended_at) AND ended_at>started_at)
);
ALTER TABLE public.ca_hand_stat_intervals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_hand_stat_intervals FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.ca_hand_stat_intervals TO service_role;

CREATE OR REPLACE FUNCTION public.ca_capture_fact_aggression_counts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $capture$
DECLARE v_actions jsonb; v_counts jsonb; v_big_blind numeric; v_start timestamptz; v_end timestamptz;
BEGIN
 SELECT h.actions,h.big_blind,h.started_at,h.ended_at INTO v_actions,v_big_blind,v_start,v_end
 FROM public.hand_history h WHERE h.id=NEW.hand_id;
 v_counts:=public.ca_fact_aggression_counts(v_actions,NEW.user_id,v_big_blind);
 NEW.af_bet_raise_actions:=(v_counts->>'bets_raises')::smallint;
 NEW.af_call_actions:=(v_counts->>'calls')::smallint;
 IF isfinite(v_start) AND isfinite(v_end) AND v_end>v_start THEN
  INSERT INTO public.ca_hand_stat_intervals(hand_id,started_at,ended_at)
  VALUES(NEW.hand_id,v_start,v_end) ON CONFLICT(hand_id) DO NOTHING;
 END IF;
 RETURN NEW;
END;
$capture$;

-- Input is the full population already selected and authorized by the owning reader.
-- Paired persisted counts remain authoritative; no scan/rewrite of historical facts.
CREATE FUNCTION public.ca_player_recorded_hand_coverage(
 p_user uuid,p_hands jsonb,p_from timestamptz DEFAULT NULL,p_to timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $coverage$
 WITH requested AS MATERIALIZED (
  SELECT x.hand_id,x.bets,x.calls,x.is_cash FROM jsonb_to_recordset(coalesce(p_hands,'[]'::jsonb))
   x(hand_id uuid,bets integer,calls integer,is_cash boolean)
 ), evidence AS MATERIALIZED (
  SELECT r.hand_id,r.is_cash,
   CASE WHEN r.bets IS NOT NULL AND r.calls IS NOT NULL AND r.bets>=0 AND r.calls>=0
    THEN jsonb_build_object('bets_raises',r.bets,'calls',r.calls)
    ELSE public.ca_fact_aggression_counts(h.actions,p_user,h.big_blind) END af,
   coalesce(i.started_at,CASE WHEN isfinite(h.started_at) AND isfinite(h.ended_at) AND h.ended_at>h.started_at THEN h.started_at END) start_at,
   coalesce(i.ended_at,CASE WHEN isfinite(h.started_at) AND isfinite(h.ended_at) AND h.ended_at>h.started_at THEN h.ended_at END) end_at
  FROM requested r LEFT JOIN public.ca_hand_stat_intervals i ON i.hand_id=r.hand_id
  LEFT JOIN public.hand_history h ON h.id=r.hand_id
 ), totals AS (
  SELECT count(*) hands,count(af) af_hands,count(start_at) interval_hands,
   coalesce(sum((af->>'bets_raises')::integer),0) bets,
   coalesce(sum((af->>'calls')::integer),0) calls,count(*) FILTER(WHERE is_cash) cash_hands,count(start_at) FILTER(WHERE is_cash) cash_interval_hands FROM evidence
 ), clipped AS (
  SELECT hand_id,kind,greatest(start_at,p_from) s,least(end_at,p_to) e FROM evidence CROSS JOIN (VALUES('all'),('cash')) buckets(kind)
  WHERE start_at IS NOT NULL AND end_at IS NOT NULL AND (kind='all' OR is_cash)
 ), ordered AS (
  SELECT hand_id,kind,s,e,max(e) OVER(PARTITION BY kind ORDER BY s,e,hand_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) previous_max
  FROM clipped WHERE e>s
 ), marked AS (
  SELECT *,sum(CASE WHEN previous_max IS NULL OR s>previous_max THEN 1 ELSE 0 END)
   OVER(PARTITION BY kind ORDER BY s,e,hand_id ROWS UNBOUNDED PRECEDING) island FROM ordered
 ), merged AS (SELECT kind,min(s) s,max(e) e FROM marked GROUP BY kind,island), elapsed AS (
  SELECT coalesce(sum(extract(epoch FROM(e-s))) FILTER(WHERE kind='all'),0) seconds,coalesce(sum(extract(epoch FROM(e-s))) FILTER(WHERE kind='cash'),0) cash_seconds FROM merged
 ) SELECT jsonb_build_object(
  'aggression_factor',CASE WHEN hands>0 AND af_hands=hands AND calls>0 THEN round(bets::numeric/calls,2) ELSE 0 END,
  'hours_played',CASE WHEN hands>0 AND interval_hands=hands THEN round(seconds/3600,9) ELSE 0 END,
  'cash_hours_played',CASE WHEN cash_hands>0 AND cash_interval_hands=cash_hands THEN round(cash_seconds/3600,9) ELSE 0 END,
  'metric_availability',jsonb_build_object(
   'cash_hours_played',cash_hands>0 AND cash_interval_hands=cash_hands,
   'aggression_factor',hands>0 AND af_hands=hands AND calls>0,
   'aggression_factor_denominator',calls,
   'hours_played',hands>0 AND interval_hands=hands),
  'recorded_coverage',jsonb_build_object('hands',hands,'af_hands',af_hands,'interval_hands',interval_hands,
   'hours_source','recorded_hand_interval_union','elapsed_seconds',seconds,'cash_elapsed_seconds',cash_seconds,'cash_hands',cash_hands,'cash_interval_hands',cash_interval_hands)) FROM totals CROSS JOIN elapsed;
$coverage$;
REVOKE ALL ON FUNCTION public.ca_player_recorded_hand_coverage(uuid,jsonb,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_recorded_hand_coverage(uuid,jsonb,timestamptz,timestamptz) TO service_role;

DO $patch$
DECLARE d text; BEGIN
 d:=pg_get_functiondef('public.ca_player_stats_overview_v2_by_club(uuid,integer,text,text,uuid)'::regprocedure);

 IF position($old$SELECT user_id,played_at,tournament_id$old$ in d)=0 THEN RAISE EXCEPTION 'Recorded coverage reader anchor 0/0 changed'; END IF;
 d:=replace(d,$old$SELECT user_id,played_at,tournament_id$old$,$new$SELECT hand_id,user_id,played_at,tournament_id$new$);

 IF position($old$), scored AS MATERIALIZED ($old$ in d)=0 THEN RAISE EXCEPTION 'Recorded coverage reader anchor 0/1 changed'; END IF;
 d:=replace(d,$old$), scored AS MATERIALIZED ($old$,$new$), recorded_coverage AS MATERIALIZED (SELECT public.ca_player_recorded_hand_coverage(p_user,coalesce(jsonb_agg(jsonb_build_object('hand_id',hand_id,'is_cash',tournament_id IS NULL,'bets',af_bet_raise_actions,'calls',af_call_actions)),'[]'::jsonb),v_from,v_to) m FROM filtered), scored AS MATERIALIZED ($new$);

 IF position($old$'aggression_factor', af_measured_hands=hands AND passive>0$old$ in d)=0 THEN RAISE EXCEPTION 'Recorded coverage reader anchor 0/2 changed'; END IF;
 d:=replace(d,$old$'aggression_factor', af_measured_hands=hands AND passive>0$old$,$new$'aggression_factor', (SELECT (m#>>'{metric_availability,aggression_factor}')::boolean FROM recorded_coverage)$new$);

 IF position($old$'aggression_factor_denominator', passive$old$ in d)=0 THEN RAISE EXCEPTION 'Recorded coverage reader anchor 0/3 changed'; END IF;
 d:=replace(d,$old$'aggression_factor_denominator', passive$old$,$new$'aggression_factor_denominator', (SELECT (m#>>'{metric_availability,aggression_factor_denominator}')::numeric FROM recorded_coverage)$new$);

 IF position($old$'hours_played', false$old$ in d)=0 THEN RAISE EXCEPTION 'Recorded coverage reader anchor 0/4 changed'; END IF;
 d:=replace(d,$old$'hours_played', false$old$,$new$'cash_hours_played', (SELECT (m#>>'{metric_availability,cash_hours_played}')::boolean FROM recorded_coverage),'hours_played', (SELECT (m#>>'{metric_availability,hours_played}')::boolean FROM recorded_coverage)$new$);

 IF position($old$'aggression_factor', coalesce(round(aggro::numeric / nullif(passive, 0), 2), 0)$old$ in d)=0 THEN RAISE EXCEPTION 'Recorded coverage reader anchor 0/5 changed'; END IF;
 d:=replace(d,$old$'aggression_factor', coalesce(round(aggro::numeric / nullif(passive, 0), 2), 0)$old$,$new$'aggression_factor', (SELECT (m->>'aggression_factor')::numeric FROM recorded_coverage)$new$);

 IF position($old$'hours_played', 0, 'hand_cap'$old$ in d)=0 THEN RAISE EXCEPTION 'Recorded coverage reader anchor 0/6 changed'; END IF;
 d:=replace(d,$old$'hours_played', 0, 'hand_cap'$old$,$new$'cash_hours_played', (SELECT (m->>'cash_hours_played')::numeric FROM recorded_coverage),'hours_played', (SELECT (m->>'hours_played')::numeric FROM recorded_coverage), 'hand_cap'$new$);

 IF position($old$'metric_availability', (SELECT jsonb_build_object($old$ in d)=0 THEN RAISE EXCEPTION 'Recorded coverage reader anchor 0/7 changed'; END IF;
 d:=replace(d,$old$'metric_availability', (SELECT jsonb_build_object($old$,$new$'recorded_hand_coverage', (SELECT m->'recorded_coverage' FROM recorded_coverage), 'metric_availability', (SELECT jsonb_build_object($new$);

 EXECUTE d; END;
$patch$;


DO $patch$
DECLARE d text; BEGIN
 d:=pg_get_functiondef('public.ca_player_stats_overview_v2(uuid,integer,text,text)'::regprocedure);

 IF position($old$  )
  SELECT count(*)::integer$old$ in d)=0 THEN RAISE EXCEPTION 'Recorded coverage reader anchor 1/0 changed'; END IF;
 d:=replace(d,$old$  )
  SELECT count(*)::integer$old$,$new$  ), recorded_coverage AS MATERIALIZED (SELECT public.ca_player_recorded_hand_coverage(p_user,coalesce(jsonb_agg(jsonb_build_object('hand_id',hand_id,'is_cash',is_cash,'bets',af_bet_raise_actions,'calls',af_call_actions)),'[]'::jsonb),v_from,v_to) m FROM source_rows)
  SELECT count(*)::integer$new$);

 IF position($old$'aggression_factor',coalesce(round(sum(af_bet_raise_actions)::numeric/nullif(sum(af_call_actions),0),2),0)$old$ in d)=0 THEN RAISE EXCEPTION 'Recorded coverage reader anchor 1/1 changed'; END IF;
 d:=replace(d,$old$'aggression_factor',coalesce(round(sum(af_bet_raise_actions)::numeric/nullif(sum(af_call_actions),0),2),0)$old$,$new$'recorded_hand_coverage',(SELECT m->'recorded_coverage' FROM recorded_coverage),'cash_hours_played',(SELECT (m->>'cash_hours_played')::numeric FROM recorded_coverage),'hours_played',(SELECT (m->>'hours_played')::numeric FROM recorded_coverage),'aggression_factor',(SELECT (m->>'aggression_factor')::numeric FROM recorded_coverage)$new$);

 IF position($old$'aggression_factor',count(*) FILTER(WHERE af_bet_raise_actions IS NOT NULL AND af_call_actions IS NOT NULL)=count(*) AND coalesce(sum(af_call_actions),0)>0$old$ in d)=0 THEN RAISE EXCEPTION 'Recorded coverage reader anchor 1/2 changed'; END IF;
 d:=replace(d,$old$'aggression_factor',count(*) FILTER(WHERE af_bet_raise_actions IS NOT NULL AND af_call_actions IS NOT NULL)=count(*) AND coalesce(sum(af_call_actions),0)>0$old$,$new$'aggression_factor',(SELECT (m#>>'{metric_availability,aggression_factor}')::boolean FROM recorded_coverage)$new$);

 IF position($old$'aggression_factor_denominator',coalesce(sum(af_call_actions),0)$old$ in d)=0 THEN RAISE EXCEPTION 'Recorded coverage reader anchor 1/3 changed'; END IF;
 d:=replace(d,$old$'aggression_factor_denominator',coalesce(sum(af_call_actions),0)$old$,$new$'aggression_factor_denominator',(SELECT (m#>>'{metric_availability,aggression_factor_denominator}')::numeric FROM recorded_coverage)$new$);

 IF position($old$'hours_played',false$old$ in d)=0 THEN RAISE EXCEPTION 'Recorded coverage reader anchor 1/4 changed'; END IF;
 d:=replace(d,$old$'hours_played',false$old$,$new$'cash_hours_played',(SELECT (m#>>'{metric_availability,cash_hours_played}')::boolean FROM recorded_coverage),'hours_played',(SELECT (m#>>'{metric_availability,hours_played}')::boolean FROM recorded_coverage)$new$);

 IF position($old$v_recorded_fact_rates-'metric_availability'$old$ in d)=0 THEN RAISE EXCEPTION 'Recorded coverage reader anchor 1/5 changed'; END IF;
 d:=replace(d,$old$v_recorded_fact_rates-'metric_availability'$old$,$new$v_recorded_fact_rates-'metric_availability'-'recorded_hand_coverage'$new$);

 IF position($old$'advanced_facts_source','ca_hand_facts','metric_availability'$old$ in d)=0 THEN RAISE EXCEPTION 'Recorded coverage reader anchor 1/6 changed'; END IF;
 d:=replace(d,$old$'advanced_facts_source','ca_hand_facts','metric_availability'$old$,$new$'advanced_facts_source','ca_hand_facts','recorded_hand_coverage',v_recorded_fact_rates->'recorded_hand_coverage','metric_availability'$new$);

 EXECUTE d; END;
$patch$;


COMMIT;
