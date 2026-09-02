-- ═══════════════════════════════════════════════════════════════════════════
-- CLUB LOBBY OWNER MESSAGE (Dan, 2026-09-01)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, verbatim: "on desktop in the club arena, the 'welcome to club jaqk'
-- thats on the bottom of the wallets should be at the top above the club card,
-- and that should be the 'custom clickable message' for the club owners to put
-- the days message, or something custom".
--
-- The strip used to print `tagline`, which is the club's PERMANENT identity
-- line: it is written once in the opening wizard, it is a checklist item, and
-- it is edited in Club Settings under "Club Tag Line". A message that changes
-- daily cannot live in the same column as one that is meant never to change -
-- rewriting the tagline every morning would break the opening checklist and
-- the invite page that prints it.
--
-- So this is its own column. `tagline` stays exactly what it is and remains the
-- fallback the strip prints when no owner message has been written.
--
-- ONE TRANSACTION, one PostgREST schema reload (CLAUDE.md section 2, the
-- Production DDL policy).

BEGIN;

ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS lobby_message text,
  ADD COLUMN IF NOT EXISTS lobby_message_updated_at timestamptz;

COMMENT ON COLUMN public.clubs.lobby_message IS
  'Owner/admin-authored message shown at the top of the club lobby rail, above the club card. The day''s message or anything custom. Falls back to tagline, then to a plain welcome line. Set through fn_set_club_lobby_message.';
COMMENT ON COLUMN public.clubs.lobby_message_updated_at IS
  'When lobby_message was last written. Lets the lobby show how fresh the day''s message is.';

-- ── The write path ────────────────────────────────────────────────────────
-- SECURITY DEFINER because the client must never be handed a direct UPDATE on
-- `clubs`: the same row carries treasury, rake and level columns. This function
-- writes two columns and nothing else, and it decides for itself who may.
--
-- Authorisation mirrors the client's `isOwner || isClubStaff(userRole)`:
-- the recorded owner_id, or an active owner/co-owner/admin/manager membership
-- (fn_is_club_admin_uid, already the estate's staff test).
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

  -- Collapse whitespace and newlines: this renders as ONE line in a fixed-height
  -- strip, so a pasted paragraph would either blow the row out or be clipped
  -- mid-sentence. 240 characters is the width the modal shows in full.
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
