CREATE OR REPLACE FUNCTION public.fn_bbj_contributions_total()
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_as_of timestamptz;
  v_total numeric;
  v_tail  numeric;
BEGIN
  SELECT c.as_of, c.total INTO v_as_of, v_total
    FROM money_flow_checkpoint c WHERE c.metric_key = 'bbj_contributions_inflow';
  IF NOT FOUND THEN
    v_as_of := '-infinity'::timestamptz; v_total := 0;
  END IF;

  SELECT COALESCE(SUM(b.amount), 0) INTO v_tail
    FROM bbj_contributions b WHERE b.created_at >= v_as_of;

  RETURN v_total + v_tail;
END;
$function$
