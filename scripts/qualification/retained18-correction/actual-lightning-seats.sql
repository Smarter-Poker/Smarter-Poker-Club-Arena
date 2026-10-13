CREATE OR REPLACE FUNCTION public.fn_lightning_settlement_seats(p_table_id uuid, p_hand_number bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT coalesce(jsonb_object_agg(m.player_id::text, m.anchor_table_id), '{}'::jsonb)
    FROM public.lightning_settlement_marker m
   WHERE m.txid = pg_current_xact_id_if_assigned()
     AND m.host_table_id = p_table_id
     AND m.hand_number = p_hand_number;
$function$
;

