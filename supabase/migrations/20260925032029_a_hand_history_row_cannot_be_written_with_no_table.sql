-- 20260925032029_a_hand_history_row_cannot_be_written_with_no_table.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ROOT CAUSE (Production Alerts Fleet, board issue #5070, incident
-- cash-pot-conservation-no-winner-recorded-null-table - the table_id half).
--
-- Four hand_history rows (2026-09-11, 09-19, 09-23, 09-24) have table_id
-- NULL, players = [], winners = [], tournament_id NULL, and an identical
-- pot_size of 600.00 with rake_amount 0.00. Every reachable write path was
-- read end to end this run and every one of them refuses a missing or NULL
-- table_id before any INSERT:
--
--   * fn_ca_commit_hand_settlement (12-arg door) and its exact-generation
--     core fn_ca_commit_hand_settlement_exact_before_obligations both resolve
--     `p_table_id` against `public.tables` (`WHERE t.id = p_table_id`) and
--     return 'table_not_found' when it does not match a real row - which a
--     NULL p_table_id never does.
--   * The nine-argument core, fn_ca_commit_hand_settlement_before_lease_generation,
--     independently refuses when `p_table_id IS NULL` or when
--     `coalesce(p_hand_row->>'table_id','') <> p_table_id::text` - so even a
--     p_hand_row that is missing the table_id KEY (which is what a JSON
--     payload with an undefined field serializes to) cannot slip through:
--     the coalesced empty string never equals a valid table_id.
--   * The protocol-2 retained-submission path (fn_ca_retain_hand_submission /
--     fn_ca_commit_hand_submission) re-enters the exact same
--     fn_ca_commit_hand_settlement door with the retained request, so it
--     inherits every one of the guards above.
--
-- That leaves exactly one function that ever performs the literal INSERT:
-- fn_ca_insert_hand_with_awards. `information_schema.routine_privileges`
-- shows its EXECUTE grant is held ONLY by `postgres` - not `service_role`,
-- not `authenticated` - so PostgREST/the engine's API key can never call it
-- directly; it is reachable only (a) from another SECURITY DEFINER function
-- in the guarded chain above, or (b) from a session logged in AS `postgres`
-- (the Supabase SQL editor, the CLI, psql, or the MCP `execute_sql` tool)
-- calling it BY NAME. Column list is a jsonb `p_row ? column_name` (see the
-- header of 20260906113554_the_atomic_hand_insert_lets_the_defaults_apply_and_proves_it.sql):
-- omit a key and it never enters the INSERT column list and takes the
-- column's bare default (NULL for table_id), and this function does not
-- itself require table_id to be present. Its bomb-pot guard test
-- (20260906143315_the_bomb_guard_is_attached_now_the_engine_can_satisfy_it.sql)
-- legitimately calls it this exact way, by name, with a synthetic table_id,
-- to prove the constraint trigger without going near the settlement RPCs.
--
-- Proof this is what happened, not merely what could: every genuine hand
-- gets an unconditional `hand_atomic_commits` row from the SAME transaction
-- inside fn_ca_commit_hand_settlement_before_lease_generation, right after
-- the fn_ca_insert_hand_with_awards call it makes. Checked today: all four
-- affected ids have ZERO hand_atomic_commits rows, ZERO bomb_pot_award_units,
-- ZERO hand_projection_outbox rows, ZERO rake_records or rake_attributions.
-- No path that produces a real settled hand can produce that combination.
-- These four rows were written by a direct, unguarded call to
-- fn_ca_insert_hand_with_awards - almost certainly an earlier investigation's
-- own probe of this exact function, run as a bare RPC call rather than the
-- rolled-back DO block CLAUDE.md 11.5 requires for a function that writes to
-- a production table, which is why it committed instead of rolling back.
--
-- THE FIX: fn_ca_insert_hand_with_awards now refuses, by itself, a payload
-- that does not name a real table_id - independent of every caller above it,
-- so a future direct call (a probe included) cannot repeat this. It still
-- accepts a syntactically valid table_id that does not reference an existing
-- row (the bomb-guard test's synthetic '00000000-...-aa' table_id), because
-- that is a deliberate, already-relied-upon testing pattern and this function
-- has never validated table_id against `public.tables` - only the settlement
-- doors above it do that, for the real path.
--
-- THE FOUR ORPHAN ROWS are deleted in the same migration. They are not
-- settled financial records: zero players, zero rake, zero linked ledger,
-- outbox or attribution row of any kind - nothing paid, nothing to reconcile,
-- nobody to make whole. Leaving them in place only keeps re-triggering the
-- CashPotConservation detector that correctly found them.
--
-- CI HARDENING (2026-09-25, second commit): check-definer-authorization.mjs
-- judges only this branch's migration text, never the live catalog, so a
-- CREATE OR REPLACE that states no grant reads as the Postgres default
-- (EXECUTE held by PUBLIC) even though production's actual grant already
-- restricts this function to `postgres` alone. Declaring that restriction
-- explicitly - rather than relying on a grant this file never states - is
-- the check's own preferred remedy (nobody in a browser should call this;
-- it is reachable only from inside the guarded settlement chain or from a
-- postgres-authenticated session by name) and costs nothing live, since it
-- only repeats the access this function already has today.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_insert_hand_with_awards(p_row jsonb, p_units jsonb DEFAULT '[]'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id   uuid;
  v_cols text;
BEGIN
  -- A HAND HISTORY ROW IS NEVER WRITTEN WITH NO TABLE (2026-09-25). Every
  -- settlement door above this function already refuses a missing or NULL
  -- table_id before it gets here; this is the same refusal held by the one
  -- function capable of writing the row directly, so a future out-of-band
  -- call (this function's own bomb-guard test included) cannot silently
  -- default the column to NULL by omitting the key.
  IF NOT (p_row ? 'table_id') OR NULLIF(p_row->>'table_id', '') IS NULL THEN
    RAISE EXCEPTION
      'fn_ca_insert_hand_with_awards: p_row names no table_id - refusing to insert a hand with no table'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

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
END $function$;

COMMENT ON FUNCTION public.fn_ca_insert_hand_with_awards(jsonb, jsonb) IS
  'HARDENED 2026-09-25: refuses any p_row with no table_id (missing key or '
  'NULL/empty value) before it names a column list, independent of every '
  'settlement door above it. See board issue #5070, incident '
  'cash-pot-conservation-no-winner-recorded-null-table. A syntactically '
  'valid but non-existent table_id (the bomb-guard test fixture) is still '
  'accepted - this function has never validated table_id against '
  'public.tables, only the settlement RPCs above it do that for the real '
  'path.';

-- Declared, not merely inherited: this function is reachable only from
-- inside the guarded settlement chain (which calls it as the same SECURITY
-- DEFINER context) or from a session logged in as `postgres` by name (the
-- bomb-guard test's own probe pattern). No browser role - PUBLIC, anon or
-- authenticated - has ever needed EXECUTE here, and this repeats that
-- restriction explicitly rather than leaving it to a grant this migration
-- never states.
REVOKE ALL ON FUNCTION public.fn_ca_insert_hand_with_awards(jsonb, jsonb) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- PROVE IT, against the real function, then roll every probe back.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_id      uuid;
  v_state   text;
  v_msg     text;
  v_table   uuid := '00000000-0000-0000-0000-0000000000aa';
  v_refused_missing_key boolean := false;
  v_refused_null_value  boolean := false;
  v_still_accepted      boolean := false;
BEGIN
  -- 1. A payload that never names table_id at all must be refused.
  BEGIN
    v_id := public.fn_ca_insert_hand_with_awards(
      jsonb_build_object(
        'hand_number', -1,
        'pot_size',    600,
        'rake_amount', 0,
        'players',     '[]'::jsonb,
        'winners',     '[]'::jsonb,
        'actions',     '[]'::jsonb),
      '[]'::jsonb);
    RAISE EXCEPTION 'VERIFY FAILED: a hand with no table_id key committed (id %)', v_id;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_state = '23000' AND v_msg LIKE '%names no table_id%' THEN
      v_refused_missing_key := true;
    ELSE
      RAISE EXCEPTION 'VERIFY FAILED: expected the guard (23000) to refuse a missing key, got % %', v_state, v_msg;
    END IF;
  END;

  -- 2. A payload with an explicit NULL table_id must be refused the same way.
  BEGIN
    v_id := public.fn_ca_insert_hand_with_awards(
      jsonb_build_object(
        'table_id',    NULL,
        'hand_number', -1,
        'pot_size',    600,
        'rake_amount', 0,
        'players',     '[]'::jsonb,
        'winners',     '[]'::jsonb,
        'actions',     '[]'::jsonb),
      '[]'::jsonb);
    RAISE EXCEPTION 'VERIFY FAILED: a hand with an explicit NULL table_id committed (id %)', v_id;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_state = '23000' AND v_msg LIKE '%names no table_id%' THEN
      v_refused_null_value := true;
    ELSE
      RAISE EXCEPTION 'VERIFY FAILED: expected the guard (23000) to refuse a NULL value, got % %', v_state, v_msg;
    END IF;
  END;

  -- 3. The bomb-guard test's own pattern - a syntactically valid table_id
  --    that names no real table - must still be ACCEPTED. This function has
  --    never checked table_id against public.tables, and must keep not doing
  --    so: that is the settlement doors' job, and the bomb-guard migration's
  --    own probes depend on this exact shape working.
  BEGIN
    v_id := public.fn_ca_insert_hand_with_awards(
      jsonb_build_object(
        'table_id',    v_table,
        'hand_number', -1,
        'pot_size',    600,
        'rake_amount', 0,
        'players',     '[]'::jsonb,
        'winners',     '[]'::jsonb,
        'actions',     '[]'::jsonb),
      '[]'::jsonb);
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED: the insert returned no id';
    END IF;
    v_still_accepted := true;
    RAISE EXCEPTION 'ca_verify_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ca_verify_rollback' THEN
      RAISE EXCEPTION 'VERIFY FAILED: a hand with a syntactically valid table_id was refused: % %', SQLSTATE, SQLERRM;
    END IF;
  END;

  IF NOT (v_refused_missing_key AND v_refused_null_value AND v_still_accepted) THEN
    RAISE EXCEPTION 'VERIFY FAILED: probes did not all run to completion (% % %)',
      v_refused_missing_key, v_refused_null_value, v_still_accepted;
  END IF;

  IF EXISTS (SELECT 1 FROM public.hand_history WHERE hand_number = -1) THEN
    RAISE EXCEPTION 'VERIFY FAILED: a probe row survived its rollback';
  END IF;

  RAISE NOTICE 'HAND_HISTORY_TABLE_ID_GUARD_PROVED refuses a missing key, refuses an explicit NULL, still accepts a syntactically valid table_id, probes rolled back';
END $verify$;

-- ---------------------------------------------------------------------------
-- SETTLE THE DAMAGE ALREADY DONE. Four orphan rows, proven above this
-- migration's header to have zero players, zero rake, and zero linkage to
-- any settlement receipt, award unit, projection outbox row, or rake record
-- - nothing paid, nothing to reconcile, nobody to make whole. Named by id so
-- this cannot touch any row this investigation did not already identify.
-- ---------------------------------------------------------------------------
DO $cleanup$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.hand_history
   WHERE id IN (
     'db62bc9f-5bca-4956-a0e9-02d0cab88d04',
     'aac82004-2253-4455-ab2b-a6f17329215a',
     '8c64fa89-a3ec-424e-be62-1dcc3c9979af',
     'f8fe7f26-27c0-454f-ae33-30f58590fbf0'
   )
   AND table_id IS NULL
   AND players = '[]'::jsonb
   AND winners = '[]'::jsonb
   AND NOT EXISTS (SELECT 1 FROM public.hand_atomic_commits c WHERE c.hand_id = hand_history.id)
   AND NOT EXISTS (SELECT 1 FROM public.bomb_pot_award_units u WHERE u.hand_history_id = hand_history.id)
   AND NOT EXISTS (SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id = hand_history.id)
   AND NOT EXISTS (SELECT 1 FROM public.rake_records r WHERE r.hand_id = hand_history.id)
   AND NOT EXISTS (SELECT 1 FROM public.rake_attributions r WHERE r.hand_id = hand_history.id);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> 4 THEN
    RAISE EXCEPTION
      'expected to delete exactly 4 verified-orphan rows, deleted % - aborting rather than guess',
      v_deleted;
  END IF;
  RAISE NOTICE 'ORPHAN_NULL_TABLE_ID_HANDS_REMOVED deleted % rows with zero players, zero rake, zero settlement linkage', v_deleted;
END $cleanup$;

COMMIT;
