-- Local fixture only. Table inputs are synthetic; allocation predicates below are captured repository owners.
CREATE TABLE hand_atomic_commits(hand_id uuid PRIMARY KEY,commission_capture_version integer);
CREATE TABLE rake_records(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,hand_id uuid,club_id uuid,table_id uuid,created_at timestamptz,rake_amount numeric,player_contributions jsonb,rake_method text,metadata jsonb);
CREATE TABLE rake_attributions(hand_id uuid,player_id uuid,weighted_rake_credit numeric);
CREATE OR REPLACE FUNCTION public.fn_allocate_rake_credits(
  p_amount        numeric,
  p_contributions jsonb,
  p_method        text DEFAULT 'WEIGHTED_CONTRIBUTED'
)
RETURNS TABLE(user_id uuid, credit numeric, weight numeric)
LANGUAGE sql
IMMUTABLE
AS $function$
  WITH c AS (
    SELECT (k.key)::uuid AS uid,
           round((k.value)::numeric * 100)::bigint AS cc
      FROM jsonb_each(COALESCE(p_contributions, '{}'::jsonb)) k
     WHERE jsonb_typeof(k.value) = 'number'
       AND (k.value)::numeric > 0
       AND k.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ),
  t AS (
    SELECT COALESCE(SUM(cc), 0)::bigint AS total,
           round(GREATEST(COALESCE(p_amount, 0), 0) * 100)::bigint AS amt,
           COUNT(*)::bigint AS n
      FROM c
  ),
  weighted AS (
    SELECT c.uid, c.cc,
           (t.amt * c.cc) / t.total AS fl,
           (t.amt * c.cc) % t.total AS rem,
           t.amt, t.total
      FROM c CROSS JOIN t
     WHERE t.total > 0
  ),
  weighted_ranked AS (
    SELECT w.*,
           row_number() OVER (ORDER BY w.rem DESC, w.uid ASC) AS rn,
           SUM(w.fl) OVER () AS fl_sum
      FROM weighted w
  ),
  equal_ranked AS (
    SELECT c.uid, c.cc, t.amt, t.total, t.n,
           row_number() OVER (ORDER BY c.uid ASC) AS rn
      FROM c CROSS JOIN t
     WHERE t.n > 0
  )
  SELECT uid,
         ((fl + CASE WHEN rn <= (amt - fl_sum) THEN 1 ELSE 0 END)::numeric / 100),
         round(cc::numeric / total, 8)
    FROM weighted_ranked
   WHERE COALESCE(p_method, 'WEIGHTED_CONTRIBUTED') = 'WEIGHTED_CONTRIBUTED'
  UNION ALL
  SELECT uid,
         (((amt / n) + CASE WHEN rn <= (amt % n) THEN 1 ELSE 0 END)::numeric / 100),
         round(cc::numeric / total, 8)
    FROM equal_ranked
   WHERE COALESCE(p_method, 'WEIGHTED_CONTRIBUTED') = 'DEALT_EQUAL';
$function$;
CREATE OR REPLACE FUNCTION public.fn_rake_shares_for_record(
  p_hand_id uuid, p_rake numeric, p_contributions jsonb, p_method text
)
RETURNS TABLE(user_id uuid, credit numeric)
LANGUAGE sql
STABLE
AS $function$
  SELECT ra.player_id, ra.weighted_rake_credit
    FROM public.rake_attributions ra
   WHERE p_hand_id IS NOT NULL AND ra.hand_id = p_hand_id
  UNION ALL
  SELECT a.user_id, a.credit
    FROM public.fn_allocate_rake_credits(p_rake, p_contributions, p_method) a
   WHERE p_hand_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM public.rake_attributions ra2 WHERE ra2.hand_id = p_hand_id);
$function$;
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
