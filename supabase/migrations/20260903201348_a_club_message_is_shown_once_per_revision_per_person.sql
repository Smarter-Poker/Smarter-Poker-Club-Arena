-- The club message becomes a full-screen greeting, so it needs to know when to
-- stop greeting.
--
-- Dan, 2026-09-03: the message should meet a player when they enter the club,
-- with an X and a "do not show me this again", and a NEW popup only when the
-- owner, a co-owner or an admin writes a new message.
--
-- That last clause is the whole design. "New" cannot mean "changed text" - an
-- owner fixing a typo would re-interrupt everyone - and it cannot mean a
-- timestamp, because two people dismissing at different moments would compare
-- against different clocks. It means a REVISION, and clubs.message_revision
-- already exists and is already bumped by both writers of lobby_message
-- (fn_set_club_lobby_message and fn_save_club_identity_messages_versioned).
-- So a dismissal records the revision it dismissed, and the next revision
-- speaks again on its own.
--
-- WHY THIS IS A TABLE AND NOT localStorage. "Do not show me this again" that
-- forgets when someone opens the club on their phone is not a promise kept.
-- Players here move between devices constantly, and a greeting that returns
-- after being dismissed reads as broken rather than helpful. One row per
-- person per club, which is the smallest thing that can be true across
-- devices.

CREATE TABLE IF NOT EXISTS public.club_message_dismissals (
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  club_id            uuid        NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  -- The revision the person said they were done with. A later revision is a
  -- different message and shows again.
  dismissed_revision bigint      NOT NULL,
  dismissed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, club_id)
);

ALTER TABLE public.club_message_dismissals ENABLE ROW LEVEL SECURITY;

-- Read-your-own only. Every write goes through the definer below, so there is
-- deliberately no INSERT/UPDATE policy: a client cannot mark a dismissal for
-- somebody else, and cannot forge one for a revision that does not exist.
DROP POLICY IF EXISTS club_message_dismissals_own ON public.club_message_dismissals;
CREATE POLICY club_message_dismissals_own
  ON public.club_message_dismissals FOR SELECT
  USING (user_id = auth.uid());

GRANT SELECT ON public.club_message_dismissals TO authenticated;

-- ── The read ────────────────────────────────────────────────────────────────
-- Exposes nothing a lobby viewer could not already read: clubs.lobby_message
-- is on the club row the lobby already fetches. What it adds is the ONE fact
-- the client cannot compute for itself - whether THIS person has already
-- retired THIS revision.
CREATE OR REPLACE FUNCTION public.fn_get_club_entry_message(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_message   text;
  v_revision  bigint;
  v_updated   timestamptz;
  v_dismissed bigint;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT c.lobby_message, c.message_revision, c.lobby_message_updated_at
    INTO v_message, v_revision, v_updated
    FROM public.clubs c WHERE c.id = p_club_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');
  END IF;

  SELECT d.dismissed_revision INTO v_dismissed
    FROM public.club_message_dismissals d
   WHERE d.user_id = v_uid AND d.club_id = p_club_id;

  RETURN jsonb_build_object(
    'ok', true,
    'message', v_message,
    'revision', COALESCE(v_revision, 0),
    'updated_at', v_updated,
    'dismissed_revision', v_dismissed,
    -- The tagline fallback is deliberately NOT eligible. "Welcome To Club
    -- JAQK" is the club's permanent identity line; interrupting a player with
    -- it on entry is a popup that says nothing. Only a message somebody
    -- actually wrote earns the screen.
    'should_show', v_message IS NOT NULL
                   AND btrim(v_message) <> ''
                   AND (v_dismissed IS NULL OR v_dismissed < COALESCE(v_revision, 0))
  );
END;
$function$;

-- ── The write ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_dismiss_club_message(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_revision bigint;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  -- The revision is read from the club, never accepted from the caller. A
  -- client that sent its own number could dismiss a revision that has not
  -- happened yet and silence every future message for that person.
  SELECT c.message_revision INTO v_revision
    FROM public.clubs c WHERE c.id = p_club_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');
  END IF;

  INSERT INTO public.club_message_dismissals AS d (user_id, club_id, dismissed_revision)
  VALUES (v_uid, p_club_id, COALESCE(v_revision, 0))
  ON CONFLICT (user_id, club_id) DO UPDATE
    -- GREATEST, not assignment: two tabs racing must not move a dismissal
    -- BACKWARDS and resurrect a message the person already retired.
    SET dismissed_revision = GREATEST(d.dismissed_revision, EXCLUDED.dismissed_revision),
        dismissed_at       = now();

  RETURN jsonb_build_object('ok', true, 'dismissed_revision', COALESCE(v_revision, 0));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_get_club_entry_message(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_dismiss_club_message(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_get_club_entry_message(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_dismiss_club_message(uuid) TO authenticated, service_role;