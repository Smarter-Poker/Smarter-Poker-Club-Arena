-- Dan, 2026-08-30: "I'M GETTING DOUBLE NOTIFICATIONS FOR THE SAME OPEN SEAT."
--
-- The delivery duplication was real and is fixed separately (World Hub #1004:
-- three active push subscriptions for one phone). But the two "Seat Open"
-- notifications in his screenshot were NOT duplicates. They were two different
-- tables:
--
--   "A Seat Just Opened At Bomb Pot NLH 0.25/0.50. Sit Down Now To Claim It."
--   "A Seat Just Opened At NLH 0.25/0.50. Sit Down Now To Claim It."
--
-- Every seat offer carried the identical title, 'Seat Open'. iOS renders the
-- title bold and stacks notifications from one app, so the shade showed two
-- entries whose only visible difference was buried mid-sentence in the body.
-- They read as a repeat. A notification a person mistakes for a duplicate has
-- failed even when the delivery was perfect.
--
-- The distinguishing token therefore moves into the title, where it is read,
-- and the club is added to the body for anyone in more than one:
--
--   title:  Seat Open: Bomb Pot NLH 0.25/0.50
--   body:   A Seat Just Opened At Bomb Pot NLH 0.25/0.50 In Midway Union.
--           Sit Down Now To Claim It.
--
-- The per-table `tag` already collapses REPEAT offers for one table into a
-- single shade entry, so two entries for two tables is correct and stays. This
-- only makes the difference legible.
--
-- REWRITTEN FROM THE DEPLOYED SOURCE, not retyped. fn_offer_open_seat is 2,823
-- characters of queue logic -- FOR UPDATE SKIP LOCKED, TTL reclamation -- that
-- has nothing to do with copy. Transcribing it by hand to change two string
-- literals is how a working queue acquires a silent bug. This reads
-- pg_get_functiondef, applies three targeted replacements, asserts every one
-- matched, and executes the result.
DO $migration$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc
   WHERE proname = 'fn_offer_open_seat' AND pronamespace = 'public'::regnamespace;
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_offer_open_seat not found'; END IF;

  v_new := v_def;

  -- 1. carry the club through, so the body can name it
  v_new := replace(v_new,
    'SELECT t.id, t.name, t.tournament_id, t.max_players, t.current_players'
      || E'\n    INTO v_tbl' || E'\n    FROM public.tables t',
    'SELECT t.id, t.name, t.tournament_id, t.max_players, t.current_players,'
      || E'\n         c.name AS club_name' || E'\n    INTO v_tbl'
      || E'\n    FROM public.tables t'
      || E'\n    LEFT JOIN public.clubs c ON c.id = t.club_id');
  IF v_new = v_def THEN RAISE EXCEPTION 'replacement 1 (club join) did not match'; END IF;

  -- 2. the title carries the table, because that is the line iOS shows bold
  v_def := v_new;
  v_new := replace(v_new,
    E'    ''waitlist_seat_open'',\n    ''Seat Open'',',
    E'    ''waitlist_seat_open'',\n    ''Seat Open: '' || COALESCE(v_tbl.name, ''Your Waitlisted Table''),');
  IF v_new = v_def THEN RAISE EXCEPTION 'replacement 2 (title) did not match'; END IF;

  -- 3. the body names the club
  v_def := v_new;
  v_new := replace(v_new,
    E'    ''A Seat Just Opened At '' || COALESCE(v_tbl.name, ''Your Waitlisted Table'') ||\n      ''. Sit Down Now To Claim It.'',',
    E'    ''A Seat Just Opened At '' || COALESCE(v_tbl.name, ''Your Waitlisted Table'') ||\n      COALESCE('' In '' || v_tbl.club_name, '''') ||\n      ''. Sit Down Now To Claim It.'',');
  IF v_new = v_def THEN RAISE EXCEPTION 'replacement 3 (body club) did not match'; END IF;

  EXECUTE v_new;
END
$migration$;

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_offer_open_seat' AND pronamespace='public'::regnamespace;
  IF position('Seat Open: ' in v_src) = 0 THEN RAISE EXCEPTION 'title does not name the table'; END IF;
  IF position('club_name' in v_src) = 0 THEN RAISE EXCEPTION 'club name was not carried through'; END IF;
  IF position('SKIP LOCKED' in v_src) = 0 THEN
    RAISE EXCEPTION 'FOR UPDATE SKIP LOCKED went missing; the rewrite damaged the queue'; END IF;
END $$;
