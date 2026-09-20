CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(current_setting('test.engine',true),'true')='true'$$;
CREATE TABLE public.clubs(id uuid PRIMARY KEY,union_id uuid,is_union boolean);
CREATE TABLE public.rake_records(id uuid PRIMARY KEY,hand_id uuid,club_id uuid,table_id uuid,rake_amount numeric,is_tournament boolean,tournament_id uuid,created_at timestamptz,metadata jsonb);
CREATE TABLE public.rake_attributions(id uuid PRIMARY KEY,rake_record_id uuid,hand_id uuid,player_id uuid,club_id uuid,weighted_rake_credit numeric,UNIQUE(hand_id,player_id));
CREATE TABLE public.rakeback_periods(id uuid PRIMARY KEY,user_id uuid,club_id uuid,period_start date,period_end date,status text,rake_generated numeric,rakeback_amount numeric);
CREATE TABLE public.hand_history(id uuid,table_id uuid,hand_number bigint);
CREATE OR REPLACE FUNCTION public.fn_rake_record_is_ghost_twin(p_hand_id uuid, p_table_id uuid, p_metadata jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  /* A null-hand rake_records row is a ghost twin when the same table carries a
     LINKED row for the same GLOBAL hand number. Hand numbers are unique only
     from 1,000,000 up (uq_hand_history_global_hand_number); below that they
     recurred per table before 2026-07-31 and a match proves nothing. */
  SELECT p_hand_id IS NULL
     AND p_table_id IS NOT NULL
     AND COALESCE(p_metadata->>'hand_number', '') ~ '^[0-9]{1,18}$'
     AND (p_metadata->>'hand_number')::bigint >= 1000000
     AND EXISTS (SELECT 1 FROM public.rake_records l
                  WHERE l.table_id = p_table_id AND l.hand_id IS NOT NULL
                    AND l.metadata->>'hand_number' = p_metadata->>'hand_number');
$function$;
