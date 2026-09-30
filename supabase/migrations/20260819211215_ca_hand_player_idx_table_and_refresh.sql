-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819211215 "ca_hand_player_idx_table_and_refresh"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4ff7af9c89282c28ee114b6d02cfa2c9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Player -> hand lookup index for the Club Arena stats RPC.
--
-- WHY: hand_history.players is JSONB, so "this user's most recent N hands"
-- can only be answered by a GIN containment scan that materialises EVERY hand
-- the user appears in before ORDER BY / LIMIT can apply. Measured on prod:
-- 71,238 matching rows, 35,807 heap blocks, ~12s — past the 8s statement_timeout
-- on the `authenticated` role, so active players' stats calls were cancelled.
--
-- This table gives a (user_id, created_at DESC) btree so the top-N lookup is an
-- index range scan and the RPC only heap-fetches the N hands it actually needs.
--
-- Kept fresh WITHOUT a trigger on hand_history: the poker engine's write path is
-- not touched. ca_refresh_hand_player_index() indexes everything newer than the
-- watermark; the RPC unions the indexed range with a small live window for
-- anything not yet indexed, so results are always complete even if the refresh
-- is behind (it just gets slower, it never gets wrong).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.ca_refresh_hand_player_index(int);
--   DROP TABLE IF EXISTS public.ca_hand_player_idx;
--   DROP TABLE IF EXISTS public.ca_hand_player_idx_state;

CREATE TABLE IF NOT EXISTS public.ca_hand_player_idx (
  user_id    uuid        NOT NULL,
  created_at timestamptz NOT NULL,
  hand_id    uuid        NOT NULL,
  PRIMARY KEY (user_id, hand_id)
);

CREATE INDEX IF NOT EXISTS idx_ca_hand_player_idx_user_time
  ON public.ca_hand_player_idx (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ca_hand_player_idx_state (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),
  watermark     timestamptz NOT NULL,
  rows_indexed  bigint      NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.ca_hand_player_idx_state (id, watermark)
SELECT true, coalesce((SELECT min(created_at) FROM public.hand_history) - interval '1 second',
                      now() - interval '10 years')
WHERE NOT EXISTS (SELECT 1 FROM public.ca_hand_player_idx_state);

ALTER TABLE public.ca_hand_player_idx        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_hand_player_idx_state  ENABLE ROW LEVEL SECURITY;
-- No policies: only SECURITY DEFINER functions (and service_role) touch these.

CREATE OR REPLACE FUNCTION public.ca_refresh_hand_player_index(p_max_hands int DEFAULT 50000)
RETURNS TABLE (hands_indexed int, rows_added int, new_watermark timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10min'
AS $fn$
DECLARE
  wm       timestamptz;
  batch_hi timestamptz;
  n_hands  int := 0;
  n_rows   int := 0;
BEGIN
  SELECT watermark INTO wm FROM ca_hand_player_idx_state WHERE id;
  IF wm IS NULL THEN
    wm := now() - interval '10 years';
  END IF;

  SELECT max(created_at) INTO batch_hi
  FROM (SELECT created_at FROM hand_history
        WHERE created_at > wm ORDER BY created_at ASC LIMIT p_max_hands) q;

  IF batch_hi IS NULL THEN
    RETURN QUERY SELECT 0, 0, wm;
    RETURN;
  END IF;

  WITH src AS (
    SELECT h.id, h.created_at, h.players
    FROM hand_history h
    WHERE h.created_at > wm AND h.created_at <= batch_hi
  ),
  expanded AS (
    SELECT DISTINCT ((pl->>'userId')::uuid) AS user_id, s.created_at, s.id AS hand_id
    FROM src s, jsonb_array_elements(s.players) pl
    WHERE pl->>'userId' ~ '^[0-9a-fA-F-]{36}$'
  ),
  ins AS (
    INSERT INTO ca_hand_player_idx (user_id, created_at, hand_id)
    SELECT user_id, created_at, hand_id FROM expanded
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM src)::int, (SELECT count(*) FROM ins)::int
  INTO n_hands, n_rows;

  UPDATE ca_hand_player_idx_state
  SET watermark = batch_hi,
      rows_indexed = rows_indexed + n_rows,
      updated_at = now()
  WHERE id;

  RETURN QUERY SELECT n_hands, n_rows, batch_hi;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_refresh_hand_player_index(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_refresh_hand_player_index(int) FROM anon;
GRANT EXECUTE ON FUNCTION public.ca_refresh_hand_player_index(int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ca_refresh_hand_player_index(int) TO service_role;
