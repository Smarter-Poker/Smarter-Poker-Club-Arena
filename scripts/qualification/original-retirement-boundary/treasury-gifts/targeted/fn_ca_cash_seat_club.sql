CREATE OR REPLACE FUNCTION public.fn_ca_cash_seat_club(p_table uuid, p_user uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT s.club_id FROM public.table_seats s
      WHERE s.table_id = p_table AND s.user_id = p_user AND s.left_at IS NULL
        AND s.club_id IS NOT NULL LIMIT 1),
    (SELECT x.funding_club_id FROM public.cash_participant_funding_receipts x
      WHERE x.operation_kind = 'buyin' AND x.table_id = p_table AND x.account_entity_id = p_user
      ORDER BY x.seat_joined_at DESC NULLS LAST LIMIT 1));
$function$
