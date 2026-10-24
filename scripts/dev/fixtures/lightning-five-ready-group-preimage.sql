CREATE OR REPLACE FUNCTION public.fn_lightning_group_sizes(p_legal integer, p_min integer, p_target integer, p_max integer)
 RETURNS integer[]
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_max    integer := LEAST(GREATEST(coalesce(p_max, 2), 2), 9);
  v_min    integer;
  v_target integer;
  v_n      integer := GREATEST(coalesce(p_legal, 0), 0);
  v_lo     integer;
  v_hi     integer;
  v_k      integer;
  v_best   numeric;
  v_d      numeric;
  v_seat   integer;
  v_q      integer;
  v_r      integer;
  k        integer;
  v_out    integer[] := ARRAY[]::integer[];
BEGIN
  v_min    := LEAST(GREATEST(coalesce(p_min, 2), 2), v_max);
  v_target := LEAST(GREATEST(coalesce(p_target, v_max), v_min), v_max);
  -- Fewer legal players than the smallest hand: no hand, never a lone seat.
  IF v_n < v_min THEN
    RETURN v_out;
  END IF;
  v_lo := ceil(v_n::numeric / v_max)::integer;   -- fewest groups that fit everyone under max
  v_hi := floor(v_n::numeric / v_min)::integer;  -- most groups that keep everyone at min or more
  IF v_lo <= v_hi THEN
    -- Everyone is seated. Among the feasible group counts, the one whose
    -- average size is closest to the target; a tie keeps the fewer groups
    -- (P6: no unnecessary instance).
    v_k := v_lo;
    v_best := abs(v_n::numeric / v_lo - v_target);
    FOR k IN v_lo + 1 .. v_hi LOOP
      v_d := abs(v_n::numeric / k - v_target);
      IF v_d < v_best THEN
        v_best := v_d;
        v_k := k;
      END IF;
    END LOOP;
    v_seat := v_n;
  ELSE
    -- No split seats everyone (a configured minimum above two can cause it):
    -- the most players that can be seated, in full groups.
    v_k := v_hi;
    v_seat := v_hi * v_max;
  END IF;
  v_q := v_seat / v_k;
  v_r := v_seat % v_k;
  FOR k IN 1 .. v_k LOOP
    v_out := v_out || (v_q + CASE WHEN k <= v_r THEN 1 ELSE 0 END);
  END LOOP;
  RETURN v_out;
END
$function$
;

