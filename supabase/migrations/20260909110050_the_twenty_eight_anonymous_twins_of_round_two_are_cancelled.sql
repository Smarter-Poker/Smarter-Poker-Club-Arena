DO $mig$
DECLARE
  r record;
  v_inc uuid;
  v_actor uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid;
  v_legs int := 0;
  v_chips numeric := 0;
  v_first uuid;
  v_key text;
BEGIN
  /* WHAT THIS FIXES. Round 2 of the union settlement cascade ran at 10:06 UTC
     today and moved 20,377.49 of commission from two club treasuries into 28
     agent wallets. It wrote a named leg for each payment by hand. It ALSO
     left both balance writes to journal themselves, and neither trigger had
     been told who the counterparty was, so each payment additionally reached
     the journal as an anonymous pair through settlement_suspense. 20,377.49
     of chips were recorded as 40,754.98 of legs; every agent wallet and both
     treasuries read double in a per-account replay.

     The source of that is fixed in the migration before this one. This one
     repairs the record it already wrote. The journal is hash-chained, so a
     wrong row is never deleted: it is cancelled by an opposing row that says
     what it cancels and why. The named commission leg is left standing,
     because it carries the period, the row count and the idempotency key -
     it is exactly the leg the fixed code now writes on its own.

     fn_ca_post_correction is the usual door and it posts ONE leg per linked
     incident by design. A duplicate spread over 28 accounts needs one leg per
     account, so the legs are written here, under this migration, with a key
     per pair so a replay cannot post them twice. */

  PERFORM public.fn_ca_raise_drift_incident(
    p_source          => 'fn_settle_round2_club_to_agents',
    p_classification  => 'reporting_mismatch',
    p_severity        => 'warning',
    p_dedupe_key      => 'round2:double-journalled:2026-09-09',
    p_discrepancy     => 20377.49,
    p_expected        => 20377.49,
    p_actual          => 40754.98,
    p_layer           => 'ledger',
    p_suspected_cause => 'Round 2 wrote its own named commission leg AND left both balance '
                      || 'writes to journal themselves through settlement_suspense, so 28 '
                      || 'payments totalling 20,377.49 were recorded twice. No chips moved '
                      || 'twice: every agent was paid once and every treasury debited once.',
    p_ledger_balanced => true,
    p_metadata        => jsonb_build_object('pairs', 28, 'chips_moved', 20377.49,
                                            'legs_written', 40754.98));

  SELECT id INTO v_inc FROM public.ca_drift_incidents
   WHERE dedupe_key = 'round2:double-journalled:2026-09-09';
  IF v_inc IS NULL THEN
    RAISE EXCEPTION 'the incident that these corrections answer to was not raised';
  END IF;

  FOR r IN
    SELECT s.club_id, s.user_id, round(s.amount, 2) AS amount, s.union_id
      FROM public.agent_commission_settlements s
     WHERE s.paid_at >= date_trunc('day', now())
     ORDER BY s.club_id, s.user_id
  LOOP
    -- Cancels the anonymous debit twin: club treasury -> suspense.
    v_key := 'round2-twin-cancel:debit:' || r.club_id::text || ':' || r.user_id::text || ':2026-09-09';
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, union_id, description, idempotency_key, metadata)
    SELECT v_actor, 'settlement_suspense', NULL, 'club_treasury', r.club_id,
           r.amount, 'correction', r.club_id, r.union_id,
           'Cancels the anonymous twin of round 2 club treasury debit for this pair',
           v_key,
           jsonb_build_object('incident_id', v_inc, 'cancels', 'club_treasury->settlement_suspense',
                              'agent_user_id', r.user_id, 'posted_via', 'migration')
     WHERE NOT EXISTS (SELECT 1 FROM public.chip_ledger k WHERE k.idempotency_key = v_key);
    IF FOUND THEN v_legs := v_legs + 1; END IF;

    -- Cancels the anonymous credit twin: suspense -> agent player wallet.
    v_key := 'round2-twin-cancel:credit:' || r.club_id::text || ':' || r.user_id::text || ':2026-09-09';
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, union_id, description, idempotency_key, metadata)
    SELECT v_actor, 'player_wallet', r.user_id, 'settlement_suspense', NULL,
           r.amount, 'correction', r.club_id, r.union_id,
           'Cancels the anonymous twin of round 2 agent wallet credit for this pair',
           v_key,
           jsonb_build_object('incident_id', v_inc, 'cancels', 'settlement_suspense->player_wallet',
                              'club_id', r.club_id, 'posted_via', 'migration')
     WHERE NOT EXISTS (SELECT 1 FROM public.chip_ledger k WHERE k.idempotency_key = v_key);
    IF FOUND THEN v_legs := v_legs + 1; END IF;

    v_chips := v_chips + r.amount;
  END LOOP;

  IF v_legs <> 56 THEN
    RAISE EXCEPTION 'expected 56 cancelling legs, wrote %', v_legs;
  END IF;
  IF round(v_chips, 2) <> 20377.49 THEN
    RAISE EXCEPTION 'expected to cancel 20377.49 of twins, covered %', round(v_chips, 2);
  END IF;

  SELECT id INTO v_first FROM public.chip_ledger
   WHERE idempotency_key LIKE 'round2-twin-cancel:%' ORDER BY chain_seq LIMIT 1;

  UPDATE public.ca_drift_incidents
     SET status = 'resolved', resolved_at = now(), resolved_by = v_actor,
         root_cause = 'fn_club_members_ledger_writer never honoured app.ledger_autoskip_club_members, '
                   || 'the one clause every other journal writer on the platform obeys, and round 2 '
                   || 'never set it. So a settlement that wrote its own named leg still got an '
                   || 'anonymous twin from each of its two balance writes, and 20,377.49 of chips '
                   || 'was journalled as 40,754.98 of legs on 2026-09-09.',
         correction_ref = 'chip_ledger ' || v_first::text,
         resolution = '56 cancelling legs posted, one per side of each of the 28 payments; the named '
                   || 'commission leg is left standing because it is the leg the fixed code now '
                   || 'writes on its own. The writer learned the stand-down clause and rounds 2 and '
                   || '3 now set it around every balance write.'
   WHERE id = v_inc;

  RAISE NOTICE 'cancelled % twin legs covering %', v_legs, round(v_chips, 2);
END
$mig$;;
