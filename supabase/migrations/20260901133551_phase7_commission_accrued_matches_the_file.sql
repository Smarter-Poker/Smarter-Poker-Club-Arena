-- ═══════════════════════════════════════════════════════════════════════════
--  PHASE 7 FOLLOW-UP: fn_club_commission_accrued MATCHES ITS FILE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260901133348 was applied through the Supabase migration API rather than
-- from the file, and the body that went up was missing the two explanatory
-- comment lines the file carries. A comment is part of prosrc, so production
-- and the repo did not match byte for byte - and "the file is what ran" has to
-- be literally true or it is not worth saying.
--
-- Caught by comparing md5(pg_get_functiondef(oid)) for all eight functions the
-- phase touched, before and after re-applying the file inside a transaction
-- that was rolled back. Seven were IDENTICAL; this one was not.
--
-- Nothing about the behaviour changes.
CREATE OR REPLACE FUNCTION public.fn_club_commission_accrued(
  p_club_id uuid,
  p_since   timestamptz DEFAULT NULL,
  p_until   timestamptz DEFAULT NULL
) RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_total numeric;
BEGIN
  IF p_club_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Staff of THIS club, or a service caller. Anybody else gets zero rather than
  -- an error: this feeds a summary card, and a card is not the place to leak
  -- whether a club exists.
  IF NOT (public.fn_is_club_admin_uid(p_club_id)
          OR (auth.uid() IS NULL AND COALESCE(auth.role(), 'service_role') = 'service_role')) THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(SUM(ac.amount), 0) INTO v_total
    FROM public.agent_commissions ac
   WHERE ac.club_id = p_club_id
     AND (p_since IS NULL OR ac.created_at >= p_since)
     AND (p_until IS NULL OR ac.created_at <  p_until);

  RETURN COALESCE(v_total, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_club_commission_accrued(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_commission_accrued(uuid, timestamptz, timestamptz) TO authenticated, service_role;
