-- 20261002014932_the_september_eight_busts_carry_the_elimination_stamp_their_.sql
--
-- THE SEPTEMBER 8 BUSTS CARRY THE ELIMINATION STAMP THEIR DOOR WOULD HAVE GIVEN
-- (2026-10-02)
--
-- @live-proof: (SELECT count(*) FROM public.tournament_players p WHERE p.tournament_id IN ('00f57d7b-db16-4307-8e40-a47e24d4aa29','106c4e13-0da7-4b62-b849-119781d25d4f','2aa4cba1-506f-426b-a1ba-d8e22e018533','2d6dadb7-d1cb-4e03-980f-41fafce98afd','3843907b-dc12-40c3-9641-d2c66f4ebe7c','44d7e2d8-66ed-48ae-a1cb-306ae92b6dfa','482e90bb-ef9d-4135-9067-9f0332c94142','659d3ec6-c584-42ea-956d-5fc2004ba566','6d359f61-d681-49ba-82f3-00493178e5b3','7284506c-093c-491a-8da7-5816bf1ccccf','8904c10b-6a47-4934-bdf2-def1b1e76f0b','8c6a20c5-a422-4177-8b93-efa371d5c14d','8d5969da-df76-44fa-8c83-5608b844ca06','90c4d93f-4577-4da2-bd9b-51b774019971','95e43b6e-c1c9-445e-a1d9-cbe711e3bac1','9cecb4fa-4fdd-4447-9e98-2fe5c20c46a8','ab4125bc-a85e-45c6-b0a7-22417d75c0c5','b3b65e07-6b3a-4b6c-b5d1-aeb5af17fa99','b5fae1b3-b900-4670-85ef-76e3aa646734','b67ab0cb-e2d6-4955-8f43-4bff32551400','c2fd1c7e-9572-4b95-90dd-3b999777a145','dae6db50-4f35-4ffd-b8f5-b9f95d104c10','e62a97cc-40a8-4d70-a89d-04ca4cc20834','efd5455d-d188-4171-becb-1d35b016d06a','f58d6375-4bb4-4f80-a673-0460fcf2c1be','f5a6896b-b739-40e0-9f73-680ee36bc532') AND p.status = 'eliminated' AND p.elimination_sequence IS NULL) = 0
--
-- WHAT WAS MISSING (read 2026-10-02 ~01:45 UTC, read-only, plus the engine
-- log): #5754 (20261001225325) launched the 26 September 8 Spins and heads-up
-- Sit & Gos so the terminal authority could pay them. Every pass now refuses:
--   [Tournament.atomic_finish_refused] TerminalSettlementRefusedError:
--   tournament <id> has no complete durable elimination sequence
--   (0/0 of 1) | (0/0 of 2) | (1/1 of 2)
-- The refusal is raised by fn_settle_tournament_places (live md5
-- c01f32784c369e5b217c2d71194692a1), called by
-- fn_complete_tournament_terminal_pre_seat_guard. With no retained standings
-- witness it requires, for an event whose survivor is promoted to first:
--   count(eliminated) = field - 1, every eliminated row has a non-NULL
--   tournament_players.elimination_sequence, and the stamps are distinct.
-- elimination_sequence is the durable record of a bust. It is database-owned:
-- the trigger fn_stamp_tournament_elimination_sequence stamps
-- nextval('public.tournament_player_elimination_sequence') when the knockout
-- door (fn_eliminate_tournament_player_atomic) moves a row INTO 'eliminated'.
-- All 37 busts of the 26 events were recorded on 2026-09-08 before that
-- stamp existed for them (the platform's NULL-stamp set closed on
-- 2026-09-09, see 20260921001532 R3), so they carry status 'eliminated',
-- their place and eliminated_at, but no stamp. 6d359f61 and 8904c10b each
-- played on after #5754 and their 2nd-place busts of 2026-10-02 were stamped
-- by the door (352556, 352846); their 2026-09-08 3rd-place busts were not.
-- The bust ranking that follows the count needs nothing else: with no
-- tournament_knockout_candidates row it ranks by eliminated_at, which is
-- present on every row.
--
-- WHY THE DOOR ITSELF IS NOT CALLED: fn_eliminate_tournament_player_atomic
-- records a bust from a committed knockout candidate and its accepted hand
-- (hand_atomic_commits). None exists for these 2026-09-08 busts (retention
-- removed the hands), so it returns knockout_candidate_required. This file
-- therefore writes exactly the one durable value the door's trigger writes,
-- through the acquisition the trigger itself permits since 2026-09-20 (NULL
-- -> a value on a row already eliminated; an existing stamp stays
-- write-once), as 20260921001532 did for the four Spins finished then.
--
-- ORDER: the stamps follow the finishing order the recorded places state
-- (3rd before 2nd), which is also eliminated_at order (asserted). Events with
-- no stamp draw nextval in that order, exactly as the door would have. For
-- 6d359f61 and 8904c10b the earlier bust takes the value just below the
-- existing stamp (the 20260921001532 rule), so the sequence never says the
-- 3rd-place bust happened after the 2nd.
--
-- NOTHING ELSE MOVES: status, place, eliminated_at, chips, seats, escrow,
-- receipts and payouts are untouched and proved unchanged; no money moves.
-- The engine's own finish lane then pays each survivor the first prize
-- through fn_complete_tournament_terminal, one event per transaction.
--
-- GUARDS: refuses in the break window; pre-image of the stamp trigger body
-- (md5/owner/security definer/volatility) and of every one of the 37 rows
-- (tournament, registration, user, place, eliminated_at, status, chips 0,
-- NULL stamp); each event RUNNING, field = stamped + unstamped busts + one
-- live survivor, no terminal receipt, no payout, untouched prize escrow.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE
  v_reason text;
  v_rows jsonb;
  v_r record;
  v_ev record;
  v_n integer;
  v_seq bigint;
  v_anchor bigint;
  v_k integer;
  v_before jsonb := '{}'::jsonb;
  v_after text;
  v_img jsonb;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'SEP8_STAMP_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;

  -- The door's stamp: its trigger body as read 2026-10-02.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_stamp_tournament_elimination_sequence()'::regprocedure
       AND md5(p.prosrc) = 'e52754fd9e6368b107afef685e283b37'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef AND p.provolatile = 'v'
       AND p.proconfig::text = '{search_path=public}'
       AND p.proacl::text = '{postgres=X/postgres}')
     OR NOT EXISTS (
    SELECT 1 FROM pg_trigger g
     WHERE g.tgrelid = 'public.tournament_players'::regclass
       AND g.tgname = 'zz_stamp_tournament_elimination_sequence'
       AND g.tgenabled = 'O'
       AND g.tgfoid = 'public.fn_stamp_tournament_elimination_sequence()'::regprocedure) THEN
    RAISE EXCEPTION 'SEP8_STAMP_DOOR_CHANGED: the elimination stamp trigger is not the one read'
      USING ERRCODE = '40001';
  END IF;

  -- tournament, registration, user, recorded place, eliminated_at (read 2026-10-02)
  v_rows := $rows$[
    {"t":"00f57d7b-db16-4307-8e40-a47e24d4aa29","p":"f6fe8ddb-dc04-4342-80bc-7019ccc59abd","u":"3cbbefb7-1a34-4111-83a1-1e04378a495e","pos":2,"at":"2026-09-08 14:50:36.665+00"},
    {"t":"106c4e13-0da7-4b62-b849-119781d25d4f","p":"296d3b8b-9a72-4635-aaf8-a9931fa1eec3","u":"6162b471-d011-41f7-ad89-9a8d856c9ffb","pos":2,"at":"2026-09-08 14:46:13.626+00"},
    {"t":"2aa4cba1-506f-426b-a1ba-d8e22e018533","p":"1350d845-cdf8-41ad-86bf-abf2f2460cab","u":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","pos":3,"at":"2026-09-08 14:50:41.689+00"},
    {"t":"2aa4cba1-506f-426b-a1ba-d8e22e018533","p":"bcab2749-47c7-4617-9d72-9e56de4eb616","u":"036f0b55-c601-4d09-982a-5294cf4ea15d","pos":2,"at":"2026-09-08 14:50:47.159+00"},
    {"t":"2d6dadb7-d1cb-4e03-980f-41fafce98afd","p":"b63c077a-e138-4911-ba64-3a91b4a6b0d4","u":"15de44a8-2e5f-48ab-9f3c-c022f83c760d","pos":2,"at":"2026-09-08 14:51:35.989+00"},
    {"t":"3843907b-dc12-40c3-9641-d2c66f4ebe7c","p":"de8ace6d-a5cf-42c2-b2ad-b0a5c5c359b3","u":"88056a18-39c6-41d8-bd36-5fb0bfb00ce9","pos":2,"at":"2026-09-08 14:51:44.165+00"},
    {"t":"44d7e2d8-66ed-48ae-a1cb-306ae92b6dfa","p":"2182ee4c-f9f1-4e2b-a1e8-1c5443a5ae23","u":"88323ada-b230-4313-bd13-e3f11b4fe987","pos":3,"at":"2026-09-08 14:39:34.105+00"},
    {"t":"44d7e2d8-66ed-48ae-a1cb-306ae92b6dfa","p":"88254aa6-522b-4a5e-99d5-3df2ce76feb9","u":"4d5ec8d4-375b-4656-8deb-8e9ab7d342b6","pos":2,"at":"2026-09-08 14:47:22.22+00"},
    {"t":"482e90bb-ef9d-4135-9067-9f0332c94142","p":"cf90df6f-d0ff-4767-91a7-bae09232c846","u":"c025d7b4-b93e-4aa0-89e5-e391c246b0f2","pos":3,"at":"2026-09-08 14:49:51.495+00"},
    {"t":"482e90bb-ef9d-4135-9067-9f0332c94142","p":"beb4eada-c857-4626-9c31-4cb2d46f0ca0","u":"89a23158-4840-4e26-b9b6-d837eca341ad","pos":2,"at":"2026-09-08 14:50:27.085+00"},
    {"t":"659d3ec6-c584-42ea-956d-5fc2004ba566","p":"f73d9c6a-3f63-4afc-8ac8-24ef9a8af343","u":"0d766e23-bdf2-437a-87f4-0268605c8120","pos":2,"at":"2026-09-08 14:48:42.49+00"},
    {"t":"6d359f61-d681-49ba-82f3-00493178e5b3","p":"9a68cec7-0b6a-4d5b-9c51-8cb43d5afd54","u":"d4d3e2b3-1520-4a01-aada-8d6d1b2364b6","pos":3,"at":"2026-09-08 14:51:52.01+00"},
    {"t":"7284506c-093c-491a-8da7-5816bf1ccccf","p":"ed77e01d-65c5-4da6-9b82-d373c8da8275","u":"e7925474-ad31-4cfb-826b-010039bcff3d","pos":3,"at":"2026-09-08 14:49:42.484+00"},
    {"t":"7284506c-093c-491a-8da7-5816bf1ccccf","p":"6f2dbdef-54ed-4761-96e3-a7c37f301f96","u":"e573c327-dc89-4d87-81f0-efd0cb3c8020","pos":2,"at":"2026-09-08 14:52:24.895+00"},
    {"t":"8904c10b-6a47-4934-bdf2-def1b1e76f0b","p":"f1aa775a-c5f4-4430-bb4f-c5adfd953500","u":"e55c9219-b0a6-4431-9669-9dc332583100","pos":3,"at":"2026-09-08 13:51:31.594+00"},
    {"t":"8c6a20c5-a422-4177-8b93-efa371d5c14d","p":"c0b73528-ee61-4c6b-a7a1-e1d18b3d97da","u":"cba6d788-80d9-43e3-a151-005e76b32701","pos":2,"at":"2026-09-08 14:52:10.749+00"},
    {"t":"8d5969da-df76-44fa-8c83-5608b844ca06","p":"71f57d85-e8d1-41ca-a521-04aef3a1ce8d","u":"890b3040-18ae-4cdf-a7c8-c2df3336765b","pos":3,"at":"2026-09-08 14:47:40.716+00"},
    {"t":"8d5969da-df76-44fa-8c83-5608b844ca06","p":"b04eca1b-ac6f-4cb2-b977-0d5708368e73","u":"45a5e770-95dd-45de-aea0-7fe2dc0302f7","pos":2,"at":"2026-09-08 14:48:19.444+00"},
    {"t":"90c4d93f-4577-4da2-bd9b-51b774019971","p":"91104a56-cf7b-49da-8438-80ab268df9e2","u":"c025d7b4-b93e-4aa0-89e5-e391c246b0f2","pos":2,"at":"2026-09-08 14:49:20.054+00"},
    {"t":"95e43b6e-c1c9-445e-a1d9-cbe711e3bac1","p":"522d94fd-f821-4c76-8998-00f90e62efd0","u":"3d15bbe7-f752-4a49-be3a-079232d23b0f","pos":3,"at":"2026-09-08 14:47:00.186+00"},
    {"t":"95e43b6e-c1c9-445e-a1d9-cbe711e3bac1","p":"6ade16b5-e8a4-4512-9410-c1f00e1182b2","u":"22af2652-f8ae-4b84-8f3d-d2894f435d79","pos":2,"at":"2026-09-08 14:50:55.917+00"},
    {"t":"9cecb4fa-4fdd-4447-9e98-2fe5c20c46a8","p":"b853deea-c620-4787-9ff7-b520b1daab0b","u":"d2ce100a-152e-4b0e-8903-2296a9cb7cbe","pos":3,"at":"2026-09-08 14:47:11.164+00"},
    {"t":"9cecb4fa-4fdd-4447-9e98-2fe5c20c46a8","p":"9f9aaee0-6af4-4e1a-8bac-d763ce22b093","u":"75f64f35-c437-453a-b241-73d9d76dda70","pos":2,"at":"2026-09-08 14:47:38.93+00"},
    {"t":"ab4125bc-a85e-45c6-b0a7-22417d75c0c5","p":"b302113a-f9cd-4cdc-93b9-e1ff809e0224","u":"341d4951-c3cf-4446-ac75-6f1448a9bf99","pos":2,"at":"2026-09-08 14:48:41.189+00"},
    {"t":"b3b65e07-6b3a-4b6c-b5d1-aeb5af17fa99","p":"5047f938-e5e3-4727-aa2f-55af95417ea7","u":"f77cb4c6-6fc4-45e9-bc6b-7791205391be","pos":3,"at":"2026-09-08 14:51:43.807+00"},
    {"t":"b3b65e07-6b3a-4b6c-b5d1-aeb5af17fa99","p":"2cfaea0f-a6e3-4449-bc69-9de6079c2bb2","u":"f53f55b8-6bd9-4953-ae64-ff319c524e0f","pos":2,"at":"2026-09-08 14:52:52.136+00"},
    {"t":"b5fae1b3-b900-4670-85ef-76e3aa646734","p":"4978f31f-918b-4746-a4aa-d9a661e9a782","u":"00000000-0000-0000-0000-000000000025","pos":2,"at":"2026-09-08 14:47:45.37+00"},
    {"t":"b67ab0cb-e2d6-4955-8f43-4bff32551400","p":"25c073ea-08ba-4775-b9b2-0d8fbfaa8364","u":"1ede808f-e293-4b2e-9811-6425f596b2cb","pos":3,"at":"2026-09-08 14:47:54.597+00"},
    {"t":"b67ab0cb-e2d6-4955-8f43-4bff32551400","p":"969c9051-7c51-42b1-aec9-854cea78d1f5","u":"4ceb0525-5b49-4138-b761-cf4c16e89a34","pos":2,"at":"2026-09-08 14:49:41.233+00"},
    {"t":"c2fd1c7e-9572-4b95-90dd-3b999777a145","p":"58ad27be-8d6e-4097-9db0-cbbaf8a1ed3c","u":"5330edb2-9f93-492a-aef3-c7e077c0de68","pos":3,"at":"2026-09-08 14:48:41.184+00"},
    {"t":"c2fd1c7e-9572-4b95-90dd-3b999777a145","p":"40294855-2fff-40fc-92e7-373a6e0e78ad","u":"6f5fd01a-cdbe-4c2b-b472-f4cafcfdad17","pos":2,"at":"2026-09-08 14:51:34.445+00"},
    {"t":"dae6db50-4f35-4ffd-b8f5-b9f95d104c10","p":"96a6c2e1-f25b-445f-a9fa-7868a0918965","u":"94cb32db-d0c0-408a-9a4f-13e66d56d2c2","pos":2,"at":"2026-09-08 14:52:47.273+00"},
    {"t":"e62a97cc-40a8-4d70-a89d-04ca4cc20834","p":"f462c48a-5b1f-401a-96cd-200de2d9fd9b","u":"dec9ad0a-55c3-4dfe-9ece-5315f9a44544","pos":2,"at":"2026-09-08 14:51:36.675+00"},
    {"t":"efd5455d-d188-4171-becb-1d35b016d06a","p":"f315cd7a-1b82-41e3-9392-9494fc32132f","u":"4845cbbb-a29c-4b34-8fbe-b8658bd6c16c","pos":3,"at":"2026-09-08 14:42:25.511+00"},
    {"t":"efd5455d-d188-4171-becb-1d35b016d06a","p":"18c3a331-0d71-42b1-ba0e-a007c3fc48e5","u":"3ac76bbb-de77-4f26-b2b9-c3408b5bbf1d","pos":2,"at":"2026-09-08 14:47:22.198+00"},
    {"t":"f58d6375-4bb4-4f80-a673-0460fcf2c1be","p":"088e836b-d2f0-489f-ade2-8d06f08afa95","u":"d3f422d8-ccab-4ee9-ba50-7678a17ba776","pos":2,"at":"2026-09-08 14:52:11.29+00"},
    {"t":"f5a6896b-b739-40e0-9f73-680ee36bc532","p":"05ea83d7-0848-490b-9d24-0e51968b612c","u":"1f01702e-320c-4e64-b030-e58fdd47cc07","pos":2,"at":"2026-09-08 14:49:51.45+00"}
  ]$rows$::jsonb;

  IF jsonb_array_length(v_rows) <> 37
     OR (SELECT count(DISTINCT e->>'t') FROM jsonb_array_elements(v_rows) e) <> 26 THEN
    RAISE EXCEPTION 'SEP8_STAMP_SET_CHANGED: the file names % rows', jsonb_array_length(v_rows);
  END IF;

  -- Canonical lock order: each tournament, then its roster.
  FOR v_ev IN SELECT DISTINCT (e->>'t')::uuid AS tournament_id
                FROM jsonb_array_elements(v_rows) e ORDER BY 1 LOOP
    PERFORM 1 FROM public.tournaments t WHERE t.id = v_ev.tournament_id FOR UPDATE;
    PERFORM 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = v_ev.tournament_id ORDER BY tp.id FOR UPDATE;

    -- Event pre-image: RUNNING, unpaid, escrow untouched, one live survivor,
    -- every other entrant eliminated, and the only unstamped busts are ours.
    IF NOT EXISTS (
         SELECT 1 FROM public.tournaments t
           JOIN public.tournament_escrow e ON e.tournament_id = t.id
          WHERE t.id = v_ev.tournament_id
            AND t.status = 'RUNNING' AND t.prize_pool_finalized
            AND e.closed_at IS NULL AND e.prize_out = 0 AND e.fee_out = 0
            AND e.prize_balance = t.prize_pool)
       OR EXISTS (SELECT 1 FROM public.tournament_terminal_settlements s
                   WHERE s.tournament_id = v_ev.tournament_id)
       OR EXISTS (SELECT 1 FROM public.tournament_payouts x
                   WHERE x.tournament_id = v_ev.tournament_id)
       OR (SELECT count(*) FROM public.tournament_players tp
            WHERE tp.tournament_id = v_ev.tournament_id
              AND tp.status IN ('playing','winner')) <> 1
       OR (SELECT count(*) FROM public.tournament_players tp
            WHERE tp.tournament_id = v_ev.tournament_id
              AND tp.status NOT IN ('playing','winner','eliminated')) <> 0
       OR (SELECT count(*) FROM public.tournament_players tp
            WHERE tp.tournament_id = v_ev.tournament_id
              AND tp.status = 'eliminated' AND tp.elimination_sequence IS NULL)
          <> (SELECT count(*) FROM jsonb_array_elements(v_rows) e
               WHERE (e->>'t')::uuid = v_ev.tournament_id) THEN
      RAISE EXCEPTION 'SEP8_STAMP_EVENT_PREIMAGE: % is not the event read on 2026-10-02',
        v_ev.tournament_id USING ERRCODE = '40001';
    END IF;

    -- Recorded finishing order: earlier bust, worse place; every unstamped
    -- bust precedes every bust the door has already stamped.
    IF EXISTS (
         SELECT 1 FROM public.tournament_players a
           JOIN public.tournament_players b
             ON b.tournament_id = a.tournament_id AND b.id <> a.id
          WHERE a.tournament_id = v_ev.tournament_id
            AND a.status = 'eliminated' AND b.status = 'eliminated'
            AND a.eliminated_at < b.eliminated_at
            AND NOT (a.position > b.position))
       OR EXISTS (
         SELECT 1 FROM public.tournament_players a
           JOIN public.tournament_players b
             ON b.tournament_id = a.tournament_id
          WHERE a.tournament_id = v_ev.tournament_id
            AND a.status = 'eliminated' AND a.elimination_sequence IS NULL
            AND b.status = 'eliminated' AND b.elimination_sequence IS NOT NULL
            AND NOT (a.eliminated_at < b.eliminated_at)) THEN
      RAISE EXCEPTION 'SEP8_STAMP_ORDER_PREIMAGE: % finishing order is not one order',
        v_ev.tournament_id USING ERRCODE = '40001';
    END IF;

    SELECT jsonb_agg(jsonb_build_array(p.id,p.user_id,p.status,p.chips,p.position,
             p.eliminated_at,p.table_id,p.seat_number,p.prize) ORDER BY p.id)
           || jsonb_build_array(
             (SELECT jsonb_build_array(e.gross_in,e.prize_balance,e.fee_balance,
                       e.prize_out,e.fee_out,e.bounty_balance,e.closed_at)
                FROM public.tournament_escrow e WHERE e.tournament_id = v_ev.tournament_id),
             (SELECT jsonb_agg(jsonb_build_array(s.id,s.user_id,s.stack,s.left_at) ORDER BY s.id)
                FROM public.table_seats s JOIN public.tables b ON b.id = s.table_id
               WHERE b.tournament_id = v_ev.tournament_id),
             (SELECT jsonb_build_array(t.status,t.started_at,t.prize_pool,t.total_rake)
                FROM public.tournaments t WHERE t.id = v_ev.tournament_id))
      INTO v_img
      FROM public.tournament_players p WHERE p.tournament_id = v_ev.tournament_id;
    v_before := v_before || jsonb_build_object(v_ev.tournament_id::text, md5(v_img::text));
  END LOOP;

  -- Row pre-image: every one of the 37 is exactly the bust read.
  SELECT count(*) INTO v_n
    FROM jsonb_array_elements(v_rows) e
    JOIN public.tournament_players tp
      ON tp.id = (e->>'p')::uuid
     AND tp.tournament_id = (e->>'t')::uuid
     AND tp.user_id = (e->>'u')::uuid
     AND tp.position = (e->>'pos')::integer
     AND tp.eliminated_at = (e->>'at')::timestamptz
     AND tp.status = 'eliminated'
     AND COALESCE(tp.chips, 0) = 0
     AND tp.elimination_sequence IS NULL;
  IF v_n <> 37 THEN
    RAISE EXCEPTION 'SEP8_STAMP_ROW_PREIMAGE: % of 37 busts match the read', v_n
      USING ERRCODE = '40001';
  END IF;

  -- The stamp, in finishing order.
  FOR v_ev IN SELECT DISTINCT (e->>'t')::uuid AS tournament_id
                FROM jsonb_array_elements(v_rows) e ORDER BY 1 LOOP
    SELECT min(tp.elimination_sequence) INTO v_anchor
      FROM public.tournament_players tp
     WHERE tp.tournament_id = v_ev.tournament_id AND tp.status = 'eliminated';
    IF v_anchor IS NULL THEN
      -- As the door would have: one nextval per bust, earliest bust first.
      FOR v_r IN SELECT (e->>'p')::uuid AS player_id
                   FROM jsonb_array_elements(v_rows) e
                  WHERE (e->>'t')::uuid = v_ev.tournament_id
                  ORDER BY (e->>'at')::timestamptz, (e->>'p')::uuid LOOP
        v_seq := nextval('public.tournament_player_elimination_sequence'::regclass);
        UPDATE public.tournament_players
           SET elimination_sequence = v_seq
         WHERE id = v_r.player_id AND status = 'eliminated'
           AND elimination_sequence IS NULL;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n <> 1 THEN
          RAISE EXCEPTION 'SEP8_STAMP_MOVED: %', v_r.player_id USING ERRCODE = '40001';
        END IF;
      END LOOP;
    ELSE
      -- Earlier than a bust the door already stamped: the values just below it.
      v_k := 0;
      FOR v_r IN SELECT (e->>'p')::uuid AS player_id
                   FROM jsonb_array_elements(v_rows) e
                  WHERE (e->>'t')::uuid = v_ev.tournament_id
                  ORDER BY (e->>'at')::timestamptz DESC, (e->>'p')::uuid DESC LOOP
        v_k := v_k + 1;
        UPDATE public.tournament_players
           SET elimination_sequence = v_anchor - v_k
         WHERE id = v_r.player_id AND status = 'eliminated'
           AND elimination_sequence IS NULL;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n <> 1 THEN
          RAISE EXCEPTION 'SEP8_STAMP_MOVED: %', v_r.player_id USING ERRCODE = '40001';
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  -- Post-image: each event's settlement rule is met, the stamps follow the
  -- finishing order, and nothing but the stamps moved.
  FOR v_ev IN SELECT DISTINCT (e->>'t')::uuid AS tournament_id
                FROM jsonb_array_elements(v_rows) e ORDER BY 1 LOOP
    IF (SELECT count(*) <> count(tp.elimination_sequence)
            OR count(DISTINCT tp.elimination_sequence) <> count(*)
            OR count(*) <> (SELECT count(*) FROM public.tournament_players f
                             WHERE f.tournament_id = v_ev.tournament_id) - 1
            OR min(tp.elimination_sequence) <= 0
          FROM public.tournament_players tp
         WHERE tp.tournament_id = v_ev.tournament_id AND tp.status = 'eliminated')
       OR EXISTS (
         SELECT 1 FROM public.tournament_players a
           JOIN public.tournament_players b
             ON b.tournament_id = a.tournament_id AND b.id <> a.id
          WHERE a.tournament_id = v_ev.tournament_id
            AND a.status = 'eliminated' AND b.status = 'eliminated'
            AND a.eliminated_at < b.eliminated_at
            AND a.elimination_sequence > b.elimination_sequence) THEN
      RAISE EXCEPTION 'SEP8_STAMP_POSTIMAGE: % has no complete ordered sequence',
        v_ev.tournament_id;
    END IF;

    SELECT jsonb_agg(jsonb_build_array(p.id,p.user_id,p.status,p.chips,p.position,
             p.eliminated_at,p.table_id,p.seat_number,p.prize) ORDER BY p.id)
           || jsonb_build_array(
             (SELECT jsonb_build_array(e.gross_in,e.prize_balance,e.fee_balance,
                       e.prize_out,e.fee_out,e.bounty_balance,e.closed_at)
                FROM public.tournament_escrow e WHERE e.tournament_id = v_ev.tournament_id),
             (SELECT jsonb_agg(jsonb_build_array(s.id,s.user_id,s.stack,s.left_at) ORDER BY s.id)
                FROM public.table_seats s JOIN public.tables b ON b.id = s.table_id
               WHERE b.tournament_id = v_ev.tournament_id),
             (SELECT jsonb_build_array(t.status,t.started_at,t.prize_pool,t.total_rake)
                FROM public.tournaments t WHERE t.id = v_ev.tournament_id))
      INTO v_img
      FROM public.tournament_players p WHERE p.tournament_id = v_ev.tournament_id;
    v_after := md5(v_img::text);
    IF v_after IS DISTINCT FROM v_before->>v_ev.tournament_id::text
       OR EXISTS (SELECT 1 FROM public.tournament_payouts x
                   WHERE x.tournament_id = v_ev.tournament_id) THEN
      RAISE EXCEPTION 'SEP8_STAMP_POSTIMAGE: % moved more than its stamps', v_ev.tournament_id;
    END IF;
  END LOOP;

  RAISE NOTICE 'SEP8_STAMPED: 37 busts in 26 events carry their elimination stamp; nothing paid';
END
$mig$;

COMMIT;
