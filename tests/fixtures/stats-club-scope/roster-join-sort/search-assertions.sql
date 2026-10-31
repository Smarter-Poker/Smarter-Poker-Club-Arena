-- Roll back synthetic names so the historical join-order assertions remain valid.
BEGIN;
UPDATE roster_fixture SET upline_name = 'Burls',
 alias = CASE user_id::text
   WHEN '00000000-0000-0000-0000-000000000001' THEN 'Burls'
   WHEN '00000000-0000-0000-0000-000000000002' THEN 'Burls Jr'
   WHEN '00000000-0000-0000-0000-000000000003' THEN 'The Burls'
   ELSE alias END,
 joined_at = CASE WHEN user_id::text IN (
 '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',
 '00000000-0000-0000-0000-000000000003') THEN '2020-01-01'::timestamptz ELSE '2030-01-01'::timestamptz END;
DO $$
DECLARE p jsonb; first_page jsonb; cursor_token jsonb; all_ids text[] := '{}'; batch text[];
 expected text[]; exported jsonb; mode text;
 club uuid := '00000000-0000-0000-0000-000000000001';
BEGIN
 FOREACH mode IN ARRAY ARRAY['newest','oldest','hierarchy','activity','name','downlines','wallet','fees'] LOOP
  first_page := public.ca_club_members_page(club,'  BURLS  ','all',mode,NULL,20);
  IF first_page#>>'{items,0,alias}' <> 'Burls' OR first_page#>>'{items,1,alias}' <> 'Burls Jr'
   OR first_page#>>'{items,2,alias}' <> 'The Burls' THEN
    RAISE EXCEPTION 'Player name search regression: direct names must precede newer upline matches for %', mode;
  END IF;
 END LOOP;
 p := first_page;
 LOOP
  SELECT array_agg(x->>'user_id' ORDER BY ord) INTO batch FROM jsonb_array_elements(p->'items') WITH ORDINALITY e(x,ord);
  all_ids := all_ids || coalesce(batch,'{}');
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'items') x WHERE x ? 'search_rank') THEN
   RAISE EXCEPTION 'Internal search rank leaked'; END IF;
  EXIT WHEN NOT (p->>'has_more')::boolean;
  cursor_token := p->'next_cursor';
  IF cursor_token->>'v' <> '3' OR cursor_token->>'sort' <> 'search' THEN RAISE EXCEPTION 'Search cursor version'; END IF;
  p := public.ca_club_members_page(club,'burls','all','newest',cursor_token,20);
 END LOOP;
 SELECT array_agg(user_id::text ORDER BY CASE alias WHEN 'Burls' THEN 0 WHEN 'Burls Jr' THEN 1 WHEN 'The Burls' THEN 2 ELSE 3 END,lower(alias),user_id) INTO expected
 FROM roster_fixture WHERE club_id=club;
 IF all_ids IS DISTINCT FROM expected OR cardinality(all_ids) <> 45 THEN RAISE EXCEPTION 'Search pagination lost or repeated matching players'; END IF;
 exported := public.ca_club_members_export(club,'burls','all','newest',NULL);
 SELECT array_agg(x->>'user_id' ORDER BY ord) INTO batch FROM jsonb_array_elements(exported->'rows') WITH ORDINALITY e(x,ord);
 IF batch IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Search export order differs from complete roster'; END IF;
 p := public.ca_club_members_page(club,'burls','all','newest',jsonb_set(first_page->'next_cursor','{v}','2'),20);
 IF p->'items' IS DISTINCT FROM first_page->'items' THEN RAISE EXCEPTION 'Stale search cursor did not restart'; END IF;
 p := public.ca_club_members_page(club,'burls','seated','newest',NULL,20);
 IF (p->>'filtered_total')::int <> 22 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'items') x WHERE NOT (x->>'is_seated')::boolean) THEN RAISE EXCEPTION 'Search bypassed filter'; END IF;
 -- Username exact matches also precede alias prefixes; literal wildcard characters remain literal.
 UPDATE roster_fixture SET username='Burls' WHERE user_id='00000000-0000-0000-0000-000000000004';
 p := public.ca_club_members_page(club,'burls','all','newest',NULL,20);
 IF p#>>'{items,1,user_id}' <> '00000000-0000-0000-0000-000000000004' THEN RAISE EXCEPTION 'Exact username must precede name prefix'; END IF;
 p := public.ca_club_members_page(club,'%','all','newest',NULL,20);
 IF (p->>'filtered_total')::int <> 0 THEN RAISE EXCEPTION 'Search wildcard escaped literal matching'; END IF;
END $$;
ROLLBACK;
