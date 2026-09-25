CREATE OR REPLACE FUNCTION public.fn_join_club(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_result jsonb;
  v_row public.club_members%ROWTYPE;
  v_owner uuid;
  v_requires_approval boolean;
  v_lifecycle text;
  v_active_count integer;
  v_previous_source text := coalesce(current_setting('app.club_membership_source', true), '');
  v_previous_lifecycle text := coalesce(current_setting('app.club_membership_lifecycle_write', true), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  PERFORM set_config('app.club_membership_source', 'join_club', true);
  BEGIN
    v_result := public.fn_join_club_membership_impl(p_club_id);

    IF coalesce(v_result ->> 'membership_lifecycle_status', 'active') = 'departed' THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('cashier-hierarchy:' || p_club_id::text, 0)
      );
      SELECT c.owner_id, coalesce(c.requires_approval, false),
             coalesce(to_jsonb(c) ->> 'lifecycle_status', 'active')
        INTO v_owner, v_requires_approval, v_lifecycle
        FROM public.clubs c
       WHERE c.id = p_club_id
       FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Club not found'; END IF;
      IF v_lifecycle = 'retired' THEN
        RAISE EXCEPTION 'This Club Is Retired And Cannot Accept Members' USING ERRCODE = '55000';
      END IF;

      SELECT count(*) INTO v_active_count
        FROM public.club_members cm
       WHERE cm.user_id = v_uid
         AND cm.club_id <> p_club_id
         AND cm.membership_lifecycle_status = 'active'
         AND cm.status::text IN ('active', 'approved');
      IF v_uid <> v_owner AND v_active_count >= 10 THEN
        RAISE EXCEPTION 'You can only be a member of up to 10 clubs. Leave a club to join a new one.';
      END IF;

      PERFORM set_config('app.club_membership_lifecycle_write', 'rejoin', true);
      UPDATE public.club_members cm
         SET membership_lifecycle_status = 'active',
             status = CASE
               WHEN v_uid = v_owner OR NOT v_requires_approval THEN 'active'
               ELSE 'pending'
             END,
             is_active = true,
             departed_at = NULL,
             departed_by = NULL,
             departure_reason = NULL,
             updated_at = clock_timestamp()
       WHERE cm.club_id = p_club_id
         AND cm.user_id = v_uid
         AND cm.membership_lifecycle_status = 'departed'
       RETURNING * INTO v_row;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'membership lifecycle changed during rejoin' USING ERRCODE = '40001';
      END IF;
      v_result := to_jsonb(v_row);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.club_membership_source', v_previous_source, true);
    PERFORM set_config('app.club_membership_lifecycle_write', v_previous_lifecycle, true);
    RAISE;
  END;

  PERFORM set_config('app.club_membership_source', v_previous_source, true);
  PERFORM set_config('app.club_membership_lifecycle_write', v_previous_lifecycle, true);
  RETURN v_result;
END
$function$
