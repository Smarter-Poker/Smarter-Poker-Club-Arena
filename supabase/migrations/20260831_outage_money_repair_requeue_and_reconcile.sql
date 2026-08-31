-- Repo copy of production migration `outage_money_repair_requeue_and_reconcile`
-- (applied 2026-08-31 via Supabase MCP). See
-- docs/changelog/2026-08-31-outage-money-repair-and-bbj-ledger-deletion.md.
--
-- OUTAGE MONEY REPAIR (2026-08-30 outage, phase 2 of the completion plan):
-- 1. seat_stack_exit criticals annotated as audited-conserved
--    (fn_unaccounted_seat_exits(30h) = 0 — every exit credit-matched).
-- 2. Stale fn_spin_unpaid_check alerts resolved where the view is clean.
-- 3. The 21 lost-rake hands (33.76 chips) re-queued for the FeeReconciler.
--
-- The hand list is a point-in-time repair; the inserts are guarded NOT
-- EXISTS on rake_records and the queue, so re-running is a no-op.

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

UPDATE public.ledger_reconcile_log
   SET notes = COALESCE(notes || ' | ', '') ||
       'AUDITED 2026-08-31 (phase 2): cash-out sweeps credited every exit; fn_unaccounted_seat_exits(30h)=0. Conserved, no repair owed.'
 WHERE entity_type = 'seat_stack_exit' AND severity = 'critical'
   AND created_at > timestamptz '2026-08-30 16:00+00';

UPDATE public.financial_alerts fa
   SET resolved = true, resolved_at = now()
 WHERE fa.source = 'fn_spin_unpaid_check' AND fa.resolved IS NOT TRUE
   AND NOT EXISTS (
     SELECT 1 FROM public.v_spin_unpaid_settlements v
      WHERE v.tournament_id::text = fa.context->>'tournament_id'
        AND v.chips_short > 0);

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
