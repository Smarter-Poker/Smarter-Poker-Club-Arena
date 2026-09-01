-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901170904; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

BEGIN;

ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS lobby_message text,
  ADD COLUMN IF NOT EXISTS lobby_message_updated_at timestamptz;

COMMENT ON COLUMN public.clubs.lobby_message IS
  'Owner/admin-authored message shown at the top of the club lobby rail, above the club card. The day''s message or anything custom. Falls back to tagline, then to a plain welcome line. Set through fn_set_club_lobby_message.';
COMMENT ON COLUMN public.clubs.lobby_message_updated_at IS
  'When lobby_message was last written. Lets the lobby show how fresh the day''s message is.';

CREATE OR REPLACE FUNCTION public.fn_set_club_lobby_message(
  p_club_id uuid,
  p_message text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_owner   uuid;
  v_clean   text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT c.owner_id INTO v_owner FROM public.clubs c WHERE c.id = p_club_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');
  END IF;

  IF v_owner IS DISTINCT FROM v_uid AND NOT public.fn_is_club_admin_uid(p_club_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  v_clean := NULLIF(btrim(regexp_replace(COALESCE(p_message, ''), '\s+', ' ', 'g')), '');
  IF v_clean IS NOT NULL THEN
    v_clean := left(v_clean, 240);
  END IF;

  UPDATE public.clubs
     SET lobby_message = v_clean,
         lobby_message_updated_at = CASE WHEN v_clean IS NULL THEN NULL ELSE now() END
   WHERE id = p_club_id;

  RETURN jsonb_build_object('ok', true, 'lobby_message', v_clean);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_set_club_lobby_message(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_set_club_lobby_message(uuid, text) TO authenticated;

COMMIT;
