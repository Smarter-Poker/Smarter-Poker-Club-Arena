BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $refunded_diamond_entry$
DECLARE
  v_fn  regprocedure := 'smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)'::regprocedure;
  v_src text; v_find text; v_n integer; v_acl text; v_owner text; v_secdef boolean; v_config text[];
BEGIN
  SELECT pg_get_functiondef(p.oid), p.proacl::text, p.proowner::regrole::text, p.prosecdef, p.proconfig
    INTO v_src, v_acl, v_owner, v_secdef, v_config
    FROM pg_proc p WHERE p.oid = v_fn;
  IF md5(v_src) <> '631844035961b4995aab130e8e53e6b6' THEN
    RAISE EXCEPTION 'F06_REFUNDED_DIAMOND_ENTRY_PREIMAGE_DRIFT: f06_movement_never_dealt_prior is %, read it before re-running', md5(v_src);
  END IF;
  v_find := ' -- AN EARLIER REFUNDED ENTRY IS NOT A SECOND ENTRY (2026-10-24). Any other receipt' || chr(10)
         || ' -- of this player is admitted only as a whole earlier chip entry whose' || chr(10)
         || ' -- registration no longer exists and whose buy-in came back: the posted refund' || chr(10)
         || ' -- legs from this event to this player before this entry equal those entries.' || chr(10)
         || ' OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament' || chr(10)
         || ' AND f.user_id=registration.user_id AND f.registration_id IS DISTINCT FROM registration.id' || chr(10)
         || ' AND (f.operation IS DISTINCT FROM ''entry'' OR f.asset IS DISTINCT FROM ''chips'' OR f.amount IS NULL OR f.amount<=0' || chr(10)
         || ' OR f.observed_at>=fund.observed_at OR f.registration_id IS NULL' || chr(10)
         || ' OR EXISTS(SELECT 1 FROM public.tournament_players q WHERE q.id=f.registration_id)))' || chr(10)
         || ' OR COALESCE((SELECT sum(f.amount) FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament' || chr(10)
         || ' AND f.user_id=registration.user_id AND f.registration_id IS DISTINCT FROM registration.id),0)' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'F06_REFUNDED_DIAMOND_ENTRY_ANCHOR: the other-receipt clause was found % times, not once', v_n; END IF;
  v_src := replace(v_src, v_find,
       ' -- AN EARLIER REFUNDED ENTRY IS NOT A SECOND ENTRY (2026-10-24). Any other receipt' || chr(10)
    || ' -- of this player is admitted only as a whole earlier entry whose registration' || chr(10)
    || ' -- no longer exists and whose buy-in came back.' || chr(10)
    || ' -- A REFUNDED DIAMOND OR FREE ENTRY IS NOT A SECOND ENTRY (2026-10-25). A paid chip' || chr(10)
    || ' -- entry came back through the posted chip refund legs below; a free chip entry' || chr(10)
    || ' -- through its unregistration receipt; a diamond entry through its own entry' || chr(10)
    || ' -- custody, released before this entry, whose refund legs equal it and which paid' || chr(10)
    || ' -- nothing else.' || chr(10)
    || ' OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament' || chr(10)
    || ' AND f.user_id=registration.user_id AND f.registration_id IS DISTINCT FROM registration.id' || chr(10)
    || ' AND (f.operation IS DISTINCT FROM ''entry'' OR f.asset IS NULL OR f.asset NOT IN (''chips'',''diamonds'') OR f.amount IS NULL OR f.amount<0' || chr(10)
    || ' OR f.observed_at>=fund.observed_at OR f.registration_id IS NULL' || chr(10)
    || ' OR EXISTS(SELECT 1 FROM public.tournament_players q WHERE q.id=f.registration_id)' || chr(10)
    || ' OR (f.asset=''chips'' AND f.amount=0 AND NOT EXISTS(SELECT 1 FROM public.tournament_unregistration_receipts u' || chr(10)
    || ' WHERE u.registration_id=f.registration_id AND u.tournament_id=p_tournament AND u.user_id=registration.user_id' || chr(10)
    || ' AND u.refunded_chips=0 AND u.settled_at<fund.observed_at))' || chr(10)
    || ' OR (f.asset=''diamonds'' AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody dc' || chr(10)
    || ' WHERE dc.id::text=f.custody_result->>''custody_id'' AND dc.user_id=registration.user_id AND dc.target_id=p_tournament' || chr(10)
    || ' AND dc.purpose=''tournament_entry'' AND dc.state=''released'' AND dc.balance=0 AND dc.released_at<fund.observed_at' || chr(10)
    || ' AND COALESCE((SELECT sum(d.amount) FROM public.poker_diamond_tournament_ledger d WHERE d.custody_id=dc.id' || chr(10)
    || ' AND d.kind=''refund'' AND d.tournament_id=p_tournament AND d.user_id=registration.user_id AND d.created_at<fund.observed_at),0)=f.amount' || chr(10)
    || ' AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger d WHERE d.custody_id=dc.id AND d.kind NOT IN (''entry'',''refund''))))))' || chr(10)
    || ' OR COALESCE((SELECT sum(f.amount) FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament' || chr(10)
    || ' AND f.user_id=registration.user_id AND f.registration_id IS DISTINCT FROM registration.id AND f.asset=''chips''),0)' || chr(10));
  IF md5(v_src) <> '35dbc3c7dd7b152d8e55892b4af9ae3b' THEN
    RAISE EXCEPTION 'F06_REFUNDED_DIAMOND_ENTRY_POSTIMAGE: the edited definition is %, not the proved post-image', md5(v_src);
  END IF;
  EXECUTE v_src;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_fn) <> '2962ab899304584d3ad1ae1d14b3e8dc'
     OR (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid = v_fn) <> '35dbc3c7dd7b152d8e55892b4af9ae3b'
     OR (SELECT proacl::text FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_acl
     OR (SELECT proowner::regrole::text FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_owner
     OR (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_secdef
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_config
     OR v_acl IS DISTINCT FROM '{postgres=X/postgres}' THEN
    RAISE EXCEPTION 'F06_REFUNDED_DIAMOND_ENTRY_POSTIMAGE: installed body, owner, ACL or settings differ from the proved post-image';
  END IF;
END
$refunded_diamond_entry$;

COMMIT;