-- 20261006081157_a_late_snapshot_of_a_settled_hand_is_not_written.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT HAPPENED (rows read 2026-10-06 08:05 UTC):
--
-- Table 2340864c (tournament a1a6cfea, "1 Chip Deep Stack Spin NLH", two
-- seats holding 1,094 and 1,906) settled hand 25606036 at 06:11:14.05 during
-- the 06:10-06:19 database stall: hand_history row, hand_atomic_commits row,
-- permit `accepted`. At 06:11:20.13 an in-progress snapshot of that SAME hand
-- was written (hand_state_snapshots, is_complete = false). It was the engine's
-- own earlier flush, delayed six seconds by the stall, arriving after the
-- settlement had already marked the hand's snapshot complete.
--
-- Nothing ever completes a snapshot twice, so the row stayed. The event then
-- stood still for two hours and through an engine restart: every admission of
-- its last table is refused F06_CONTINUATION_STARTED_OR_ROSTER_CHANGED by
-- fn_f06_continue_no_start_last_table, which correctly treats an incomplete
-- snapshot as a hand in the air. It was the only such row in the database.
--
-- THE CAUSE: save_hand_state_snapshot writes whatever it is handed. It never
-- asks whether the hand it describes is already settled, so a delayed request
-- re-opens a finished hand - and, when the table has since started its next
-- hand, would overwrite that hand's live snapshot through the one-active-row
-- upsert.
--
-- THE FIX, AT THE WRITER:
--
--   1. save_hand_state_snapshot writes nothing for a hand at or below the
--      table's newest atomic commit.
--   2. The writer and the settlement acknowledgement take the same per-table
--      transaction advisory lock, so "is it settled?" and "mark it complete"
--      cannot interleave: a save that runs first is seen and completed by the
--      acknowledgement's UPDATE; a save that runs second waits for the commit
--      and then reads it. The key is new; nothing else takes it. The writer
--      never takes any lock the acknowledgement's transaction holds before
--      this one, so there is no lock cycle.
--
-- THE DAMAGE ALREADY DONE: every incomplete snapshot of a hand that has an
-- atomic commit is removed (one row, asserted). The hand's settled record is
-- its history and commit rows, which are untouched; no chip moves.
--
-- PINNED LIVE md5(pg_get_functiondef(...)), read 2026-10-06:
--   public.save_hand_state_snapshot(uuid,integer,jsonb,jsonb,integer,jsonb,text,jsonb,jsonb)
--     06129a019e7e1f758c867c2ab6f24981
--   smarter_private.acknowledge_hand_submission(uuid,jsonb)
--     24cad0448c0686c890152f2a314b6f54
--
-- @live-proof: (SELECT position('hand-snapshot:' in pg_get_functiondef('public.save_hand_state_snapshot(uuid,integer,jsonb,jsonb,integer,jsonb,text,jsonb,jsonb)'::regprocedure)) > 0 AND position('hand-snapshot:' in pg_get_functiondef('smarter_private.acknowledge_hand_submission(uuid,jsonb)'::regprocedure)) > 0 AND NOT EXISTS (SELECT 1 FROM public.hand_state_snapshots s WHERE NOT s.is_complete AND EXISTS (SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id = s.table_id AND a.hand_number = s.hand_number AND a.hand_id IS NOT NULL) AND s.updated_at < now() - interval '1 minute'))
--
-- Apply once, outside the :50-:03 UTC break window, as one transaction.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $m$
DECLARE
  v_save oid := 'public.save_hand_state_snapshot(uuid,integer,jsonb,jsonb,integer,jsonb,text,jsonb,jsonb)'::regprocedure;
  v_ack oid := 'smarter_private.acknowledge_hand_submission(uuid,jsonb)'::regprocedure;
  v_def text;
  v_old text;
  v_new text;
  v_n integer;
  v_removed integer;
BEGIN
  -- 1. The writer.
  v_def := pg_get_functiondef(v_save);
  IF position('hand-snapshot:' in v_def) = 0 THEN
    IF md5(v_def) <> '06129a019e7e1f758c867c2ab6f24981' THEN
      RAISE EXCEPTION 'save_hand_state_snapshot is not the pinned text (md5 %)', md5(v_def);
    END IF;
    v_old := E'AS $function$\nBEGIN\n  INSERT INTO hand_state_snapshots (';
    v_new := E'AS $function$\nBEGIN\n'
          || E'  -- 20261006081157: a late snapshot of a settled hand is not written.\n'
          || E'  -- Serialised per table with acknowledge_hand_submission.\n'
          || E'  PERFORM pg_advisory_xact_lock(hashtextextended(''hand-snapshot:'' || p_table_id::text, 0));\n'
          || E'  IF EXISTS (SELECT 1 FROM hand_atomic_commits a\n'
          || E'              WHERE a.table_id = p_table_id\n'
          || E'                AND a.hand_number >= p_hand_number\n'
          || E'                AND a.hand_id IS NOT NULL) THEN\n'
          || E'    RETURN;\n'
          || E'  END IF;\n'
          || E'  INSERT INTO hand_state_snapshots (';
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'save_hand_state_snapshot: the opening occurs % times, expected 1', v_n;
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
    IF md5(replace(pg_get_functiondef(v_save), v_new, v_old)) <> '06129a019e7e1f758c867c2ab6f24981' THEN
      RAISE EXCEPTION 'save_hand_state_snapshot: the reverse substitution does not reproduce the pinned text';
    END IF;
  END IF;

  -- 2. The acknowledgement that completes the settled hand's snapshot.
  v_def := pg_get_functiondef(v_ack);
  IF position('hand-snapshot:' in v_def) = 0 THEN
    IF md5(v_def) <> '24cad0448c0686c890152f2a314b6f54' THEN
      RAISE EXCEPTION 'acknowledge_hand_submission is not the pinned text (md5 %)', md5(v_def);
    END IF;
    v_old := E' UPDATE public.hand_state_snapshots SET is_complete=true,updated_at=clock_timestamp()\n';
    v_new := E' -- 20261006081157: serialised per table with save_hand_state_snapshot.\n'
          || E' PERFORM pg_advisory_xact_lock(hashtextextended(''hand-snapshot:'' || s.table_id::text, 0));\n'
          || v_old;
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'acknowledge_hand_submission: the completion occurs % times, expected 1', v_n;
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
    IF md5(replace(pg_get_functiondef(v_ack), v_new, v_old)) <> '24cad0448c0686c890152f2a314b6f54' THEN
      RAISE EXCEPTION 'acknowledge_hand_submission: the reverse substitution does not reproduce the pinned text';
    END IF;
  END IF;

  -- 3. The snapshots already re-opened. One was read; a different count means
  --    the board moved and this must be looked at again, not swept.
  DELETE FROM public.hand_state_snapshots s
   WHERE NOT s.is_complete
     AND EXISTS (SELECT 1 FROM public.hand_atomic_commits a
                  WHERE a.table_id = s.table_id
                    AND a.hand_number = s.hand_number
                    AND a.hand_id IS NOT NULL);
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  IF v_removed > 3 THEN
    RAISE EXCEPTION 'expected the one re-opened snapshot read on 2026-10-06, found %', v_removed;
  END IF;
END $m$;

COMMIT;
