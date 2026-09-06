-- THE ATOMIC HAND INSERT LETS THE DEFAULTS APPLY, AND PROVES IT.
--
-- Found in the pre-Phase-2 deep dive, before the engine that calls it shipped.
--
-- 20260906100735 wrote fn_ca_insert_hand_with_awards as:
--
--   INSERT INTO public.hand_history
--   SELECT * FROM jsonb_populate_record(null::public.hand_history, p_row)
--
-- jsonb_populate_record over a NULL base fills every column the jsonb does not
-- mention with NULL, and an explicit NULL in an INSERT **overrides the column
-- default**. hand_history.id is `uuid NOT NULL DEFAULT gen_random_uuid()`, so
-- the very first thing that happens is
--
--   23502  null value in column "id" of relation "hand_history"
--          violates not-null constraint
--
-- measured against production in a self-aborting probe. bbj_amount and reported
-- are NOT NULL too, and created_at, started_at, game_variant, source, version,
-- players and actions would all have been written as NULL instead of their
-- defaults.
--
-- SO THE FUNCTION FAILED ON EVERY CALL. It had no caller yet - the engine
-- change is still in PR #3272 - and this is the only reason it cost nothing.
-- Had it deployed, every bomb-pot hand would have failed its history insert,
-- failed again in the background retry queue, and lost the whole hand record
-- rather than just the award breakdown. I would have made the defect I was
-- fixing considerably worse.
--
-- THE FIX: name only the columns the caller actually supplied, so every other
-- column takes its default. The column list is built from information_schema
-- and quote_ident'ed, so a key that is not a real column cannot reach the SQL.
--
-- AND THE REASON IT GOT THIS FAR: the law test I wrote for this pins SOURCE
-- TEXT - that the engine calls the RPC, that the units are built from
-- perPotAwards. Every one of those assertions was true while the function was
-- incapable of inserting a row. A test that reads code cannot tell you the code
-- works. So this migration ends by CALLING the function against the real table,
-- checking the row and the units it wrote, and rolling that back inside a
-- subtransaction - and it aborts the whole migration if the function cannot do
-- its job.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_insert_hand_with_awards(
  p_row jsonb,
  p_units jsonb DEFAULT '[]'::jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_id   uuid;
  v_cols text;
BEGIN
  /* Only the columns the caller named. Anything absent keeps its DEFAULT,
     which is the entire point - see the header. */
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
    INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND c.table_name   = 'hand_history'
     AND p_row ? c.column_name;

  IF v_cols IS NULL THEN
    RAISE EXCEPTION
      'fn_ca_insert_hand_with_awards: p_row names no hand_history column - refusing to insert a row of pure defaults';
  END IF;

  EXECUTE format(
    'INSERT INTO public.hand_history (%1$s) '
    'SELECT %1$s FROM jsonb_populate_record(null::public.hand_history, $1) '
    'RETURNING id', v_cols)
    USING p_row
     INTO v_id;

  IF jsonb_array_length(COALESCE(p_units, '[]'::jsonb)) > 0 THEN
    INSERT INTO public.bomb_pot_award_units
      (hand_history_id, table_id, hand_number, pot_index, board, side, user_id, amount, hand_name)
    SELECT v_id,
           (u->>'table_id')::uuid,
           (u->>'hand_number')::bigint,
           (u->>'pot_index')::int,
           COALESCE((u->>'board')::int, 1),
           COALESCE(u->>'side', 'high'),
           (u->>'user_id')::uuid,
           (u->>'amount')::numeric,
           NULLIF(u->>'hand_name', '')
      FROM jsonb_array_elements(p_units) u
    ON CONFLICT (hand_history_id, pot_index, board, side, user_id) DO NOTHING;
  END IF;

  RETURN v_id;
END $fn$;

REVOKE ALL ON FUNCTION public.fn_ca_insert_hand_with_awards(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_insert_hand_with_awards(jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- PROVE IT, against the real table, then put it back.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_id      uuid;
  v_units   int;
  v_created timestamptz;
  v_bbj     numeric;
  v_done    boolean := false;
  v_table   uuid := '00000000-0000-0000-0000-0000000000aa';
  v_user    uuid := '00000000-0000-0000-0000-0000000000bb';
BEGIN
  BEGIN
    v_id := public.fn_ca_insert_hand_with_awards(
      jsonb_build_object(
        'table_id',    v_table,
        'hand_number', -1,                 -- negative: cannot collide with a real hand
        'pot_size',    10,
        'rake_amount', 0,
        'bbj_amount',  0,
        'bomb_pot',    jsonb_build_object('board_count', 1),
        'players',     '[]'::jsonb,
        'actions',     '[]'::jsonb
      ),
      jsonb_build_array(jsonb_build_object(
        'table_id', v_table, 'hand_number', -1, 'pot_index', 0,
        'board', 1, 'side', 'high', 'user_id', v_user, 'amount', 10))
    );

    IF v_id IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED: the function returned no id';
    END IF;

    SELECT created_at, bbj_amount INTO v_created, v_bbj
      FROM public.hand_history WHERE id = v_id;
    IF v_created IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED: created_at is NULL - the defaults are still being overridden';
    END IF;
    IF v_bbj IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED: bbj_amount is NULL on a NOT NULL column';
    END IF;

    SELECT count(*) INTO v_units
      FROM public.bomb_pot_award_units WHERE hand_history_id = v_id;
    IF v_units <> 1 THEN
      RAISE EXCEPTION 'VERIFY FAILED: expected 1 award unit written with the row, found %', v_units;
    END IF;

    v_done := true;
    RAISE EXCEPTION 'ca_verify_rollback';   -- undo the probe
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ca_verify_rollback' THEN
      RAISE;                                -- a real failure aborts the migration
    END IF;
  END;

  IF NOT v_done THEN
    RAISE EXCEPTION 'VERIFY FAILED: the probe did not run to completion';
  END IF;

  IF EXISTS (SELECT 1 FROM public.hand_history WHERE hand_number = -1) THEN
    RAISE EXCEPTION 'VERIFY FAILED: the probe row survived its rollback';
  END IF;

  RAISE NOTICE 'ATOMIC_HAND_INSERT_VERIFIED row+units written together, defaults applied, probe rolled back';
END $verify$;

COMMIT;
