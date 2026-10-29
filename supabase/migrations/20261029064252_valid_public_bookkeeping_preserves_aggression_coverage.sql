-- Reserved by scripts/new-migration.mjs.
-- Public RIT boards and forced bomb antes are bookkeeping, not player bets.
-- Preserve the helper OID/ACL, existing original-insert trigger and historical NULLs.
-- @live-proof: public.ca_fact_aggression_counts('[{"userId":"system","seat":0,"stage":"river","timestamp":1,"action":"rit_board_2:Jhearts,9clubs,Qdiamonds,7diamonds,9hearts"}]'::jsonb,'20000000-0000-0000-0000-000000000001'::uuid,2)=jsonb_build_object('bets_raises',0,'calls',0)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
CREATE OR REPLACE FUNCTION public.ca_fact_aggression_counts(p_actions jsonb,p_user uuid,p_big_blind numeric DEFAULT 0)
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
     ('fold','check','call','bet','raise','all_in','allin','sb','bb','post','blind','post_sb','post_bb','small_blind','big_blind','straddle','kill_blind','ante','post_ante','dead_blind','bring_in','return','bomb_ante')
     AND NOT coalesce((action ~ '^rit_board_[23]:([2-9tjqka](hearts|diamonds|clubs|spades),){4}[2-9tjqka](hearts|diamonds|clubs|spades)$'
       AND actor='system' AND stage='river' AND a->'seat'='0'::jsonb
       AND CASE WHEN jsonb_typeof(a->'timestamp')='number' AND a->>'timestamp' ~ '^[0-9]+$' THEN (a->>'timestamp')::numeric<=9007199254740991 ELSE false END
       AND (SELECT count(DISTINCT card) FROM unnest(string_to_array(split_part(action,':',2),',')) card)=5),false)
     OR (action='bomb_ante' AND (a->>'origin' IS DISTINCT FROM 'forced' OR a->'dead' IS DISTINCT FROM 'true'::jsonb
       OR stage IS DISTINCT FROM 'preflop' OR amount IS NULL OR amount<=0))
     OR stage IS NULL OR stage='' OR actor IS NULL OR actor=''
     OR (action IN ('bet','raise','all_in','allin') AND (amount IS NULL OR amount<=0)))
  THEN NULL ELSE jsonb_build_object(
   'bets_raises',count(*) FILTER(WHERE actor=p_user::text AND voluntary AND
    (action IN ('bet','raise') OR (action IN ('all_in','allin') AND amount>prior_level))),
   'calls',count(*) FILTER(WHERE actor=p_user::text AND voluntary AND
    (action='call' OR (action IN ('all_in','allin') AND amount<=prior_level)))) END
 FROM levels;
$function$;

COMMIT;
