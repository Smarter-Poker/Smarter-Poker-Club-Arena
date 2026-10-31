CREATE OR REPLACE FUNCTION smarter_private.deleted_wallet_published_rakeback_reserve(p_club uuid, p_user uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
 r public.rakeback_periods%ROWTYPE;
 c public.accounting_rakeback_period_calculations%ROWTYPE;
 reserved numeric:=0;
 locked_period_ids uuid[];
BEGIN
 IF p_club IS NULL OR p_user IS NULL THEN
  RAISE EXCEPTION 'deleted_wallet_reserve_identity_required' USING ERRCODE='22023';
 END IF;
 -- Publishers lock an existing period FOR UPDATE before adding its certificate.
 -- NOWAIT is essential: caller may already own the member row, while the
 -- ordinary stage owns period rows before member rows. Never wait in reverse.
 SELECT coalesce(array_agg(locked.id ORDER BY locked.id),ARRAY[]::uuid[]) INTO locked_period_ids
 FROM (SELECT rp.id FROM public.rakeback_periods rp
       WHERE rp.club_id=p_club AND rp.status='pending'
       ORDER BY rp.id FOR SHARE NOWAIT) locked;
 -- Visit ONLY the locked admission cohort, not a second fresh pending scan.
 FOR r IN SELECT rp.* FROM public.rakeback_periods rp
          WHERE rp.id=ANY(locked_period_ids) ORDER BY rp.id
 LOOP
  -- Select latest FIRST. An invalid latest certificate must not expose funds
  -- by falling back to an older certificate or disappearing from a filtered sum.
  SELECT pc.* INTO c FROM public.accounting_rakeback_period_calculations pc
  WHERE pc.period_id=r.id ORDER BY pc.id DESC LIMIT 1;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'deleted_wallet_reserve_latest_certificate_required' USING ERRCODE='55000';
  END IF;
  IF r.id IS NULL OR r.club_id IS NULL OR r.club_id IS DISTINCT FROM p_club
   OR r.user_id IS NULL OR r.period_start IS NULL OR r.period_end IS NULL
   OR NOT isfinite(r.period_start) OR NOT isfinite(r.period_end)
   OR r.period_start>r.period_end OR extract(isodow FROM r.period_start)<>1 OR r.period_end<>r.period_start+6
   OR r.rake_generated IS NULL OR r.total_rake_paid IS NULL
   OR r.rakeback_amount IS NULL OR r.rakeback_earned IS NULL OR r.rakeback_rate IS NULL
   OR c.id IS NULL OR c.period_id IS DISTINCT FROM r.id
   OR c.accounting_version IS DISTINCT FROM 2
   OR c.club_id IS DISTINCT FROM r.club_id OR c.player_id IS DISTINCT FROM r.user_id
   OR c.period_start IS DISTINCT FROM r.period_start OR c.period_end IS DISTINCT FROM r.period_end
   OR c.rake_generated IS NULL OR c.rake_generated IS DISTINCT FROM r.rake_generated
   OR c.rake_generated IS DISTINCT FROM r.total_rake_paid
   OR c.rake_generated<0 OR c.rake_generated::text IN ('NaN','Infinity','-Infinity')
   OR c.rakeback_amount IS NULL OR c.rakeback_amount IS DISTINCT FROM r.rakeback_amount
   OR c.rakeback_amount IS DISTINCT FROM r.rakeback_earned
   OR c.rakeback_amount<0 OR c.rakeback_amount>c.rake_generated OR c.rakeback_amount<>round(c.rakeback_amount,2)
   OR c.rakeback_amount::text IN ('NaN','Infinity','-Infinity')
   OR c.display_rate IS NULL OR c.display_rate IS DISTINCT FROM r.rakeback_rate
   OR c.display_rate<0 OR c.display_rate>1 OR c.display_rate<>round(c.display_rate,4)
   OR c.display_rate::text IN ('NaN','Infinity','-Infinity')
   OR c.payer_kind IS NULL OR c.payer_kind NOT IN ('agent','club','split')
   OR (c.payer_kind='agent') IS DISTINCT FROM (c.payer_user_id IS NOT NULL)
   OR c.payer_user_id=r.user_id
   OR c.source_fingerprint IS NULL OR c.source_fingerprint !~ '^[0-9a-f]{32}$'
  THEN
   RAISE EXCEPTION 'deleted_wallet_reserve_certificate_identity_invalid' USING ERRCODE='55000';
  END IF;
  -- The owning R3 stage refuses any existing payout for a pending period.
  -- A pending row plus a paid receipt must never be mistaken for free money.
  IF EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=r.id) THEN
   RAISE EXCEPTION 'deleted_wallet_reserve_pending_payout_conflict' USING ERRCODE='55000';
  END IF;
  IF c.payer_kind='split' THEN
   -- Same immutable certificate producer; retain all child liabilities before
   -- any deleted account's free net is returned by the existing R2/R3 owner.
   reserved:=reserved+COALESCE((SELECT sum(g.owed) FROM smarter_private.rakeback_certificate_payers(c.id)g WHERE g.payer_kind='agent' AND g.payer_user=p_user),0);
  ELSIF c.payer_kind='agent' AND c.payer_user_id=p_user THEN
   reserved:=reserved+c.rakeback_amount;
  END IF;
 END LOOP;
 RETURN reserved;
END;
$function$
;
