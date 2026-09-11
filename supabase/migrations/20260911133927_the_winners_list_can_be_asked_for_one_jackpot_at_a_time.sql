-- 20260911133927_the_winners_list_can_be_asked_for_one_jackpot_at_a_time.sql
--
-- Version 20260911133927 is the one production recorded when this was applied (the
-- reserved 20260911133811 was renamed to match it, so the file and the record agree).
--
-- WHAT THIS CHANGES, AND WHY (BBJ programme phase 2 of 5). Dan, 2026-09-11,
-- with the popup in front of him: "INSIDE THE BBJ POP UP, YOU NEED TO SEPERATE
-- BBJ WINERS, AND MINI BBJ WINNERS. THERE SHOULD BE A CLICKABLE TAB FOR THE
-- MINI (SHOULDN'T BE A MAIN FEATURE)."
--
-- fn_bbj_recent_hits returned every payout of either kind in one list, so the
-- "Bad Beat Jackpot Winners (5 Of 13)" caption counted minis and the list the
-- caption named was mostly minis - thirteen minis to six mains on the union
-- pool in thirty days. The list gains `p_kind`: NULL keeps today's mixed list
-- for any caller that does not ask, 'main' and 'mini' return one jackpot each,
-- and `total_hits` counts what the list counts.
--
-- Adding a defaulted parameter is a new signature, and two overloads of one
-- name make PostgREST refuse a call that fits both. So the four-argument form
-- is dropped and the five-argument form replaces it in the same transaction;
-- every existing caller names its arguments and resolves to the new one.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL search_path TO public, pg_temp;

DROP FUNCTION IF EXISTS public.fn_bbj_recent_hits(uuid, integer, timestamptz, uuid);

CREATE FUNCTION public.fn_bbj_recent_hits(
  p_pool_id uuid,
  p_limit integer DEFAULT 5,
  p_before timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_kind text DEFAULT NULL
)
RETURNS TABLE(
  payout_id uuid, awarded_at timestamptz, hand_number bigint, total_payout numeric,
  bad_beat_user_id uuid, bad_beat_player_number text, bad_beat_avatar_url text,
  bad_beat_name text, bad_beat_hand text, bad_beat_amount numeric, bad_beat_cards jsonb,
  hand_winner_name text, hand_winner_hand text, hand_winner_amount numeric,
  hand_winner_cards jsonb, board jsonb, game_variant text, small_blind numeric,
  big_blind numeric, table_player_count integer, recipients jsonb, total_hits integer,
  kind text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH pool_total AS (
    SELECT count(*)::int AS n FROM public.bbj_payouts p
     WHERE p.pool_id = p_pool_id
       AND (p_kind IS NULL OR COALESCE(p.kind, 'main') = p_kind)
  ),
  top_payouts AS (
    SELECT p.* FROM public.bbj_payouts p
    WHERE p.pool_id = p_pool_id
      AND (p_kind IS NULL OR COALESCE(p.kind, 'main') = p_kind)
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
    COALESCE(public.fn_arena_name(bb.alias, bb.username, bb.display_name, bb.first_name, bb.last_name, bb.full_name), x.winner_display_name, 'Player'),
    x.winner_hand,
    (SELECT r.amount FROM public.bbj_payout_recipients r
      WHERE r.payout_id = x.id AND r.user_id = x.winner_user_id),
    x.hole_cards -> (x.winner_user_id::text),
    COALESCE(public.fn_arena_name(hw.alias, hw.username, hw.display_name, hw.first_name, hw.last_name, hw.full_name), x.loser_display_name, 'Player'),
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
                 'name', COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), pr.username, 'Player'),
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
    (SELECT n FROM pool_total),
    COALESCE(x.kind, 'main')
  FROM hits x
  LEFT JOIN public.profiles bb ON bb.id = x.winner_user_id
  LEFT JOIN public.profiles hw ON hw.id = x.loser_user_id
  ORDER BY x.created_at DESC, x.id DESC;
$function$;

REVOKE ALL ON FUNCTION public.fn_bbj_recent_hits(uuid, integer, timestamptz, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_recent_hits(uuid, integer, timestamptz, uuid, text) TO authenticated, service_role;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_recent_hits') <> 1 THEN
    RAISE EXCEPTION 'fn_bbj_recent_hits must have exactly one signature - two overloads make PostgREST refuse the call';
  END IF;
  IF pg_get_function_identity_arguments('public.fn_bbj_recent_hits(uuid, integer, timestamptz, uuid, text)'::regprocedure)
     NOT LIKE '%p_kind text%' THEN
    RAISE EXCEPTION 'fn_bbj_recent_hits did not gain p_kind';
  END IF;
END $$;

COMMIT;
