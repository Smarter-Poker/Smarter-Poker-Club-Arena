-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825232424; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- LAUNCH FROM TEMPLATE (2026-08-25)
--
-- The admin dashboard's Launch button hand-copied EIGHT fields (name,
-- game_type, blinds, seats, buy-ins) out of a row with over a hundred columns.
-- Every rule the host had configured on that template -- straddle, bomb pots,
-- ante, insurance, run it twice, cap, no-rathole, VIP-only, the lot -- was
-- silently discarded, so a launched template was a plain table wearing the
-- template's name.
--
-- The fix is to stop enumerating columns. This copies the WHOLE row and
-- overrides only the handful that describe identity and live state, so a
-- column added tomorrow is carried without anyone having to remember it.

CREATE OR REPLACE FUNCTION public.fn_launch_table_from_template(p_template_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_row   jsonb;
  v_club  uuid;
  v_new   uuid := gen_random_uuid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_launch_table_from_template requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT to_jsonb(t), t.club_id INTO v_row, v_club
    FROM public.tables t
   WHERE t.id = p_template_id AND COALESCE(t.is_template, false) = true
   LIMIT 1;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'TEMPLATE_NOT_FOUND: % is not a table template', p_template_id;
  END IF;

  -- Only club staff may launch a game. Same question the tables RLS policy
  -- asks on an ordinary insert; asked here because this runs as definer.
  IF NOT (
    EXISTS (SELECT 1 FROM public.club_members cm
             WHERE cm.club_id = v_club AND cm.user_id = v_uid
               AND cm.role IN ('owner', 'admin', 'manager', 'agent'))
    OR EXISTS (SELECT 1 FROM public.clubs c
                WHERE c.id = v_club AND c.owner_id = v_uid)
  ) THEN
    RAISE EXCEPTION 'NOT_CLUB_STAFF: only club staff may launch a table';
  END IF;

  -- Identity and live state are the ONLY things that do not carry over.
  v_row := v_row || jsonb_build_object(
    'id',              v_new,
    'is_template',     false,
    'status',          'active',
    'current_players', 0,
    'hands_dealt',     0,
    'avg_pot',         0,
    'live_state',      NULL,
    'is_deleted',      false,
    'created_by',      v_uid,
    'created_at',      now(),
    'updated_at',      now()
  );

  INSERT INTO public.tables
  SELECT * FROM jsonb_populate_record(NULL::public.tables, v_row);

  RETURN v_new;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_launch_table_from_template(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_launch_table_from_template(uuid) TO authenticated;
