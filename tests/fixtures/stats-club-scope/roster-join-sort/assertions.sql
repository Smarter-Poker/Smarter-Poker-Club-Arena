DO $test$
DECLARE
 club uuid := '00000000-0000-0000-0000-000000000001';
 mode text; expected jsonb; actual jsonb; page jsonb; first_page jsonb;
 token jsonb; exported jsonb; pages int;
BEGIN
 FOREACH mode IN ARRAY ARRAY['newest','oldest'] LOOP
  SELECT jsonb_agg(user_id ORDER BY
    CASE WHEN mode='newest' THEN joined_at END DESC NULLS LAST,
    CASE WHEN mode='oldest' THEN joined_at END ASC NULLS LAST, user_id)
  INTO expected FROM roster_fixture WHERE club_id=club;
  actual := '[]'; token := NULL; pages := 0;
  LOOP
   page := public.ca_club_members_page(club,'','all',mode,token,20);
   IF pages=0 THEN first_page:=page; END IF;
   SELECT actual || jsonb_agg(value->'user_id' ORDER BY ordinality)
     INTO actual FROM jsonb_array_elements(page->'items') WITH ORDINALITY;
   pages := pages+1;
   IF NOT (page->>'has_more')::boolean THEN EXIT; END IF;
   IF pages>4 THEN RAISE EXCEPTION 'Cursor did not terminate'; END IF;
   token := page->'next_cursor';

  END LOOP;
  IF actual IS DISTINCT FROM expected OR pages<>3 THEN
   RAISE EXCEPTION 'Club join ordering regression: %',mode;
  END IF;
  IF jsonb_typeof(first_page->'next_cursor'->'metric') <> 'string' THEN
    RAISE EXCEPTION 'Join cursor must preserve numeric precision as text';
  END IF;
  exported := public.ca_club_members_export(club,'','all',mode,NULL);
  IF (SELECT jsonb_agg(value->'user_id' ORDER BY ordinality)
      FROM jsonb_array_elements(exported->'rows') WITH ORDINALITY) IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Export join order mismatch: %',mode;
  END IF;
  token := jsonb_set(first_page->'next_cursor','{metric}','"invalid"');
  IF public.ca_club_members_page(club,'','all',mode,token,20)->'items' <> first_page->'items' THEN
    RAISE EXCEPTION 'Malformed cursor did not restart';
  END IF;
  token := jsonb_set(first_page->'next_cursor','{sort}','"name"');
  IF public.ca_club_members_page(club,'','all',mode,token,20)->'items' <> first_page->'items' THEN
    RAISE EXCEPTION 'Wrong sort cursor did not restart';
  END IF;
  page := public.ca_club_members_page(club,'Player 9','all',mode,NULL,20);
  IF (page->>'filtered_total')::int <> 10 THEN RAISE EXCEPTION 'Search scope mismatch'; END IF;
 END LOOP;
END $test$;
