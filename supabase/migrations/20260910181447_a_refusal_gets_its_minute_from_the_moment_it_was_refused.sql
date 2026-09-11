-- 20260910181447_a_refusal_gets_its_minute_from_the_moment_it_was_refused
--
-- Version reserved by scripts/reserve-migration-version.sh (CLAUDE.md 4.5).
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE BACK-OFF CLOCK STARTED WHEN THE MOVE WAS PLANNED, NOT WHEN IT WAS REFUSED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Finding A7 of the 2026-09-09 must-move audit (lane-A.md).
--
-- Three planners skip a player whose last move the engine refused:
--
--   fn_cash_cluster_tick      step 2 (must-move) and step 5 (break moves)
--   fn_cash_cluster_balance   the mover
--   fn_cash_seat_change_plan  the seat-change grant and the swap
--
-- all with the same predicate, and the same comment beside it:
--
--   -- BACK-OFF (2026-09-05): a move the engine just refused (cancelled
--   -- with a note) is not re-planned every 5 s; the refusal gets a minute.
--   AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m
--                    WHERE m.player_id = ts.user_id AND m.state = 'cancelled'
--                      AND m.created_at > v_now - interval '60 seconds')
--
-- `created_at` is when the move was PLANNED. A move is refused at the
-- player's hand boundary, which is anywhere up to its deadline - three
-- minutes by default, five once announced, fifteen on a slow table
-- (fn_cash_seat_move_window). So by the time a refusal lands, the minute it
-- was supposed to get has usually already passed, and the next tick re-plans
-- the same player five seconds later. The comment describes a rule the code
-- does not implement.
--
-- MEASURED 2026-09-09: 400 cancellations in 24 hours; landing rate 97.6%, so
-- the cost today is churn rather than a stuck player - but every one of those
-- re-plans is a "Moving After This Hand" notice, and `cash_seat_moves` had NO
-- column that said when a move was refused (`executed_at` is NULL on every
-- cancelled row), so the rule could not even be measured, let alone applied.
--
-- THE FIX, in three parts, all the live path (CLAUDE.md 10.12):
--
--   1. `cash_seat_moves.resolved_at`: when the row left `pending`, whatever it
--      left to. NULL means it has not.
--   2. ONE authority stamps it: a BEFORE INSERT OR UPDATE OF state trigger,
--      `zz_cash_seat_move_resolved`. Every terminal transition today is one
--      of eleven UPDATE statements across three executor functions and the
--      tick; a stamp in each of them is eleven places to forget, and the next
--      writer would be a twelfth. This is the same shape as
--      `zz_cash_seat_move_window`, which owns `expires_at` on insert for the
--      same reason ("ONE AUTHORITY. The column default is gone").
--   3. The three planners key the minute on
--      `coalesce(m.resolved_at, m.created_at)`, by anchored replacement of the
--      predicate they already share. A historical row with no stamp behaves
--      exactly as it does today; no backfill (there is nothing true to
--      backfill it with, and CLAUDE.md 10.12 forbids the job anyway).
--
-- WHY NOT EXPIRED TOO. An expired move is one the engine never acted on; the
-- right thing is to re-plan it at once, which is what happens. The back-off
-- is for a REFUSAL, and refusals are `cancelled`.
--
-- ORDER OF APPLY. This must run AFTER 20260910181433 (the balancer rewrite),
-- which keeps the back-off text this migration anchors on; if it ran first
-- the balancer's md5 guard would refuse, which is the correct outcome. It
-- runs after lane B's 20260909181259 by version, and lane B's rewritten
-- fn_cash_seat_change_plan carries the identical predicate, so the anchor
-- matches before and after that migration. The three tick anchors of
-- 20260909181632 / 181704 / 181259 are disjoint from this one (the back-off
-- predicate appears in none of their replaced text; checked by grep).
--
-- THE ALTER TABLE. cash_seat_moves is in no publication (checked
-- pg_publication_tables), and the column is nullable with no default, so the
-- ADD is a catalog write; but the controller pass holds row locks on the
-- table for up to ~5.5 s, so the ALTER waits behind one pass at most.
-- lock_timeout is 3 s and the whole transaction rolls back on it; re-run.
--
-- ROLLBACK
--   DROP TRIGGER zz_cash_seat_move_resolved ON public.cash_seat_moves;
--   DROP FUNCTION public.fn_cash_seat_move_stamp_resolved();
--   ALTER TABLE public.cash_seat_moves DROP COLUMN resolved_at;
--   and restore `m.created_at >` in the three predicates.
--
-- Manifest fragment: scripts/ci/schema-manifest.d/a-refusal-gets-its-minute.json
--
-- ONE transaction (production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE public.cash_seat_moves ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
COMMENT ON COLUMN public.cash_seat_moves.resolved_at IS
  'When the move left pending (done, cancelled or expired), stamped by zz_cash_seat_move_resolved. NULL while pending. The planners back off a refused player for 60 s from THIS moment, not from created_at (20260910181447).';

CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_stamp_resolved()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- ONE AUTHORITY. Whichever writer takes a move out of `pending` - the tick's
  -- expiry, an executor's refusal, a landed move - the moment is recorded
  -- here, once, and a row put back to pending (nothing does today) clears it.
  IF NEW.state = 'pending' THEN
    NEW.resolved_at := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM NEW.state THEN
    NEW.resolved_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_cash_seat_move_stamp_resolved() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_cash_seat_move_resolved ON public.cash_seat_moves;
CREATE TRIGGER zz_cash_seat_move_resolved
  BEFORE INSERT OR UPDATE OF state ON public.cash_seat_moves
  FOR EACH ROW EXECUTE FUNCTION public.fn_cash_seat_move_stamp_resolved();

-- ── the three planners ──────────────────────────────────────────────────────
DO $migration$
DECLARE
  v_src text;
  v_new text;
  f record;
BEGIN
  FOR f IN SELECT * FROM (VALUES
      ('public.fn_cash_cluster_tick(uuid, integer)',
       $a$m.state = 'cancelled' AND m.created_at > v_now - interval '60 seconds'$a$,
       $b$m.state = 'cancelled' AND coalesce(m.resolved_at, m.created_at) > v_now - interval '60 seconds'$b$,
       2),
      ('public.fn_cash_cluster_balance(uuid, timestamptz)',
       $a$AND m.created_at > p_now - interval '60 seconds')$a$,
       $b$AND coalesce(m.resolved_at, m.created_at) > p_now - interval '60 seconds')$b$,
       1),
      ('public.fn_cash_seat_change_plan(uuid, timestamptz)',
       $a$m.state = 'cancelled' AND m.created_at > p_now - interval '60 seconds')$a$,
       $b$m.state = 'cancelled' AND coalesce(m.resolved_at, m.created_at) > p_now - interval '60 seconds')$b$,
       2)
    ) AS t(fn, anchor, repl, expected)
  LOOP
    v_src := pg_get_functiondef(f.fn::regprocedure);
    IF position('coalesce(m.resolved_at, m.created_at)' in v_src) > 0 THEN
      RAISE NOTICE '% already keyed on resolved_at; nothing to do', f.fn;
      CONTINUE;
    END IF;
    IF (length(v_src) - length(replace(v_src, f.anchor, ''))) / length(f.anchor) <> f.expected THEN
      RAISE EXCEPTION '% does not carry the back-off predicate exactly % time(s) in the shape this migration expects',
        f.fn, f.expected;
    END IF;
    v_new := replace(v_src, f.anchor, f.repl);
    IF position('coalesce(m.resolved_at, m.created_at)' in v_new) = 0
       OR position(f.anchor in v_new) > 0 THEN
      RAISE EXCEPTION 'the replacement in % did not take', f.fn;
    END IF;
    EXECUTE v_new;
    RAISE NOTICE '% re-keyed (% occurrence(s))', f.fn, f.expected;
  END LOOP;
END;
$migration$;

DO $assert$
DECLARE v_tick text; v_bal text; v_plan text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'cash_seat_moves' AND column_name = 'resolved_at') THEN
    RAISE EXCEPTION 'cash_seat_moves.resolved_at is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_cash_seat_move_resolved'
                    AND tgrelid = 'public.cash_seat_moves'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'zz_cash_seat_move_resolved is missing';
  END IF;
  v_tick := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);
  v_bal  := pg_get_functiondef('public.fn_cash_cluster_balance'::regproc);
  v_plan := pg_get_functiondef('public.fn_cash_seat_change_plan'::regproc);
  IF position($q$m.created_at > v_now - interval '60 seconds'$q$ in v_tick) > 0
     OR position($q$m.created_at > p_now - interval '60 seconds'$q$ in v_bal) > 0
     OR position($q$m.created_at > p_now - interval '60 seconds'$q$ in v_plan) > 0 THEN
    RAISE EXCEPTION 'a planner still keys the back-off on created_at';
  END IF;
  IF position('coalesce(m.resolved_at, m.created_at)' in v_tick) = 0
     OR position('coalesce(m.resolved_at, m.created_at)' in v_bal) = 0
     OR position('coalesce(m.resolved_at, m.created_at)' in v_plan) = 0 THEN
    RAISE EXCEPTION 'a planner did not take the resolved_at key';
  END IF;
  -- Every landmark of the tick survives.
  IF position('fn_platform_frozen' in v_tick) = 0 OR position('main1_reopened' in v_tick) = 0
     OR position('table_break_started' in v_tick) = 0 OR position('main_demoted_to_feeder' in v_tick) = 0 THEN
    RAISE EXCEPTION 'a landmark of the cluster tick went missing in the edit';
  END IF;
END;
$assert$;

COMMIT;
