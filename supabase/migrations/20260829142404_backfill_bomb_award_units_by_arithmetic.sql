-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829142404; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_backfill_bomb_pot_award_units(
  p_limit integer DEFAULT 1000,
  p_dry_run boolean DEFAULT true
)
RETURNS TABLE (
  hands_considered  bigint,
  hands_written     bigint,
  units_written     bigint,
  hands_skipped     bigint,
  skip_reason       text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_considered bigint := 0;
  v_written    bigint := 0;
  v_units      bigint := 0;
  v_skipped    bigint := 0;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS zz_backfill_units (
    hand_history_id uuid,
    table_id        uuid,
    hand_number     bigint,
    pot_index       integer,
    board           smallint,
    side            text,
    user_id         uuid,
    amount          numeric,
    hand_name       text
  ) ON COMMIT DROP;
  DELETE FROM zz_backfill_units;

  WITH candidates AS (
    SELECT
      h.id, h.table_id, h.hand_number,
      h.winners -> 0 ->> 'userId' AS winner_id,
      h.winners -> 0 -> 'hand' ->> 'name' AS hand_name,
      1
        + (CASE WHEN COALESCE(array_length(h.community_cards2, 1), 0) = 5 THEN 1 ELSE 0 END)
        + (CASE WHEN COALESCE(array_length(h.community_cards3, 1), 0) = 5 THEN 1 ELSE 0 END)
        AS boards,
      COALESCE(
        NULLIF(h.pots, 'null'::jsonb),
        jsonb_build_array(jsonb_build_object('index', 0, 'amount', h.pot_size))
      ) AS pots,
      round(COALESCE(h.pot_size, 0) - COALESCE(h.rake_amount, 0) - COALESCE(h.bbj_amount, 0), 2)
        AS net_winnings,
      COALESCE(h.pot_size, 0) AS gross_pot
    FROM public.hand_history h
    WHERE h.bomb_pot IS NOT NULL
      AND jsonb_array_length(COALESCE(h.winners, '[]'::jsonb)) = 1
      AND h.winners -> 0 ->> 'userId' IS NOT NULL
      AND COALESCE(h.pot_size, 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.bomb_pot_award_units a WHERE a.hand_history_id = h.id
      )
    ORDER BY h.created_at
    LIMIT GREATEST(p_limit, 0)
  ),
  shares AS (
    SELECT
      c.*,
      (p.value ->> 'index')::int AS pot_index,
      b.board_no,
      (
        (round((p.value ->> 'amount')::numeric * 100)::bigint / c.boards)
        + CASE
            WHEN b.board_no <= (round((p.value ->> 'amount')::numeric * 100)::bigint % c.boards)
            THEN 1 ELSE 0
          END
      ) AS share_cents
    FROM candidates c
    CROSS JOIN LATERAL jsonb_array_elements(c.pots) p
    CROSS JOIN LATERAL generate_series(1, c.boards) AS b(board_no)
  ),
  scaled AS (
    SELECT
      s.*,
      round(s.share_cents * (s.net_winnings / NULLIF(s.gross_pot, 0))) AS scaled_cents
    FROM shares s
  ),
  repaired AS (
    SELECT
      sc.*,
      row_number() OVER (
        PARTITION BY sc.id ORDER BY sc.scaled_cents DESC, sc.pot_index, sc.board_no
      ) AS rn,
      round(sc.net_winnings * 100) - SUM(sc.scaled_cents) OVER (PARTITION BY sc.id) AS diff
    FROM scaled sc
  )
  INSERT INTO zz_backfill_units
  SELECT
    r.id, r.table_id, r.hand_number, r.pot_index, r.board_no::smallint,
    'high', r.winner_id::uuid,
    (r.scaled_cents + CASE WHEN r.rn = 1 THEN r.diff ELSE 0 END) / 100.0,
    r.hand_name
  FROM repaired r;

  SELECT count(DISTINCT hand_history_id), count(*)
    INTO v_written, v_units
  FROM zz_backfill_units;
  v_considered := v_written;

  DELETE FROM zz_backfill_units u
  WHERE EXISTS (
    SELECT 1 FROM zz_backfill_units z
    WHERE z.hand_history_id = u.hand_history_id AND z.amount <= 0
  );

  SELECT count(DISTINCT hand_history_id), count(*)
    INTO v_written, v_units
  FROM zz_backfill_units;
  v_skipped := v_considered - v_written;

  IF NOT p_dry_run THEN
    INSERT INTO public.bomb_pot_award_units
      (hand_history_id, table_id, hand_number, pot_index, board, side, user_id, amount, hand_name)
    SELECT hand_history_id, table_id, hand_number, pot_index, board, side, user_id, amount, hand_name
    FROM zz_backfill_units
    ON CONFLICT (hand_history_id, pot_index, board, side, user_id) DO NOTHING;
  END IF;

  hands_considered := v_considered;
  hands_written    := v_written;
  units_written    := v_units;
  hands_skipped    := v_skipped;
  skip_reason      := 'non-positive share after rake scaling';
  RETURN NEXT;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_backfill_bomb_pot_award_units(integer, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_backfill_bomb_pot_award_units(integer, boolean)
  TO service_role;

COMMENT ON FUNCTION public.fn_backfill_bomb_pot_award_units(integer, boolean) IS
  'Reconstructs bomb_pot_award_units for SINGLE-WINNER bomb hands only, from stored pots/boards/rake - arithmetic, never card evaluation. Multi-winner hands are deliberately left missing and visible in fn_bomb_pot_ledger_gaps.';
