-- Reserved by scripts/new-migration.mjs.
-- @install-window: daily-maintenance
-- Existing passive_actions includes checks. Persist call-only counts in the
-- original fact insertion transaction; old/unrecorded action histories stay NULL.
-- No engine replacement, background repair or replay of player records.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
ALTER TABLE public.ca_hand_facts
 ADD COLUMN af_bet_raise_actions smallint,
 ADD COLUMN af_call_actions smallint;

CREATE FUNCTION public.ca_fact_aggression_counts(p_actions jsonb,p_user uuid,p_big_blind numeric DEFAULT 0)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp
AS $function$
 WITH ordered AS (
  SELECT a,ord,lower(a->>'action') action,lower(a->>'stage') stage,
   coalesce(a->>'userId',a->>'user_id') actor,
   CASE WHEN a->>'amount' ~ '^[0-9]+([.][0-9]+)?$' THEN (a->>'amount')::numeric END amount,
   coalesce(a->>'origin','')<>'forced' AND coalesce(a->>'dead','false')<>'true' voluntary
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_actions)='array' THEN p_actions ELSE '[]'::jsonb END)
   WITH ORDINALITY x(a,ord)
 ), levels AS (
  SELECT *,greatest(CASE WHEN stage='preflop' THEN greatest(coalesce(p_big_blind,0),0) ELSE 0 END,coalesce(max(CASE WHEN action IN ('bet','raise','all_in','allin','sb','bb','straddle','kill_blind','post_sb','post_bb','small_blind','big_blind')
    AND coalesce(a->>'dead','false')<>'true' THEN amount END)
   OVER(PARTITION BY stage ORDER BY ord ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)) prior_level
  FROM ordered
 ) SELECT CASE WHEN jsonb_typeof(p_actions) IS DISTINCT FROM 'array' OR
   jsonb_array_length(CASE WHEN jsonb_typeof(p_actions)='array' THEN p_actions ELSE '[]'::jsonb END)=0 OR p_user IS NULL
   OR EXISTS(SELECT 1 FROM ordered WHERE action IS NULL OR action NOT IN
     ('fold','check','call','bet','raise','all_in','allin','sb','bb','post','blind','post_sb','post_bb','small_blind','big_blind','straddle','kill_blind','ante','post_ante','dead_blind','bring_in')
     OR stage IS NULL OR stage='' OR actor IS NULL OR actor=''
     OR (action IN ('bet','raise','all_in','allin') AND (amount IS NULL OR amount<=0)))
  THEN NULL ELSE jsonb_build_object(
   'bets_raises',count(*) FILTER(WHERE actor=p_user::text AND voluntary AND
    (action IN ('bet','raise') OR (action IN ('all_in','allin') AND amount>prior_level))),
   'calls',count(*) FILTER(WHERE actor=p_user::text AND voluntary AND
    (action='call' OR (action IN ('all_in','allin') AND amount<=prior_level)))) END
 FROM levels;
$function$;
REVOKE ALL ON FUNCTION public.ca_fact_aggression_counts(jsonb,uuid,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ca_fact_aggression_counts(jsonb,uuid,numeric) TO service_role;

CREATE FUNCTION public.ca_capture_fact_aggression_counts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $function$
DECLARE v_actions jsonb; v_counts jsonb; v_big_blind numeric;
BEGIN
 SELECT h.actions,h.big_blind INTO v_actions,v_big_blind FROM public.hand_history h WHERE h.id=NEW.hand_id;
 v_counts:=public.ca_fact_aggression_counts(v_actions,NEW.user_id,v_big_blind);
 NEW.af_bet_raise_actions:=(v_counts->>'bets_raises')::smallint;
 NEW.af_call_actions:=(v_counts->>'calls')::smallint;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.ca_capture_fact_aggression_counts() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ca_capture_fact_aggression_counts() TO service_role;
CREATE TRIGGER ca_capture_fact_aggression_counts BEFORE INSERT ON public.ca_hand_facts
 FOR EACH ROW EXECUTE FUNCTION public.ca_capture_fact_aggression_counts();

DO $patch$
DECLARE d text;
BEGIN
 d:=pg_get_functiondef('public.ca_player_stats_overview_v2_by_club(uuid,integer,text,text,uuid)'::regprocedure);
 IF position('recorded_three_bet_opportunities' in d)=0 THEN RAISE EXCEPTION 'Recorded rate predecessor not installed'; END IF;
 d:=replace(d,'aggressive_actions,passive_actions,funded_club',
  'aggressive_actions,passive_actions,af_bet_raise_actions,af_call_actions,funded_club');
 d:=replace(d,'coalesce(sum(aggressive_actions), 0)::integer aggro,',
  'coalesce(sum(af_bet_raise_actions), 0)::integer aggro,
        count(*) FILTER(WHERE af_bet_raise_actions IS NOT NULL AND af_call_actions IS NOT NULL)::integer af_measured_hands,');
 d:=replace(d,'coalesce(sum(passive_actions), 0)::integer passive,',
  'coalesce(sum(af_call_actions), 0)::integer passive,');
 d:=replace(d,$text$'aggression_factor', false,$text$,
  $text$'aggression_factor', af_measured_hands=hands AND passive>0,$text$);
 EXECUTE d;

 d:=pg_get_functiondef('public.ca_player_stats_overview_v2(uuid,integer,text,text)'::regprocedure);
 IF position('v_recorded_fact_rates' in d)=0 THEN RAISE EXCEPTION 'Full-window rate predecessor not installed'; END IF;
 d:=replace(d,'f.won_at_showdown,', 'f.won_at_showdown,f.af_bet_raise_actions,f.af_call_actions,');
 d:=replace(d,$text$'metric_availability',jsonb_build_object($text$,
  $text$'aggression_factor',coalesce(round(sum(af_bet_raise_actions)::numeric/nullif(sum(af_call_actions),0),2),0),
      'metric_availability',jsonb_build_object($text$);
 d:=replace(d,$text$'aggression_factor',false,'aggression_factor_denominator',0,$text$,
  $text$'aggression_factor',count(*) FILTER(WHERE af_bet_raise_actions IS NOT NULL AND af_call_actions IS NOT NULL)=count(*) AND coalesce(sum(af_call_actions),0)>0,
        'aggression_factor_denominator',coalesce(sum(af_call_actions),0),$text$);
 EXECUTE d;
END $patch$;
COMMIT;
