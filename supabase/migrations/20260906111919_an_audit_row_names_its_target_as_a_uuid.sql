-- ============================================================================
--  AN AUDIT ROW NAMES ITS TARGET AS A UUID
--  Phase 6 of 7, Previous Hand build plan. Corrects both Phase 6 audit writers.
-- ============================================================================
--
--  `public.audit_trail.target_id` is a **uuid** on this database. Both writers
--  added minutes earlier cast the id to text on the way in:
--
--      target_id => v_hand.id::text
--      target_id => p_flag_id::text
--
--  They did that by following the column list in
--  `20260428000001_audit_trail.sql`, which declares `target_id TEXT`. The file
--  and the live column disagree, and THE LIVE COLUMN IS THE AUTHORITY. Every
--  godmode read and every flag resolution would have raised
--  `42804: column "target_id" is of type uuid but expression is of type text`
--  at runtime - a feature that works in every test and fails on first use.
--
--  HOW IT WAS MISSED THE FIRST TIME, which is the part worth keeping. The
--  first probe exercised the permission gates: a non-control caller, an
--  operator of another club, a hand at another club, a player resolving
--  someone else's flag. Every one of them was REFUSED - correctly - and every
--  refusal returns before the INSERT. A probe that only walks the paths that
--  are supposed to fail never reaches the write at the end of the path that is
--  supposed to succeed. The second probe impersonated a real club owner and
--  ran the whole thing, and this is what fell out of it.
--
--  THIS FILE EXISTS BECAUSE `Applied Migrations Are Recorded` SAID SO. The fix
--  was applied to production as its own migration and the file was not
--  written, so the repo still held the broken casts: a fresh database built
--  from these files would have had functions that throw. Production was right
--  and the repo was wrong, which is the worse way round - nothing in a test
--  run would ever have shown it.
--
--  ONE TRANSACTION (CLAUDE.md section 2): two `CREATE OR REPLACE`s, one
--  PostgREST schema reload.
-- ============================================================================

BEGIN;

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
    p_flag_id,
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
    v_hand.id,
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
