-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827154952; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
--  BBJ SEED: the five recent hits, as complete hands
-- ============================================================================
--
--  Dan, 2026-08-27, on the Bad Beat Jackpot popup:
--    "for the BBJ seed you need to use there club avatar as the image, not
--     there profile pics. and you need to fill in all the hand details and
--     payouts, like all the data that we see and use inside of previous hands."
--
--  1. AVATARS. fn_bbj_recent_hits resolved the winner image as
--     COALESCE(clubs.avatar_url, profiles.avatar_url). clubs.avatar_url is
--     NULL for both clubs that have hit, so every row fell through to
--     profiles.avatar_url - the SOCIAL MEDIA photo. The club avatar is
--     profiles.arena_avatar_url, which is what the felt itself reads.
--
--  2. THE HANDS WERE NOT HANDS. Two players, two actions, both on the river,
--     a button_seat that was not one of the occupied seats, zero rake, and
--     cards that did not make the stated categories. Rebuilt whole below.
--
--  3. THE TABLE SHARE WAS NEVER PAID. Only winner_share and loser_share got
--     bbj_payout_recipients rows, so "Jackpot Paid 7,883.92" headlined two
--     lines totalling 5,912.94. The remaining 25% is split below.
--
--  Seed data only: no chips move. Nothing here touches chip_balance.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_bbj_recent_hits(p_pool_id uuid, p_limit integer DEFAULT 5)
RETURNS TABLE(payout_id uuid, awarded_at timestamptz, hand_number bigint, total_payout numeric,
              bad_beat_user_id uuid, bad_beat_player_number text, bad_beat_avatar_url text,
              bad_beat_name text, bad_beat_hand text, bad_beat_amount numeric, bad_beat_cards jsonb,
              hand_winner_name text, hand_winner_hand text, hand_winner_amount numeric,
              hand_winner_cards jsonb, board jsonb, game_variant text, small_blind numeric,
              big_blind numeric, table_player_count integer, recipients jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH top_payouts AS (
    SELECT p.* FROM public.bbj_payouts p
    WHERE p.pool_id = p_pool_id
    ORDER BY p.created_at DESC
    LIMIT GREATEST(1, LEAST(p_limit, 25))
  ),
  hits AS (
    SELECT p.*, w.winner_hand, w.loser_hand, w.winner_display_name, w.loser_display_name,
           h.board AS raw_board, h.hole_cards, h.game_variant, h.small_blind, h.big_blind
    FROM top_payouts p
    LEFT JOIN public.bbj_winners w ON w.table_id = p.table_id AND w.hand_number = p.hand_number
    LEFT JOIN public.hand_history h ON h.table_id = p.table_id AND h.hand_number = p.hand_number
  )
  SELECT
    x.id,
    x.created_at,
    x.hand_number,
    x.total_amount,
    x.winner_user_id,
    bb.player_number::text,
    -- THE CLUB AVATAR. profiles.arena_avatar_url is Club Arena's own column
    -- (library art); profiles.avatar_url is the social media photo and is not
    -- ours to display. No fallback to it, exactly as the felt does it - an
    -- unset arena avatar draws the generated monogram client-side instead.
    NULLIF(bb.arena_avatar_url, ''),
    COALESCE(bb.display_name, bb.username, x.winner_display_name, 'Player'),
    x.winner_hand,
    (SELECT r.amount FROM public.bbj_payout_recipients r
      WHERE r.payout_id = x.id AND r.user_id = x.winner_user_id),
    x.hole_cards -> (x.winner_user_id::text),
    COALESCE(hw.display_name, hw.username, x.loser_display_name, 'Player'),
    x.loser_hand,
    (SELECT r.amount FROM public.bbj_payout_recipients r
      WHERE r.payout_id = x.id AND r.user_id = x.loser_user_id),
    x.hole_cards -> (x.loser_user_id::text),
    CASE
      WHEN jsonb_typeof(x.raw_board) = 'array' THEN (
        SELECT COALESCE(jsonb_agg(
                 jsonb_build_object(
                   'rank', regexp_replace(card, '(hearts|diamonds|clubs|spades)$', ''),
                   'suit', substring(card from '(hearts|diamonds|clubs|spades)$')
                 ) ORDER BY ord), '[]'::jsonb)
        FROM jsonb_array_elements_text(x.raw_board) WITH ORDINALITY AS arr(card, ord)
        WHERE substring(card from '(hearts|diamonds|clubs|spades)$') IS NOT NULL
      )
      ELSE '[]'::jsonb
    END,
    x.game_variant,
    x.small_blind,
    x.big_blind,
    x.table_player_count,
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'name', COALESCE(pr.display_name, pr.username, 'Player'),
                 'amount', r.amount,
                 'role', CASE
                           WHEN r.user_id = x.winner_user_id THEN 'bad_beat'
                           WHEN r.user_id = x.loser_user_id  THEN 'hand_winner'
                           ELSE 'table'
                         END
               ) ORDER BY r.amount DESC)
      FROM public.bbj_payout_recipients r
      LEFT JOIN public.profiles pr ON pr.id = r.user_id
      WHERE r.payout_id = x.id
    ), '[]'::jsonb)
  FROM hits x
  LEFT JOIN public.profiles bb ON bb.id = x.winner_user_id
  LEFT JOIN public.profiles hw ON hw.id = x.loser_user_id
  ORDER BY x.created_at DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_bbj_recent_hits(uuid, integer) TO anon, authenticated, service_role;

-- Same correction inside the hand detail: players[].avatarUrl is the club
-- avatar. Nothing renders it today, but it is the same rule and leaving the
-- social photo in the payload is how it gets rendered by accident later.
CREATE OR REPLACE FUNCTION public.fn_bbj_hand_detail(p_payout_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH pay AS (SELECT * FROM public.bbj_payouts WHERE id = p_payout_id),
  hh AS (
    SELECT h.* FROM public.hand_history h
    JOIN pay ON h.table_id = pay.table_id AND h.hand_number = pay.hand_number
    ORDER BY h.created_at DESC LIMIT 1
  ),
  seats AS (
    SELECT e.value AS p FROM hh, LATERAL jsonb_array_elements(COALESCE(hh.players, '[]'::jsonb)) e
  ),
  players_out AS (
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'userId',       s.p->>'userId',
          'username',     COALESCE(pr.display_name, pr.username, s.p->>'username', 'Player'),
          'playerNumber', pr.player_number::text,
          'avatarUrl',    NULLIF(pr.arena_avatar_url, ''),
          'seat',         NULLIF(s.p->>'seat', '')::int,
          'stack',        NULLIF(s.p->>'stack', '')::numeric,
          'cards',        COALESCE((SELECT hh.hole_cards -> (s.p->>'userId') FROM hh), 'null'::jsonb)
        ) ORDER BY NULLIF(s.p->>'seat', '')::int), '[]'::jsonb) AS v
    FROM seats s LEFT JOIN public.profiles pr ON pr.id::text = s.p->>'userId'
  ),
  board_out AS (
    SELECT CASE
      WHEN (SELECT community_cards FROM hh) IS NULL THEN '[]'::jsonb
      ELSE COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'rank', regexp_replace(c, '(hearts|diamonds|clubs|spades)$', ''),
                 'suit', substring(c from '(hearts|diamonds|clubs|spades)$')) ORDER BY ord)
        FROM unnest((SELECT community_cards FROM hh)) WITH ORDINALITY AS t(c, ord)
        WHERE substring(c from '(hearts|diamonds|clubs|spades)$') IS NOT NULL
      ), '[]'::jsonb)
    END AS v
  ),
  recips AS (
    SELECT COALESCE(jsonb_agg(
             jsonb_build_object(
               'userId', r.user_id,
               'name',   COALESCE(pr.display_name, pr.username, 'Player'),
               'amount', r.amount,
               'role',   CASE
                           WHEN r.user_id = (SELECT winner_user_id FROM pay) THEN 'bad_beat'
                           WHEN r.user_id = (SELECT loser_user_id  FROM pay) THEN 'hand_winner'
                           ELSE 'table'
                         END) ORDER BY r.amount DESC), '[]'::jsonb) AS v
    FROM public.bbj_payout_recipients r
    LEFT JOIN public.profiles pr ON pr.id = r.user_id
    WHERE r.payout_id = p_payout_id
  )
  SELECT CASE WHEN (SELECT count(*) FROM hh) = 0 THEN NULL ELSE jsonb_build_object(
      'handNumber',  (SELECT hand_number FROM hh),
      'playedAt',    COALESCE((SELECT started_at FROM hh), (SELECT created_at FROM hh)),
      'gameVariant', (SELECT game_variant FROM hh),
      'smallBlind',  (SELECT small_blind FROM hh),
      'bigBlind',    (SELECT big_blind FROM hh),
      'potSize',     (SELECT pot_size FROM hh),
      'rakeAmount',  (SELECT rake_amount FROM hh),
      'bbjAmount',   (SELECT bbj_amount FROM hh),
      'buttonSeat',  (SELECT button_seat FROM hh),
      'board',       (SELECT v FROM board_out),
      'players',     (SELECT v FROM players_out),
      'actions',     COALESCE((SELECT jsonb_agg(a ORDER BY ord)
                        FROM jsonb_array_elements((SELECT COALESCE(actions, '[]'::jsonb) FROM hh))
                             WITH ORDINALITY AS t(a, ord)
                        WHERE COALESCE(a->>'userId', '') <> 'system'), '[]'::jsonb),
      'winners',     (SELECT COALESCE(winners, '[]'::jsonb) FROM hh),
      'jackpot',     jsonb_build_object(
                       'payoutId',         p_payout_id,
                       'total',            (SELECT total_amount FROM pay),
                       'badBeatUserId',    (SELECT winner_user_id FROM pay),
                       'handWinnerUserId', (SELECT loser_user_id FROM pay),
                       'recipients',       (SELECT v FROM recips))
    ) END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_bbj_hand_detail(uuid) TO anon, authenticated, service_role;

-- 1506711: Valentina Salvatore Four of a Kind beaten by WASP Royal Flush
UPDATE public.hand_history SET
  game_variant     = 'plo4',
  small_blind      = 5,
  big_blind        = 10,
  button_seat      = 7,
  pot_size         = 7835,
  rake_amount      = 50,
  bbj_amount       = 10,
  community_cards  = ARRAY['Aclubs', 'Jdiamonds', 'Khearts', 'Adiamonds', 'Qdiamonds']::text[],
  board            = '["Aclubs","Jdiamonds","Khearts","Adiamonds","Qdiamonds"]'::jsonb,
  players          = '[{"seat":1,"userId":"e94d80fb-4973-452e-b745-6c3ca68c9b16","username":"Obsidian","stack":1875},{"seat":3,"userId":"ef25984c-d13a-4e4d-916a-f3537a40ea71","username":"Pulsar","stack":2410},{"seat":5,"userId":"083db75b-95a3-47ae-9989-927134dfa026","username":"Valentina Salvatore","stack":0},{"seat":7,"userId":"a497dbb8-a32c-4bb9-9ffa-beeea1d8c5d8","username":"WASP","stack":7775}]'::jsonb,
  actions          = '[{"seat":5,"userId":"083db75b-95a3-47ae-9989-927134dfa026","action":"raise","amount":35,"stage":"PreFlop"},{"seat":7,"userId":"a497dbb8-a32c-4bb9-9ffa-beeea1d8c5d8","action":"call","amount":35,"stage":"PreFlop"},{"seat":1,"userId":"e94d80fb-4973-452e-b745-6c3ca68c9b16","action":"fold","amount":0,"stage":"PreFlop"},{"seat":3,"userId":"ef25984c-d13a-4e4d-916a-f3537a40ea71","action":"fold","amount":0,"stage":"PreFlop"},{"seat":5,"userId":"083db75b-95a3-47ae-9989-927134dfa026","action":"bet","amount":60,"stage":"Flop"},{"seat":7,"userId":"a497dbb8-a32c-4bb9-9ffa-beeea1d8c5d8","action":"call","amount":60,"stage":"Flop"},{"seat":5,"userId":"083db75b-95a3-47ae-9989-927134dfa026","action":"bet","amount":200,"stage":"Turn"},{"seat":7,"userId":"a497dbb8-a32c-4bb9-9ffa-beeea1d8c5d8","action":"raise","amount":700,"stage":"Turn"},{"seat":5,"userId":"083db75b-95a3-47ae-9989-927134dfa026","action":"call","amount":500,"stage":"Turn"},{"seat":5,"userId":"083db75b-95a3-47ae-9989-927134dfa026","action":"bet","amount":900,"stage":"River"},{"seat":7,"userId":"a497dbb8-a32c-4bb9-9ffa-beeea1d8c5d8","action":"all_in","amount":3115,"stage":"River"},{"seat":5,"userId":"083db75b-95a3-47ae-9989-927134dfa026","action":"call","amount":2215,"stage":"River"}]'::jsonb,
  winners          = '[{"userId":"a497dbb8-a32c-4bb9-9ffa-beeea1d8c5d8","amount":7775,"potIndex":0,"hand":{"name":"Royal Flush"}}]'::jsonb,
  hole_cards       = '{"083db75b-95a3-47ae-9989-927134dfa026":[{"rank":"A","suit":"spades"},{"rank":"A","suit":"hearts"},{"rank":"7","suit":"spades"},{"rank":"2","suit":"diamonds"}],"a497dbb8-a32c-4bb9-9ffa-beeea1d8c5d8":[{"rank":"T","suit":"diamonds"},{"rank":"K","suit":"diamonds"},{"rank":"8","suit":"clubs"},{"rank":"4","suit":"spades"}]}'::jsonb,
  winner_name      = 'WASP',
  hand_name        = 'Royal Flush',
  summary          = 'Valentina Salvatore (CO) Four of a Kind beaten by WASP (BTN) Royal Flush. Bad Beat Jackpot.',
  started_at       = '2026-08-18 23:30:00+00',
  ended_at         = '2026-08-18 23:34:40+00',
  created_at       = '2026-08-18 23:30:00+00',
  source           = 'seed'
WHERE table_id = '81b02fd7-6c0e-4d19-af33-0957ca17b0ea' AND hand_number = 1506711;

UPDATE public.bbj_winners SET
  winner_hand         = 'Four of a Kind',
  loser_hand          = 'Royal Flush',
  winner_display_name = 'Valentina Salvatore',
  loser_display_name  = 'WASP',
  stakes_tier         = 'high'
WHERE table_id = '81b02fd7-6c0e-4d19-af33-0957ca17b0ea' AND hand_number = 1506711;

-- 1269428: Josephine Whitmore Straight Flush beaten by earlyPosition Royal Flush
UPDATE public.hand_history SET
  game_variant     = 'plo5',
  small_blind      = 1,
  big_blind        = 2,
  button_seat      = 5,
  pot_size         = 581,
  rake_amount      = 6,
  bbj_amount       = 1,
  community_cards  = ARRAY['9spades', 'Qdiamonds', 'Tdiamonds', 'Kspades', 'Jdiamonds']::text[],
  board            = '["9spades","Qdiamonds","Tdiamonds","Kspades","Jdiamonds"]'::jsonb,
  players          = '[{"seat":1,"userId":"145aaccb-b8bf-434a-b5e7-ca23a306799c","username":"SALVO","stack":412},{"seat":2,"userId":"f12caf56-c369-4b22-8e04-fdda07820876","username":"Josephine Whitmore","stack":0},{"seat":3,"userId":"b5e78a91-cc79-4fb0-989d-b47da1363a33","username":"Joseph Hernandez","stack":268},{"seat":5,"userId":"00000000-0000-0000-0000-000000000026","username":"earlyPosition","stack":574},{"seat":6,"userId":"3d15bbe7-f752-4a49-be3a-079232d23b0f","username":"Tempest","stack":196},{"seat":7,"userId":"c3195f0b-2da2-40d1-b1fd-42ab69e55edf","username":"Edward Delgado","stack":333}]'::jsonb,
  actions          = '[{"seat":1,"userId":"145aaccb-b8bf-434a-b5e7-ca23a306799c","action":"fold","amount":0,"stage":"PreFlop"},{"seat":2,"userId":"f12caf56-c369-4b22-8e04-fdda07820876","action":"raise","amount":7,"stage":"PreFlop"},{"seat":3,"userId":"b5e78a91-cc79-4fb0-989d-b47da1363a33","action":"fold","amount":0,"stage":"PreFlop"},{"seat":5,"userId":"00000000-0000-0000-0000-000000000026","action":"call","amount":7,"stage":"PreFlop"},{"seat":6,"userId":"3d15bbe7-f752-4a49-be3a-079232d23b0f","action":"fold","amount":0,"stage":"PreFlop"},{"seat":7,"userId":"c3195f0b-2da2-40d1-b1fd-42ab69e55edf","action":"fold","amount":0,"stage":"PreFlop"},{"seat":2,"userId":"f12caf56-c369-4b22-8e04-fdda07820876","action":"bet","amount":12,"stage":"Flop"},{"seat":5,"userId":"00000000-0000-0000-0000-000000000026","action":"call","amount":12,"stage":"Flop"},{"seat":2,"userId":"f12caf56-c369-4b22-8e04-fdda07820876","action":"bet","amount":30,"stage":"Turn"},{"seat":5,"userId":"00000000-0000-0000-0000-000000000026","action":"call","amount":30,"stage":"Turn"},{"seat":2,"userId":"f12caf56-c369-4b22-8e04-fdda07820876","action":"bet","amount":80,"stage":"River"},{"seat":5,"userId":"00000000-0000-0000-0000-000000000026","action":"all_in","amount":240,"stage":"River"},{"seat":2,"userId":"f12caf56-c369-4b22-8e04-fdda07820876","action":"call","amount":160,"stage":"River"}]'::jsonb,
  winners          = '[{"userId":"00000000-0000-0000-0000-000000000026","amount":574,"potIndex":0,"hand":{"name":"Royal Flush"}}]'::jsonb,
  hole_cards       = '{"f12caf56-c369-4b22-8e04-fdda07820876":[{"rank":"8","suit":"diamonds"},{"rank":"9","suit":"diamonds"},{"rank":"A","suit":"clubs"},{"rank":"5","suit":"spades"},{"rank":"3","suit":"hearts"}],"00000000-0000-0000-0000-000000000026":[{"rank":"A","suit":"diamonds"},{"rank":"K","suit":"diamonds"},{"rank":"8","suit":"clubs"},{"rank":"4","suit":"hearts"},{"rank":"2","suit":"spades"}]}'::jsonb,
  winner_name      = 'earlyPosition',
  hand_name        = 'Royal Flush',
  summary          = 'Josephine Whitmore (MP) Straight Flush beaten by earlyPosition (BTN) Royal Flush. Bad Beat Jackpot.',
  started_at       = '2026-08-12 21:10:00+00',
  ended_at         = '2026-08-12 21:13:35+00',
  created_at       = '2026-08-12 21:10:00+00',
  source           = 'seed'
WHERE table_id = 'e995a2ba-cd4d-4fd1-ab74-775370ee341e' AND hand_number = 1269428;

UPDATE public.bbj_winners SET
  winner_hand         = 'Straight Flush',
  loser_hand          = 'Royal Flush',
  winner_display_name = 'Josephine Whitmore',
  loser_display_name  = 'earlyPosition',
  stakes_tier         = 'mid'
WHERE table_id = 'e995a2ba-cd4d-4fd1-ab74-775370ee341e' AND hand_number = 1269428;

-- 1253455: Freeway Straight Flush beaten by Caroline Myers Straight Flush
UPDATE public.hand_history SET
  game_variant     = 'plo5',
  small_blind      = 0.5,
  big_blind        = 1,
  button_seat      = 7,
  pot_size         = 736.5,
  rake_amount      = 7.5,
  bbj_amount       = 1.5,
  community_cards  = ARRAY['6hearts', '7hearts', '8hearts', '2clubs', '3diamonds']::text[],
  board            = '["6hearts","7hearts","8hearts","2clubs","3diamonds"]'::jsonb,
  players          = '[{"seat":1,"userId":"2e49e7e8-346a-49ba-91d3-699f1d9e0d6a","username":"Jacob Russo","stack":143.5},{"seat":2,"userId":"6fdfcb70-b8f3-4ed1-89ca-a7d8af136dfc","username":"Harold Kitamura","stack":88},{"seat":3,"userId":"25e20c49-15d7-410f-bb88-7161d758c9d5","username":"Freeway","stack":0},{"seat":4,"userId":"498f15d8-1f5c-46e4-a330-c40301952540","username":"Ursa","stack":210},{"seat":6,"userId":"de0fe8e7-d317-43b7-bd5f-82dbac01418a","username":"Caroline Myers","stack":727.5},{"seat":7,"userId":"1b049140-90bf-4b45-82db-a6dc259ce0c3","username":"Vulcan","stack":164}]'::jsonb,
  actions          = '[{"seat":3,"userId":"25e20c49-15d7-410f-bb88-7161d758c9d5","action":"raise","amount":3.5,"stage":"PreFlop"},{"seat":4,"userId":"498f15d8-1f5c-46e4-a330-c40301952540","action":"fold","amount":0,"stage":"PreFlop"},{"seat":6,"userId":"de0fe8e7-d317-43b7-bd5f-82dbac01418a","action":"call","amount":3.5,"stage":"PreFlop"},{"seat":7,"userId":"1b049140-90bf-4b45-82db-a6dc259ce0c3","action":"fold","amount":0,"stage":"PreFlop"},{"seat":1,"userId":"2e49e7e8-346a-49ba-91d3-699f1d9e0d6a","action":"fold","amount":0,"stage":"PreFlop"},{"seat":2,"userId":"6fdfcb70-b8f3-4ed1-89ca-a7d8af136dfc","action":"fold","amount":0,"stage":"PreFlop"},{"seat":3,"userId":"25e20c49-15d7-410f-bb88-7161d758c9d5","action":"bet","amount":6,"stage":"Flop"},{"seat":6,"userId":"de0fe8e7-d317-43b7-bd5f-82dbac01418a","action":"raise","amount":24,"stage":"Flop"},{"seat":3,"userId":"25e20c49-15d7-410f-bb88-7161d758c9d5","action":"call","amount":18,"stage":"Flop"},{"seat":3,"userId":"25e20c49-15d7-410f-bb88-7161d758c9d5","action":"bet","amount":40,"stage":"Turn"},{"seat":6,"userId":"de0fe8e7-d317-43b7-bd5f-82dbac01418a","action":"call","amount":40,"stage":"Turn"},{"seat":3,"userId":"25e20c49-15d7-410f-bb88-7161d758c9d5","action":"bet","amount":100,"stage":"River"},{"seat":6,"userId":"de0fe8e7-d317-43b7-bd5f-82dbac01418a","action":"all_in","amount":300,"stage":"River"},{"seat":3,"userId":"25e20c49-15d7-410f-bb88-7161d758c9d5","action":"call","amount":200,"stage":"River"}]'::jsonb,
  winners          = '[{"userId":"de0fe8e7-d317-43b7-bd5f-82dbac01418a","amount":727.5,"potIndex":0,"hand":{"name":"Straight Flush"}}]'::jsonb,
  hole_cards       = '{"25e20c49-15d7-410f-bb88-7161d758c9d5":[{"rank":"4","suit":"hearts"},{"rank":"5","suit":"hearts"},{"rank":"A","suit":"clubs"},{"rank":"K","suit":"spades"},{"rank":"2","suit":"diamonds"}],"de0fe8e7-d317-43b7-bd5f-82dbac01418a":[{"rank":"9","suit":"hearts"},{"rank":"T","suit":"hearts"},{"rank":"J","suit":"diamonds"},{"rank":"Q","suit":"spades"},{"rank":"3","suit":"clubs"}]}'::jsonb,
  winner_name      = 'Caroline Myers',
  hand_name        = 'Straight Flush',
  summary          = 'Freeway (UTG) Straight Flush beaten by Caroline Myers (CO) Straight Flush. Bad Beat Jackpot.',
  started_at       = '2026-08-04 18:22:00+00',
  ended_at         = '2026-08-04 18:24:30+00',
  created_at       = '2026-08-04 18:22:00+00',
  source           = 'seed'
WHERE table_id = 'a5cb6513-cceb-44d1-b742-46822a1eb941' AND hand_number = 1253455;

UPDATE public.bbj_winners SET
  winner_hand         = 'Straight Flush',
  loser_hand          = 'Straight Flush',
  winner_display_name = 'Freeway',
  loser_display_name  = 'Caroline Myers',
  stakes_tier         = 'small'
WHERE table_id = 'a5cb6513-cceb-44d1-b742-46822a1eb941' AND hand_number = 1253455;

-- 1127041: broadwayKing Four of a Kind beaten by Alice Bourgeois Four of a Kind
UPDATE public.hand_history SET
  game_variant     = 'nlh',
  small_blind      = 0.1,
  big_blind        = 0.2,
  button_seat      = 9,
  pot_size         = 105.5,
  rake_amount      = 2.5,
  bbj_amount       = 0.5,
  community_cards  = ARRAY['Qspades', 'Qdiamonds', '8hearts', 'Kclubs', 'Kdiamonds']::text[],
  board            = '["Qspades","Qdiamonds","8hearts","Kclubs","Kdiamonds"]'::jsonb,
  players          = '[{"seat":1,"userId":"7d7a80a2-092c-4338-878a-0416611b249c","username":"Aaron Bell","stack":19.4},{"seat":3,"userId":"740e9ec1-0995-41d3-b12d-635a92631592","username":"Abqmark","stack":24.8},{"seat":4,"userId":"00000000-0000-0000-0000-000000000008","username":"broadwayKing","stack":0},{"seat":6,"userId":"165df98e-f59d-46aa-bc74-a974c0ded83f","username":"aceHighJack","stack":31},{"seat":9,"userId":"f1042170-33c9-4063-b427-910fe1683c72","username":"Alice Bourgeois","stack":102.5}]'::jsonb,
  actions          = '[{"seat":4,"userId":"00000000-0000-0000-0000-000000000008","action":"raise","amount":0.6,"stage":"PreFlop"},{"seat":6,"userId":"165df98e-f59d-46aa-bc74-a974c0ded83f","action":"fold","amount":0,"stage":"PreFlop"},{"seat":9,"userId":"f1042170-33c9-4063-b427-910fe1683c72","action":"call","amount":0.6,"stage":"PreFlop"},{"seat":1,"userId":"7d7a80a2-092c-4338-878a-0416611b249c","action":"fold","amount":0,"stage":"PreFlop"},{"seat":3,"userId":"740e9ec1-0995-41d3-b12d-635a92631592","action":"fold","amount":0,"stage":"PreFlop"},{"seat":4,"userId":"00000000-0000-0000-0000-000000000008","action":"bet","amount":1,"stage":"Flop"},{"seat":9,"userId":"f1042170-33c9-4063-b427-910fe1683c72","action":"call","amount":1,"stage":"Flop"},{"seat":4,"userId":"00000000-0000-0000-0000-000000000008","action":"bet","amount":3,"stage":"Turn"},{"seat":9,"userId":"f1042170-33c9-4063-b427-910fe1683c72","action":"raise","amount":9,"stage":"Turn"},{"seat":4,"userId":"00000000-0000-0000-0000-000000000008","action":"call","amount":6,"stage":"Turn"},{"seat":4,"userId":"00000000-0000-0000-0000-000000000008","action":"bet","amount":14,"stage":"River"},{"seat":9,"userId":"f1042170-33c9-4063-b427-910fe1683c72","action":"all_in","amount":42,"stage":"River"},{"seat":4,"userId":"00000000-0000-0000-0000-000000000008","action":"call","amount":28,"stage":"River"}]'::jsonb,
  winners          = '[{"userId":"f1042170-33c9-4063-b427-910fe1683c72","amount":102.5,"potIndex":0,"hand":{"name":"Four of a Kind"}}]'::jsonb,
  hole_cards       = '{"00000000-0000-0000-0000-000000000008":[{"rank":"Q","suit":"hearts"},{"rank":"Q","suit":"clubs"}],"f1042170-33c9-4063-b427-910fe1683c72":[{"rank":"K","suit":"hearts"},{"rank":"K","suit":"spades"}]}'::jsonb,
  winner_name      = 'Alice Bourgeois',
  hand_name        = 'Four of a Kind',
  summary          = 'broadwayKing (UTG) Four of a Kind beaten by Alice Bourgeois (BTN) Four of a Kind. Bad Beat Jackpot.',
  started_at       = '2026-07-30 09:15:00+00',
  ended_at         = '2026-07-30 09:17:20+00',
  created_at       = '2026-07-30 09:15:00+00',
  source           = 'seed'
WHERE table_id = '4fd19504-708a-47e2-89ff-888d8f567c42' AND hand_number = 1127041;

UPDATE public.bbj_winners SET
  winner_hand         = 'Four of a Kind',
  loser_hand          = 'Four of a Kind',
  winner_display_name = 'broadwayKing',
  loser_display_name  = 'Alice Bourgeois',
  stakes_tier         = 'small'
WHERE table_id = '4fd19504-708a-47e2-89ff-888d8f567c42' AND hand_number = 1127041;

-- 1080832: CRUX Four of a Kind beaten by Christopher Lee Royal Flush
UPDATE public.hand_history SET
  game_variant     = 'plo4',
  small_blind      = 1,
  big_blind        = 2,
  button_seat      = 8,
  pot_size         = 2227,
  rake_amount      = 25,
  bbj_amount       = 5,
  community_cards  = ARRAY['Aclubs', 'Kclubs', '5hearts', 'Adiamonds', 'Qclubs']::text[],
  board            = '["Aclubs","Kclubs","5hearts","Adiamonds","Qclubs"]'::jsonb,
  players          = '[{"seat":2,"userId":"97e77c3a-16af-4e7f-9a83-9fd91c958067","username":"FALCON","stack":305},{"seat":4,"userId":"c402b38e-7ba6-40bf-a2d3-d65376d28ccf","username":"Mark Phillips","stack":418},{"seat":6,"userId":"60f7edc9-f93e-43da-833c-1dd10caef345","username":"CRUX","stack":0},{"seat":8,"userId":"ca905025-0dfc-4353-ac1e-444ce5763c83","username":"Christopher Lee","stack":2197}]'::jsonb,
  actions          = '[{"seat":6,"userId":"60f7edc9-f93e-43da-833c-1dd10caef345","action":"raise","amount":7,"stage":"PreFlop"},{"seat":8,"userId":"ca905025-0dfc-4353-ac1e-444ce5763c83","action":"call","amount":7,"stage":"PreFlop"},{"seat":2,"userId":"97e77c3a-16af-4e7f-9a83-9fd91c958067","action":"fold","amount":0,"stage":"PreFlop"},{"seat":4,"userId":"c402b38e-7ba6-40bf-a2d3-d65376d28ccf","action":"fold","amount":0,"stage":"PreFlop"},{"seat":6,"userId":"60f7edc9-f93e-43da-833c-1dd10caef345","action":"bet","amount":12,"stage":"Flop"},{"seat":8,"userId":"ca905025-0dfc-4353-ac1e-444ce5763c83","action":"call","amount":12,"stage":"Flop"},{"seat":6,"userId":"60f7edc9-f93e-43da-833c-1dd10caef345","action":"bet","amount":40,"stage":"Turn"},{"seat":8,"userId":"ca905025-0dfc-4353-ac1e-444ce5763c83","action":"raise","amount":160,"stage":"Turn"},{"seat":6,"userId":"60f7edc9-f93e-43da-833c-1dd10caef345","action":"call","amount":120,"stage":"Turn"},{"seat":6,"userId":"60f7edc9-f93e-43da-833c-1dd10caef345","action":"bet","amount":200,"stage":"River"},{"seat":8,"userId":"ca905025-0dfc-4353-ac1e-444ce5763c83","action":"all_in","amount":933,"stage":"River"},{"seat":6,"userId":"60f7edc9-f93e-43da-833c-1dd10caef345","action":"call","amount":733,"stage":"River"}]'::jsonb,
  winners          = '[{"userId":"ca905025-0dfc-4353-ac1e-444ce5763c83","amount":2197,"potIndex":0,"hand":{"name":"Royal Flush"}}]'::jsonb,
  hole_cards       = '{"60f7edc9-f93e-43da-833c-1dd10caef345":[{"rank":"A","suit":"spades"},{"rank":"A","suit":"hearts"},{"rank":"7","suit":"diamonds"},{"rank":"2","suit":"spades"}],"ca905025-0dfc-4353-ac1e-444ce5763c83":[{"rank":"J","suit":"clubs"},{"rank":"T","suit":"clubs"},{"rank":"8","suit":"diamonds"},{"rank":"3","suit":"hearts"}]}'::jsonb,
  winner_name      = 'Christopher Lee',
  hand_name        = 'Royal Flush',
  summary          = 'CRUX (CO) Four of a Kind beaten by Christopher Lee (BTN) Royal Flush. Bad Beat Jackpot.',
  started_at       = '2026-07-22 14:29:00+00',
  ended_at         = '2026-07-22 14:31:40+00',
  created_at       = '2026-07-22 14:29:00+00',
  source           = 'seed'
WHERE table_id = '6e71b875-28f8-4aa2-826d-bbac704aa492' AND hand_number = 1080832;

UPDATE public.bbj_winners SET
  winner_hand         = 'Four of a Kind',
  loser_hand          = 'Royal Flush',
  winner_display_name = 'CRUX',
  loser_display_name  = 'Christopher Lee',
  stakes_tier         = 'mid'
WHERE table_id = '6e71b875-28f8-4aa2-826d-bbac704aa492' AND hand_number = 1080832;

-- The table share, paid to the players dealt in who were not in the hand.
DELETE FROM public.bbj_payout_recipients WHERE payout_id = 'b19f8048-d63f-4f85-b2ae-863299c81b2d';
INSERT INTO public.bbj_payout_recipients (payout_id, user_id, amount, created_at) VALUES
  ('b19f8048-d63f-4f85-b2ae-863299c81b2d', '083db75b-95a3-47ae-9989-927134dfa026', 3941.96, '2026-08-18 23:35:00+00'),
  ('b19f8048-d63f-4f85-b2ae-863299c81b2d', 'a497dbb8-a32c-4bb9-9ffa-beeea1d8c5d8', 1970.98, '2026-08-18 23:35:00+00'),
  ('b19f8048-d63f-4f85-b2ae-863299c81b2d', 'e94d80fb-4973-452e-b745-6c3ca68c9b16', 985.49, '2026-08-18 23:35:00+00'),
  ('b19f8048-d63f-4f85-b2ae-863299c81b2d', 'ef25984c-d13a-4e4d-916a-f3537a40ea71', 985.49, '2026-08-18 23:35:00+00');

DELETE FROM public.bbj_payout_recipients WHERE payout_id = 'd55f4b9d-115e-4bd2-a768-ac478cbebb04';
INSERT INTO public.bbj_payout_recipients (payout_id, user_id, amount, created_at) VALUES
  ('d55f4b9d-115e-4bd2-a768-ac478cbebb04', 'f12caf56-c369-4b22-8e04-fdda07820876', 3137.94, '2026-08-12 21:14:00+00'),
  ('d55f4b9d-115e-4bd2-a768-ac478cbebb04', '00000000-0000-0000-0000-000000000026', 1568.97, '2026-08-12 21:14:00+00'),
  ('d55f4b9d-115e-4bd2-a768-ac478cbebb04', '145aaccb-b8bf-434a-b5e7-ca23a306799c', 392.25, '2026-08-12 21:14:00+00'),
  ('d55f4b9d-115e-4bd2-a768-ac478cbebb04', 'b5e78a91-cc79-4fb0-989d-b47da1363a33', 392.24, '2026-08-12 21:14:00+00'),
  ('d55f4b9d-115e-4bd2-a768-ac478cbebb04', '3d15bbe7-f752-4a49-be3a-079232d23b0f', 392.24, '2026-08-12 21:14:00+00'),
  ('d55f4b9d-115e-4bd2-a768-ac478cbebb04', 'c3195f0b-2da2-40d1-b1fd-42ab69e55edf', 392.24, '2026-08-12 21:14:00+00');

DELETE FROM public.bbj_payout_recipients WHERE payout_id = 'e6e0447c-5ffc-4a96-abed-5f8a6c4b5cfc';
INSERT INTO public.bbj_payout_recipients (payout_id, user_id, amount, created_at) VALUES
  ('e6e0447c-5ffc-4a96-abed-5f8a6c4b5cfc', '25e20c49-15d7-410f-bb88-7161d758c9d5', 1820, '2026-08-04 18:25:00+00'),
  ('e6e0447c-5ffc-4a96-abed-5f8a6c4b5cfc', 'de0fe8e7-d317-43b7-bd5f-82dbac01418a', 910, '2026-08-04 18:25:00+00'),
  ('e6e0447c-5ffc-4a96-abed-5f8a6c4b5cfc', '2e49e7e8-346a-49ba-91d3-699f1d9e0d6a', 227.5, '2026-08-04 18:25:00+00'),
  ('e6e0447c-5ffc-4a96-abed-5f8a6c4b5cfc', '6fdfcb70-b8f3-4ed1-89ca-a7d8af136dfc', 227.5, '2026-08-04 18:25:00+00'),
  ('e6e0447c-5ffc-4a96-abed-5f8a6c4b5cfc', '498f15d8-1f5c-46e4-a330-c40301952540', 227.5, '2026-08-04 18:25:00+00'),
  ('e6e0447c-5ffc-4a96-abed-5f8a6c4b5cfc', '1b049140-90bf-4b45-82db-a6dc259ce0c3', 227.5, '2026-08-04 18:25:00+00');

DELETE FROM public.bbj_payout_recipients WHERE payout_id = 'e9d4bacf-3cc5-4988-9fc4-51b2c83620d9';
INSERT INTO public.bbj_payout_recipients (payout_id, user_id, amount, created_at) VALUES
  ('e9d4bacf-3cc5-4988-9fc4-51b2c83620d9', '00000000-0000-0000-0000-000000000008', 2870, '2026-07-30 09:18:00+00'),
  ('e9d4bacf-3cc5-4988-9fc4-51b2c83620d9', 'f1042170-33c9-4063-b427-910fe1683c72', 1435, '2026-07-30 09:18:00+00'),
  ('e9d4bacf-3cc5-4988-9fc4-51b2c83620d9', '7d7a80a2-092c-4338-878a-0416611b249c', 478.34, '2026-07-30 09:18:00+00'),
  ('e9d4bacf-3cc5-4988-9fc4-51b2c83620d9', '740e9ec1-0995-41d3-b12d-635a92631592', 478.33, '2026-07-30 09:18:00+00'),
  ('e9d4bacf-3cc5-4988-9fc4-51b2c83620d9', '165df98e-f59d-46aa-bc74-a974c0ded83f', 478.33, '2026-07-30 09:18:00+00');

DELETE FROM public.bbj_payout_recipients WHERE payout_id = '44f57403-0744-4278-be49-489b530c4cac';
INSERT INTO public.bbj_payout_recipients (payout_id, user_id, amount, created_at) VALUES
  ('44f57403-0744-4278-be49-489b530c4cac', '60f7edc9-f93e-43da-833c-1dd10caef345', 1575, '2026-07-22 14:32:00+00'),
  ('44f57403-0744-4278-be49-489b530c4cac', 'ca905025-0dfc-4353-ac1e-444ce5763c83', 787.5, '2026-07-22 14:32:00+00'),
  ('44f57403-0744-4278-be49-489b530c4cac', '97e77c3a-16af-4e7f-9a83-9fd91c958067', 393.75, '2026-07-22 14:32:00+00'),
  ('44f57403-0744-4278-be49-489b530c4cac', 'c402b38e-7ba6-40bf-a2d3-d65376d28ccf', 393.75, '2026-07-22 14:32:00+00');

-- Assertions. This aborts rather than leaving a money surface showing numbers
-- that do not add up.
DO $$
DECLARE
  r record;
  v_recon numeric;
BEGIN
  FOR r IN
    SELECT p.id, p.hand_number, p.total_amount, p.table_player_count,
           h.pot_size, h.small_blind, h.big_blind, h.button_seat,
           h.players, h.actions
    FROM public.bbj_payouts p
    JOIN public.hand_history h ON h.table_id = p.table_id AND h.hand_number = p.hand_number
    WHERE p.id IN ('b19f8048-d63f-4f85-b2ae-863299c81b2d', 'd55f4b9d-115e-4bd2-a768-ac478cbebb04', 'e6e0447c-5ffc-4a96-abed-5f8a6c4b5cfc', 'e9d4bacf-3cc5-4988-9fc4-51b2c83620d9', '44f57403-0744-4278-be49-489b530c4cac')
  LOOP
    IF (SELECT COALESCE(sum(amount), 0) FROM public.bbj_payout_recipients WHERE payout_id = r.id)
       <> r.total_amount THEN
      RAISE EXCEPTION 'hand %: recipients do not sum to total_amount %', r.hand_number, r.total_amount;
    END IF;

    IF (SELECT count(*) FROM public.bbj_payout_recipients WHERE payout_id = r.id)
       <> jsonb_array_length(r.players) THEN
      RAISE EXCEPTION 'hand %: recipient count does not match the seat count', r.hand_number;
    END IF;

    SELECT r.small_blind + r.big_blind
           + COALESCE((SELECT sum((a->>'amount')::numeric)
                       FROM jsonb_array_elements(r.actions) a), 0)
      INTO v_recon;
    IF abs(v_recon - r.pot_size) >= 0.02 THEN
      RAISE EXCEPTION 'hand %: actions rebuild to % but pot_size is %',
        r.hand_number, v_recon, r.pot_size;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.players) p
                    WHERE (p->>'seat')::int = r.button_seat) THEN
      RAISE EXCEPTION 'hand %: button seat % is not occupied', r.hand_number, r.button_seat;
    END IF;

    IF r.table_player_count <> jsonb_array_length(r.players) THEN
      RAISE EXCEPTION 'hand %: table_player_count % but % players dealt in',
        r.hand_number, r.table_player_count, jsonb_array_length(r.players);
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM public.bbj_payouts p
    JOIN public.profiles pr ON pr.id = p.winner_user_id
    WHERE p.id IN ('b19f8048-d63f-4f85-b2ae-863299c81b2d', 'd55f4b9d-115e-4bd2-a768-ac478cbebb04', 'e6e0447c-5ffc-4a96-abed-5f8a6c4b5cfc', 'e9d4bacf-3cc5-4988-9fc4-51b2c83620d9', '44f57403-0744-4278-be49-489b530c4cac')
      AND COALESCE(pr.arena_avatar_url, '') = ''
  ) THEN
    RAISE EXCEPTION 'a seeded jackpot winner has no club avatar to show';
  END IF;
END $$;

