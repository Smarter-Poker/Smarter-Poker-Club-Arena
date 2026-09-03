-- Drop the function first to allow changing the RETURNS TABLE signature
DROP FUNCTION IF EXISTS public.fn_bbj_recent_hits(uuid);

CREATE OR REPLACE FUNCTION public.fn_bbj_recent_hits(p_pool_id uuid)
 RETURNS TABLE(
   id uuid,
   hand_number bigint,
   winner_display_name text,
   loser_display_name text,
   winner_hand text,
   loser_hand text,
   awarded_at timestamp with time zone,
   total_amount numeric,
   bad_beat_name text,
   bad_beat_avatar_url text,
   bad_beat_player_number text
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    x.id,
    w.hand_number,
    w.winner_display_name,
    w.loser_display_name,
    w.winner_hand,
    w.loser_hand,
    x.created_at AS awarded_at,
    x.total_amount,
    COALESCE(bb.display_name, 'Unknown') AS bad_beat_name,
    bb.avatar_url AS bad_beat_avatar_url,
    bb.player_number::text AS bad_beat_player_number
  FROM public.bbj_payouts x
  LEFT JOIN public.bbj_winners w
         ON w.hand_number = x.hand_number
  LEFT JOIN public.profiles bb
         ON bb.id = x.winner_user_id
  WHERE x.pool_id = p_pool_id
  ORDER BY x.created_at DESC
  LIMIT 5;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_bbj_recent_hits(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_recent_hits(uuid) TO anon;
