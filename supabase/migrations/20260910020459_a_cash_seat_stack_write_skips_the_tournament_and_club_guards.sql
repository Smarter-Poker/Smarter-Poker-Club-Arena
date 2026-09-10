-- 20260910020459_a_cash_seat_stack_write_skips_the_tournament_and_club_guards.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- MEASURED 2026-09-10 02:02 UTC, on production, in a rolled-back probe
-- (EXPLAIN ANALYZE of `UPDATE table_seats SET stack = stack + 1` on one live
-- CASH seat, plan cache warm):
--
--     execution      18.75 ms
--     of which triggers   16.63 ms   (89%)
--     the row itself       ~2 ms
--
--     aa_tournament_live_seat_proof_lock     6.40 ms   <- tournament guard, cash seat
--     trg_table_seats_stamp_club             6.00 ms   <- club stamp, stack-only write
--     terminal_tournament_seat_is_immutable  1.74 ms   <- tournament guard, cash seat
--     zz_freeze_guard                        0.96 ms
--     everything else (12 triggers)          1.53 ms
--
-- Cold cache the same write is 92 ms (89 ms triggers). A hand settles six to
-- nine seats, so the seat triggers ARE the settlement cost:
-- fn_ca_commit_hand_settlement averaged 159 ms/hand over 17 h and ~1 s/hand
-- during the 01:05-01:42 UTC evening ramp at 13k hands/h, when 25 backends
-- were sharing the XL's four cores. This is what took the compute tier
-- Medium -> Large -> XL in ten days: every guard added since 2026-08-25 was
-- correct, and every one of them also ran on rows it had nothing to say about.
--
-- THREE EARLY EXITS. NO GUARD IS REMOVED OR WEAKENED. Each function still does
-- exactly what it did on every row it was written for; it now returns before
-- the expensive part on rows where its own logic provably ends in RETURN NEW:
--
-- 1. trg_lock_and_validate_tournament_live_seat (aa_tournament_live_seat_proof_lock)
--    After resolving the old/new tournament ids, if BOTH are NULL the seat is
--    on a cash table on both sides of the write. In that case the original
--    body's v_ids is {NULL,NULL}: the proof-open EXISTS is false,
--    fn_lock_tournament_launch_proof_parents({NULL,NULL}) returns before
--    locking anything (it strips NULLs and returns on an empty set), and the
--    roster check requires v_new_tournament_id IS NOT NULL. Nothing it could
--    do on a cash seat is skipped, because there was nothing. Also: an UPDATE
--    that keeps table_id looks tables up once instead of twice.
--
-- 2. fn_stamp_seat_club (trg_table_seats_stamp_club)
--    An UPDATE that changes neither user_id nor table_id nor club_id, on a seat
--    that already carries a club, keeps that club. The seat's club is the club
--    it was seated under; re-deriving it from club_members on every stack
--    change was never the intent (a membership change mid-session would have
--    silently re-attributed the seat's chips). INSERTs, seat acquisitions, table
--    moves and rows with a NULL club still stamp exactly as before.
--
-- 3. fn_terminal_tournament_seat_is_immutable (terminal_tournament_seat_is_immutable)
--    Both tournament ids NULL and both terminal markers NULL: the original body
--    passes every check (no owner change, no marker on either side, status ''
--    from the LEFT JOIN, no receipts for a NULL tournament) and returns the
--    row. Return it before the three receipt EXISTS and the status lookup.
--    Same single-lookup reuse on an UPDATE that keeps table_id.
--
-- Tournament seats are untouched on every path: v_old/v_new_tournament_id is
-- non-NULL for them and every original line still runs.
--
-- EXPECTED: seat write ~19 ms -> ~6 ms warm; settlement roughly 100 ms/hand
-- lighter at six seats. Verified after apply with the same rolled-back probe;
-- the numbers go in docs/changelog/2026-09-10-a-cash-seat-write-skips-guards-it-never-needed.md.
--
-- ROLLBACK: the three previous bodies are at the bottom of this file, verbatim
-- from pg_get_functiondef on production before this change.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_lock_and_validate_tournament_live_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_ids uuid[];
  v_is_live_acquisition boolean := false;
  v_proof_open boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.seat_number IS NOT DISTINCT FROM OLD.seat_number
     AND NEW.stack IS NOT DISTINCT FROM OLD.stack
     AND NEW.left_at IS NOT DISTINCT FROM OLD.left_at THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    SELECT t.tournament_id INTO v_old_tournament_id
      FROM public.tables t
     WHERE t.id = OLD.table_id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id THEN
    -- Same table on both sides: one lookup answers for both (2026-09-10).
    v_new_tournament_id := v_old_tournament_id;
  ELSIF TG_OP <> 'DELETE' THEN
    SELECT t.tournament_id INTO v_new_tournament_id
      FROM public.tables t
     WHERE t.id = NEW.table_id;
  END IF;

  -- A CASH SEAT HAS NO LAUNCH PROOF TO LOCK (2026-09-10). With both ids NULL
  -- the body below cannot lock, refuse or require anything: v_ids would be
  -- {NULL,NULL}, the proof-open test is false, the lock helper returns on an
  -- empty set, and the roster check needs a tournament. Measured 6.4 ms per
  -- seat write on a cash table for that no-op; see the migration header.
  IF v_old_tournament_id IS NULL AND v_new_tournament_id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_ids := CASE
    WHEN TG_OP = 'INSERT' THEN ARRAY[v_new_tournament_id]
    WHEN TG_OP = 'DELETE' THEN ARRAY[v_old_tournament_id]
    ELSE ARRAY[v_old_tournament_id, v_new_tournament_id]
  END;

  IF TG_OP = 'INSERT' THEN
    v_is_live_acquisition := NEW.left_at IS NULL AND NEW.user_id IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_is_live_acquisition := NEW.left_at IS NULL
      AND NEW.user_id IS NOT NULL
      AND (
        OLD.left_at IS NOT NULL
        OR OLD.user_id IS DISTINCT FROM NEW.user_id
        OR OLD.table_id IS DISTINCT FROM NEW.table_id
      );
  END IF;

  IF NOT v_is_live_acquisition THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.tournaments t
        LEFT JOIN public.tournament_launch_receipts r
          ON r.tournament_id = t.id
       WHERE t.id = ANY(v_ids)
         AND (upper(t.status::text) = 'REGISTERING' OR r.completed_at IS NULL)
         AND (upper(t.status::text) = 'REGISTERING' OR r.tournament_id IS NOT NULL)
    ) INTO v_proof_open;
    IF NOT v_proof_open THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;

  PERFORM *
    FROM public.fn_lock_tournament_launch_proof_parents(v_ids);

  IF TG_OP <> 'DELETE'
     AND NEW.left_at IS NULL
     AND NEW.user_id IS NOT NULL
     AND v_new_tournament_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = v_new_tournament_id
          AND p.user_id = NEW.user_id
          AND p.status IN ('registered', 'playing')
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ROSTER_REQUIRED: live seat user % has no active roster in tournament %',
      NEW.user_id, v_new_tournament_id
      USING ERRCODE = '23514';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_seat_club()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- A SEAT KEEPS THE CLUB IT WAS SEATED UNDER (2026-09-10). Nothing that the
  -- stamp is derived from changed, and the seat already carries a club, so
  -- there is nothing to derive. This was 6.0 ms of club_members lookups on
  -- every stack write; see the migration header.
  IF TG_OP = 'UPDATE'
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
     AND NEW.club_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS NOT NULL AND NEW.table_id IS NOT NULL THEN
    NEW.club_id := COALESCE(
      public.fn_seat_club_for_user(NEW.user_id, NEW.table_id, NEW.club_id),
      NEW.club_id
    );
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_seat_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_status text;
  v_marker timestamptz;
  v_receipted boolean := false;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT tb.tournament_id INTO v_old_tournament_id
      FROM public.tables tb WHERE tb.id = OLD.table_id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id THEN
    -- Same table on both sides: one lookup answers for both (2026-09-10).
    v_new_tournament_id := v_old_tournament_id;
  ELSIF TG_OP <> 'DELETE' THEN
    SELECT tb.tournament_id INTO v_new_tournament_id
      FROM public.tables tb WHERE tb.id = NEW.table_id;
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;

  -- A CASH SEAT WITH NO TERMINAL MARKER HAS NOTHING TO BE IMMUTABLE ABOUT
  -- (2026-09-10). With no tournament on either side and no marker on either
  -- side, every check below passes and the row is returned; return it here
  -- instead of after a status lookup and three receipt scans on a NULL id.
  IF v_old_tournament_id IS NULL AND v_new_tournament_id IS NULL
     AND v_old_marker IS NULL AND v_new_marker IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION 'seat % cannot move between tournament owners',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION 'new tournament seat % cannot supply a terminal marker',NEW.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal tournament seat % is immutable',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_old_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'seat % terminal marker transition is not canonical',OLD.id
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' AND v_new_tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_new_tournament_id
     FOR SHARE;
    SELECT tb.terminal_closed_at INTO v_marker
      FROM public.tables tb
     WHERE tb.id = NEW.table_id
       AND tb.tournament_id = v_new_tournament_id
     FOR SHARE;
  ELSE
    SELECT upper(COALESCE(t.status::text,'')),tb.terminal_closed_at
      INTO v_status,v_marker
      FROM public.tables tb
      LEFT JOIN public.tournaments t ON t.id = tb.tournament_id
     WHERE tb.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.table_id ELSE NEW.table_id END;
  END IF;
  SELECT EXISTS (
           SELECT 1 FROM public.tournament_terminal_settlements h
            WHERE h.tournament_id = COALESCE(v_new_tournament_id,v_old_tournament_id))
      OR EXISTS (
           SELECT 1 FROM public.tournament_satellite_settlements h
            WHERE h.tournament_id = COALESCE(v_new_tournament_id,v_old_tournament_id))
      OR EXISTS (
           SELECT 1 FROM public.tournament_cancellation_receipts h
            WHERE h.tournament_id = COALESCE(v_new_tournament_id,v_old_tournament_id))
    INTO v_receipted;
  IF v_status IN ('COMPLETED','CANCELLED','CANCELED')
     AND (TG_OP = 'INSERT' OR v_receipted) THEN
    RAISE EXCEPTION 'terminal tournament seat % is immutable',
      CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

COMMIT;

-- ============================================================================
-- ROLLBACK (previous bodies, verbatim from production 2026-09-10 02:04 UTC).
-- Run all three in ONE transaction to undo this migration.
-- ============================================================================
-- BEGIN;
--
-- CREATE OR REPLACE FUNCTION public.trg_lock_and_validate_tournament_live_seat()
--  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
--  SET search_path TO 'public', 'pg_temp'
-- AS $function$
-- DECLARE
--   v_old_tournament_id uuid; v_new_tournament_id uuid; v_ids uuid[];
--   v_is_live_acquisition boolean := false; v_proof_open boolean := false;
-- BEGIN
--   IF TG_OP = 'UPDATE'
--      AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
--      AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
--      AND NEW.seat_number IS NOT DISTINCT FROM OLD.seat_number
--      AND NEW.stack IS NOT DISTINCT FROM OLD.stack
--      AND NEW.left_at IS NOT DISTINCT FROM OLD.left_at THEN
--     RETURN NEW;
--   END IF;
--   IF TG_OP <> 'INSERT' THEN
--     SELECT t.tournament_id INTO v_old_tournament_id FROM public.tables t WHERE t.id = OLD.table_id;
--   END IF;
--   IF TG_OP <> 'DELETE' THEN
--     SELECT t.tournament_id INTO v_new_tournament_id FROM public.tables t WHERE t.id = NEW.table_id;
--   END IF;
--   v_ids := CASE WHEN TG_OP = 'INSERT' THEN ARRAY[v_new_tournament_id]
--                 WHEN TG_OP = 'DELETE' THEN ARRAY[v_old_tournament_id]
--                 ELSE ARRAY[v_old_tournament_id, v_new_tournament_id] END;
--   IF TG_OP = 'INSERT' THEN
--     v_is_live_acquisition := NEW.left_at IS NULL AND NEW.user_id IS NOT NULL;
--   ELSIF TG_OP = 'UPDATE' THEN
--     v_is_live_acquisition := NEW.left_at IS NULL AND NEW.user_id IS NOT NULL
--       AND (OLD.left_at IS NOT NULL OR OLD.user_id IS DISTINCT FROM NEW.user_id
--            OR OLD.table_id IS DISTINCT FROM NEW.table_id);
--   END IF;
--   IF NOT v_is_live_acquisition THEN
--     SELECT EXISTS (SELECT 1 FROM public.tournaments t
--        LEFT JOIN public.tournament_launch_receipts r ON r.tournament_id = t.id
--       WHERE t.id = ANY(v_ids)
--         AND (upper(t.status::text) = 'REGISTERING' OR r.completed_at IS NULL)
--         AND (upper(t.status::text) = 'REGISTERING' OR r.tournament_id IS NOT NULL)) INTO v_proof_open;
--     IF NOT v_proof_open THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
--   END IF;
--   PERFORM * FROM public.fn_lock_tournament_launch_proof_parents(v_ids);
--   IF TG_OP <> 'DELETE' AND NEW.left_at IS NULL AND NEW.user_id IS NOT NULL
--      AND v_new_tournament_id IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM public.tournament_players p
--        WHERE p.tournament_id = v_new_tournament_id AND p.user_id = NEW.user_id
--          AND p.status IN ('registered', 'playing')) THEN
--     RAISE EXCEPTION 'TOURNAMENT_SEAT_ROSTER_REQUIRED: live seat user % has no active roster in tournament %',
--       NEW.user_id, v_new_tournament_id USING ERRCODE = '23514';
--   END IF;
--   RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
-- END;
-- $function$;
--
-- CREATE OR REPLACE FUNCTION public.fn_stamp_seat_club()
--  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
-- AS $function$
-- BEGIN
--   IF NEW.user_id IS NOT NULL AND NEW.table_id IS NOT NULL THEN
--     NEW.club_id := COALESCE(public.fn_seat_club_for_user(NEW.user_id, NEW.table_id, NEW.club_id), NEW.club_id);
--   END IF;
--   RETURN NEW;
-- END
-- $function$;
--
-- fn_terminal_tournament_seat_is_immutable: identical to the body above with
-- the "same table on both sides" branch replaced by the unconditional second
-- lookup (IF TG_OP <> 'DELETE' THEN SELECT ... INTO v_new_tournament_id ...)
-- and the early-exit block between the marker assignments and the
-- "cannot move between tournament owners" check removed. The full prior text
-- is in git history: `git log -S fn_terminal_tournament_seat_is_immutable`.
--
-- COMMIT;
