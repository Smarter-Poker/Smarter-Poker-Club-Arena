-- ============================================================================
--  fn_bbj_hand_detail: the data points the rundown was missing
-- ============================================================================
--
--  Dan, 2026-08-27: "make sure the HAND DETAILS looks and is exactly like it
--  appears inside our hand details. don't leave anything out."
--
--  Three columns hand_history has carried since 2026-08-25/26 were never in
--  this payload, so the jackpot rundown could not draw what the reference does:
--
--    showdown   - reveal order and the muck ruling, per player. Without it a
--                 player who did not show is indistinguishable from one whose
--                 cards simply were not stored.
--    pots       - the real main/side split. The rundown had to print
--                 Main(pot_size) even on a hand with a side pot.
--    rit_boards - run-it-twice boards 2..N, and community_cards2 for a
--                 double-board bomb pot. Both were invisible, so a hand that
--                 ran twice rendered as if it had run once.
--
--  Additive: nothing is removed and no existing key changes shape.
-- ============================================================================

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
          -- The CLUB avatar. profiles.avatar_url is the social media photo and
          -- is not Club Arena's to display.
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
  -- Run-it-twice boards, then a double-board bomb pot's second board. Left as
  -- the stored string form ('Ahearts'); toDeckCards on the client reads both.
  extra_boards AS (
    SELECT COALESCE(jsonb_agg(b ORDER BY ord), '[]'::jsonb) AS v
    FROM (
      SELECT e.value AS b, e.ordinality AS ord
      FROM hh, LATERAL jsonb_array_elements(COALESCE(hh.rit_boards, '[]'::jsonb))
                       WITH ORDINALITY e(value, ordinality)
      UNION ALL
      SELECT to_jsonb(hh.community_cards2), 1000
      FROM hh WHERE hh.community_cards2 IS NOT NULL
                AND array_length(hh.community_cards2, 1) > 0
    ) t
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
      'extraBoards', (SELECT v FROM extra_boards),
      'players',     (SELECT v FROM players_out),
      'actions',     COALESCE((SELECT jsonb_agg(a ORDER BY ord)
                        FROM jsonb_array_elements((SELECT COALESCE(actions, '[]'::jsonb) FROM hh))
                             WITH ORDINALITY AS t(a, ord)
                        WHERE COALESCE(a->>'userId', '') <> 'system'), '[]'::jsonb),
      'winners',     (SELECT COALESCE(winners, '[]'::jsonb) FROM hh),
      'showdown',    (SELECT COALESCE(showdown, '[]'::jsonb) FROM hh),
      'pots',        (SELECT COALESCE(pots, '[]'::jsonb) FROM hh),
      'jackpot',     jsonb_build_object(
                       'payoutId',         p_payout_id,
                       'total',            (SELECT total_amount FROM pay),
                       'badBeatUserId',    (SELECT winner_user_id FROM pay),
                       'handWinnerUserId', (SELECT loser_user_id FROM pay),
                       'recipients',       (SELECT v FROM recips))
    ) END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_bbj_hand_detail(uuid) TO anon, authenticated, service_role;
