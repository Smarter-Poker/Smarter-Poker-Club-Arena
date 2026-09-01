-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831002408; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- OUTAGE MONEY REPAIR (2026-08-31, phase 2 of the completion plan)
--
-- Every class of the 2026-08-30 outage's money damage, audited and settled:
--
-- 1. SEAT-STACK EXITS (1,033 criticals / 431,906 chips): all cash-table
--    exits from the restart storms. fn_unaccounted_seat_exits (credit-
--    matched, 30h window) returns ZERO — the engine's boot cash-out sweeps
--    credited every one; the 20:00 reconciler snapshot was taken mid-
--    recovery. No chips owed. Rows annotated below as audited-conserved.
--
-- 2. UNPAID SPINS (61 criticals): v_spin_unpaid_settlements now returns
--    ZERO rows with chips_short > 0 — the stranded spins settled or
--    refunded after revival. Stale alerts resolved below, gated on the view
--    staying clean for each tournament.
--
-- 3. QUEUE-FAILED FEES (147 criticals): 124 hands banked anyway, 2 sit in
--    the queue, and 21 hands' rake (33.86 chips) fell through — queue
--    insert failed during the timeout storm and nothing retried. Re-queued
--    below as kind='rake'; the FeeReconciler drives them through
--    atomic_distribute_rake, which is hand-gated and idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- 3. Re-queue the 21 lost rake rows (guarded: skip any that got banked or
--    queued since the audit ran).
DO $$
DECLARE r record; v_added int := 0;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('ac5a793f-b20c-461e-a385-8dea41e8fb3f'::uuid, 4.70),
      ('b98467d0-af10-4fda-aaf1-d2be3cb30881'::uuid, 0.50),
      ('44ec68be-7ce6-4e6b-b608-2f4164bda59c'::uuid, 1.00),
      ('3e558fa2-b391-4e62-8113-b64abf458e3b'::uuid, 0.10),
      ('d695edfd-c5cf-42e3-bf8c-81bf968a8620'::uuid, 1.80),
      ('70f70caa-bd6f-4a24-9584-e5e08e010f05'::uuid, 0.06),
      ('87a59f61-573f-4b40-b451-f8720e4df57c'::uuid, 0.90),
      ('a4c9e02e-dd22-47db-ace9-e12453425a42'::uuid, 5.00),
      ('520907b7-aa46-407a-b461-5fb189f57e96'::uuid, 2.50),
      ('4261c99a-18f9-4113-a93d-ef83e0321836'::uuid, 0.40),
      ('b49f1aff-7063-42ca-a82d-d170df035683'::uuid, 2.50),
      ('78065886-0ab2-418b-9f7d-f31c1691651c'::uuid, 2.50),
      ('8f9b6f09-069e-4453-a353-85a0d616baf7'::uuid, 0.40),
      ('08343f73-443d-4285-8c5f-265f35717dfb'::uuid, 0.80),
      ('9e58cf70-769a-4b6e-86d0-d46c87bf48f8'::uuid, 1.80),
      ('bd605f7f-2602-4e6a-9f53-350c1e3a6fc3'::uuid, 1.10),
      ('e87cb137-e07c-40c7-9ed4-140ef6caa605'::uuid, 0.40),
      ('7a1a5c6d-e6f1-4d30-9afb-171a3128e0e0'::uuid, 1.60),
      ('85ed9cf7-b42e-4532-9eeb-74cdcf879e0a'::uuid, 2.40),
      ('951598f3-86ad-46c6-9a0b-6671ecc6bbcd'::uuid, 2.50),
      ('c4f849c0-90b4-4a4b-9ce9-88868258e31a'::uuid, 0.80)
    ) AS v(hand_id, rake)
  LOOP
    INSERT INTO public.pending_fee_distributions (
      id, table_id, club_id, hand_id, hand_number, rake, bbj, pot,
      num_players, contributions, tournament_id, kind
    )
    SELECT gen_random_uuid(), hh.table_id, COALESCE(t.club_id, 'fade0000-0000-0000-0000-000000000001'),
           hh.id, hh.hand_number, r.rake, 0,
           COALESCE(hh.pot_size, r.rake), COALESCE(jsonb_array_length(hh.players), 2),
           '{}'::jsonb, t.tournament_id, 'rake'
      FROM public.hand_history hh
      LEFT JOIN public.tables t ON t.id = hh.table_id
     WHERE hh.id = r.hand_id
       AND NOT EXISTS (SELECT 1 FROM public.rake_records rr WHERE rr.hand_id = r.hand_id)
       AND NOT EXISTS (SELECT 1 FROM public.pending_fee_distributions p WHERE p.hand_id = r.hand_id);
    IF FOUND THEN v_added := v_added + 1; END IF;
  END LOOP;
  RAISE NOTICE 're-queued % lost rake rows', v_added;
END $$;

-- 1. Annotate the seat-exit criticals as audited-conserved.
UPDATE public.ledger_reconcile_log
   SET notes = COALESCE(notes || ' | ', '') ||
       'AUDITED 2026-08-31 (phase 2): cash-out sweeps credited every exit; fn_unaccounted_seat_exits(30h)=0. Conserved, no repair owed.'
 WHERE entity_type = 'seat_stack_exit' AND severity = 'critical'
   AND created_at > now() - interval '32 hours';

-- 2. Resolve stale spin alerts — only where the view is clean for that event.
UPDATE public.financial_alerts fa
   SET resolved = true, resolved_at = now()
 WHERE fa.source = 'fn_spin_unpaid_check' AND fa.resolved IS NOT TRUE
   AND NOT EXISTS (
     SELECT 1 FROM public.v_spin_unpaid_settlements v
      WHERE v.tournament_id::text = fa.context->>'tournament_id'
        AND v.chips_short > 0);

-- 3b. Resolve queue-failed alerts whose hand is now banked or queued.
UPDATE public.financial_alerts fa
   SET resolved = true, resolved_at = now()
 WHERE fa.source = 'FeeReconciler.queue_failed' AND fa.resolved IS NOT TRUE
   AND EXISTS (
     SELECT 1 FROM public.hand_history hh
      WHERE (hh.id::text = (regexp_match(fa.message, 'hand ([0-9a-f]{8}-[0-9a-f-]{27,})'))[1]
             OR hh.hand_number::text = (regexp_match(fa.message, 'hand (\d{5,9}) '))[1])
        AND (EXISTS (SELECT 1 FROM public.rake_records rr WHERE rr.hand_id = hh.id)
             OR EXISTS (SELECT 1 FROM public.bbj_contributions b WHERE b.hand_id = hh.id)
             OR EXISTS (SELECT 1 FROM public.pending_fee_distributions p WHERE p.hand_id = hh.id)));

-- ASSERTIONS
DO $$
DECLARE v_lost int; v_spin int;
BEGIN
  SELECT count(*) INTO v_lost FROM (VALUES
      ('ac5a793f-b20c-461e-a385-8dea41e8fb3f'::uuid),('b98467d0-af10-4fda-aaf1-d2be3cb30881'::uuid),
      ('44ec68be-7ce6-4e6b-b608-2f4164bda59c'::uuid),('3e558fa2-b391-4e62-8113-b64abf458e3b'::uuid),
      ('d695edfd-c5cf-42e3-bf8c-81bf968a8620'::uuid),('70f70caa-bd6f-4a24-9584-e5e08e010f05'::uuid),
      ('87a59f61-573f-4b40-b451-f8720e4df57c'::uuid),('a4c9e02e-dd22-47db-ace9-e12453425a42'::uuid),
      ('520907b7-aa46-407a-b461-5fb189f57e96'::uuid),('4261c99a-18f9-4113-a93d-ef83e0321836'::uuid),
      ('b49f1aff-7063-42ca-a82d-d170df035683'::uuid),('78065886-0ab2-418b-9f7d-f31c1691651c'::uuid),
      ('8f9b6f09-069e-4453-a353-85a0d616baf7'::uuid),('08343f73-443d-4285-8c5f-265f35717dfb'::uuid),
      ('9e58cf70-769a-4b6e-86d0-d46c87bf48f8'::uuid),('bd605f7f-2602-4e6a-9f53-350c1e3a6fc3'::uuid),
      ('e87cb137-e07c-40c7-9ed4-140ef6caa605'::uuid),('7a1a5c6d-e6f1-4d30-9afb-171a3128e0e0'::uuid),
      ('85ed9cf7-b42e-4532-9eeb-74cdcf879e0a'::uuid),('951598f3-86ad-46c6-9a0b-6671ecc6bbcd'::uuid),
      ('c4f849c0-90b4-4a4b-9ce9-88868258e31a'::uuid)) v(h)
   WHERE NOT EXISTS (SELECT 1 FROM public.rake_records rr WHERE rr.hand_id=v.h)
     AND NOT EXISTS (SELECT 1 FROM public.pending_fee_distributions p WHERE p.hand_id=v.h);
  IF v_lost > 0 THEN RAISE EXCEPTION '% lost hands still neither banked nor queued', v_lost; END IF;

  SELECT count(*) INTO v_spin FROM public.financial_alerts
   WHERE source='fn_spin_unpaid_check' AND resolved IS NOT TRUE;
  IF v_spin > 0 THEN
    RAISE NOTICE '% spin alerts remain (view still lists them) — left open on purpose', v_spin;
  END IF;
END $$;

