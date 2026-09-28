-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260818235043 as "bbj_recent_hits_with_real_cards"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- BBJ RECENT HITS — now with the actual cards (2026-08-18)
-- Dan: show the real Club Arena cards, not just hand names.
--
-- Board and hole cards live in hand_history. bbj_payouts.hand_id is NULL on
-- every row, so we reach the hand the way bbj_winners is joined:
-- (table_id, hand_number). Verified: that join resolves for every recent hit.
--
-- Shapes in hand_history (board is JSONB, not text[]):
--   board       jsonb  ["6diamonds","Ahearts","Jclubs"]
--   hole_cards  jsonb  { "<user_id>": [{"rank":"K","suit":"hearts"}, ...] }
-- Normalised here to [{rank,suit}] so the client hands them straight to
-- <CardImage>, which already accepts full suit names.
--
-- Hole-card coverage is PARTIAL in history (often only one player's cards were
-- stored), so either side may come back null and the UI must cope.
--
-- Return type changes, so DROP + CREATE must be one migration.

DROP FUNCTION IF EXISTS public.fn_bbj_recent_hits(uuid, integer);

CREATE FUNCTION public.fn_bbj_recent_hits(
  p_pool_id uuid,
  p_limit integer DEFAULT 5
)
RETURNS TABLE (
  payout_id uuid,
  awarded_at timestamptz,
  hand_number bigint,
  total_payout numeric,
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
  table_player_count integer,
  recipients jsonb
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  WITH hits AS (
    SELECT p.*, w.winner_hand, w.loser_hand,
           w.winner_display_name, w.loser_display_name,
           h.board AS raw_board, h.hole_cards, h.game_variant
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
    COALESCE(bb.display_name, x.winner_display_name, 'Player'),
    x.winner_hand,
    (SELECT r.amount FROM public.bbj_payout_recipients r
      WHERE r.payout_id = x.id AND r.user_id = x.winner_user_id),
    x.hole_cards -> (x.winner_user_id::text),
    COALESCE(hw.display_name, x.loser_display_name, 'Player'),
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
$$;

REVOKE ALL ON FUNCTION public.fn_bbj_recent_hits(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_recent_hits(uuid, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_bbj_recent_hits(uuid, integer) IS
  'Last N jackpot hits with per-recipient breakdown AND the real cards (board + both hole hands from hand_history). Roles derived from which uid received which share, never from the crossed winner/loser column names.';
