CREATE OR REPLACE FUNCTION public.fn_tournament_entry_split(p_buy_in numeric, p_fee numeric, p_bounty numeric, p_is_bounty boolean)
 RETURNS TABLE(charge numeric, rake numeric, bounty numeric, prize numeric)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_charge numeric; v_rake numeric; v_bounty numeric; v_prize numeric;
BEGIN
  IF NOT COALESCE(p_is_bounty, false) THEN
    -- Non-bounty: unchanged - fee charged on top of the buy-in portion.
    v_charge := round(COALESCE(p_buy_in,0),2) + round(COALESCE(p_fee,0),2);
    v_rake   := round(COALESCE(p_fee,0),2);
    v_bounty := 0;
    v_prize  := round(COALESCE(p_buy_in,0),2);
  ELSE
    -- Bounty event: the rake is exactly the fee. A zero fee is a legitimate
    -- outcome of the whole-number floor rule (totals under 10 take no rake)
    -- and must NEVER be replaced with a percentage default.
    v_charge := round(COALESCE(p_buy_in,0),2) + round(COALESCE(p_fee,0),2);
    v_rake   := round(COALESCE(p_fee,0),2);
    v_bounty := round(COALESCE(p_bounty,0), 2);
    v_prize  := round(v_charge - v_rake - v_bounty, 2);  -- = buy_in - bounty
  END IF;
  RETURN QUERY SELECT v_charge, v_rake, v_bounty, v_prize;
END;
$function$

