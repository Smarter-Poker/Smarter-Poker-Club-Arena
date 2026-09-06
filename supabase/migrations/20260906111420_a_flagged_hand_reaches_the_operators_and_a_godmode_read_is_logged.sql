-- ============================================================================
--  A FLAGGED HAND REACHES THE OPERATORS, AND A GODMODE READ IS LOGGED
--  Phase 6 of 7, Previous Hand build plan (docs/PREVIOUS-HAND-REPLAYER-BUILD-PLAN.md)
-- ============================================================================
--
--  Two things, and the second is the reason the first is safe to have.
--
--  1. A PLAYER CAN FLAG A HAND. One button files the hand id and a note with
--     the club's operators, and the player can see what happened to it. Until
--     now the only way to raise a hand was `user_reports`, which folds the
--     hand number into free text (`ReportPlayerPage`: "Hand: 6421788" inside a
--     paragraph) - so no operator could open the hand it names, and nothing
--     could count how many flags a hand has.
--
--  2. AN OPERATOR CAN READ THE WHOLE HAND, AND THE READ IS ALWAYS LOGGED.
--     Every seat's hole cards, including the ones that folded and the ones
--     that mucked - cards the table NEVER saw. That is the most sensitive
--     read on this platform and it exists because a dispute cannot be settled
--     without it.
--
--  WHY THE LOG CANNOT BE SKIPPED, which is the whole design:
--
--    * `table_hole_cards` is readable only by `auth.uid() = user_id`, and
--      `hand_history` only by a player who was dealt into the hand. So an
--      operator has NO path to another player's cards except the function
--      below.
--    * `audit_trail` REVOKEs INSERT from `authenticated`. So the audit row
--      can only be written by a definer function.
--    * `fn_ca_operator_read_hand` writes that row and returns the cards in
--      the SAME statement. One transaction: if the insert fails, the function
--      fails, and nothing is returned. There is no ordering, no flag and no
--      caller cooperation involved - the log is not a side effect of the
--      read, it is part of it.
--
--  WHAT `hand_history` ALREADY HOLDS, measured 2026-09-06 so nobody re-runs
--  it: `hole_cards` is populated on 68 of 500 recent hands - exactly the ones
--  that reached a showdown. Across 8,193 showdown rows in 4,000 hands, ZERO
--  mucked seats have cards stored, zero shown seats are missing them, and no
--  hand carries more card entries than it had showers. That column holds what
--  the table SAW, so a player reading their own hand learns nothing they were
--  not shown. The unshown holdings live only in `table_hole_cards`, which is
--  why the operator read has to go there and why it has to be logged.
--
--  ROLES. Two different questions, two different answers:
--    * TRIAGE is staff - owner, co_owner, admin, manager, super_agent, agent.
--      Seeing that a hand was flagged and by whom is moderation intake.
--    * THE CARDS ARE CONTROL - owner, co_owner, admin, and the club's own
--      `clubs.owner_id`. Seeing what everyone folded is not triage.
--  Stated inline rather than through `is_club_admin()`, whose set (owner,
--  co_owner, admin, manager, agent) is neither of these and would quietly
--  hand an agent every hole card at the club.
--
--  ONE TRANSACTION, per the production DDL policy in CLAUDE.md section 2:
--  each DDL statement fires `pgrst_ddl_watch` and a PostgREST schema reload
--  takes ~28 seconds on this database. Postgres coalesces the NOTIFYs inside
--  a single transaction.
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- THE FLAG
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ca_hand_flags (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hand_id       uuid NOT NULL REFERENCES public.hand_history (id) ON DELETE CASCADE,
  club_id       uuid NOT NULL REFERENCES public.clubs (id) ON DELETE CASCADE,
  -- Denormalised from the hand at the moment it is filed. `hand_history` is
  -- pruned for horse-only hands and a table row can be recycled; a flag that
  -- outlives either still has to say which hand it was about.
  table_id      uuid,
  hand_number   bigint,
  flagged_by    uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  note          text NOT NULL,
  status        text NOT NULL DEFAULT 'open',
  operator_note text,
  reviewed_by   uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  reviewed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ca_hand_flags_note_len CHECK (char_length(btrim(note)) BETWEEN 4 AND 2000),
  CONSTRAINT ca_hand_flags_operator_note_len CHECK (
    operator_note IS NULL OR char_length(operator_note) <= 2000
  ),
  CONSTRAINT ca_hand_flags_status CHECK (
    status IN ('open', 'under_review', 'resolved', 'dismissed')
  ),
  -- One player, one hand, one flag. A second concern about the same hand is a
  -- reply on the one that is open, not a second row in the queue.
  CONSTRAINT ca_hand_flags_one_per_player UNIQUE (hand_id, flagged_by)
);

COMMENT ON TABLE public.ca_hand_flags IS
  'A player''s flag on a hand they played, filed with their club''s operators. Written only through fn_ca_flag_hand; resolved only through fn_ca_resolve_hand_flag.';

CREATE INDEX IF NOT EXISTS ca_hand_flags_club_status_idx
  ON public.ca_hand_flags (club_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ca_hand_flags_mine_idx
  ON public.ca_hand_flags (flagged_by, created_at DESC);
CREATE INDEX IF NOT EXISTS ca_hand_flags_hand_idx
  ON public.ca_hand_flags (hand_id);

ALTER TABLE public.ca_hand_flags ENABLE ROW LEVEL SECURITY;

-- READS. The player sees their own; club staff see their club's queue.
-- There is no INSERT, UPDATE or DELETE policy on purpose: every write goes
-- through a definer function below, so the club id cannot be chosen by the
-- caller and a status cannot be moved without an audit row.
DROP POLICY IF EXISTS ca_hand_flags_select_own ON public.ca_hand_flags;
CREATE POLICY ca_hand_flags_select_own
  ON public.ca_hand_flags
  FOR SELECT
  TO authenticated
  USING (flagged_by = (SELECT auth.uid()));

DROP POLICY IF EXISTS ca_hand_flags_select_staff ON public.ca_hand_flags;
CREATE POLICY ca_hand_flags_select_staff
  ON public.ca_hand_flags
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.club_members m
      WHERE m.club_id = ca_hand_flags.club_id
        AND m.user_id = (SELECT auth.uid())
        AND COALESCE(m.is_active, true)
        AND COALESCE(m.status, 'active') IN ('active', 'approved')
        AND m.role IN ('owner', 'co_owner', 'admin', 'manager', 'super_agent', 'agent')
    )
    OR EXISTS (
      SELECT 1 FROM public.clubs c
      WHERE c.id = ca_hand_flags.club_id AND c.owner_id = (SELECT auth.uid())
    )
  );

REVOKE ALL ON public.ca_hand_flags FROM PUBLIC, anon;
GRANT SELECT ON public.ca_hand_flags TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- WHO IS WHO. Two sets, said once each.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_ca_is_club_staff(p_club_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_user_id IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.club_members m
      WHERE m.club_id = p_club_id
        AND m.user_id = p_user_id
        AND COALESCE(m.is_active, true)
        AND COALESCE(m.status, 'active') IN ('active', 'approved')
        AND m.role IN ('owner', 'co_owner', 'admin', 'manager', 'super_agent', 'agent')
    )
    OR EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_club_id AND c.owner_id = p_user_id)
  );
$$;

COMMENT ON FUNCTION public.fn_ca_is_club_staff(uuid, uuid) IS
  'Club staff: may triage a flagged hand. NOT the set that may read hole cards - see fn_ca_is_club_control.';

CREATE OR REPLACE FUNCTION public.fn_ca_is_club_control(p_club_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_user_id IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.club_members m
      WHERE m.club_id = p_club_id
        AND m.user_id = p_user_id
        AND COALESCE(m.is_active, true)
        AND COALESCE(m.status, 'active') IN ('active', 'approved')
        AND m.role IN ('owner', 'co_owner', 'admin')
    )
    OR EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_club_id AND c.owner_id = p_user_id)
  );
$$;

COMMENT ON FUNCTION public.fn_ca_is_club_control(uuid, uuid) IS
  'Club control: the only set that may read every seat''s hole cards, and only through fn_ca_operator_read_hand, which logs it.';

-- The role to record in `audit_trail.actor_role`, which is CHECK-constrained.
CREATE OR REPLACE FUNCTION public.fn_ca_club_actor_role(p_club_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT m.role FROM public.club_members m
      WHERE m.club_id = p_club_id AND m.user_id = p_user_id
        AND m.role IN ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent')
      ORDER BY CASE m.role
        WHEN 'owner' THEN 0 WHEN 'co_owner' THEN 1 WHEN 'admin' THEN 2
        WHEN 'super_agent' THEN 3 WHEN 'agent' THEN 4 ELSE 5 END
      LIMIT 1),
    (SELECT 'owner' FROM public.clubs c WHERE c.id = p_club_id AND c.owner_id = p_user_id),
    'player'
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- FILING A FLAG
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_ca_flag_hand(p_hand_id uuid, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_hand   record;
  v_club   uuid;
  v_note   text := btrim(COALESCE(p_note, ''));
  v_row    public.ca_hand_flags%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not signed in' USING ERRCODE = '28000';
  END IF;
  IF char_length(v_note) < 4 THEN
    RAISE EXCEPTION 'say what is wrong with the hand' USING ERRCODE = '22023';
  END IF;

  SELECT h.id, h.table_id, h.hand_number, h.players
    INTO v_hand
    FROM public.hand_history h
   WHERE h.id = p_hand_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such hand' USING ERRCODE = 'P0002';
  END IF;

  /* YOU CAN ONLY FLAG A HAND YOU PLAYED. The same predicate `hand_history`'s
     own SELECT policy uses, restated here because this function is a definer
     and RLS is not applied to it - the check has to be explicit or it is not
     made at all. */
  IF NOT (v_hand.players @> jsonb_build_array(jsonb_build_object('userId', v_uid::text))) THEN
    RAISE EXCEPTION 'that hand is not yours to flag' USING ERRCODE = '42501';
  END IF;

  SELECT t.club_id INTO v_club FROM public.tables t WHERE t.id = v_hand.table_id;
  IF v_club IS NULL THEN
    /* Measured 2026-09-06: every one of 3,000 recent and 2,000 oldest hands
       resolves to a club, so this is the honest refusal for a table row that
       has genuinely gone, not an expected path. */
    RAISE EXCEPTION 'that hand has no club on record, so it cannot reach an operator'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.ca_hand_flags (hand_id, club_id, table_id, hand_number, flagged_by, note)
  VALUES (v_hand.id, v_club, v_hand.table_id, v_hand.hand_number, v_uid, v_note)
  ON CONFLICT (hand_id, flagged_by) DO UPDATE
    SET note = EXCLUDED.note,
        updated_at = now(),
        /* Re-filing a flag an operator already closed re-opens it; one that is
           still open just takes the new words. */
        status = CASE WHEN public.ca_hand_flags.status IN ('resolved', 'dismissed')
                      THEN 'open' ELSE public.ca_hand_flags.status END
  RETURNING * INTO v_row;

  RETURN to_jsonb(v_row);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- THE OPERATOR'S QUEUE
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_ca_club_hand_flags(
  p_club_id uuid,
  p_status  text DEFAULT NULL,
  p_limit   integer DEFAULT 100
)
RETURNS TABLE (
  id            uuid,
  hand_id       uuid,
  hand_number   bigint,
  table_id      uuid,
  table_name    text,
  flagged_by    uuid,
  note          text,
  status        text,
  operator_note text,
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  created_at    timestamptz,
  updated_at    timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT public.fn_ca_is_club_staff(p_club_id, v_uid) THEN
    RAISE EXCEPTION 'not an operator of this club' USING ERRCODE = '42501';
  END IF;

  /* THE NAME IS NOT RESOLVED HERE. `playerDisplayName` is the one place that
     decides what a player is called, and it carries a rule this query cannot
     restate safely: a real name must never be rendered (Dan 2026-09-02), and
     `display_name` holds exactly `full_name` for 264 of 1,308 profiles. A
     second resolution written in SQL would be a second answer to that
     question, and the two would drift. The id travels; the client names it
     through the same helper every other surface uses. */
  RETURN QUERY
  SELECT f.id, f.hand_id, f.hand_number, f.table_id,
         t.name AS table_name,
         f.flagged_by,
         f.note, f.status, f.operator_note, f.reviewed_by, f.reviewed_at,
         f.created_at, f.updated_at
    FROM public.ca_hand_flags f
    LEFT JOIN public.tables t ON t.id = f.table_id
   WHERE f.club_id = p_club_id
     AND (p_status IS NULL OR p_status = 'all' OR f.status = p_status)
   ORDER BY
     /* Open work first, and oldest first inside it: a queue sorted newest-first
        buries the flag that has been waiting longest. */
     CASE WHEN f.status IN ('open', 'under_review') THEN 0 ELSE 1 END,
     CASE WHEN f.status IN ('open', 'under_review') THEN f.created_at END ASC,
     f.updated_at DESC
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RESOLVING ONE
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_ca_resolve_hand_flag(
  p_flag_id       uuid,
  p_status        text,
  p_operator_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_flag public.ca_hand_flags%ROWTYPE;
  v_note text := NULLIF(btrim(COALESCE(p_operator_note, '')), '');
BEGIN
  IF p_status NOT IN ('open', 'under_review', 'resolved', 'dismissed') THEN
    RAISE EXCEPTION 'unknown status %', p_status USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_flag FROM public.ca_hand_flags WHERE id = p_flag_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such flag' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.fn_ca_is_club_staff(v_flag.club_id, v_uid) THEN
    RAISE EXCEPTION 'not an operator of this club' USING ERRCODE = '42501';
  END IF;

  /* A CLOSED FLAG SAYS WHY. The player is told what happened to what they
     filed, so "resolved" with nothing attached is not an answer. */
  IF p_status IN ('resolved', 'dismissed') AND v_note IS NULL THEN
    RAISE EXCEPTION 'closing a flag needs a note the player can read'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.ca_hand_flags
     SET status = p_status,
         operator_note = COALESCE(v_note, operator_note),
         reviewed_by = v_uid,
         reviewed_at = now(),
         updated_at = now()
   WHERE id = p_flag_id
   RETURNING * INTO v_flag;

  INSERT INTO public.audit_trail
    (actor_id, actor_role, action, target_type, target_id, club_id, reason, after_state)
  VALUES (
    v_uid,
    public.fn_ca_club_actor_role(v_flag.club_id, v_uid),
    'hand_flag_' || p_status,
    'hand_flag',
    p_flag_id::text,
    v_flag.club_id,
    v_note,
    jsonb_build_object(
      'hand_id', v_flag.hand_id,
      'hand_number', v_flag.hand_number,
      'status', v_flag.status
    )
  );

  RETURN to_jsonb(v_flag);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- THE AUDITED GODMODE READ
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_ca_operator_read_hand(
  p_club_id     uuid,
  p_hand_number bigint,
  p_reason      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_hand   public.hand_history%ROWTYPE;
  v_club   uuid;
  v_cards  jsonb;
  v_out    jsonb;
BEGIN
  IF NOT public.fn_ca_is_club_control(p_club_id, v_uid) THEN
    RAISE EXCEPTION 'only a club owner or admin may open a hand'
      USING ERRCODE = '42501';
  END IF;

  /* A REASON IS PART OF THE READ, not a form field beside it. It is written
     verbatim into the audit row, so it has to be long enough to mean
     something: "x" and "." are not reasons. */
  IF char_length(v_reason) < 8 THEN
    RAISE EXCEPTION 'say why this hand is being opened' USING ERRCODE = '22023';
  END IF;

  SELECT h.* INTO v_hand
    FROM public.hand_history h
   WHERE h.hand_number = p_hand_number
   ORDER BY h.created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no hand numbered %', p_hand_number USING ERRCODE = 'P0002';
  END IF;

  /* THE HAND MUST BE THIS CLUB'S. An operator of one club has no standing to
     read a hand dealt at another, and hand numbers are global. */
  SELECT t.club_id INTO v_club FROM public.tables t WHERE t.id = v_hand.table_id;
  IF v_club IS DISTINCT FROM p_club_id THEN
    RAISE EXCEPTION 'hand % was not dealt at this club', p_hand_number
      USING ERRCODE = '42501';
  END IF;

  /* Every seat's cards, including the ones that folded and the ones that
     mucked - the holdings the table never saw, which is the entire reason
     this function exists and the entire reason it is logged. */
  SELECT jsonb_object_agg(c.user_id::text, c.cards)
    INTO v_cards
    FROM public.table_hole_cards c
   WHERE c.table_id = v_hand.table_id
     AND c.hand_number = v_hand.hand_number;

  /* THE LOG IS PART OF THE READ. `audit_trail` REVOKEs INSERT from
     `authenticated`, so this definer function is the only writer, and it is
     the same statement that returns the cards: one transaction, so a failed
     insert fails the read and nothing is handed back. There is no order of
     operations for a caller to get wrong and no flag for one to omit. */
  INSERT INTO public.audit_trail
    (actor_id, actor_role, action, target_type, target_id, club_id, reason, after_state)
  VALUES (
    v_uid,
    public.fn_ca_club_actor_role(p_club_id, v_uid),
    'hand_godmode_read',
    'hand',
    v_hand.id::text,
    p_club_id,
    v_reason,
    jsonb_build_object(
      'hand_number', v_hand.hand_number,
      'table_id', v_hand.table_id,
      'seats_revealed', (SELECT count(*) FROM jsonb_object_keys(COALESCE(v_cards, '{}'::jsonb))),
      'played_at', COALESCE(v_hand.started_at, v_hand.created_at)
    )
  );

  /* The row shape the client's ONE reconstruction already reads
     (`replayInputFromRow`), with `all_hole_cards` beside it. The operator
     watches the same replayer every other surface renders; the only
     difference is that no seat is face down. */
  v_out := to_jsonb(v_hand) || jsonb_build_object(
    'all_hole_cards', COALESCE(v_cards, '{}'::jsonb),
    'club_id', p_club_id
  );

  RETURN v_out;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- GRANTS. `authenticated` only; `anon` gets nothing anywhere here.
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.fn_ca_is_club_staff(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_ca_is_club_control(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_ca_club_actor_role(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_ca_flag_hand(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_ca_club_hand_flags(uuid, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_ca_resolve_hand_flag(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_ca_operator_read_hand(uuid, bigint, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_ca_is_club_staff(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_is_club_control(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_actor_role(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_flag_hand(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_hand_flags(uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_resolve_hand_flag(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_operator_read_hand(uuid, bigint, text) TO authenticated;

-- Keeps `updated_at` honest without asking every writer to remember it.
CREATE OR REPLACE FUNCTION public.fn_ca_hand_flags_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ca_hand_flags_touch ON public.ca_hand_flags;
CREATE TRIGGER trg_ca_hand_flags_touch
  BEFORE UPDATE ON public.ca_hand_flags
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_hand_flags_touch();

COMMIT;
