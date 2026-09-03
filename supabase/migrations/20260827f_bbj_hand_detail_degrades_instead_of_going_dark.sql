-- ============================================================================
--  A jackpot whose hand is gone still has plenty to say
-- ============================================================================
--
--  Recorded in production as `bbj_hand_detail_degrades_instead_of_going_dark`.
--
--  fn_bbj_hand_detail returned NULL when no hand_history row matched, and the
--  client turned that into "The Full Hand For This Jackpot Is No Longer
--  Available." - a dead end, and what 24 of the 29 real jackpots on this
--  platform showed, because the pruner deleted their hands before
--  20260827d stopped it and bbj_payouts.hand_id was NULL so nothing can
--  rebuild them.
--
--  The hand is not all we have. bbj_winners records both hand names and both
--  display names and the pool at the moment it hit; bbj_payouts records the
--  total and the split; bbj_payout_recipients records every player who was
--  paid and how much. That is the whole payout story. Only the street-by-street
--  action is missing, and the payload now says exactly that:
--
--    handAvailable = true   the full rundown, unchanged
--    handAvailable = false  the summary
--
--  NULL is still returned when the payout id does not exist, because that is a
--  genuine "no such thing" rather than a partial record.
--
--  Additive: handAvailable is a new key, every existing key keeps its shape,
--  and a client that ignores the flag sees what it saw before.
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
  win AS (
    SELECT w.* FROM public.bbj_winners w
    JOIN pay ON w.table_id = pay.table_id AND w.hand_number = pay.hand_number
    LIMIT 1
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
               -- The summary card has no seat roster to look a number up in,
               -- so it travels with the recipient.
               'playerNumber', pr.player_number::text,
               'amount', r.amount,
               'role',   CASE
                           WHEN r.user_id = (SELECT winner_user_id FROM pay) THEN 'bad_beat'
                           WHEN r.user_id = (SELECT loser_user_id  FROM pay) THEN 'hand_winner'
                           ELSE 'table'
                         END) ORDER BY r.amount DESC), '[]'::jsonb) AS v
    FROM public.bbj_payout_recipients r
    LEFT JOIN public.profiles pr ON pr.id = r.user_id
    WHERE r.payout_id = p_payout_id
  ),
  jackpot AS (
    SELECT jsonb_build_object(
             'payoutId',         p_payout_id,
             'total',            (SELECT total_amount FROM pay),
             'badBeatUserId',    (SELECT winner_user_id FROM pay),
             'handWinnerUserId', (SELECT loser_user_id FROM pay),
             'recipients',       (SELECT v FROM recips)) AS v
  )
  SELECT CASE
    -- No such payout. A genuine nothing, and still a NULL.
    WHEN (SELECT count(*) FROM pay) = 0 THEN NULL

    -- THE HAND IS GONE. Everything the payout ledger knows, and an honest flag
    -- saying the street-by-street part is not coming.
    WHEN (SELECT count(*) FROM hh) = 0 THEN jsonb_build_object(
      'handAvailable', false,
      'handNumber',    (SELECT hand_number FROM pay),
      'playedAt',      (SELECT created_at FROM pay),
      'gameVariant',   NULL,
      'tablePlayerCount', (SELECT table_player_count FROM pay),
      -- bbj_winners names the two hands. Note the deliberate inversion the
      -- rest of this feature lives with: in bbj_winners, "winner" is the
      -- winner OF THE JACKPOT (the bad-beat holder, who LOST the hand).
      'badBeatName',   (SELECT COALESCE(NULLIF(winner_display_name,''), 'Player') FROM win),
      'badBeatHand',   (SELECT NULLIF(winner_hand, 'Unknown') FROM win),
      'handWinnerName',(SELECT COALESCE(NULLIF(loser_display_name,''), 'Player') FROM win),
      'handWinnerHand',(SELECT NULLIF(loser_hand, 'Unknown') FROM win),
      'poolAtHit',     (SELECT pool_amount_at_hit FROM win),
      'jackpot',       (SELECT v FROM jackpot)
    )

    ELSE jsonb_build_object(
      'handAvailable', true,
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
      'jackpot',     (SELECT v FROM jackpot)
    )
  END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_bbj_hand_detail(uuid) TO anon, authenticated, service_role;

DO $$
DECLARE
  v_full integer := 0;
  v_summary integer := 0;
  r record;
  d jsonb;
BEGIN
  FOR r IN SELECT id FROM public.bbj_payouts LOOP
    d := public.fn_bbj_hand_detail(r.id);
    IF d IS NULL THEN
      RAISE EXCEPTION 'payout % returned NULL - every real payout must render something', r.id;
    END IF;
    IF (d->>'handAvailable')::boolean THEN v_full := v_full + 1; ELSE v_summary := v_summary + 1; END IF;

    -- Whichever kind it is, the payout story must be complete: the recipients
    -- are the whole point of the summary card.
    IF jsonb_array_length(d->'jackpot'->'recipients') = 0 THEN
      RAISE EXCEPTION 'payout % has no recipients to show', r.id;
    END IF;
  END LOOP;

  RAISE NOTICE 'bbj hand detail: % full, % summary', v_full, v_summary;
END $$;
