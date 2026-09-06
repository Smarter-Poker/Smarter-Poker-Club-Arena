-- ============================================================================
--  THE OPERATOR'S LOOKUP READS THE STORE THAT KEEPS THE CARDS
--  Phase 6 of 7, Previous Hand build plan. Corrects `fn_ca_operator_read_hand`
--  from 20260906111420, written minutes earlier in the same session.
-- ============================================================================
--
--  THE DEFECT, and it would have shipped a lookup that always looked empty.
--
--  That function read the unshown holdings from `table_hole_cards`, on the
--  reasonable-sounding assumption that a table's hole cards are where a
--  table's hole cards live. They are, for about a day. Measured on production
--  2026-09-06: 31,836 rows spanning ~29 hours, pruned every six hours by the
--  `cleanup-hole-cards` cron (`cleanup_old_hole_cards`), and only 982 rows
--  written in a ten-minute window that dealt 3,821 hands.
--
--  A dispute is raised hours or days after the hand. So the lookup would have
--  returned an EMPTY card map for essentially every hand anyone would ever
--  dispute - and an empty map reads exactly like "nobody was holding
--  anything". That is worse than having no lookup at all, because an operator
--  would have settled a dispute on it.
--
--  It was caught by a probe line that only printed a count. The assertion
--  above it passed.
--
--  THE DURABLE STORE is `ca_hand_facts`: one row per player per hand, 1.09M
--  rows back to 2026-08-21, `club_id` already denormalised, carrying
--  `hole_cards`. Over 800 recent hands - 2,696 seats dealt, 2,696 fact rows
--  (every seat), 1,910 of them with cards, against only 238 seats that
--  reached a showdown. That is 1,672 UNSHOWN holdings recoverable, which is
--  the whole point of an operator's read and precisely what the previous
--  source could not give.
--
--  BOTH ARE READ NOW. Facts first; `table_hole_cards` union'd underneath for
--  a hand fresh enough to still be in it, so a seat missing from facts is
--  recovered while it can be.
--
--  AND IT SAYS WHAT IT DOES NOT HAVE. `hand_history` reaches back further
--  than `ca_hand_facts` does, so an old enough hand has seats whose holdings
--  are simply gone. `seats_dealt`, `seats_with_cards` and `cards_complete`
--  travel with the result so the surface can say "3 of 9 holdings are on
--  record" - the same refusal-to-invent the tracker export makes, applied to
--  the one read where inventing would decide a dispute.
--
--  ONE TRANSACTION (CLAUDE.md section 2): one `CREATE OR REPLACE`, one
--  PostgREST schema reload.
-- ============================================================================

BEGIN;

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
  v_cards  jsonb := '{}'::jsonb;
  v_fresh  jsonb;
  v_dealt  int;
  v_have   int;
BEGIN
  IF NOT public.fn_ca_is_club_control(p_club_id, v_uid) THEN
    RAISE EXCEPTION 'only a club owner or admin may open a hand'
      USING ERRCODE = '42501';
  END IF;

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

  SELECT t.club_id INTO v_club FROM public.tables t WHERE t.id = v_hand.table_id;
  IF v_club IS DISTINCT FROM p_club_id THEN
    RAISE EXCEPTION 'hand % was not dealt at this club', p_hand_number
      USING ERRCODE = '42501';
  END IF;

  -- The durable store: every seat's holding, shown or not.
  SELECT COALESCE(jsonb_object_agg(f.user_id::text, f.hole_cards), '{}'::jsonb)
    INTO v_cards
    FROM public.ca_hand_facts f
   WHERE f.hand_id = v_hand.id
     AND f.hole_cards IS NOT NULL
     AND f.hole_cards::text NOT IN ('null', '[]', '{}');

  -- The live store, for a hand young enough to still be in it.
  SELECT jsonb_object_agg(c.user_id::text, c.cards)
    INTO v_fresh
    FROM public.table_hole_cards c
   WHERE c.table_id = v_hand.table_id
     AND c.hand_number = v_hand.hand_number
     AND c.cards IS NOT NULL;

  v_cards := COALESCE(v_fresh, '{}'::jsonb) || v_cards;

  v_dealt := COALESCE(jsonb_array_length(v_hand.players), 0);
  v_have  := (SELECT count(*) FROM jsonb_object_keys(v_cards));

  /* THE LOG IS PART OF THE READ. `audit_trail` REVOKEs INSERT from
     `authenticated`, so this definer function is the only writer, and it is
     the same transaction that returns the cards: a failed insert fails the
     read and nothing is handed back. */
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
      'seats_dealt', v_dealt,
      'seats_revealed', v_have,
      'played_at', COALESCE(v_hand.started_at, v_hand.created_at)
    )
  );

  RETURN to_jsonb(v_hand) || jsonb_build_object(
    'all_hole_cards', v_cards,
    'club_id', p_club_id,
    'seats_dealt', v_dealt,
    'seats_with_cards', v_have,
    -- Says plainly when the record is short, so an absent holding is never
    -- read as an empty one.
    'cards_complete', (v_dealt > 0 AND v_have >= v_dealt)
  );
END;
$$;

COMMENT ON FUNCTION public.fn_ca_operator_read_hand(uuid, bigint, text) IS
  'The audited godmode read: every seat''s holding for one hand at the caller''s own club, from ca_hand_facts (durable) and table_hole_cards (fresh). Writes the audit_trail row in the same transaction that returns the cards, so a read cannot happen unlogged.';

COMMIT;
