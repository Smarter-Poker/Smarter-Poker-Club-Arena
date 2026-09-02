-- ═══════════════════════════════════════════════════════════════════════════════
--  A LOGGED-OUT CALLER WRITES NOTHING, AND TWO WRITERS SHARE ONE VERSION
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Found on 2026-09-01 by reading why `Schema Manifest Refresh` had been red
-- since 17:26 UTC. Its first job is the live definer-exposure audit, and the
-- audit was right:
--
--     [definer-exposure] A LOGGED-OUT CALLER CAN EXECUTE A WRITING FUNCTION.
--       fn_set_club_lobby_message(p_club_id uuid, p_message text)
--
-- Because that job fails, the `refresh` job behind it never runs, so
-- `supabase-schema-manifest.json` had also stopped refreshing. Every agent
-- since has been hand-writing manifest fragments against a stale snapshot.
-- One wrong grant was costing the whole estate.
--
-- ── 1. WHY THE GRANT WAS THERE, GIVEN THE MIGRATION TRIED TO PREVENT IT ────
--
-- 20260902113000 ends with what looks like the right thing:
--
--     REVOKE ALL ON FUNCTION public.fn_set_club_lobby_message(uuid, text)
--       FROM PUBLIC;
--     GRANT EXECUTE ... TO authenticated;
--
-- It is not the right thing here. Supabase grants EXECUTE on new functions in
-- `public` to anon, authenticated and service_role EXPLICITLY, not through
-- PUBLIC. Revoking PUBLIC therefore removes a grant that was never the one
-- doing the work, and leaves `anon` holding EXECUTE. The idiom the audit
-- prints names anon for exactly this reason:
--
--     REVOKE ALL ON FUNCTION public.<name>(<types>) FROM PUBLIC, anon;
--     GRANT EXECUTE ON FUNCTION public.<name>(<types>) TO authenticated, service_role;
--
-- The function does check `auth.uid() IS NULL` and refuse. That is not the
-- point, and the audit says so: the 2026-08-28 rebuy hole was a guard that
-- read auth.uid() and skipped itself when there was none, and the only thing
-- between that and a live exploit was a grant exactly like this one. A
-- logged-out caller has no business reaching a writing function at all.
--
-- ── 2. TWO WRITERS, ONE COLUMN, ONE OF THEM IGNORING THE VERSION ───────────
--
-- `clubs.lobby_message` now has two writers:
--
--   fn_save_club_identity_messages_versioned  (Phase 5) reads message_revision
--     FOR UPDATE, refuses on mismatch with 'version_conflict', and bumps it.
--   fn_set_club_lobby_message                 (the owner's daily message)
--     writes the same column and never touches message_revision.
--
-- So the legacy path is invisible to the compare-and-swap. An operator with
-- the Phase 5 panel open holds a revision that is still "current" after
-- somebody else has rewritten the message underneath them, sees no conflict,
-- and overwrites it on save. That is precisely the overwritten-draft failure
-- Phase 5 exists to prevent, reintroduced by a sibling writer.
--
-- Bumping the revision here does not change who may write or what they may
-- write. It makes the other writer VISIBLE to the version, so the panel now
-- returns 'version_conflict' and reloads, which is what it was built to do.
--
-- NOT CHANGED, AND DELIBERATELY LEFT FOR DAN: the two writers disagree on the
-- length of the same column. This one caps at 240 ("the width the modal shows
-- in full", Dan's daily-message feature); the Phase 5 identity panel caps
-- lobby_message at 72 and calls it a one-line identity message. Today no club
-- is affected - 17 clubs have a message, the longest is exactly 72 - so
-- nothing is at risk and nothing needs truncating. But they are two different
-- ideas of what this column is, and picking one is a product decision, not a
-- migration.
--
-- ONE TRANSACTION, one PostgREST schema reload (CLAUDE.md section 2).
-- The grants come AFTER the replace: CREATE OR REPLACE FUNCTION preserves the
-- existing ACL, so revoking first would simply be undone by the replace.

BEGIN;

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
  v_uid      uuid := auth.uid();
  v_owner    uuid;
  v_clean    text;
  v_revision bigint;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  -- FOR UPDATE so a concurrent identity save cannot interleave between the
  -- authorisation read and the write, which is the same lock the versioned
  -- writer takes.
  SELECT c.owner_id INTO v_owner
    FROM public.clubs c WHERE c.id = p_club_id FOR UPDATE;
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
         lobby_message_updated_at = CASE WHEN v_clean IS NULL THEN NULL ELSE now() END,
         message_revision = message_revision + 1
   WHERE id = p_club_id
   RETURNING message_revision INTO v_revision;

  RETURN jsonb_build_object(
    'ok', true,
    'lobby_message', v_clean,
    'revision', v_revision
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_set_club_lobby_message(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_set_club_lobby_message(uuid, text)
  TO authenticated, service_role;

COMMIT;
