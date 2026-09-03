-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826020146; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Drop the existing function so we can change its return signature
DROP FUNCTION IF EXISTS public.fn_bbj_recent_hits(uuid, integer);

CREATE OR REPLACE FUNCTION public.fn_bbj_recent_hits(
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
  hand_winner_name text,
  hand_winner_hand text,
  hand_winner_amount numeric,
  table_player_count integer,
  recipients jsonb,
  table_id uuid,
  table_name text,
  game_variant text,
  big_blind numeric
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    p.id,
    p.created_at,
    p.hand_number,
    p.total_amount,
    COALESCE(bb.display_name, w.winner_display_name, 'Player'),
    w.winner_hand,
    (SELECT r.amount FROM public.bbj_payout_recipients r
      WHERE r.payout_id = p.id AND r.user_id = p.winner_user_id),
    COALESCE(hw.display_name, w.loser_display_name, 'Player'),
    w.loser_hand,
    (SELECT r.amount FROM public.bbj_payout_recipients r
      WHERE r.payout_id = p.id AND r.user_id = p.loser_user_id),
    p.table_player_count,
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'name', COALESCE(pr.display_name, pr.username, 'Player'),
                 'amount', r.amount,
                 'role', CASE
                           WHEN r.user_id = p.winner_user_id THEN 'bad_beat'
                           WHEN r.user_id = p.loser_user_id  THEN 'hand_winner'
                           ELSE 'table'
                         END
               )
               ORDER BY r.amount DESC
             )
      FROM public.bbj_payout_recipients r
      LEFT JOIN public.profiles pr ON pr.id = r.user_id
      WHERE r.payout_id = p.id
    ), '[]'::jsonb),
    p.table_id,
    t.name AS table_name,
    t.game_variant,
    t.big_blind
  FROM public.bbj_payouts p
  LEFT JOIN public.bbj_winners w
         ON w.table_id = p.table_id AND w.hand_number = p.hand_number
  LEFT JOIN public.profiles bb ON bb.id = p.winner_user_id
  LEFT JOIN public.profiles hw ON hw.id = p.loser_user_id
  LEFT JOIN public.tables t ON t.id = p.table_id
  WHERE p.pool_id = p_pool_id
  ORDER BY p.created_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 25));
$$;

REVOKE ALL ON FUNCTION public.fn_bbj_recent_hits(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_recent_hits(uuid, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_bbj_recent_hits(uuid, integer) IS
  'Last N jackpot hits for a pool with per-recipient breakdown and table metadata.';
