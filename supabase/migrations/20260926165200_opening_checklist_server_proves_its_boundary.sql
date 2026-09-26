-- THE SERVER, NOT THE SCREEN, PROVES A CHECKLIST IS FINISHED.

CREATE OR REPLACE FUNCTION public.fn_club_opening_checklist_eligible(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT c.opening_checklist_started_at IS NOT NULL
     AND COALESCE(c.is_union, false) IS FALSE
     AND c.union_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id = c.id)
    FROM public.clubs c
   WHERE c.id = p_club_id
$function$;
REVOKE ALL ON FUNCTION public.fn_club_opening_checklist_eligible(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_club_opening_checklist_state(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_row public.club_opening_checklists%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign In To Read The Opening Checklist' USING ERRCODE = '42501';
  END IF;
  SELECT c.owner_id INTO v_owner FROM public.clubs c WHERE c.id = p_club_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002'; END IF;
  IF v_owner IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only The Club Owner Can Read The Opening Checklist' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(public.fn_club_opening_checklist_eligible(p_club_id), false) THEN
    RAISE EXCEPTION 'This Club Has No Opening Checklist' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_row FROM public.club_opening_checklists k WHERE k.club_id = p_club_id;
  RETURN jsonb_build_object(
    'clubId', p_club_id, 'completedAt', v_row.completed_at,
    'skippedTaskIds', to_jsonb(COALESCE(v_row.skipped_task_ids, '{}'::text[])));
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_club_opening_checklist_skip(
  p_club_id uuid, p_task_id text, p_skipped boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_task text := btrim(COALESCE(p_task_id, ''));
  v_row public.club_opening_checklists%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign In To Change The Opening Checklist' USING ERRCODE = '42501';
  END IF;
  IF p_skipped IS NULL THEN
    RAISE EXCEPTION 'Say Whether The Step Is Skipped' USING ERRCODE = '22023';
  END IF;
  IF v_task = 'opening-setup' THEN
    RAISE EXCEPTION 'The Opening Setup Wizard Is Required And Cannot Be Skipped'
      USING ERRCODE = '22023';
  END IF;
  IF NOT (v_task = ANY (ARRAY['identity', 'tagline', 'nlh', 'plo', 'limit', 'mtt',
                              'spin', 'heads-up', 'first-player', 'first-agent']::text[])) THEN
    RAISE EXCEPTION 'That Is Not An Optional Opening Checklist Step' USING ERRCODE = '22023';
  END IF;
  SELECT c.owner_id INTO v_owner FROM public.clubs c WHERE c.id = p_club_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002'; END IF;
  IF v_owner IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only The Club Owner Can Change The Opening Checklist' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(public.fn_club_opening_checklist_eligible(p_club_id), false) THEN
    RAISE EXCEPTION 'This Club Has No Opening Checklist' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_row FROM public.club_opening_checklists k
   WHERE k.club_id = p_club_id FOR UPDATE;
  IF FOUND AND v_row.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'The Opening Checklist Is Already Complete' USING ERRCODE = '55000';
  END IF;

  IF p_skipped THEN
    INSERT INTO public.club_opening_checklists AS k (club_id, skipped_task_ids)
    VALUES (p_club_id, ARRAY[v_task])
    ON CONFLICT (club_id) DO UPDATE
       SET skipped_task_ids = ARRAY(SELECT DISTINCT s
                                      FROM unnest(k.skipped_task_ids || ARRAY[v_task]) AS s
                                     ORDER BY s), updated_at = now()
     WHERE k.completed_at IS NULL AND NOT (v_task = ANY (k.skipped_task_ids));
  ELSE
    UPDATE public.club_opening_checklists k
       SET skipped_task_ids = array_remove(k.skipped_task_ids, v_task), updated_at = now()
     WHERE k.club_id = p_club_id AND k.completed_at IS NULL
       AND v_task = ANY (k.skipped_task_ids);
  END IF;
  SELECT * INTO v_row FROM public.club_opening_checklists k WHERE k.club_id = p_club_id;
  RETURN jsonb_build_object(
    'clubId', p_club_id, 'completedAt', v_row.completed_at,
    'skippedTaskIds', to_jsonb(COALESCE(v_row.skipped_task_ids, '{}'::text[])));
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_club_opening_checklist_complete(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_club public.clubs%ROWTYPE;
  v_row public.club_opening_checklists%ROWTYPE;
  v_skipped text[] := '{}'::text[];
  v_unfinished text[] := '{}'::text[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign In To Finish The Opening Checklist' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_club FROM public.clubs c WHERE c.id = p_club_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002'; END IF;
  IF v_club.owner_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only The Club Owner Can Finish The Opening Checklist' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.club_opening_checklists k
   WHERE k.club_id = p_club_id FOR UPDATE;
  IF FOUND AND v_row.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('clubId', p_club_id, 'completedAt', v_row.completed_at,
      'skippedTaskIds', to_jsonb(v_row.skipped_task_ids));
  END IF;
  IF NOT COALESCE(public.fn_club_opening_checklist_eligible(p_club_id), false) THEN
    RAISE EXCEPTION 'This Club Has No Opening Checklist' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.club_opening_setups s WHERE s.club_id = p_club_id) THEN
    RAISE EXCEPTION 'Complete The Opening Setup Wizard First' USING ERRCODE = '55000';
  END IF;
  v_skipped := COALESCE(v_row.skipped_task_ids, '{}'::text[]);

  IF NOT ('identity' = ANY(v_skipped)) AND NOT (
    (NULLIF(btrim(COALESCE(v_club.logo_url, '')), '') IS NOT NULL
      AND v_club.logo_url !~* '(^|/)club-logos/preset-[0-9]+[.](webp|png|jpe?g)([?#].*)?$')
    OR (NULLIF(btrim(COALESCE(v_club.avatar_url, '')), '') IS NOT NULL
      AND v_club.avatar_url !~* '(^|/)club-logos/preset-[0-9]+[.](webp|png|jpe?g)([?#].*)?$')
  ) THEN v_unfinished := array_append(v_unfinished, 'identity'); END IF;
  IF NOT ('tagline' = ANY(v_skipped)) AND NULLIF(btrim(COALESCE(v_club.tagline, '')), '') IS NULL
    THEN v_unfinished := array_append(v_unfinished, 'tagline'); END IF;
  IF NOT ('nlh' = ANY(v_skipped)) AND NOT EXISTS (
    SELECT 1 FROM public.tables t WHERE t.club_id = p_club_id
      AND lower(COALESCE(t.game_variant, '')) IN ('nlh', 'short_deck', 'pineapple')
      AND lower(COALESCE(t.status, '')) NOT IN ('deleted', 'archived'))
    THEN v_unfinished := array_append(v_unfinished, 'nlh'); END IF;
  IF NOT ('plo' = ANY(v_skipped)) AND NOT EXISTS (
    SELECT 1 FROM public.tables t WHERE t.club_id = p_club_id
      AND lower(COALESCE(t.game_variant, '')) LIKE 'plo%'
      AND lower(COALESCE(t.status, '')) NOT IN ('deleted', 'archived'))
    THEN v_unfinished := array_append(v_unfinished, 'plo'); END IF;
  IF NOT ('limit' = ANY(v_skipped)) AND NOT EXISTS (
    SELECT 1 FROM public.tables t WHERE t.club_id = p_club_id
      AND (lower(COALESCE(t.game_variant, '')) IN ('flh', 'flo8')
        OR lower(COALESCE(t.game_variant, '')) LIKE 'limit%')
      AND lower(COALESCE(t.status, '')) NOT IN ('deleted', 'archived'))
    THEN v_unfinished := array_append(v_unfinished, 'limit'); END IF;
  IF NOT ('mtt' = ANY(v_skipped)) AND NOT EXISTS (
    SELECT 1 FROM public.tournaments t WHERE t.club_id = p_club_id
      AND t.format_contract IN ('mtt-v1', 'mtt-v2'))
    THEN v_unfinished := array_append(v_unfinished, 'mtt'); END IF;
  IF NOT ('spin' = ANY(v_skipped)) AND NOT EXISTS (
    SELECT 1 FROM public.tournaments t WHERE t.club_id = p_club_id
      AND t.format_contract = 'spin-v1')
    THEN v_unfinished := array_append(v_unfinished, 'spin'); END IF;
  IF NOT ('heads-up' = ANY(v_skipped)) AND NOT EXISTS (
    SELECT 1 FROM public.tournaments t WHERE t.club_id = p_club_id
      AND t.format_contract = 'sng-v1')
    THEN v_unfinished := array_append(v_unfinished, 'heads-up'); END IF;
  IF NOT ('first-player' = ANY(v_skipped)) AND NOT EXISTS (
    SELECT 1 FROM public.club_members m WHERE m.club_id = p_club_id
      AND m.user_id IS DISTINCT FROM v_club.owner_id
      AND m.status::text IN ('active', 'approved'))
    THEN v_unfinished := array_append(v_unfinished, 'first-player'); END IF;
  IF NOT ('first-agent' = ANY(v_skipped)) AND NOT EXISTS (
    SELECT 1 FROM public.agents a WHERE a.club_id = p_club_id
      AND lower(COALESCE(a.status, 'active')) <> 'inactive')
    THEN v_unfinished := array_append(v_unfinished, 'first-agent'); END IF;

  IF cardinality(v_unfinished) > 0 THEN
    RAISE EXCEPTION 'Finish Or Skip Every Opening Checklist Step: %',
      array_to_string(v_unfinished, ', ') USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.club_opening_checklists AS k (club_id, completed_at, completed_by)
  VALUES (p_club_id, now(), v_uid)
  ON CONFLICT (club_id) DO UPDATE
     SET completed_at = now(), completed_by = v_uid, updated_at = now()
   WHERE k.completed_at IS NULL;
  SELECT * INTO v_row FROM public.club_opening_checklists k WHERE k.club_id = p_club_id;
  RETURN jsonb_build_object('clubId', p_club_id, 'completedAt', v_row.completed_at,
    'skippedTaskIds', to_jsonb(v_row.skipped_task_ids));
END
$function$;

REVOKE ALL ON FUNCTION public.fn_club_opening_checklist_state(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_club_opening_checklist_skip(uuid, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_club_opening_checklist_complete(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_opening_checklist_state(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_opening_checklist_skip(uuid, text, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_opening_checklist_complete(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_club_opening_checklist_complete(uuid) IS
  'Owner only. Latches only an eligible new standalone club whose required setup exists and whose ten optional steps are complete or validly skipped.';
