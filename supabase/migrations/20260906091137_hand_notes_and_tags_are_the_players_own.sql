-- 20260906091137_hand_notes_and_tags_are_the_players_own.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Phase 5 of the Previous Hand build plan: a player can write a note on a hand
-- and tag it, then find it again by either.
--
-- THE NOTE IS THE PLAYER'S OWN, AND ONLY THEIRS. It is a private record of
-- what they thought about a hand - "called too light", "he always does this
-- on a paired board" - and it is about other people at the table. Two things
-- follow, and both are enforced here rather than in the client:
--
--   1. RLS lets a row be read, written, changed or deleted by exactly one
--      person: the one whose user_id it carries. There is no shared note, no
--      club-visible note, and no operator read. `auth.uid() = user_id` on
--      every one of the four commands, with WITH CHECK on the two that write
--      so a row cannot be inserted or moved onto somebody else's id.
--   2. The grant is to `authenticated` only. `anon` gets nothing at all.
--
-- ONE ROW PER PLAYER PER HAND, so writing a note twice edits it rather than
-- growing a pile: the primary key is (user_id, hand_id) and the client upserts
-- on it. `hand_id` references `hand_history(id)` ON DELETE CASCADE, so when
-- the horse-only retention sweep prunes a hand its notes go with it instead of
-- becoming rows pointing at nothing.
--
-- SIZE IS BOUNDED IN THE DATABASE. A note is capped at 2,000 characters and a
-- hand may carry at most 12 tags of at most 24 characters each, checked here.
-- A cap that lives only in a text input is a suggestion.
--
-- The per-tag length rule is a FUNCTION rather than an inline check because a
-- CHECK constraint may not contain a subquery (`0A000: cannot use subquery in
-- check constraint`), and reading every element of an array needs one. The
-- function is IMMUTABLE and touches nothing but its argument, which is what
-- makes it legal in a constraint.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_hand_tags_ok(p_tags text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_tags IS NULL OR NOT EXISTS (
    SELECT 1 FROM unnest(p_tags) AS t
    WHERE char_length(t) = 0 OR char_length(t) > 24
  );
$$;

COMMENT ON FUNCTION public.fn_ca_hand_tags_ok(text[]) IS
  'Every tag is 1..24 characters. A CHECK constraint may not contain a subquery, so the rule lives in an IMMUTABLE function the constraint calls.';

CREATE TABLE IF NOT EXISTS public.ca_hand_notes (
  user_id    uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  hand_id    uuid        NOT NULL REFERENCES public.hand_history (id) ON DELETE CASCADE,
  note       text        NOT NULL DEFAULT '',
  tags       text[]      NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ca_hand_notes_pkey PRIMARY KEY (user_id, hand_id),
  CONSTRAINT ca_hand_notes_note_len CHECK (char_length(note) <= 2000),
  CONSTRAINT ca_hand_notes_tag_count CHECK (coalesce(array_length(tags, 1), 0) <= 12),
  CONSTRAINT ca_hand_notes_tag_len CHECK (public.fn_ca_hand_tags_ok(tags))
);

COMMENT ON TABLE public.ca_hand_notes IS
  'A player''s own private note and tags on one hand. RLS: readable and '
  'writable by that player alone - never by a club, an operator or anon.';

-- The archive lists a player's most recently noted hands, and the search
-- filters "hands I noted" - both are (user_id, updated_at desc).
CREATE INDEX IF NOT EXISTS ca_hand_notes_user_updated_idx
  ON public.ca_hand_notes (user_id, updated_at DESC);

-- Finding a hand by tag is a containment test on the player's own rows.
CREATE INDEX IF NOT EXISTS ca_hand_notes_tags_idx
  ON public.ca_hand_notes USING gin (tags);

ALTER TABLE public.ca_hand_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ca_hand_notes_select_own ON public.ca_hand_notes;
CREATE POLICY ca_hand_notes_select_own ON public.ca_hand_notes
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS ca_hand_notes_insert_own ON public.ca_hand_notes;
CREATE POLICY ca_hand_notes_insert_own ON public.ca_hand_notes
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS ca_hand_notes_update_own ON public.ca_hand_notes;
CREATE POLICY ca_hand_notes_update_own ON public.ca_hand_notes
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS ca_hand_notes_delete_own ON public.ca_hand_notes;
CREATE POLICY ca_hand_notes_delete_own ON public.ca_hand_notes
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.ca_hand_notes FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ca_hand_notes TO authenticated;

-- `updated_at` is what the archive sorts by, so it may not be left to the
-- client: a browser that never sets it would sort its own notes wrongly, and
-- one that sets it forward would sort them above everybody else's.
CREATE OR REPLACE FUNCTION public.fn_ca_hand_notes_touch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ca_hand_notes_touch ON public.ca_hand_notes;
CREATE TRIGGER trg_ca_hand_notes_touch
  BEFORE INSERT OR UPDATE ON public.ca_hand_notes
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_hand_notes_touch();

COMMIT;
