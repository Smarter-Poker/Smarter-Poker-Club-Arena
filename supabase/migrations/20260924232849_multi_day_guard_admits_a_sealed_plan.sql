-- 20260924232849_multi_day_guard_admits_a_sealed_plan.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  MULTI-DAY TOURNAMENTS, RELEASE R6: THE GUARD ADMITS A SEALED PLAN
--  Design: docs/handoffs/club-arena-product-completion/MULTI-DAY-DESIGN.md
--  sections 2 (exact changes for Option A), 3, 9 (R6) and 11.
-- ===========================================================================
--
-- WHAT THIS CHANGES.
--
--   1. fn_tournaments_refuse_unbuilt_multi_day (behind the unchanged
--      seven-column trigger trg_tournaments_refuse_unbuilt_multi_day) is
--      replaced:
--
--        * the five STRUCTURE columns (day_number > 1, parent_tournament_id,
--          survivors_advance_to, flight_number, flight_end_chips_snapshot)
--          stay refused unconditionally, forever. Option A runs every day of
--          an event on ONE row (a sealed stage plan, BAGGED between days), so
--          nothing ever needs them, and fn_uncollected_entry_check's
--          later-day exemption, which reads day_number and
--          parent_tournament_id, stays unreachable by design;
--
--        * the two BADGE columns (is_multi_day, total_days) are admitted only
--          when the row has a sealed tournament_stage_plans row, total_days
--          equals its stage_count (is_multi_day true), and
--          fn_capability_available(plan.capability_id) is true. A row that
--          HAS a sealed plan may not be written with any other badge value,
--          so the lobby badge is exactly the plan. A row with no plan keeps
--          the ordinary values (false, 1) and nothing else.
--
--      The function becomes SECURITY DEFINER with a pinned search_path, like
--      the R3 doors of 20260924043224, because it now reads
--      tournament_stage_plans (service-role only) and asks
--      fn_capability_available (not granted to anon) on behalf of whichever
--      role writes the tournament. It RETURNS trigger, so it cannot be called
--      as an RPC. The trigger itself is NOT recreated: its seven columns are
--      checked below and the install refuses if they differ.
--
--   2. fn_seal_tournament_stage_plan (the one service-role seal; the operator
--      door fn_operator_seal_stage_plan of 20260924063656 delegates to it and
--      adds no second copy of any rule) now writes is_multi_day = true and
--      total_days = <stage count> on the tournament in the same transaction
--      as the plan, after the plan, the stages and the seal receipt exist.
--      Every existing refusal, the capability gate, the replay and the
--      receipt are unchanged: the function is edited by an exact text
--      replacement of its CURRENT source at one anchor, never re-typed.
--      Replay writes nothing (the original seal already wrote the badge).
--
--   3. The description of fn_uncollected_entry_check (COMMENT ON FUNCTION,
--      pg_description only) records that the later-day exemption is
--      unreachable by design. Its body is not touched: the in-body note sits
--      inside prosrc, and changing prosrc of a money check is not a comment
--      change.
--
-- THE TWO REPLACED FUNCTIONS ARE PINNED BY md5(prosrc) against their NEWEST
-- repository definition (prosrc, not pg_get_functiondef: production carries a
-- later search_path hardening on the guard, which changes the definition text
-- and not the source):
--
--   fn_tournaments_refuse_unbuilt_multi_day        20260902052302:76
--     pre  428b31045fc54a32e6207a6c15200cf5  (also the source_md5 captured
--          from production in scripts/ci/fixtures/satellite-qualifiers/
--          current-terminal-triggers-20260917.json)
--     post e6d43459c396f7e2b9ad4103d8a0ab21
--   fn_seal_tournament_stage_plan                  20260924043239:122
--     pre  7d41b8e3b192cf4d9ec4f13ed34a72f1
--     post 6c562ca24eb23ee3a9c1b8b00c1e3983
--
-- THE OWNER CONFIRMS THE LIVE md5(prosrc) OF BOTH EQUALS "pre" BEFORE
-- INSTALLING. If production differs this migration refuses
-- (MULTI_DAY_R6_SOURCE_DRIFT) and changes nothing.
--
-- PRECONDITIONS, checked here and refused if false:
--   * R1, R3, R5 and the capability registry are installed
--     (tournament_stage_plans, the bagged status door,
--     fn_seal_tournament_stage_plan, fn_capability_available);
--   * the trigger is attached, enabled, BEFORE INSERT OR UPDATE OF exactly
--     the seven columns, FOR EACH ROW, calling this function;
--   * NO plan has been sealed yet. A plan sealed before this release has no
--     badge (the old guard refused it), and this release does not write rows
--     after the fact: the owner decides that event first.
--
-- STILL INERT IN PRODUCTION: tournament.multi_day.single_flight is 'planned'
-- in the registry, so the seal refuses before it reaches the badge write and
-- the guard admits no badge. Nothing is badged until the owner moves the
-- capability to deployed.
--
-- NO MONEY. No chip, escrow, obligation, rake or ledger row is written. No
-- trigger is created or dropped, so ca_declared_money_triggers is unchanged.
-- The seal's badge write on a plannable (ANNOUNCED or REGISTERING, nobody
-- registered) event records a new managed-game contract revision through the
-- existing capture trigger, which is the honest outcome: the lobby promise now
-- says multi-day.
--
-- LOCKING. CREATE OR REPLACE FUNCTION takes no lock on tournaments. Nothing
-- else runs in this transaction; lock_timeout bounds the catalog wait. Never
-- apply at :50 to :03 UTC.
--
-- ROLLBACK (only while no plan is sealed, i.e. while the capability is still
-- planned): restore the guard from 20260902052302 (its source is the "pre"
-- above) and replace the seal's source by its "pre" text (the replacement is
-- exact, so reversing it is exact).
--
-- @live-proof: (SELECT md5(prosrc) = 'e6d43459c396f7e2b9ad4103d8a0ab21' AND prosecdef FROM pg_proc WHERE oid = 'public.fn_tournaments_refuse_unbuilt_multi_day()'::regprocedure)
-- @live-proof: (SELECT md5(prosrc) = '6c562ca24eb23ee3a9c1b8b00c1e3983' AND prosecdef FROM pg_proc WHERE oid = 'public.fn_seal_tournament_stage_plan(uuid,jsonb)'::regprocedure)
-- @live-proof: (SELECT count(*) = 1 FROM pg_trigger t WHERE t.tgrelid = 'public.tournaments'::regclass AND t.tgname = 'trg_tournaments_refuse_unbuilt_multi_day' AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgtype = 23 AND t.tgfoid = 'public.fn_tournaments_refuse_unbuilt_multi_day()'::regprocedure AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(t.tgattr::int2[]) k(attnum) JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.attnum) = ARRAY['day_number','flight_end_chips_snapshot','flight_number','is_multi_day','parent_tournament_id','survivors_advance_to','total_days'])
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.tournament_stage_plans p JOIN public.tournaments t ON t.id = p.tournament_id WHERE NOT (COALESCE(t.is_multi_day, false) AND t.total_days IS NOT DISTINCT FROM p.stage_count)))
-- @live-proof: (SELECT obj_description('public.fn_uncollected_entry_check(integer)'::regprocedure, 'pg_proc') LIKE '%unreachable by design%')

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE
  v_trigger_ok boolean;
  v_md5 text;
BEGIN
  IF to_regprocedure('public.fn_capability_available(text)') IS NULL
     OR to_regprocedure('public.fn_tournaments_refuse_unbuilt_multi_day()') IS NULL
     OR to_regprocedure('public.fn_seal_tournament_stage_plan(uuid,jsonb)') IS NULL
     OR to_regprocedure('public.fn_uncollected_entry_check(integer)') IS NULL
     OR to_regclass('public.tournament_stage_plans') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t
                     WHERE t.tgrelid = 'public.tournaments'::regclass
                       AND t.tgname = 'trg_tournaments_bagged_status_door'
                       AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION 'MULTI_DAY_R6_PREREQUISITES_MISSING (install 20260924025555 and 20260924043217..043239 first)'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) = 1 INTO v_trigger_ok
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'trg_tournaments_refuse_unbuilt_multi_day'
     AND NOT t.tgisinternal
     AND t.tgenabled = 'O'
     -- ROW (1) + BEFORE (2) + INSERT (4) + UPDATE (16)
     AND t.tgtype = 23
     AND t.tgfoid = 'public.fn_tournaments_refuse_unbuilt_multi_day()'::regprocedure
     AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
            FROM unnest(t.tgattr::int2[]) k(attnum)
            JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.attnum)
         = ARRAY['day_number','flight_end_chips_snapshot','flight_number','is_multi_day',
                 'parent_tournament_id','survivors_advance_to','total_days'];
  IF NOT v_trigger_ok THEN
    RAISE EXCEPTION 'MULTI_DAY_R6_TRIGGER_DRIFT: trg_tournaments_refuse_unbuilt_multi_day is not the seven-column BEFORE INSERT OR UPDATE row trigger this release replaces the function of'
      USING ERRCODE = '55000';
  END IF;

  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public.fn_tournaments_refuse_unbuilt_multi_day()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '428b31045fc54a32e6207a6c15200cf5' THEN
    RAISE EXCEPTION 'MULTI_DAY_R6_SOURCE_DRIFT: fn_tournaments_refuse_unbuilt_multi_day is %, expected 428b31045fc54a32e6207a6c15200cf5', v_md5
      USING ERRCODE = '55000';
  END IF;
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public.fn_seal_tournament_stage_plan(uuid,jsonb)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '7d41b8e3b192cf4d9ec4f13ed34a72f1' THEN
    RAISE EXCEPTION 'MULTI_DAY_R6_SOURCE_DRIFT: fn_seal_tournament_stage_plan is %, expected 7d41b8e3b192cf4d9ec4f13ed34a72f1', v_md5
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (SELECT 1 FROM public.tournament_stage_plans) THEN
    RAISE EXCEPTION 'MULTI_DAY_R6_PLAN_SEALED_BEFORE_THE_BADGE: a stage plan exists whose tournament the old guard kept unbadged; the owner decides that event before R6 installs'
      USING ERRCODE = '55000';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. THE GUARD.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_tournaments_refuse_unbuilt_multi_day()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_field text := NULL;
  v_badged boolean;
  v_found boolean := false;
  v_days integer;
  v_capability text;
  v_reason text := NULL;
BEGIN
  /* THE STRUCTURE COLUMNS - refused unconditionally, for ever. A multi day
     event is ONE row across its days (a sealed stage plan, BAGGED between
     days), so nothing writes these. A row carrying one would also switch on
     the later-day exemption inside fn_uncollected_entry_check and excuse its
     seats from the was-this-paid-for question. */
  IF COALESCE(NEW.day_number, 1) > 1 THEN
    v_field := 'day_number';
  ELSIF NEW.parent_tournament_id IS NOT NULL THEN
    v_field := 'parent_tournament_id';
  ELSIF NEW.survivors_advance_to IS NOT NULL THEN
    v_field := 'survivors_advance_to';
  ELSIF NEW.flight_number IS NOT NULL THEN
    v_field := 'flight_number';
  ELSIF NEW.flight_end_chips_snapshot IS NOT NULL THEN
    v_field := 'flight_end_chips_snapshot';
  END IF;
  IF v_field IS NOT NULL THEN
    RAISE EXCEPTION
      'MULTI_DAY_STRUCTURE_COLUMN_REFUSED: % is never written. A multi day '
      'event is one row across its days, with a sealed stage plan and BAGGED '
      'between days; the flight structure columns stay unused, and a later '
      'day row would excuse its seats from the uncollected entry check.', v_field
      USING ERRCODE = '0A000';
  END IF;

  /* THE BADGE COLUMNS - what the lobby reads. They are exactly the sealed
     plan: admitted only with a sealed plan for this row, total_days equal to
     its day count, and its capability available. A row with a plan carries
     no other badge; a row without one carries none. On INSERT no plan can
     exist yet (the plan references the tournament), so only a badge is
     looked up. */
  v_badged := COALESCE(NEW.is_multi_day, false) OR COALESCE(NEW.total_days, 1) > 1;
  IF TG_OP = 'UPDATE' OR v_badged THEN
    SELECT true, p.stage_count, p.capability_id
      INTO v_found, v_days, v_capability
      FROM public.tournament_stage_plans p
     WHERE p.tournament_id = NEW.id;
    v_found := COALESCE(v_found, false);
    IF NOT v_found THEN
      IF v_badged THEN
        v_reason := 'no_sealed_plan';
      END IF;
    ELSIF NOT (COALESCE(NEW.is_multi_day, false) AND NEW.total_days IS NOT DISTINCT FROM v_days) THEN
      v_reason := 'badge_differs_from_plan';
    ELSIF NOT COALESCE(public.fn_capability_available(v_capability), false) THEN
      v_reason := 'capability_unavailable';
    END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION
      'MULTI_DAY_BADGE_REFUSED (%): is_multi_day and total_days describe a '
      'sealed stage plan and are written with it by '
      'fn_seal_tournament_stage_plan. They are admitted only when this event '
      'has a sealed plan, total_days equals its day count and its capability '
      'is available.', v_reason
      USING ERRCODE = '0A000',
            DETAIL = format('tournament %s: is_multi_day=%s total_days=%s plan_days=%s capability=%s',
                            NEW.id, NEW.is_multi_day, NEW.total_days, v_days, v_capability);
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.fn_tournaments_refuse_unbuilt_multi_day() IS
  'R6 (20260924232849): refuses the five multi-day structure columns '
  '(day_number > 1, parent_tournament_id, survivors_advance_to, flight_number, '
  'flight_end_chips_snapshot) unconditionally, and admits the badge columns '
  '(is_multi_day, total_days) only as the exact image of a sealed '
  'tournament_stage_plans row whose capability is available. The seal writes '
  'them; nothing else does.';

-- ---------------------------------------------------------------------------
-- 2. THE SEAL WRITES THE BADGE, in the transaction that seals the plan.
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  v_oid oid := 'public.fn_seal_tournament_stage_plan(uuid,jsonb)'::regprocedure;
  v_body text;
  v_definition text;
  v_patched text;
  v_anchor text := $a$  PERFORM set_config('app.multi_day_stage_writer', '', true);

  RETURN jsonb_build_object('ok', true, 'replay', false, 'tournament_id', p_tournament_id,
    'plan_hash', v_hash, 'stage_count', v_n, 'time_zone', v_zone, 'stages', v_rows);$a$;
BEGIN
  SELECT p.prosrc, pg_get_functiondef(p.oid) INTO v_body, v_definition
    FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
  IF md5(v_body) IS DISTINCT FROM '7d41b8e3b192cf4d9ec4f13ed34a72f1' THEN
    RAISE EXCEPTION 'MULTI_DAY_R6_SOURCE_DRIFT: fn_seal_tournament_stage_plan is %, expected 7d41b8e3b192cf4d9ec4f13ed34a72f1', md5(v_body)
      USING ERRCODE = '55000';
  END IF;
  IF (length(v_body) - length(replace(v_body, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'MULTI_DAY_R6_PATCH_ANCHOR_NOT_UNIQUE: fn_seal_tournament_stage_plan' USING ERRCODE = '55000';
  END IF;
  v_patched := replace(v_body, v_anchor,
$r$  PERFORM set_config('app.multi_day_stage_writer', '', true);

  -- R6 (20260924232849): the lobby badge is the plan, written in the same
  -- transaction as the plan and nowhere else. trg_tournaments_refuse_unbuilt_multi_day
  -- admits exactly this pair: a sealed plan, its day count, its capability.
  UPDATE public.tournaments
     SET is_multi_day = true, total_days = v_n
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'replay', false, 'tournament_id', p_tournament_id,
    'plan_hash', v_hash, 'stage_count', v_n, 'time_zone', v_zone, 'stages', v_rows);$r$);
  EXECUTE replace(v_definition, v_body, v_patched);
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_oid) IS DISTINCT FROM '6c562ca24eb23ee3a9c1b8b00c1e3983' THEN
    RAISE EXCEPTION 'MULTI_DAY_R6_PATCH_RESULT_DRIFT: fn_seal_tournament_stage_plan' USING ERRCODE = '55000';
  END IF;
END
$patch$;

-- ---------------------------------------------------------------------------
-- 3. THE LATER-DAY EXEMPTION IS UNREACHABLE BY DESIGN (description only).
-- ---------------------------------------------------------------------------
COMMENT ON FUNCTION public.fn_uncollected_entry_check(integer) IS
  'Phase 2 of the MTT payout audit. Reports seats in paid events with no auditable '
  'record that the entry was paid. Exempts the four legitimate funding sources by '
  'name. Moves no money. Bounded at 48h and refuses any window predating 2026-08-19. '
  'The day-2 exemption reads day_number and parent_tournament_id only: the union '
  'flag means UNION event, not multi-day. That later-day exemption is unreachable by '
  'design: multi-day events (20260924232849, R6) are one row across their days, and '
  'trg_tournaments_refuse_unbuilt_multi_day refuses day_number and '
  'parent_tournament_id for ever, so a Day 2 seat is the same funded seat.';

DO $post$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc
       WHERE oid = 'public.fn_tournaments_refuse_unbuilt_multi_day()'::regprocedure)
     IS DISTINCT FROM 'e6d43459c396f7e2b9ad4103d8a0ab21'
     OR NOT (SELECT prosecdef FROM pg_catalog.pg_proc
              WHERE oid = 'public.fn_tournaments_refuse_unbuilt_multi_day()'::regprocedure) THEN
    RAISE EXCEPTION 'MULTI_DAY_R6_RESULT_DRIFT: fn_tournaments_refuse_unbuilt_multi_day' USING ERRCODE = '55000';
  END IF;
  -- The seal stays a service-role RPC; the operator door stays its only browser path.
  IF NOT has_function_privilege('service_role', 'public.fn_seal_tournament_stage_plan(uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_seal_tournament_stage_plan(uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_seal_tournament_stage_plan(uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'MULTI_DAY_R6_SEAL_GRANTS_CHANGED' USING ERRCODE = '42501';
  END IF;
END
$post$;

COMMIT;
