-- ═══════════════════════════════════════════════════════════════════════════════
--  BBJ WINNERS + HAND DETAIL (Dan, 2026-08-20)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Two changes, both driven by the BBJ popup rebuild:
--
-- 1. fn_bbj_recent_hits now also returns the jackpot winner's identity
--    (user id, player number, avatar) so the "Winner" tab can render the
--    PokerBros-style row: avatar, name, player number, hand, payout, time.
--    It previously returned display names only, which is why the winners list
--    could not show an avatar or a player id at all.
--
-- 2. New fn_bbj_hand_detail(payout_id) returns the FULL hand behind a jackpot
--    hit, so tapping a winner opens a real hand rundown.
--
--    This has to be SECURITY DEFINER. hand_history RLS only lets a player read
--    hands they were dealt into (hand_history_authenticated_select matches
--    players @> [{"userId": auth.uid()}]), and the whole point of a public
--    jackpot board is that everyone can see the hand that paid. The exposure is
--    deliberately narrow: the function is keyed by a bbj_payouts id, so the
--    ONLY hands reachable through it are hands that actually hit the jackpot,
--    and it exposes exactly the hole cards hand_history already stores — which
--    the engine only persists for cards shown at showdown (mucked cards are
--    never written; see server/src/engine/ServerTableEngineSettlement.ts).
--    It cannot be used as a general hand reader.
--
-- TIER 3 (drops and recreates an RPC). ROLLBACK is at the bottom of this file.

-- ─────────────────────────────────────────────────────────────────────────────
-- Pre-flight assumptions. If any of these are false the migration must abort
-- rather than half-apply.
-- ─────────────────────────────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'player_number'
  ) THEN
    RAISE EXCEPTION 'profiles.player_number is missing - winners rows cannot show a player id';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'hand_history' AND column_name = 'button_seat'
  ) THEN
    RAISE EXCEPTION 'hand_history.button_seat is missing - positions cannot be derived';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bbj_payouts' AND column_name = 'hand_number'
  ) THEN
    RAISE EXCEPTION 'bbj_payouts.hand_number is missing - the hand join key is gone';
  END IF;
END
$pre$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. fn_bbj_recent_hits - same rows, three extra identity columns.
--    RETURNS TABLE gained columns, so the old signature must be dropped first.
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.fn_bbj_recent_hits(uuid, integer);

CREATE FUNCTION public.fn_bbj_recent_hits(p_pool_id uuid, p_limit integer DEFAULT 5)
RETURNS TABLE(
  payout_id uuid,
  awarded_at timestamp with time zone,
  hand_number bigint,
  total_payout numeric,
  bad_beat_user_id uuid,
  bad_beat_player_number text,
  bad_beat_avatar_url text,
  bad_beat_name text,
  bad_beat_hand text,
  bad_beat_amount numeric,
  bad_beat_cards jsonb,
  hand_winner_name text,
  hand_winner_hand text,
  hand_winner_amount numeric,
  hand_winner_cards jsonb,
  board jsonb,
  game_variant text,
  small_blind numeric,
  big_blind numeric,
  table_player_count integer,
  recipients jsonb
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH hits AS (
    SELECT p.*, w.winner_hand, w.loser_hand,
           w.winner_display_name, w.loser_display_name,
           h.board AS raw_board, h.hole_cards, h.game_variant,
           h.small_blind, h.big_blind
    FROM public.bbj_payouts p
    LEFT JOIN public.bbj_winners w
           ON w.table_id = p.table_id AND w.hand_number = p.hand_number
    LEFT JOIN public.hand_history h
           ON h.table_id = p.table_id AND h.hand_number = p.hand_number
    WHERE p.pool_id = p_pool_id
    ORDER BY p.created_at DESC
    LIMIT GREATEST(1, LEAST(p_limit, 25))
  )
  SELECT
    x.id,
    x.created_at,
    x.hand_number,
    x.total_amount,
    -- "winner" in bbj_payouts means winner OF THE JACKPOT: the bad-beat holder,
    -- who LOST the hand. Naming preserved from the source table on purpose.
    x.winner_user_id,
    bb.player_number::text,
    bb.avatar_url,
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
                   'rank', regexp_replace(c, '(hearts|diamonds|clubs|spades)$', ''),
                   'suit', substring(c from '(hearts|diamonds|clubs|spades)$')
                 ) ORDER BY ord
               ), '[]'::jsonb)
        FROM jsonb_array_elements_text(x.raw_board) WITH ORDINALITY AS t(c, ord)
        WHERE substring(c from '(hearts|diamonds|clubs|spades)$') IS NOT NULL
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
               )
               ORDER BY r.amount DESC
             )
      FROM public.bbj_payout_recipients r
      LEFT JOIN public.profiles pr ON pr.id = r.user_id
      WHERE r.payout_id = x.id
    ), '[]'::jsonb)
  FROM hits x
  LEFT JOIN public.profiles bb ON bb.id = x.winner_user_id
  LEFT JOIN public.profiles hw ON hw.id = x.loser_user_id
  ORDER BY x.created_at DESC;
$function$;

REVOKE ALL ON FUNCTION public.fn_bbj_recent_hits(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_bbj_recent_hits(uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_recent_hits(uuid, integer) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. fn_bbj_hand_detail - the whole hand behind one jackpot payout.
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.fn_bbj_hand_detail(uuid);

CREATE FUNCTION public.fn_bbj_hand_detail(p_payout_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH pay AS (
    SELECT * FROM public.bbj_payouts WHERE id = p_payout_id
  ),
  hh AS (
    SELECT h.*
    FROM public.hand_history h
    JOIN pay ON h.table_id = pay.table_id AND h.hand_number = pay.hand_number
    ORDER BY h.created_at DESC
    LIMIT 1
  ),
  seats AS (
    SELECT e.value AS p
    FROM hh, LATERAL jsonb_array_elements(COALESCE(hh.players, '[]'::jsonb)) e
  ),
  players_out AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'userId',       s.p->>'userId',
          'username',     COALESCE(pr.display_name, pr.username, s.p->>'username', 'Player'),
          'playerNumber', pr.player_number::text,
          'avatarUrl',    pr.avatar_url,
          'seat',         NULLIF(s.p->>'seat', '')::int,
          'stack',        NULLIF(s.p->>'stack', '')::numeric,
          'cards',        COALESCE((SELECT hh.hole_cards -> (s.p->>'userId') FROM hh), 'null'::jsonb)
        )
        ORDER BY NULLIF(s.p->>'seat', '')::int
      ), '[]'::jsonb) AS v
    FROM seats s
    LEFT JOIN public.profiles pr ON pr.id::text = s.p->>'userId'
  ),
  board_out AS (
    SELECT CASE
      WHEN (SELECT community_cards FROM hh) IS NULL THEN '[]'::jsonb
      ELSE COALESCE((
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'rank', regexp_replace(c, '(hearts|diamonds|clubs|spades)$', ''),
                   'suit', substring(c from '(hearts|diamonds|clubs|spades)$')
                 ) ORDER BY ord)
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
                         END
             ) ORDER BY r.amount DESC
           ), '[]'::jsonb) AS v
    FROM public.bbj_payout_recipients r
    LEFT JOIN public.profiles pr ON pr.id = r.user_id
    WHERE r.payout_id = p_payout_id
  )
  SELECT CASE
    WHEN (SELECT count(*) FROM hh) = 0 THEN NULL
    ELSE jsonb_build_object(
      'handNumber',   (SELECT hand_number FROM hh),
      'playedAt',     COALESCE((SELECT started_at FROM hh), (SELECT created_at FROM hh)),
      'gameVariant',  (SELECT game_variant FROM hh),
      'smallBlind',   (SELECT small_blind FROM hh),
      'bigBlind',     (SELECT big_blind FROM hh),
      'potSize',      (SELECT pot_size FROM hh),
      'rakeAmount',   (SELECT rake_amount FROM hh),
      'bbjAmount',    (SELECT bbj_amount FROM hh),
      'buttonSeat',   (SELECT button_seat FROM hh),
      'board',        (SELECT v FROM board_out),
      'players',      (SELECT v FROM players_out),
      -- 'system' rows carry run-it-twice boards, not player actions. The client
      -- filters them, but strip them here too so no surface has to remember.
      'actions',      COALESCE((
                        SELECT jsonb_agg(a ORDER BY ord)
                        FROM jsonb_array_elements((SELECT COALESCE(actions, '[]'::jsonb) FROM hh))
                             WITH ORDINALITY AS t(a, ord)
                        WHERE COALESCE(a->>'userId', '') <> 'system'
                      ), '[]'::jsonb),
      'winners',      (SELECT COALESCE(winners, '[]'::jsonb) FROM hh),
      'jackpot',      jsonb_build_object(
                        'payoutId',        p_payout_id,
                        'total',           (SELECT total_amount FROM pay),
                        'badBeatUserId',   (SELECT winner_user_id FROM pay),
                        'handWinnerUserId',(SELECT loser_user_id FROM pay),
                        'recipients',      (SELECT v FROM recips)
                      )
    )
  END;
$function$;

REVOKE ALL ON FUNCTION public.fn_bbj_hand_detail(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_bbj_hand_detail(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_hand_detail(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Post-apply assertions.
-- ─────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_cols int;
BEGIN
  SELECT count(*) INTO v_cols
  FROM information_schema.routines r
  WHERE r.routine_schema = 'public' AND r.routine_name = 'fn_bbj_hand_detail';
  IF v_cols = 0 THEN
    RAISE EXCEPTION 'fn_bbj_hand_detail was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'fn_bbj_recent_hits'
      AND pg_get_function_result(p.oid) LIKE '%bad_beat_player_number%'
  ) THEN
    RAISE EXCEPTION 'fn_bbj_recent_hits did not gain the identity columns';
  END IF;

  IF has_function_privilege('anon', 'public.fn_bbj_hand_detail(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can still execute fn_bbj_hand_detail';
  END IF;
END
$post$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════════
-- DROP FUNCTION IF EXISTS public.fn_bbj_hand_detail(uuid);
-- DROP FUNCTION IF EXISTS public.fn_bbj_recent_hits(uuid, integer);
-- -- then re-create fn_bbj_recent_hits from its pre-2026-08-20 definition, which
-- -- is identical to the body above minus the bad_beat_user_id /
-- -- bad_beat_player_number / bad_beat_avatar_url / small_blind / big_blind
-- -- columns, and with COALESCE(bb.display_name, x.winner_display_name, 'Player').
