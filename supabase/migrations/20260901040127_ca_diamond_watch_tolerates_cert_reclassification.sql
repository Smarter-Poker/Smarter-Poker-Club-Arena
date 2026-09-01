-- 03:40 critical (incident dd9089c1): registering the recreated horse fleet
-- in ca_cert_accounts moved ~228,900 diamonds from the non-cert bucket to
-- the cert bucket between snapshots. The non-cert drift check read that
-- basis shift as a -226,910 leak. Same design as the chip supply snapshot's
-- leaderboard-liability precedent: the first snapshot after a basis change
-- records unexplained NULL (the interval is unexplainable by construction),
-- and the alarm resumes on the next interval. A real leak spanning the
-- basis-change hour is caught one snapshot later; total supply is unchanged
-- by reclassification, so nothing can hide a mint this way.
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_snapshot()
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prof numeric; v_wal numeric; v_cert numeric; v_total numeric;
  prev RECORD; v_journal numeric; v_journal_noncert numeric; v_unexplained numeric;
  v_basis_changed boolean := false;
BEGIN
  SELECT COALESCE(sum(diamonds),0) INTO v_prof FROM profiles;
  SELECT COALESCE(sum(balance),0)  INTO v_wal  FROM diamond_wallets;
  SELECT COALESCE(sum(p.diamonds),0) INTO v_cert
    FROM profiles p WHERE public.fn_ca_is_cert_account(p.id);
  v_total := v_prof + v_wal;

  SELECT * INTO prev FROM public.ca_diamond_snapshots ORDER BY taken_at DESC LIMIT 1;
  IF prev.id IS NOT NULL THEN
    SELECT COALESCE(sum(amount),0) INTO v_journal
      FROM diamond_transactions WHERE created_at > prev.taken_at;
    -- 2026-09-01: the journal that must explain NON-CERT supply is the
    -- non-cert journal. Cert grants explain cert supply, which is tracked
    -- in cert_diamonds and deliberately excluded from the drift math - the
    -- certification fleet seeds hundreds of test accounts nightly and must
    -- not wedge the deploy gate.
    SELECT COALESCE(sum(amount),0) INTO v_journal_noncert
      FROM diamond_transactions t
     WHERE t.created_at > prev.taken_at
       AND NOT public.fn_ca_is_cert_account(t.user_id);
    -- Accounts (re)tagged cert since the previous snapshot move their whole
    -- balance across the cert/non-cert line with no journal row - a basis
    -- change, not a leak. (Untagging is manual and rare; if done, expect one
    -- unexplained interval and read this comment.)
    SELECT EXISTS (SELECT 1 FROM public.ca_cert_accounts c
                    WHERE c.tagged_at > prev.taken_at) INTO v_basis_changed;
  END IF;

  INSERT INTO public.ca_diamond_snapshots
    (profile_diamonds, wallet_diamonds, cert_diamonds, total,
     journaled_delta, delta_vs_prev, unexplained)
  VALUES
    (v_prof, v_wal, v_cert, v_total, v_journal,
     CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - prev.total END,
     CASE WHEN prev.id IS NULL OR v_basis_changed THEN NULL
          ELSE (v_total - v_cert)
               - (prev.total - COALESCE(prev.cert_diamonds, 0))
               - COALESCE(v_journal_noncert, 0) END)
  RETURNING unexplained INTO v_unexplained;

  IF v_unexplained IS NOT NULL AND abs(v_unexplained) > 50 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_diamond_snapshot', 'ledger_imbalance',
      CASE WHEN abs(v_unexplained) > 5000 THEN 'critical' ELSE 'warning' END,
      'diamond-unexplained:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_unexplained,
      prev.total + COALESCE(v_journal,0), v_total,
      'ledger', 'ca_diamond_snapshots', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'NON-CERT diamond supply changed by ' || round(v_unexplained,2)
        || ' with no non-cert diamond_transactions row explaining it - a diamond writer is bypassing the journal',
      false, jsonb_build_object('profile_diamonds', v_prof, 'wallet_diamonds', v_wal,
                                 'cert_diamonds', v_cert));
  END IF;

  RETURN v_unexplained;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_snapshot() TO service_role;
