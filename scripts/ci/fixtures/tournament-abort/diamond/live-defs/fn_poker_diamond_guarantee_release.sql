-- live_md5 0dea3ea59cc13950412abc67e4d2645a
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_guarantee_release(p_tournament_id uuid, p_moment text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_open bigint;
BEGIN
  IF p_tournament_id IS NULL OR p_moment NOT IN ('lock','finalize','cancel','complete') THEN
    RAISE EXCEPTION 'invalid_diamond_guarantee_release' USING ERRCODE = '22023';
  END IF;
  v_open := public.fn_ca_diamond_earmark_open('guarantee:' || p_tournament_id::text);
  IF v_open <= 0 THEN RETURN 0; END IF;
  INSERT INTO public.ca_diamond_house_earmarks (entry, earmark_key, purpose, amount, tournament_id, reason)
  VALUES ('release', 'guarantee:' || p_tournament_id::text, 'guarantee', v_open, p_tournament_id,
          'Guarantee earmark released at ' || p_moment || ': the event no longer needs it');
  RETURN v_open;
END $function$

