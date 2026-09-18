BEGIN;
SELECT set_config('request.jwt.claims','{"role":"service_role","sub":"46468201-0000-4000-8000-000000000003"}',true);
DO $$DECLARE r jsonb; BEGIN
 IF (SELECT abi FROM public.ca_mtt_admission_contract)<>'unlimited-mtt-v2' THEN RAISE EXCEPTION 'ACTIVATION_HU_ACTUAL_ACTIVATION_REQUIRED'; END IF;
 r:=public.fn_complete_tournament_launch_atomic('46468200-0000-4000-8000-000000000003','46468204-0000-4000-8000-000000000001',
  '46468202-0000-4000-8000-000000000001','seat-first-satellite-v1');
 IF r->'ok' IS DISTINCT FROM 'true'::jsonb OR r->'replay' IS DISTINCT FROM 'true'::jsonb
    OR r->>'format_contract'<>'seat-first-satellite-v1'
    OR NOT EXISTS(SELECT 1 FROM r46_activation_hu.accepted a WHERE a.money=r46_activation_hu.money()
      AND a.receipt=(SELECT to_jsonb(l) FROM public.tournament_launch_receipts l WHERE tournament_id='46468200-0000-4000-8000-000000000003'))
    OR NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id='46468200-0000-4000-8000-000000000003'
      AND format_contract='seat-first-satellite-v1' AND max_players=2 AND min_players=2 AND starting_chips=300) THEN
  RAISE EXCEPTION 'ACTIVATION_HU_BOOKED_RECEIPT_OR_MONEY_CHANGED'; END IF;
END $$;
COMMIT;
SELECT 'MTT_ACTIVATION_FUNDED_HU_AFTER_PASS';
