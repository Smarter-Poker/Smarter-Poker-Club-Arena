-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905000730; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905000730   (the stamp IS the apply time, UTC: 2026-09-05 00:07:30)
--   name        the_club_message_has_one_rule_and_one_door
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 16578 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905000730 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TRIGGER        trg_clubs_lobby_message_keeps_its_own_books
--     FUNCTION       public.fn_can_manage_club_message, public.fn_can_manage_club_message_uid, public.fn_clubs_lobby_message_keeps_its_own_books, public.fn_get_club_entry_message, public.fn_set_club_lobby_message, public.fn_get_club_message_management, public.fn_save_club_identity_messages_versioned
--     DROP           TRIGGER trg_clubs_lobby_message_keeps_its_own_books
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- ═══════════════════════════════════════════════════════════════════════════════
--  THE CLUB MESSAGE HAS ONE RULE AND ONE DOOR (Dan, 2026-09-04)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan, verbatim: "THE CLUB MESSAGE DOESN'T POP UP AT ALL NOW... I WANT YOU TO DO
-- A DEEP DIVE AND AUDIT EVERYTHING, GET DONE TO THE ROOT CAUSE OF WHAT WAS
-- BROKEN AND FIX IT AT ITS CORE. THEN FIX IT SO IT ACTUALLY WORKS, NEVER BLOCKS
-- ENTIRE PAGES, AND CAN BE MANAGED FROM THE TABLE MANEGEMENT PAGE BY CLUB OR
-- UNION OWNERS."
--
-- WHAT WAS BROKEN, MEASURED. 20260904012413 made fn_get_club_entry_message
-- require clubs.lobby_message_updated_at IS NOT NULL, on the theory that the
-- column is "exact evidence a human wrote this through the guarded writer". On
-- the production project at the time of this migration every one of the four
-- clubs had a non-empty lobby_message and a NULL lobby_message_updated_at, so
-- the RPC answered should_show:false for every club, for every person, and the
-- popup vanished. 395 successful calls in six hours, zero errors, zero
-- dismissals, and nothing on screen. Simulated as the owner inside a rolled
-- back transaction: stamping the column on one club flipped that club - and
-- only that club - to should_show:true. That is the whole bug.
--
-- WHY IT WAS BROKEN, which is the part worth fixing. "Is this message real"
-- was recorded in a column that only SOME of the doors into clubs.lobby_message
-- bothered to keep:
--
--   fn_set_club_lobby_message                 stamped it, bumped the revision
--   fn_save_club_identity_messages_versioned  stamped it, bumped the revision
--   ClubSettingsPage (a direct UPDATE)        stamped it, did NOT bump
--   the migrations that seeded the messages   did neither
--
-- Whether a player saw the greeting depended on which door the text had come
-- through. A rule that lives in the writers is a rule that every writer can
-- forget, and one of them had. The row must keep its own books.
--
-- AND WHO MAY WRITE IT was three different answers too:
--
--   fn_set_club_lobby_message      the club owner, or club staff whose row says
--                                  status = 'active' (every real row says
--                                  'approved', so in practice: the owner only)
--   the versioned identity writer  fn_can_create_games - which for a club that
--                                  belongs to a union admits the UNION owner and
--                                  REJECTS the club's own owner
--   ClubSettingsPage               whoever RLS lets update the club row
--
-- Dan's rule is one sentence - club or union owners - so it becomes one
-- predicate, and every door checks the same one.
--
-- WHAT THIS DOES.
--   1. fn_can_manage_club_message(club, user): the one predicate. Club owner,
--      club staff (owner / co-owner / admin / manager, active OR approved), or
--      an overseer of the union the club belongs to.
--   2. A BEFORE INSERT OR UPDATE trigger on clubs: when lobby_message changes,
--      the row stamps lobby_message_updated_at itself and bumps message_revision
--      itself unless the statement already did. Every door, present and future,
--      behaves the same. Whitespace-only collapses to NULL here too.
--   3. Backfill: a non-empty message with no timestamp is a message somebody
--      wrote before the column existed. It gets today's date and earns the
--      screen. This is what brings the four clubs back.
--   4. fn_get_club_entry_message: should_show is "there is a message and this
--      person has not retired this revision of it". The updated_at gate is gone:
--      with the trigger it could only ever be redundant, and when it was not
--      redundant it was wrong. The reply now also carries can_manage, so the
--      client can offer the editor to a union owner it cannot recognise on its
--      own.
--   5. The three writers and the management reader all authorise through
--      fn_can_manage_club_message. Nothing else about them changes.
--
-- WHAT THIS DOES NOT DO. It does not touch the dismissal model. The X still
-- writes nothing and "Do Not Show Me This Message Again" still retires exactly
-- one revision. It does not make the popup larger: the contained card in
-- ClubEntryMessage.css is unchanged and pinned by theGreetingFillsThePanel.

-- clubs is a busy table on a live site and the trigger below needs a lock on
-- it. Wait briefly rather than sit in a deadlock cycle with a game write: the
-- migration is one transaction, so a timeout rolls back cleanly and is retried.
SET LOCAL lock_timeout = '8s';

-- ── 1. One predicate ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_can_manage_club_message(p_club_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p_club_id IS NOT NULL
     AND p_user_id IS NOT NULL
     AND (
          EXISTS (SELECT 1 FROM public.clubs c
                   WHERE c.id = p_club_id AND c.owner_id = p_user_id)
       OR EXISTS (SELECT 1 FROM public.club_members m
                   WHERE m.club_id = p_club_id
                     AND m.user_id = p_user_id
                     AND m.role IN ('owner', 'co_owner', 'admin', 'manager')
                     -- Both spellings are live. fn_is_club_admin_uid only knew
                     -- one of them, which is why club staff could not write.
                     AND COALESCE(m.status, 'active') IN ('active', 'approved'))
       OR public.fn_union_oversees_club(p_club_id, p_user_id)
     );
$$;

REVOKE ALL ON FUNCTION public.fn_can_manage_club_message(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_can_manage_club_message(uuid, uuid) TO authenticated, service_role;

-- The same question, asked by a browser about itself.
CREATE OR REPLACE FUNCTION public.fn_can_manage_club_message_uid(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.fn_can_manage_club_message(p_club_id, auth.uid());
$$;

REVOKE ALL ON FUNCTION public.fn_can_manage_club_message_uid(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_can_manage_club_message_uid(uuid) TO authenticated, service_role;

-- ── 2. The row keeps its own books ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_clubs_lobby_message_keeps_its_own_books()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Whitespace is not a message. One rule, applied before any writer's own.
  IF NEW.lobby_message IS NOT NULL AND btrim(NEW.lobby_message) = '' THEN
    NEW.lobby_message := NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.lobby_message_updated_at := CASE
      WHEN NEW.lobby_message IS NULL THEN NULL
      ELSE COALESCE(NEW.lobby_message_updated_at, now())
    END;
    RETURN NEW;
  END IF;

  IF NEW.lobby_message IS DISTINCT FROM OLD.lobby_message THEN
    NEW.lobby_message_updated_at := CASE
      WHEN NEW.lobby_message IS NULL THEN NULL
      ELSE now()
    END;
    -- A writer that bumped the revision in this same statement is left alone.
    -- One that forgot is corrected, which is the difference between a message
    -- rewritten from Club Settings reaching a player who dismissed the last
    -- one, and that message never reaching them at all.
    IF NEW.message_revision IS NOT DISTINCT FROM OLD.message_revision THEN
      NEW.message_revision := COALESCE(OLD.message_revision, 0) + 1;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clubs_lobby_message_keeps_its_own_books ON public.clubs;
CREATE TRIGGER trg_clubs_lobby_message_keeps_its_own_books
  BEFORE INSERT OR UPDATE ON public.clubs
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_clubs_lobby_message_keeps_its_own_books();

-- ── 3. Backfill ──────────────────────────────────────────────────────────────
-- lobby_message is not in the SET list, so the trigger leaves the revision
-- alone: nobody's dismissal is invalidated by this, and there are none anyway.

UPDATE public.clubs
   SET lobby_message_updated_at = now()
 WHERE lobby_message IS NOT NULL
   AND btrim(lobby_message) <> ''
   AND lobby_message_updated_at IS NULL;

-- ── 4. The reader ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_get_club_entry_message(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
    -- One rule: there is a message, and this person has not retired THIS
    -- revision of it. Which door the text came through is not the player's
    -- concern, and 20260904012413 proved that making it their concern
    -- silences clubs by accident.
    'should_show', v_message IS NOT NULL
                   AND btrim(v_message) <> ''
                   AND (v_dismissed IS NULL OR v_dismissed < COALESCE(v_revision, 0)),
    -- The server knows about union ownership; the lobby page does not. Say so
    -- here rather than making the client guess and hide the editor.
    'can_manage', public.fn_can_manage_club_message(p_club_id, v_uid)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_get_club_entry_message(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_club_entry_message(uuid) TO authenticated, service_role;

-- ── 5. The writers, and the management reader ────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_set_club_lobby_message(p_club_id uuid, p_message text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_clean    text;
  v_revision bigint;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  -- FOR UPDATE so a concurrent identity save cannot interleave between the
  -- authorisation read and the write, which is the same lock the versioned
  -- writer takes.
  PERFORM 1 FROM public.clubs c WHERE c.id = p_club_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');
  END IF;

  IF NOT public.fn_can_manage_club_message(p_club_id, v_uid) THEN
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
GRANT EXECUTE ON FUNCTION public.fn_set_club_lobby_message(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_get_club_message_management(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_identity jsonb;
  v_identity_revision bigint;
  v_announcements jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.fn_can_manage_club_message(p_club_id, v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;
  SELECT jsonb_build_object(
      'tagline', COALESCE(c.tagline, ''),
      'lobby_message', COALESCE(c.lobby_message, ''),
      'description', COALESCE(c.description, '')
    ), c.message_revision
    INTO v_identity, v_identity_revision
    FROM public.clubs c WHERE c.id = p_club_id;
  IF v_identity IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', a.id,
      'title', a.title,
      'content', a.content,
      'is_pinned', COALESCE(a.is_pinned, false),
      'is_active', COALESCE(a.is_active, true),
      'created_at', a.created_at,
      'updated_at', a.updated_at,
      'revision', a.management_revision
    ) ORDER BY a.is_pinned DESC, a.created_at DESC), '[]'::jsonb)
    INTO v_announcements
    FROM public.club_announcements a WHERE a.club_id = p_club_id;
  RETURN jsonb_build_object(
    'ok', true,
    'identity', v_identity,
    'identity_revision', v_identity_revision,
    'announcements', v_announcements
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_get_club_message_management(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_club_message_management(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_save_club_identity_messages_versioned(
  p_club_id uuid,
  p_expected_revision bigint,
  p_tagline text,
  p_lobby_message text,
  p_description text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_current_revision bigint;
  v_tagline text;
  v_lobby text;
  v_description text;
BEGIN
  IF v_uid IS NULL OR NOT public.fn_can_manage_club_message(p_club_id, v_uid) THEN
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
END;
$$;

REVOKE ALL ON FUNCTION public.fn_save_club_identity_messages_versioned(uuid, bigint, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_save_club_identity_messages_versioned(uuid, bigint, text, text, text) TO authenticated, service_role;
