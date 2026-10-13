CREATE OR REPLACE FUNCTION public.fn_claim_rakeback(p_club_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE actor uuid:=auth.uid();
BEGIN
 IF actor IS NULL THEN RETURN jsonb_build_object('success',false,'error','Authentication Required','periods_claimed',0,'total_payout',0);END IF;
 IF p_club_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.club_members m WHERE m.club_id=p_club_id AND m.user_id=actor AND m.status IN('active','approved')) THEN
  RETURN jsonb_build_object('success',false,'error','You Are Not An Active Member Of This Club','periods_claimed',0,'total_payout',0);END IF;
 RETURN jsonb_build_object('success',false,'code','automatic_weekly_settlement','error','Rakeback Is Settled Automatically Every Monday At 4:00 AM Central Time. View Invoices For Recorded Transfers.',
  'authority','fn_process_weekly_accounting','schedule','Monday 04:00 America/Chicago','periods_claimed',0,'total_payout',0,'club_id',p_club_id);
END $function$
