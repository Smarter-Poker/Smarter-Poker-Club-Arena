CREATE OR REPLACE FUNCTION public.fn_union_pnl_touched_registrations(p_start timestamp with time zone, p_end timestamp with time zone, p_projected boolean)
 RETURNS TABLE(registration_id uuid, touched_tournament_id text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_projected THEN
  RETURN QUERY SELECT i.row_id,i.tournament_id FROM public.union_pnl_inventory_touches i
   WHERE i.source_name='tournament_players' AND i.frame_observed_at>=p_start AND i.frame_observed_at<p_end
    AND i.observed_at>=p_start AND i.observed_at<p_end;
 ELSE
  RETURN QUERY SELECT i.row_id,COALESCE(i.after_row,i.before_row)->>'tournament_id' FROM public.union_pnl_inventory_events i
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=i.transaction_id
   WHERE i.source_name='tournament_players' AND b.observed_at>=p_start AND b.observed_at<p_end
    AND i.observed_at>=p_start AND i.observed_at<p_end;
 END IF;
END $function$;
