-- The club message had four different lengths and one of them threw.
--
-- Found 2026-09-03 while moving the message to a full-screen greeting. The
-- same column was governed by four rules that had never been reconciled:
--
--   clubs_lobby_message_character_limit        CHECK <= 72
--   fn_set_club_lobby_message                  left(v_clean, 240)
--   fn_save_club_identity_messages_versioned   rejects > 72
--   the three client editors                   72, 240 and 72
--
-- So `fn_set_club_lobby_message` accepted up to 240 characters, truncated to
-- 240, and then handed the row to a CHECK that allowed 72. Proved against
-- production inside a rolled-back transaction:
--
--   72 chars  -> ok=true
--   100 chars -> EXCEPTION: violates check constraint
--   240 chars -> EXCEPTION: violates check constraint
--
-- Not a caught, named failure - a raw constraint violation surfacing to the
-- browser as "Could Not Save The Club Message" with nothing to act on. The
-- desktop editor offered a 240-character box, so any staff member who used
-- more than the first 72 hit it. Shipped since 2026-09-01 and invisible,
-- because the only clubs that ever saved were the ones who wrote short.
--
-- WHICH NUMBER WINS. 72 was the right cap for a one-line strip clipped in a
-- fixed-height row; that strip no longer exists. The message is a full-screen
-- greeting now, 240 is what the writer was already trying to allow, and it is
-- the number the modal has always shown in full. So the CHECK moves to 240 and
-- everything else is brought to it, rather than the reverse.
--
-- Widening a CHECK cannot invalidate a stored row: every existing message is
-- 72 or shorter and stays legal. Verified before writing this: 0 rows exceed
-- 72 today.

ALTER TABLE public.clubs
  DROP CONSTRAINT IF EXISTS clubs_lobby_message_character_limit;

ALTER TABLE public.clubs
  ADD CONSTRAINT clubs_lobby_message_character_limit
  CHECK (char_length(COALESCE(lobby_message, ''::text)) <= 240);

-- The second writer. It capped lobby_message at 72 alongside the tagline, and
-- it never set lobby_message_updated_at - which is why 17 of the 17 clubs with
-- a message have no written-at timestamp. The tagline keeps its own 72: it is
-- the permanent identity line, printed under the club name, and it is a
-- different thing with a different job.
CREATE OR REPLACE FUNCTION public.fn_save_club_identity_messages_versioned(p_club_id uuid, p_expected_revision bigint, p_tagline text, p_lobby_message text, p_description text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_current_revision bigint;
  v_tagline text;
  v_lobby text;
  v_description text;
BEGIN
  IF v_uid IS NULL OR NOT public.fn_can_create_games(p_club_id, v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;
  SELECT message_revision INTO v_current_revision
    FROM public.clubs WHERE id = p_club_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');
  END IF;
  IF v_current_revision <> p_expected_revision THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'version_conflict',
      'current_revision', v_current_revision
    );
  END IF;
  -- 240 for the message, matching the CHECK and fn_set_club_lobby_message;
  -- 72 for the tagline, which is a one-line identity and unchanged.
  IF char_length(COALESCE(p_tagline, '')) > 72
    OR char_length(COALESCE(p_lobby_message, '')) > 240
    OR char_length(COALESCE(p_description, '')) > 500 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'character_limit');
  END IF;
  v_tagline := trim(regexp_replace(COALESCE(p_tagline, ''), '[\r\n\t ]+', ' ', 'g'));
  v_lobby := trim(regexp_replace(COALESCE(p_lobby_message, ''), '[\r\n\t ]+', ' ', 'g'));
  v_description := trim(COALESCE(p_description, ''));
  UPDATE public.clubs
    SET tagline = NULLIF(v_tagline, ''),
        lobby_message = NULLIF(v_lobby, ''),
        description = NULLIF(v_description, ''),
        -- Stamped here too. A message written through this path used to arrive
        -- with no written-at, so nothing downstream could tell how old it was.
        lobby_message_updated_at = CASE
          WHEN NULLIF(v_lobby, '') IS NULL THEN NULL
          WHEN NULLIF(v_lobby, '') IS DISTINCT FROM lobby_message THEN now()
          ELSE lobby_message_updated_at
        END,
        message_revision = message_revision + 1,
        updated_at = now()
    WHERE id = p_club_id
    RETURNING message_revision INTO v_current_revision;
  RETURN jsonb_build_object(
    'ok', true,
    'revision', v_current_revision,
    'identity', jsonb_build_object(
      'tagline', v_tagline,
      'lobby_message', v_lobby,
      'description', v_description
    )
  );
END $function$;