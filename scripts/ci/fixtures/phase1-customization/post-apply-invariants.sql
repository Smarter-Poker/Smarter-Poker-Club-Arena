DO $phase1_proof$
DECLARE
  v_definition text;
BEGIN
  IF (SELECT count(*) FROM public.cosmetic_catalog WHERE category = 'face_deck_id') <> 10 THEN
    RAISE EXCEPTION 'expected ten face decks';
  END IF;
  IF (SELECT count(*) FROM public.cosmetic_catalog
       WHERE category = 'face_deck_id' AND tier = 'free') <> 3 THEN
    RAISE EXCEPTION 'expected three free face decks';
  END IF;
  IF (SELECT count(*) FROM public.feature_pricing
       WHERE feature LIKE 'studio:face_deck_id:%' AND usage_type = 'permanent') <> 7 THEN
    RAISE EXCEPTION 'expected seven permanent face-deck prices';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.user_table_studio_preferences p
    CROSS JOIN LATERAL jsonb_array_elements(p.loadouts) slot(value)
    WHERE slot.value <> 'null'::jsonb AND NOT (slot.value ? 'face_deck_id')
  ) THEN
    RAISE EXCEPTION 'legacy loadout was not upgraded with a face deck';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.theme_asset_unlocks
     WHERE user_id = '00000000-0000-4000-8000-000000000001'
       AND category = 'face_deck_id' AND asset_id = 'house-classic'
  ) THEN
    RAISE EXCEPTION 'owned composite look did not receive its face deck';
  END IF;

  SELECT pg_get_functiondef('public.fn_purchase_feature_v2(uuid,text,uuid)'::regprocedure)
    INTO v_definition;
  IF position('RETURN v_cached_result;' IN v_definition) = 0
     OR position('RETURN v_cached_result ||' IN v_definition) <> 0
     OR position('''face_deck_id''' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'purchase-v2 first-receipt semantics or face-deck category was lost';
  END IF;

  IF (SELECT count(*) FROM public.avatar_style_catalog
       WHERE unlock_token LIKE 'frame\_%') <> 7
     OR (SELECT count(*) FROM public.avatar_style_catalog
       WHERE unlock_token LIKE 'aura\_%') <> 7 THEN
    RAISE EXCEPTION 'expected seven premium frames and seven premium auras';
  END IF;
  IF NOT public.sp_cosmetic_is_owned(NULL, 'frame_slate', 'frame')
     OR NOT public.sp_cosmetic_is_owned(NULL, 'aura_mist', 'aura') THEN
    RAISE EXCEPTION 'free avatar cosmetics are not owned';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournaments
     WHERE final_table_triggered
       AND format_contract IS DISTINCT FROM 'mtt-v1'
       AND format_contract IS DISTINCT FROM 'mtt-v2'
  ) THEN
    RAISE EXCEPTION 'a short format retained a final-table flag';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.tournaments'::regclass
       AND conname = 'tournaments_final_table_requires_mtt_check'
       AND convalidated
  ) THEN
    RAISE EXCEPTION 'final-table format constraint is not validated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.feature_purchases'::regclass
       AND tgname = 'trg_deliver_table_studio_entitlement' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.feature_purchases'::regclass
       AND tgname = 'trg_phase1_receipt_audit' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.user_theme_settings'::regclass
       AND tgname = 'trg_user_theme_settings_entitlement' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.profiles'::regclass
       AND tgname = 'trg_profiles_cosmetics_ownership' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'a pre-existing trigger was detached';
  END IF;

  IF (SELECT count(*) FROM public.phase_one_customization_cutover_seals
       WHERE contract = 'phase1-customization-v1') < 1 THEN
    RAISE EXCEPTION 'the exact client/engine cutover seal is missing';
  END IF;
  IF has_table_privilege('anon',
       'public.phase_one_customization_cutover_seals', 'SELECT')
     OR has_table_privilege('authenticated',
       'public.phase_one_customization_cutover_seals', 'SELECT')
     OR has_table_privilege('service_role',
       'public.phase_one_customization_cutover_seals', 'SELECT') THEN
    RAISE EXCEPTION 'a cutover ledger has leaked direct read authority';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid =
       'public.fn_seal_phase_one_customization_cutover(text,text)'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'the cutover sealer owner, search path, or ACL is wrong';
  END IF;
END;
$phase1_proof$;
