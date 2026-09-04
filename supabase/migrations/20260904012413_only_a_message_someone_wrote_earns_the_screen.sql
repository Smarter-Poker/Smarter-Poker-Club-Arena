-- ============================================================================
--  ONLY A MESSAGE SOMEONE ACTUALLY WROTE EARNS THE SCREEN
--  (2026-09-04 - the club entry popup was interrupting every player, in every
--   club, with text no staff member ever typed)
-- ============================================================================
--
--  Dan: "the pop up card STILL blocks the entire page when it loads".
--
--  It was not the dismissal logic, which is correct: fn_dismiss_club_message
--  reads the revision server-side, COALESCEs a NULL to 0, and uses GREATEST on
--  conflict so two tabs cannot move a dismissal backwards. And it was not the
--  client, which trusts the server's should_show and is pinned not to re-derive
--  it. Both were audited before this change.
--
--  It was the data, and the reader's inability to see it.
--
--  fn_get_club_entry_message already carried the right INTENT, in its own
--  words: "The tagline fallback is deliberately NOT eligible ... Only a message
--  somebody actually wrote earns the screen." But the condition it shipped only
--  excluded the tagline COLUMN. It could not tell a message a human typed from
--  a message seeded into lobby_message by an earlier migration - and on this
--  platform, every single one is seeded:
--
--      clubs with a lobby_message                       4
--      ... never written by staff (updated_at IS NULL)  4   <-- all of them
--      ... actually written by staff                    0
--      ... seeded at message_revision = 1               4
--      ... where lobby_message is literally the tagline 2
--
--  The four messages are "MESSAGE ME FOR CHIPS...", "West Coast Grinders",
--  "THE BEST POKER UNION ON THE PLANET" and "WELCOME TO THE SHARK CLUB...".
--  Every one is a club identity line, not an announcement. So 100% of clubs
--  interrupted 100% of entries with a full-screen modal containing nothing
--  worth reading. Dan had no dismissal row for Deep Stack Society because the
--  X deliberately does not silence the club (that is his spec), so it returned
--  on every load, forever.
--
--  THE SIGNAL ALREADY EXISTS. fn_set_club_lobby_message stamps
--  lobby_message_updated_at = now() on every real save and sets it back to NULL
--  when the message is cleared:
--
--      lobby_message_updated_at = CASE WHEN v_clean IS NULL THEN NULL ELSE now() END
--
--  so a non-NULL timestamp is exact evidence that a human wrote the message
--  through the guarded writer. The reader simply never consulted it. Adding
--  that one condition makes the function enforce the rule its own comment
--  already stated.
--
--  BLAST RADIUS. This can only make the modal show LESS. Today it silences the
--  popup for all four clubs, because none of their messages were ever written.
--  The moment an owner, co-owner or admin writes a real one, the revision
--  increments, the timestamp is stamped, and the modal appears once per person
--  until they dismiss it - exactly the behaviour Dan asked for.
--
--  Nothing else changes: the dismissal comparison, the empty-string guard, the
--  authentication check and the payload shape are all untouched.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_get_club_entry_message(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
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
    --
    -- 2026-09-04: that rule is now ENFORCED rather than merely intended.
    -- lobby_message_updated_at is stamped by fn_set_club_lobby_message on every
    -- real save and nulled when the message is cleared, so a non-NULL value is
    -- exact evidence a human wrote this through the guarded writer. Without
    -- this condition, a lobby_message seeded by a migration - which was ALL
    -- FOUR clubs, two of them literally the tagline - interrupted every entry
    -- forever with text nobody typed.
    'should_show', v_message IS NOT NULL
                   AND btrim(v_message) <> ''
                   AND v_updated IS NOT NULL
                   AND (v_dismissed IS NULL OR v_dismissed < COALESCE(v_revision, 0))
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_get_club_entry_message(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_club_entry_message(uuid) TO authenticated, service_role;
