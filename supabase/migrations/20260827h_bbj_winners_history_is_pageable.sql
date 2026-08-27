-- ============================================================================
--  The jackpot history stops ending at the last handful
-- ============================================================================
--
--  `fn_bbj_recent_hits` hard-caps at `LEAST(p_limit, 25)` and has no cursor, so
--  the 26th jackpot a club ever pays becomes unreachable from the product --
--  not hidden behind a slower path, GONE. The surfaces ask for less again on
--  top of that: the popup asks for 5, the full page for 10. A club that has
--  paid 29 shows ten of them and no indication the other nineteen exist.
--
--  This adds keyset pagination and the one number the UI needs to know whether
--  to offer another page at all.
--
--  WHY A KEYSET AND NOT OFFSET. New jackpots land at the TOP of this list, in
--  realtime, while a player is reading it -- BBJRecentHits subscribes to
--  `bbj_winners` INSERT. An OFFSET page 2 taken after a new hit lands repeats
--  the row that shifted across the boundary. A cursor on the row you last saw
--  cannot: it names a position in the data, not a position in a list that
--  moves.
--
--  THE PAIR (created_at, id), not created_at alone. Two payouts in one pool at
--  the same microsecond is unlikely, not impossible -- and a tie under a
--  `created_at <` cursor SKIPS a jackpot silently, which on a money surface is
--  the one failure mode that must not be possible. `p_before_id` is optional so
--  a caller with only a timestamp still works.
--
--  DROP + CREATE, not CREATE OR REPLACE: the return type gains `total_hits`,
--  and a replace cannot change it. Both statements are in this one transaction,
--  so there is no window where the function does not exist.
-- ============================================================================

DROP FUNCTION IF EXISTS public.fn_bbj_recent_hits(uuid, integer);

-- The signature is spelled exactly as pg_get_functiondef prints it back
-- (`timestamp with time zone`, `NULL::uuid`) so that
-- scripts/ci/check-bbj-functions-match-production.mjs can compare the repo
-- against production byte for byte. That check exists because the two payout
-- functions once lived ONLY in production; a signature that merely means the
-- same thing would make it report a drift that is not there, and a check that
-- cries wolf is a check nobody reads.
CREATE OR REPLACE FUNCTION public.fn_bbj_recent_hits(p_pool_id uuid, p_limit integer DEFAULT 5, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(payout_id uuid, awarded_at timestamp with time zone, hand_number bigint, total_payout numeric, bad_beat_user_id uuid, bad_beat_player_number text, bad_beat_avatar_url text, bad_beat_name text, bad_beat_hand text, bad_beat_amount numeric, bad_beat_cards jsonb, hand_winner_name text, hand_winner_hand text, hand_winner_amount numeric, hand_winner_cards jsonb, board jsonb, game_variant text, small_blind numeric, big_blind numeric, table_player_count integer, recipients jsonb, total_hits integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH pool_total AS (
    SELECT count(*)::int AS n FROM public.bbj_payouts p WHERE p.pool_id = p_pool_id
  ),
  top_payouts AS (
    SELECT p.* FROM public.bbj_payouts p
    WHERE p.pool_id = p_pool_id
      AND (
        p_before IS NULL
        OR (p_before_id IS NULL AND p.created_at < p_before)
        OR (p_before_id IS NOT NULL AND (p.created_at, p.id) < (p_before, p_before_id))
      )
    ORDER BY p.created_at DESC, p.id DESC
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
    ), '[]'::jsonb),
    (SELECT n FROM pool_total)
  FROM hits x
  LEFT JOIN public.profiles bb ON bb.id = x.winner_user_id
  LEFT JOIN public.profiles hw ON hw.id = x.loser_user_id
  ORDER BY x.created_at DESC, x.id DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_bbj_recent_hits(uuid, integer, timestamptz, uuid) TO anon, authenticated, service_role;

DO $$
DECLARE
  v_pool uuid;
  v_first record;
  v_page2 integer;
  v_overloads integer;
BEGIN
  -- Exactly one signature must exist. Two would make every PostgREST call that
  -- passes only p_pool_id/p_limit ambiguous (HTTP 300) and take the feature
  -- down for the already-deployed client.
  SELECT count(*) INTO v_overloads
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_recent_hits';
  IF v_overloads <> 1 THEN
    RAISE EXCEPTION 'fn_bbj_recent_hits has % signatures, expected exactly 1', v_overloads;
  END IF;

  SELECT pool_id INTO v_pool
    FROM public.bbj_payouts GROUP BY pool_id ORDER BY count(*) DESC LIMIT 1;

  IF v_pool IS NOT NULL THEN
    -- Page 1 still works with the old two-argument call shape.
    SELECT payout_id, awarded_at, total_hits INTO v_first
      FROM public.fn_bbj_recent_hits(v_pool, 1);
    IF v_first.payout_id IS NULL THEN
      RAISE EXCEPTION 'page 1 returned nothing for a pool with payouts';
    END IF;

    -- Page 2 must not repeat page 1.
    SELECT count(*) INTO v_page2
      FROM public.fn_bbj_recent_hits(v_pool, 25, v_first.awarded_at, v_first.payout_id) h
     WHERE h.payout_id = v_first.payout_id;
    IF v_page2 <> 0 THEN
      RAISE EXCEPTION 'the cursor repeated the row it was given';
    END IF;

    RAISE NOTICE 'pool % has % jackpots, pageable', v_pool, v_first.total_hits;
  END IF;
END $$;
