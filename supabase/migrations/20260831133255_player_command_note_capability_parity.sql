-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831133255; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- PLAYER COMMAND PHASE 3: NOTE CAPABILITY PARITY (2026-08-31)
--
-- ca_club_member_detail has always advertised can_edit_notes=false when the
-- actor is the target. Enforce the same rule in the writer so a crafted RPC
-- call cannot bypass what the role-shaped response promises.

DO $patch$
DECLARE
  v_definition text := pg_get_functiondef(
    'public.ca_club_member_notes_update(uuid,uuid,text,text,text)'::regprocedure
  );
  v_old text := E'  v_access := public.ca_club_roster_access(p_club_id, p_target_user_id);\n'
    '  IF v_access NOT IN (''staff'', ''downline'', ''service'') THEN';
  v_new text := E'  v_access := public.ca_club_roster_access(p_club_id, p_target_user_id);\n'
    '  IF v_actor = p_target_user_id THEN\n'
    '    RAISE EXCEPTION USING ERRCODE = ''42501'', MESSAGE = ''Member Notes Are Private Staff Context, Not Self-Editable Profile Fields'';\n'
    '  END IF;\n'
    '  IF v_access NOT IN (''staff'', ''downline'', ''service'') THEN';
BEGIN
  IF position(v_old IN v_definition) = 0 THEN
    RAISE EXCEPTION 'ca_club_member_notes_update access block drifted';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);

  v_definition := pg_get_functiondef(
    'public.ca_club_member_notes_update(uuid,uuid,text,text,text)'::regprocedure
  );
  IF position('v_actor = p_target_user_id' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'note self-edit guard was not installed';
  END IF;
END
$patch$;

REVOKE ALL ON FUNCTION public.ca_club_member_notes_update(uuid, uuid, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_member_notes_update(uuid, uuid, text, text, text)
  TO authenticated, service_role;

