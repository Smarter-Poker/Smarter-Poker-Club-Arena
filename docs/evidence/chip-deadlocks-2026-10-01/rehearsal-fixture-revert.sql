-- Rehearsal fixture for 20261001000500_a_raked_hand_takes_its_club_wallet_where_it_did (rolled back by rehearse.sh).
SET LOCAL lock_timeout = '2s';
DO $fx$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'atomic_distribute_rake') <> '0ef820b10c57d902b5ab2d5f9e2be8a6' THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: atomic_distribute_rake is not its old body';
  END IF;
  IF position('PERFORM 1 FROM public.club_wallets WHERE club_id = p_club_id FOR NO KEY UPDATE;' IN
       pg_get_functiondef('public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: the early wallet lock is still there';
  END IF;
  IF (SELECT applied FROM public.atomic_distribute_rake(NULL::uuid, NULL::uuid, NULL::uuid, 0, 0::numeric)) THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: a rake with no club applied';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
       AND (p.proname, md5(pg_get_functiondef(p.oid))) IN (('trg_agent_commission_rollup_insert','c7e84377219a39d955783d0feae6642b'),
        ('fn_credit_agent_commissions_batch','5ebf5489eabbe478d393e2e040683fe8'),('fn_retry_cash_accounting_sources','4b62b13c70191e56fe55644070303a97'),
        ('fn_sync_profile_total_hands','f6ee538e4bcfc329dd0e46673b05dc30'),('upsert_horse_mind_pairs','389109138a65a4d150b48da5ffa209bb'))) <> 5 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: one of the changes that stand moved';
  END IF;
  RAISE EXCEPTION 'REHEARSAL OK: atomic_distribute_rake restored to 0ef820b10c57d902b5ab2d5f9e2be8a6, the other changes stand, nothing opened';
END $fx$;
