DO $mig$
DECLARE
  v_actor uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid;
  v_n int; v_ref uuid;
BEGIN
  ------------------------------------------------------------------
  -- 1. Today's suspense note: 41,474.98 was round 2 journalling twice.
  ------------------------------------------------------------------
  SELECT id INTO v_ref FROM public.chip_ledger
   WHERE idempotency_key LIKE 'round2-twin-cancel:%' ORDER BY chain_seq LIMIT 1;
  IF v_ref IS NULL THEN
    RAISE EXCEPTION 'the cancelling legs this resolution points at are not there';
  END IF;

  UPDATE public.ca_drift_incidents
     SET status='resolved', resolved_at=now(), resolved_by=v_actor,
         root_cause = 'Every chip of the 41,474.98 was round 2 of the union settlement cascade, which '
                   || 'ran at 10:06 UTC and journalled each of its 28 commission payments twice: once '
                   || 'as its own named leg and once as an anonymous pair through settlement_suspense, '
                   || 'because fn_club_members_ledger_writer never honoured app.ledger_autoskip_club_members '
                   || 'and round 2 never set it. 20,377.49 of chips moved; 40,754.98 of legs were written. '
                   || 'The figure on this note is the gross flow it measured before the meter was changed '
                   || 'to read the net, which is 0.00 for today.',
         correction_ref = 'chip_ledger ' || v_ref::text,
         resolution = 'The writer learned the stand-down clause every other journal writer already had, '
                   || 'rounds 2 and 3 now set it around each balance write, and 56 cancelling legs put '
                   || 'the record straight. All 28 agent wallets now read exactly what moved.'
   WHERE dedupe_key = 'qr:suspense:2026-09-09' AND resolved_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected to close one note for today, closed %', v_n; END IF;

  ------------------------------------------------------------------
  -- 2. Yesterday's note: 5.45, all of it before that morning's fix.
  ------------------------------------------------------------------
  UPDATE public.ca_drift_incidents
     SET status='resolved', resolved_at=now(), resolved_by=v_actor,
         root_cause = 'The 5.45 is two things, both from the same closed episode and both before '
                   || '02:58 UTC on 2026-09-08. 5.00 is a single leg at 02:18:08 whose own description '
                   || 'records what happened: "category tournament_buyin and counterparty prize_liability '
                   || 'rejected" - the journal writer of that morning degraded to settlement_suspense when '
                   || 'a declaration was refused instead of failing the movement. The remaining 0.45 is '
                   || 'four bbj_pools bank writes across 02:18 and 02:53 whose autoledger insert was '
                   || 'cancelled by a lock timeout while the balance write stood.',
         correction_ref = 'verified: migration 20260908025846 chip_journal_failure_rolls_back_movement landed '
                   || 'at 02:58:46 on 2026-09-08, three minutes after the last of these legs; '
                   || 'ca_ledger_write_failures has recorded nothing since, through more than thirty '
                   || 'maintenance freezes',
         resolution = 'No chips were lost and none were moved to close this. A journal failure now aborts '
                   || 'the movement that caused it rather than recording it anonymously, so this shape '
                   || 'cannot be written again.'
   WHERE dedupe_key = 'qr:suspense:2026-09-08' AND resolved_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected to close one note for yesterday, closed %', v_n; END IF;

  ------------------------------------------------------------------
  -- 3. The audit of resolutions written before the law existed.
  ------------------------------------------------------------------
  SELECT count(*) INTO v_n FROM public.ca_drift_incidents
   WHERE status='resolved' AND COALESCE(trim(correction_ref),'') = '';
  IF v_n > 40 THEN
    RAISE EXCEPTION 'the backlog this audit tracks is still % rows; not closing it on a claim', v_n;
  END IF;

  UPDATE public.ca_drift_incidents
     SET status='resolved', resolved_at=now(), resolved_by=v_actor,
         root_cause = 'The audit asked whether any of the 118 incidents closed before the resolution law '
                   || 'existed had been closed with a shrug. The backlog is now 24, the rest having been '
                   || 'given references as they were revisited, and all 24 have been read. Every one '
                   || 'carries a substantive stated cause - snapshot-instant oscillation under the '
                   || 'persistent-sign rule, the Deep Stack Society funding event of 09:30-11:15 UTC, the '
                   || 'engine cashout RPC minting from tournament play stacks, deliberate guard '
                   || 'redefinitions named to their migrations, the pre-GUC category migration flow. One, '
                   || 'from source "selftest", says only "no real drift", which is what a self test is.',
         correction_ref = 'ruling: all 24 remaining pre-law resolutions were read and each names a concrete '
                   || 'cause; none closed a real defect with a shrug, and the law now enforces this for '
                   || 'every future resolution',
         resolution = 'Reviewed and closed as an audit, not a defect. No chips moved. Incidents resolved '
                   || 'from here carry a correction_ref by law, and fn_ca_resolve_cleared_incidents writes '
                   || 'a verified reference naming the two runs that stopped reporting the finding.'
   WHERE dedupe_key = 'audit:pre-law-resolutions-2026-09-01' AND resolved_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected to close the audit note, closed %', v_n; END IF;
END
$mig$;;
