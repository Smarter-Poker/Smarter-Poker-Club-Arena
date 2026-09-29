-- 20260922141704_a_running_field_is_counted_by_the_bust_that_shrinks_it
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-22 14:17:04 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- CLAUDE.md 10.12: this file removes compensation. It adds none, schedules
-- nothing and retries nothing.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- public.tournaments.current_players is a cached count of the field. Its
-- writers were split by status, and one status had no writer at all:
--
--   before the start     trg_sync_tournament_current_players, the roster
--                        count, deliberately pre-start only (20260823120000)
--   seat-first formats   trg_seat_change_syncs_seat_first_count, live seats
--                        on the primary table, every status
--   a RUNNING field      NOBODY. A bust moves a row from 'playing' to
--                        'eliminated' and the count stays where it was.
--
-- That gap was closed from outside, by the pg_cron job
-- reconcile-tournament-denormals, which runs
-- fn_reconcile_tournament_denormals() every minute, 1,440 times a day, and
-- rewrites current_players for every live event. So for up to a minute after
-- every bust the count was wrong, and the registration door refuses a late
-- entry while it is wrong:
--
--   Tournament roster cache diverged before registration (cached %, actual %)
--
-- The job also decides which events are seat-first with its own heuristic,
--
--   lower(variant) IN ('spin','sng') OR COALESCE(max_players, 0) <= 2
--
-- which is not the platform's rule. The rule is
-- fn_ca_tournament_recorded_seat_first (spin-v1, seat-first-satellite-v1,
-- sng-v1 capped at 2 seats), and it is what the seat-first owner uses. Every
-- mtt-v2 event has max_players NULL by contract (fn_ca_guard_tournament_format
-- refuses anything else), COALESCE turns that into 0, and the heuristic calls
-- every unlimited MTT seat-first. Measured 2026-09-22, both written by the job
-- itself:
--
--   1. The count branch overwrites current_players of a multi-table mtt-v2
--      event, every minute, with the live seats of ONE table. At 14:05 UTC
--      38 of 56 RUNNING mtt-v2 events carried a count different from their
--      roster; in all 38 the stored value equals the primary table's live
--      seats exactly; together they were undercounted by 595 players, and 18
--      of them still had an open (unfinalized) pool.
--
--   2. The duplicate-table branch closes "empty duplicate seat-first tables",
--      and for an mtt-v2 event that is every table still being filled at
--      launch. Tables of live mtt-v2 events that the job closed (closed with
--      no lifecycle and no terminal marker, at second 00-01 of a minute, the
--      job's own second; mtt-v1, which the heuristic does not misread, has
--      0 of 90 closures there): 3 tables in 2 events still stranded in
--      REGISTERING, 4 tables in 4 RUNNING events. Example: 376f71ad (Prime
--      Time Free Buy, start 2026-09-21 01:00), tables created 01:01:59.79
--      and 01:01:59.95, both closed at 01:02:00.10329, the event still in
--      REGISTERING with 24 entrants. a74b3909 (Mid-Morning Turbo, start
--      2026-09-18 09:36) is the same shape. Neither is touched here: see 3.
--
-- The job failed 25 times in the 14 days of retained run history: 16 were
-- "terminal tournament % is immutable after closure" from the count branch
-- (a truth computed while the event was RUNNING, written after it had
-- completed), 1 was TOURNAMENT_TABLE_CLOSE_NOT_EMPTY from the duplicate
-- branch racing a seat, 2 were deadlocks, 6 were startup or restart.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- 1. fn_sync_tournament_current_players() keeps its pre-start statement
--    byte-for-byte and gains one branch: when a RUNNING event's player moves
--    into or out of the field (an UPDATE of status that changes membership of
--    'registered'/'playing'), the same transaction recounts the field. That
--    is every bust and every re-entry. It skips seat-first formats with the
--    SAME predicate their owner uses, so the two owners partition the column
--    exactly and never write the same event.
--
--    Why only membership UPDATEs while RUNNING, and not INSERT/DELETE: the
--    doors that admit a late entrant already publish the count themselves,
--    in their own transaction, and they REQUIRE this trigger to leave a
--    RUNNING count alone. fn_register_for_tournament_before_atomic_capacity_20260907
--    and the horse door compute
--        v_expected_cached_players := CASE WHEN status IN ('ANNOUNCED',
--          'REGISTERING') THEN v_players_before + 1 ELSE v_players_before END
--    and write v_players_before + 1 only if the row still holds that value;
--    fn_award_satellite_seat adds its own +1 on a RUNNING target. Counting a
--    RUNNING insert here would make every late registration fail its own
--    guard. So each event is written by exactly one writer: the door for an
--    admission, this trigger for a bust or a re-entry, and the seat trigger
--    for a seat-first format.
--
--    Lock order is unchanged. Every count-changing write to
--    tournament_players (INSERT, DELETE, or a status move into or out of the
--    field) already takes FOR UPDATE on the tournaments row in the BEFORE
--    trigger aa_tournament_player_launch_proof_lock
--    (fn_lock_tournament_launch_proof_parents), so the UPDATE below re-uses a
--    row lock its own transaction already holds. It adds no new lock.
--
-- 2. Two branches are removed from fn_reconcile_tournament_denormals() with
--    pg_temp.ca_patch, each marker asserted to match exactly once:
--      - the count branch: its only live effect was the lag above and the
--        mtt-v2 corruption; the owners now cover every status;
--      - the duplicate-table branch: seat-first duplicates have no writer.
--        fn_create_seat_first_game_atomic creates one joinable table under a
--        per-event advisory lock and raises SEAT_FIRST_ATOMIC_PARTIAL_STATE
--        otherwise; 17,369 seat-first events were created in the last 14
--        days and none has a second table.
--    The returned keys stay, at 0, naming their owners, as the stakes key
--    did on 2026-09-20. The roster branch (tournament_players.table_id and
--    seat_number) is left in place: every live tournament seat is acquired
--    through a canonical RPC (fn_tournament_live_seat_acquisition_requires_authority
--    refuses anything else) and each of them writes table_id and
--    seat_number in the same transaction, so it is expected to find nothing.
--    Unscheduling the job is not this file's decision.
--
-- 3. The damage the removed branch did is undone once, in this transaction,
--    with the owner's own formula: every RUNNING non-seat-first event whose
--    count disagrees with its roster is locked FIRST (so no bust can land
--    between the count and the write), recounted, and written. The two
--    REGISTERING events stranded by closed launch tables are NOT touched:
--    writing their count would let the engine's start gate launch a
--    tournament days after its advertised start, and that is a lifecycle
--    decision, not a counter.
--
--    The job is held off for this transaction by taking its own advisory
--    key; its cron command uses pg_try_advisory_lock on that key and skips.
--
-- ===========================================================================
-- HOW TO SEE IT HOLD (read-only; nothing else writes this column now)
--
--   SELECT count(*) FROM public.tournaments t
--    WHERE t.status = 'RUNNING'
--      AND NOT public.fn_ca_tournament_recorded_seat_first(t.id, true)
--      AND t.current_players IS DISTINCT FROM (
--            SELECT count(*) FROM public.tournament_players tp
--             WHERE tp.tournament_id = t.id
--               AND tp.status IN ('registered', 'playing'));
--
-- It must read 0 at any instant: the count and the bust commit together.
--
-- @live-proof: (SELECT position('A RUNNING FIELD IS COUNTED BY THE BUST THAT SHRINKS IT' in p.prosrc) > 0 AND position('NOT public.fn_ca_tournament_recorded_seat_first(t.id, true)' in p.prosrc) > 0 FROM pg_proc p WHERE p.oid = 'public.fn_sync_tournament_current_players()'::regprocedure)
-- @live-proof: (SELECT COALESCE(bool_and(position('UPDATE public.tables' in p.prosrc) = 0 AND position('UPDATE public.tournaments ' in p.prosrc) = 0 AND position('COALESCE(t.max_players, 0) <= 2' in p.prosrc) = 0), true) FROM pg_proc p WHERE p.oid = to_regprocedure('public.fn_reconcile_tournament_denormals()'))
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Hold the minutely job off for the rest of this transaction. Its cron
-- command takes this key with pg_try_advisory_lock and skips when it cannot,
-- so it can neither race the recount in step 3 nor run a half-replaced body.
SELECT pg_advisory_xact_lock(hashtext('reconcile-tournament-denormals'));

-- ---------------------------------------------------------------------------
-- 1. The owner: a bust recounts a RUNNING field in its own transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_sync_tournament_current_players()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tid uuid;
  v_count integer;
BEGIN
  v_tid := COALESCE(NEW.tournament_id, OLD.tournament_id);
  IF v_tid IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT count(*) INTO v_count
  FROM public.tournament_players
  WHERE tournament_id = v_tid
    AND status IN ('registered', 'playing');

  UPDATE public.tournaments
     SET current_players = v_count
   WHERE id = v_tid
     AND status IN ('ANNOUNCED', 'REGISTERING')
     AND current_players IS DISTINCT FROM v_count;

  /* A RUNNING FIELD IS COUNTED BY THE BUST THAT SHRINKS IT (2026-09-22).
     The statement above is pre-start only, on purpose, and nothing else
     counted a RUNNING field: a bust left the count one too high until a
     minutely job (reconcile-tournament-denormals) rewrote it, and the
     registration door refuses a late entrant while the count and the roster
     disagree. A player moving into or out of the field is recounted here, in
     the transaction that moves them.

     Only a MEMBERSHIP change on UPDATE. An admission (INSERT) or a removal
     (DELETE) into a RUNNING field is counted by the door that performs it:
     the registration, horse and satellite-seat doors publish the new count
     themselves and require this trigger to leave a RUNNING count alone.

     Seat-first formats are skipped with the predicate their own owner uses
     (fn_sync_seat_first_player_count, live seats on the primary table), so
     the two writers partition the column and never write the same event.

     The tournaments row is already locked FOR UPDATE by this transaction:
     every membership change takes it first, in
     aa_tournament_player_launch_proof_lock. */
  IF TG_OP = 'UPDATE'
     AND NEW.tournament_id IS NOT DISTINCT FROM OLD.tournament_id
     AND (COALESCE(OLD.status, '') IN ('registered', 'playing'))
         IS DISTINCT FROM (COALESCE(NEW.status, '') IN ('registered', 'playing')) THEN
    UPDATE public.tournaments t
       SET current_players = v_count
     WHERE t.id = v_tid
       AND t.status = 'RUNNING'
       AND t.current_players IS DISTINCT FROM v_count
       AND NOT public.fn_ca_tournament_recorded_seat_first(t.id, true);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

COMMENT ON FUNCTION public.fn_sync_tournament_current_players() IS
  'Owner of tournaments.current_players for non-seat-first formats: recounts the roster on every pre-start change (20260823120000) and on every RUNNING membership change, a bust or a re-entry (20260922141704). A RUNNING admission is counted by the door that performs it. Seat-first formats belong to fn_sync_seat_first_player_count.';

-- ---------------------------------------------------------------------------
-- 2. The minutely job stops writing a column and a table it does not own.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.ca_patch(p_fn text, p_from text, p_to text, p_expected integer DEFAULT 1)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_def text; v_n integer; v_procs integer;
BEGIN
  SELECT count(*) INTO v_procs FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  IF v_procs <> 1 THEN
    RAISE EXCEPTION 'ca_patch: % has % overloads in public (expected exactly 1)', p_fn, v_procs;
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  v_n := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  IF v_n <> p_expected THEN
    RAISE EXCEPTION 'ca_patch: marker in % found % times, expected %: %', p_fn, v_n, p_expected, left(p_from, 120);
  END IF;
  EXECUTE replace(v_def, p_from, p_to);
END $$;

-- 2a. The duplicate-table branch. Its writer is gone, and for mtt-v2 it was
--     closing launch tables.
SELECT pg_temp.ca_patch('fn_reconcile_tournament_denormals',
$dupes_from$  WITH seat_first AS (
    SELECT t.id
      FROM public.tournaments t
     WHERE t.status IN ('REGISTERING', 'ANNOUNCED', 'RUNNING')
       AND (lower(COALESCE(t.variant, '')) IN ('spin', 'sng')
            OR COALESCE(t.max_players, 0) <= 2)
  ), ranked AS (
    SELECT tb.id,
           (SELECT count(*) FROM public.table_seats s
             WHERE s.table_id = tb.id AND s.left_at IS NULL) AS seats,
           public.fn_tournament_primary_table(tb.tournament_id) AS keep_id
      FROM public.tables tb
      JOIN seat_first sf ON sf.id = tb.tournament_id
     WHERE lower(COALESCE(tb.status, '')) <> 'closed'
  ), upd3 AS (
    UPDATE public.tables tb
       SET status = 'closed', current_players = 0
      FROM ranked r
     WHERE tb.id = r.id
       AND r.seats = 0
       AND r.keep_id IS NOT NULL
       AND r.keep_id <> r.id
    RETURNING 1
  ) SELECT count(*) INTO v_dupes FROM upd3;
$dupes_from$,
$dupes_to$  -- The duplicate-table branch was here. A seat-first game gets exactly one
  -- joinable table from fn_create_seat_first_game_atomic, under a per-event
  -- lock, so there is no duplicate to close. Its own seat-first test read
  -- every mtt-v2 event as seat-first (max_players is NULL by contract) and
  -- closed that event's launch tables while they were still being filled.
  -- Do not add it back: a second table on a seat-first game means the
  -- creation door was bypassed, and closing it a minute later would hide that.
$dupes_to$);

-- 2b. The player-count branch. Its column has an owner in every status now.
SELECT pg_temp.ca_patch('fn_reconcile_tournament_denormals',
$counts_from$  WITH truth AS (
    SELECT t.id,
           (lower(COALESCE(t.variant, '')) IN ('spin', 'sng')
            OR COALESCE(t.max_players, 0) <= 2) AS is_seat_first,
           public.fn_tournament_primary_table(t.id) AS primary_table,
           CASE
             WHEN lower(COALESCE(t.variant, '')) IN ('spin', 'sng')
                  OR COALESCE(t.max_players, 0) <= 2
             THEN (
               SELECT count(*) FROM public.table_seats s
                WHERE s.table_id = public.fn_tournament_primary_table(t.id)
                  AND s.left_at IS NULL
             )
             ELSE (
               SELECT count(*) FROM public.tournament_players tp
                WHERE tp.tournament_id = t.id
                  AND tp.status IN ('registered', 'playing')
             )
           END AS real_count
      FROM public.tournaments t
     WHERE t.status IN ('REGISTERING', 'ANNOUNCED', 'RUNNING')
  ), upd4 AS (
    UPDATE public.tournaments t
       SET current_players = truth.real_count
      FROM truth
     WHERE t.id = truth.id
       AND NOT (truth.is_seat_first AND truth.primary_table IS NULL)
       AND COALESCE(t.current_players, -1) IS DISTINCT FROM truth.real_count
    RETURNING 1
  ) SELECT count(*) INTO v_counts FROM upd4;
$counts_from$,
$counts_to$  -- The player-count branch was here. The column is owned in the
  -- transaction that changes the field: fn_sync_tournament_current_players
  -- (pre-start, and every RUNNING bust or re-entry), the admission doors (a
  -- RUNNING admission) and fn_sync_seat_first_player_count (seat-first
  -- formats). A fourth writer a minute later is what made the count lag
  -- every bust and what overwrote every mtt-v2 field with one table.
$counts_to$);

-- 2c. The returned shape keeps both keys, at 0, and names who owns them now.
SELECT pg_temp.ca_patch('fn_reconcile_tournament_denormals',
$shape_from$    'empty_dupes_closed',  v_dupes,
    'player_counts_fixed', v_counts
  );$shape_from$,
$shape_to$    'empty_dupes_closed',  v_dupes,
    'empty_dupes_owner',   'fn_create_seat_first_game_atomic',
    'player_counts_fixed', v_counts,
    'player_counts_owner', 'fn_sync_tournament_current_players + fn_sync_seat_first_player_count'
  );$shape_to$);

-- ---------------------------------------------------------------------------
-- 3. Undo, once, what the removed branch wrote: the owner's own formula,
--    applied to RUNNING non-seat-first events whose count disagrees with
--    their roster. Each row is locked BEFORE it is counted, so a bust cannot
--    land between the count and the write. REGISTERING events are not
--    touched (see the header, point 3).
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE ca_aligned_field (
  tournament_id uuid PRIMARY KEY,
  was integer,
  now_is integer
) ON COMMIT DROP;

DO $align$
DECLARE
  r record;
  v_count integer;
  v_was integer;
  v_rows integer;
BEGIN
  FOR r IN
    SELECT t.id
      FROM public.tournaments t
     WHERE t.status = 'RUNNING'
       AND NOT public.fn_ca_tournament_recorded_seat_first(t.id, true)
       AND t.current_players IS DISTINCT FROM (
             SELECT count(*) FROM public.tournament_players tp
              WHERE tp.tournament_id = t.id
                AND tp.status IN ('registered', 'playing'))
     ORDER BY t.id
  LOOP
    SELECT t.current_players INTO v_was
      FROM public.tournaments t
     WHERE t.id = r.id AND t.status = 'RUNNING'
       FOR UPDATE;
    CONTINUE WHEN NOT FOUND;

    SELECT count(*) INTO v_count
      FROM public.tournament_players tp
     WHERE tp.tournament_id = r.id
       AND tp.status IN ('registered', 'playing');

    UPDATE public.tournaments t
       SET current_players = v_count
     WHERE t.id = r.id
       AND t.status = 'RUNNING'
       AND t.current_players IS DISTINCT FROM v_count;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    IF v_rows = 1 THEN
      INSERT INTO ca_aligned_field (tournament_id, was, now_is)
      VALUES (r.id, v_was, v_count);
    END IF;
  END LOOP;
END
$align$;

-- ---------------------------------------------------------------------------
-- 4. Proof, both directions.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_sync text;
  v_rec  text;
  v_code text;
  v_bad  integer;
  v_n    integer;
  v_under integer;
  v_out  jsonb;
  v_detail text;
BEGIN
  SELECT p.prosrc INTO v_sync FROM pg_proc p
   WHERE p.oid = 'public.fn_sync_tournament_current_players()'::regprocedure;
  SELECT p.prosrc INTO v_rec FROM pg_proc p
   WHERE p.oid = 'public.fn_reconcile_tournament_denormals()'::regprocedure;

  -- (a) The owner covers a RUNNING membership change, and only that.
  v_code := regexp_replace(regexp_replace(v_sync, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g');
  IF position('AND t.status = ''RUNNING''' in v_code) = 0
     OR position('NOT public.fn_ca_tournament_recorded_seat_first(t.id, true)' in v_code) = 0
     OR position('IF TG_OP = ''UPDATE''' in v_code) = 0
     OR position('IS DISTINCT FROM (COALESCE(NEW.status, '''') IN (''registered'', ''playing''))' in v_code) = 0 THEN
    RAISE EXCEPTION 'failed: the RUNNING membership branch is not in fn_sync_tournament_current_players';
  END IF;
  -- ... and the pre-start statement every admission door relies on is intact.
  IF position('AND status IN (''ANNOUNCED'', ''REGISTERING'')' in v_code) = 0 THEN
    RAISE EXCEPTION 'failed: the pre-start statement of fn_sync_tournament_current_players changed';
  END IF;

  -- (b) The owner is still wired: on the roster, enabled, for every event
  --     this body reads; and the seat-first owner it defers to is wired too.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger g
     WHERE g.tgrelid = 'public.tournament_players'::regclass
       AND g.tgname = 'trg_sync_tournament_current_players'
       AND g.tgenabled = 'O'
       AND g.tgfoid = 'public.fn_sync_tournament_current_players()'::regprocedure
       AND position('AFTER INSERT OR DELETE OR UPDATE OF status, tournament_id' in pg_get_triggerdef(g.oid)) > 0) THEN
    RAISE EXCEPTION 'failed: trg_sync_tournament_current_players is absent, disabled or narrowed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger g
     WHERE g.tgrelid = 'public.table_seats'::regclass
       AND g.tgname = 'trg_seat_change_syncs_seat_first_count'
       AND g.tgenabled = 'O') THEN
    RAISE EXCEPTION 'failed: the seat-first owner trg_seat_change_syncs_seat_first_count is absent or disabled';
  END IF;
  -- ... and the lock the new branch relies on is still taken first.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger g
     WHERE g.tgrelid = 'public.tournament_players'::regclass
       AND g.tgname = 'aa_tournament_player_launch_proof_lock'
       AND g.tgenabled = 'O') THEN
    RAISE EXCEPTION 'failed: aa_tournament_player_launch_proof_lock is absent or disabled';
  END IF;

  -- (c) The minutely job no longer writes the count, closes a table, or
  --     carries the heuristic that misread every mtt-v2 event.
  v_code := regexp_replace(v_rec, '--[^\n]*', '', 'g');
  IF position('UPDATE public.tournaments ' in v_code) > 0
     OR position('UPDATE public.tables' in v_code) > 0
     OR position('COALESCE(t.max_players, 0) <= 2' in v_code) > 0 THEN
    RAISE EXCEPTION 'failed: fn_reconcile_tournament_denormals still writes counts or tables';
  END IF;
  -- ... and removed nothing else: the roster branch and the shape remain.
  IF position('UPDATE public.tournament_players tp' in v_code) = 0
     OR position('''player_counts_fixed''' in v_code) = 0
     OR position('''empty_dupes_closed''' in v_code) = 0
     OR position('''stakes_rows_fixed''' in v_code) = 0 THEN
    RAISE EXCEPTION 'failed: the patch removed more than the two branches';
  END IF;

  -- (d) The patched job still runs. One self-aborting call: whatever the
  --     roster branch would write is rolled back with the probe.
  BEGIN
    v_out := public.fn_reconcile_tournament_denormals();
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ca-probe-rollback', DETAIL = v_out::text;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF v_detail IS NULL OR v_detail = '' THEN RAISE; END IF;
  END;
  v_out := v_detail::jsonb;
  IF (v_out->>'player_counts_fixed') <> '0' OR (v_out->>'empty_dupes_closed') <> '0'
     OR NOT (v_out ? 'roster_rows_fixed') THEN
    RAISE EXCEPTION 'failed: the patched job returned %', v_out;
  END IF;

  -- (e) Positive: every row this file wrote now equals its roster. They are
  --     still locked by this transaction, so nothing else can have moved them.
  SELECT count(*) INTO v_n FROM ca_aligned_field;
  SELECT count(*) INTO v_bad
    FROM ca_aligned_field a
    JOIN public.tournaments t ON t.id = a.tournament_id
   WHERE t.current_players IS DISTINCT FROM (
           SELECT count(*) FROM public.tournament_players tp
            WHERE tp.tournament_id = a.tournament_id
              AND tp.status IN ('registered', 'playing'));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'failed: % aligned field count(s) still disagree with their roster', v_bad;
  END IF;
  SELECT COALESCE(sum(now_is - was), 0) INTO v_under FROM ca_aligned_field;

  -- (f) Negative: nothing seat-first and nothing outside RUNNING was written.
  SELECT count(*) INTO v_bad
    FROM ca_aligned_field a
    JOIN public.tournaments t ON t.id = a.tournament_id
   WHERE t.status <> 'RUNNING'
      OR public.fn_ca_tournament_recorded_seat_first(t.id, true);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'failed: % aligned row(s) are seat-first or not RUNNING', v_bad;
  END IF;

  RAISE NOTICE 'PASS: a RUNNING field is counted by its own bust; the minutely job writes no count and closes no table; % field count(s) realigned, net % player(s) restored',
    v_n, v_under;
END
$verify$;

COMMIT;
