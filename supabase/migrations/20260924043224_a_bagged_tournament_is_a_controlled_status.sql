-- 20260924043224_a_bagged_tournament_is_a_controlled_status.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  MULTI-DAY TOURNAMENTS, RELEASES R3 AND R4: THE BAGGED STATUS AND ITS DOORS
--  Design: docs/handoffs/club-arena-product-completion/MULTI-DAY-DESIGN.md
--  sections 2 (S1 to S3, S8) and 3.
-- ===========================================================================
--
-- WHAT THIS CHANGES.
--
--   1. tournaments_status_check gains 'BAGGED', added NOT VALID so this
--      transaction does not scan the table under ACCESS EXCLUSIVE.
--      20260924043232 validates it.
--
--   2. trg_tournaments_bagged_status_door (BEFORE INSERT OR UPDATE OF status):
--      no row is inserted BAGGED; RUNNING -> BAGGED only inside the bag RPC
--      (marker app.atomic_stage_bag = <tournament>:<bag receipt id>, receipt
--      written in this transaction); BAGGED -> anything only to RUNNING and
--      only inside the resume completion RPC (marker app.atomic_stage_resume =
--      <tournament>:<resume id>, receipt still incomplete). So a bagged event
--      can never be completed, cancelled or launched a second time.
--
--   3. trg_tournament_players_bagged_custody_fence (BEFORE INSERT, DELETE, or
--      UPDATE OF chips, status, current_bounty, tournament_id): while the
--      parent is BAGGED the bag row owns every stack, so any other writer of a
--      chip count, a roster status or a bounty head is refused. A no-op update
--      passes (fn_sync_tournament_chips already skips no-ops). The stage RPCs
--      pass with marker app.multi_day_stage_custody = <tournament>.
--
--   4. fn_refuse_new_entries_while_frozen (the function behind
--      zz_freeze_launch_guard): one narrow exemption beside the existing
--      launch-receipt case. BAGGED -> RUNNING is admitted only with the
--      resume marker and an incomplete resume receipt. Every other write into
--      RUNNING keeps raising TOURNAMENT_LAUNCH_RECEIPT_REQUIRED, so a second
--      launch is still refused.
--
--   5. fn_tournament_live_seat_acquisition_requires_authority (behind
--      a0_tournament_live_seat_root_guard): a live tournament seat may be
--      acquired while BAGGED only with the same resume marker and incomplete
--      receipt. The terminal-authority proof (T or G held exclusively) is
--      unchanged and still required first.
--
-- THE TWO PATCHED FUNCTIONS are edited in place by an exact text replacement
-- of their CURRENT source, never re-typed. Each is pinned by md5(prosrc)
-- against its NEWEST definition in this repository:
--
--   fn_refuse_new_entries_while_frozen                        20260908042800:372
--     pre  d21668d1254e1bdb49661f6365fd9cfc
--     post e8c94fe07905dee54ecbccde538ce7f0
--   fn_tournament_live_seat_acquisition_requires_authority    20260910173147:310
--     pre  5a60bdd761aaaaad4b3bf982a3c50f6e
--     post e234a1ad46b2682cc25d8877e155a17a
--
-- THE OWNER MUST CONFIRM THE LIVE md5(prosrc) OF BOTH FUNCTIONS EQUALS "pre"
-- BEFORE INSTALLING. The repository is not proof of what production runs
-- (check-definer-authorization.mjs explains why); if production differs this
-- migration refuses (MULTI_DAY_PATCH_SOURCE_DRIFT) and changes nothing.
--
-- R0 PRECONDITIONS, checked here and refused if false:
--   * tournaments_status_check is exactly the seven-status vocabulary;
--   * the MTT ABI activation is complete (ca_mtt_admission_contract.abi =
--     'unlimited-mtt-v2'): its guard pins tournaments_status_check, and an
--     activation still pending would refuse forever after this change;
--   * zz_freeze_launch_guard and a0_tournament_live_seat_root_guard are
--     attached and enabled;
--   * the capability registry and the R1 stage tables exist.
--
-- UNREACHABLE UNTIL R6. Nothing can reach BAGGED without the bag RPC of
-- 20260924043239, which requires
-- fn_capability_available('tournament.multi_day.single_flight').
--
-- NO MONEY. No chip, escrow, obligation, rake or ledger row is written.
--
-- LOCKING. ALTER TABLE ... DROP/ADD CONSTRAINT ... NOT VALID and the two
-- CREATE TRIGGER statements take ACCESS EXCLUSIVE / SHARE ROW EXCLUSIVE on
-- tournaments and tournament_players until COMMIT; nothing else runs in this
-- transaction and lock_timeout bounds the wait. Never apply at :50 to :03 UTC.
--
-- ROLLBACK (only while no row is BAGGED): restore the seven-status CHECK,
-- DROP the two triggers and their functions, and replace each patched source
-- by its "pre" text (the replacement is exact, so reversing it is exact).
--
-- @live-proof: (SELECT pg_get_constraintdef(c.oid) LIKE 'CHECK ((status = ANY (ARRAY[''ANNOUNCED''::text, ''REGISTERING''::text, ''LATE_REG''::text, ''RUNNING''::text, ''COMPLETING''::text, ''COMPLETED''::text, ''CANCELLED''::text, ''BAGGED''::text])))%' FROM pg_constraint c WHERE c.conrelid = 'public.tournaments'::regclass AND c.conname = 'tournaments_status_check')
-- @live-proof: (SELECT count(*) = 2 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled = 'O' AND ((t.tgrelid = 'public.tournaments'::regclass AND t.tgname = 'trg_tournaments_bagged_status_door') OR (t.tgrelid = 'public.tournament_players'::regclass AND t.tgname = 'trg_tournament_players_bagged_custody_fence')))
-- @live-proof: (SELECT md5(prosrc) = 'e8c94fe07905dee54ecbccde538ce7f0' FROM pg_proc WHERE oid = 'public.fn_refuse_new_entries_while_frozen()'::regprocedure)
-- @live-proof: (SELECT md5(prosrc) = 'e234a1ad46b2682cc25d8877e155a17a' FROM pg_proc WHERE oid = 'public.fn_tournament_live_seat_acquisition_requires_authority()'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
BEGIN
  IF (SELECT pg_get_constraintdef(c.oid)
        FROM pg_constraint c
       WHERE c.conrelid = 'public.tournaments'::regclass
         AND c.conname = 'tournaments_status_check')
     IS DISTINCT FROM
     'CHECK ((status = ANY (ARRAY[''ANNOUNCED''::text, ''REGISTERING''::text, ''LATE_REG''::text, ''RUNNING''::text, ''COMPLETING''::text, ''COMPLETED''::text, ''CANCELLED''::text])))'
  THEN
    RAISE EXCEPTION 'MULTI_DAY_STATUS_VOCABULARY_CHANGED' USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.ca_mtt_admission_contract') IS NULL
     OR (SELECT abi FROM public.ca_mtt_admission_contract WHERE singleton) IS DISTINCT FROM 'unlimited-mtt-v2' THEN
    RAISE EXCEPTION 'MULTI_DAY_REQUIRES_MTT_ACTIVATION_FIRST: the activation guard pins tournaments_status_check'
      USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
         AND ((t.tgrelid = 'public.tournaments'::regclass AND t.tgname = 'zz_freeze_launch_guard'
               AND t.tgfoid = 'public.fn_refuse_new_entries_while_frozen()'::regprocedure)
           OR (t.tgrelid = 'public.table_seats'::regclass AND t.tgname = 'a0_tournament_live_seat_root_guard'
               AND t.tgfoid = 'public.fn_tournament_live_seat_acquisition_requires_authority()'::regprocedure))) <> 2 THEN
    RAISE EXCEPTION 'MULTI_DAY_GUARDED_DOORS_NOT_ATTACHED' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('public.fn_capability_available(text)') IS NULL
     OR to_regclass('public.tournament_stage_resume_receipts') IS NULL
     OR to_regclass('public.tournament_stage_transitions') IS NULL
     OR to_regclass('public.ca_declared_money_triggers') IS NULL THEN
    RAISE EXCEPTION 'MULTI_DAY_PREREQUISITES_MISSING' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t
              WHERE t.tgname IN ('trg_tournaments_bagged_status_door',
                                 'trg_tournament_players_bagged_custody_fence')) THEN
    RAISE EXCEPTION 'MULTI_DAY_TRIGGER_NAME_TAKEN' USING ERRCODE = '42710';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. THE VOCABULARY.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tournaments
  DROP CONSTRAINT tournaments_status_check,
  ADD CONSTRAINT tournaments_status_check
      CHECK (status = ANY (ARRAY[
        'ANNOUNCED'::text,
        'REGISTERING'::text,
        'LATE_REG'::text,
        'RUNNING'::text,
        'COMPLETING'::text,
        'COMPLETED'::text,
        'CANCELLED'::text,
        'BAGGED'::text
      ])) NOT VALID;

-- ---------------------------------------------------------------------------
-- 2. THE STATUS DOOR.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_tournaments_bagged_status_door()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'BAGGED' THEN
      RAISE EXCEPTION 'TOURNAMENT_BAGGED_REQUIRES_STAGE_BAG: a tournament is never created bagged'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'BAGGED' THEN
    IF OLD.status IS DISTINCT FROM 'RUNNING'
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_stage_transitions x
          WHERE x.tournament_id = NEW.id
            AND x.kind = 'bag'
            AND x.transaction_id = pg_current_xact_id()
            AND current_setting('app.atomic_stage_bag', true) = NEW.id::text || ':' || x.id::text) THEN
      RAISE EXCEPTION 'TOURNAMENT_BAGGED_REQUIRES_STAGE_BAG: % to BAGGED belongs to the stage bag RPC', OLD.status
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'BAGGED' THEN
    IF NEW.status IS DISTINCT FROM 'RUNNING'
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_stage_resume_receipts r
          WHERE r.tournament_id = NEW.id
            AND r.completed_at IS NULL
            AND current_setting('app.atomic_stage_resume', true) = NEW.id::text || ':' || r.resume_id::text) THEN
      RAISE EXCEPTION 'TOURNAMENT_BAGGED_LEAVES_ONLY_BY_STAGE_RESUME: BAGGED to % refused', NEW.status
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

-- money-trigger-ok: tournaments.trg_tournaments_bagged_status_door because it only refuses status writes into or out of BAGGED that lack their stage receipt; it moves no chips and is declared in ca_declared_money_triggers below.
CREATE TRIGGER trg_tournaments_bagged_status_door
  BEFORE INSERT OR UPDATE OF status ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.fn_tournaments_bagged_status_door();

-- ---------------------------------------------------------------------------
-- 3. THE CUSTODY FENCE.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_tournament_players_bagged_custody_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_tournaments uuid[];
  v_bagged uuid;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.chips IS NOT DISTINCT FROM OLD.chips
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.current_bounty IS NOT DISTINCT FROM OLD.current_bounty
     AND NEW.tournament_id IS NOT DISTINCT FROM OLD.tournament_id THEN
    RETURN NEW;
  END IF;
  v_tournaments := CASE TG_OP
    WHEN 'INSERT' THEN ARRAY[NEW.tournament_id]
    WHEN 'DELETE' THEN ARRAY[OLD.tournament_id]
    ELSE ARRAY[OLD.tournament_id, NEW.tournament_id] END;
  SELECT t.id INTO v_bagged
    FROM public.tournaments t
   WHERE t.id = ANY (v_tournaments) AND t.status = 'BAGGED'
     AND current_setting('app.multi_day_stage_custody', true) IS DISTINCT FROM t.id::text
   LIMIT 1;
  IF v_bagged IS NOT NULL THEN
    RAISE EXCEPTION 'TOURNAMENT_BAGGED_CUSTODY: tournament % is bagged; its stacks belong to the bag until the stage resumes', v_bagged
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;

-- money-trigger-ok: tournament_players.trg_tournament_players_bagged_custody_fence because it only refuses chip, status and bounty writes to a roster whose event is BAGGED; it moves no chips and is declared in ca_declared_money_triggers below.
CREATE TRIGGER trg_tournament_players_bagged_custody_fence
  BEFORE INSERT OR DELETE OR UPDATE OF chips, status, current_bounty, tournament_id
  ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_players_bagged_custody_fence();

REVOKE ALL ON FUNCTION public.fn_tournaments_bagged_status_door() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_tournament_players_bagged_custody_fence() FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note) VALUES
  ('tournaments', 'trg_tournaments_bagged_status_door',
   'multi-day R3: RUNNING to BAGGED only inside the stage bag RPC, BAGGED to RUNNING only inside the stage resume RPC; refuses, never writes'),
  ('tournament_players', 'trg_tournament_players_bagged_custody_fence',
   'multi-day R3: while the event is BAGGED the bag owns every stack; refuses chip, status and bounty writes outside the stage RPCs')
ON CONFLICT (table_name, trigger_name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4 AND 5. THE TWO NARROW RESUME EXEMPTIONS, BY EXACT SOURCE REPLACEMENT.
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  v_oid oid;
  v_body text;
  v_definition text;
  v_anchor text;
  v_patched text;
BEGIN
  -- 4. fn_refuse_new_entries_while_frozen
  v_oid := 'public.fn_refuse_new_entries_while_frozen()'::regprocedure;
  SELECT p.prosrc, pg_get_functiondef(p.oid) INTO v_body, v_definition
    FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
  IF md5(v_body) IS DISTINCT FROM 'd21668d1254e1bdb49661f6365fd9cfc' THEN
    RAISE EXCEPTION 'MULTI_DAY_PATCH_SOURCE_DRIFT: fn_refuse_new_entries_while_frozen is %, expected d21668d1254e1bdb49661f6365fd9cfc', md5(v_body)
      USING ERRCODE = '55000';
  END IF;
  v_anchor := E'    RAISE EXCEPTION\n      ''TOURNAMENT_LAUNCH_RECEIPT_REQUIRED';
  IF (length(v_body) - length(replace(v_body, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'MULTI_DAY_PATCH_ANCHOR_NOT_UNIQUE: fn_refuse_new_entries_while_frozen' USING ERRCODE = '55000';
  END IF;
  v_patched := replace(v_body, v_anchor,
E'    /* A BAGGED EVENT RESUMES ONLY THROUGH ITS STAGE RESUME RECEIPT\n'
 '       (multi-day, 20260924043224). The private resume completion RPC sets\n'
 '       this exact transaction-local marker, the incomplete receipt proves\n'
 '       which resume it completes, and its begin already took the\n'
 '       maintenance barrier. Every other write into RUNNING still raises. */\n'
 '    IF OLD.status = ''BAGGED''\n'
 '       AND EXISTS (\n'
 '         SELECT 1\n'
 '           FROM public.tournament_stage_resume_receipts r\n'
 '          WHERE r.tournament_id = NEW.id\n'
 '            AND r.completed_at IS NULL\n'
 '            AND current_setting(''app.atomic_stage_resume'', true)\n'
 '                = NEW.id::text || '':'' || r.resume_id::text\n'
 '       ) THEN\n'
 '      RETURN NEW;\n'
 '    END IF;\n' || v_anchor);
  EXECUTE replace(v_definition, v_body, v_patched);
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_oid) IS DISTINCT FROM 'e8c94fe07905dee54ecbccde538ce7f0' THEN
    RAISE EXCEPTION 'MULTI_DAY_PATCH_RESULT_DRIFT: fn_refuse_new_entries_while_frozen' USING ERRCODE = '55000';
  END IF;

  -- 5. fn_tournament_live_seat_acquisition_requires_authority
  v_oid := 'public.fn_tournament_live_seat_acquisition_requires_authority()'::regprocedure;
  SELECT p.prosrc, pg_get_functiondef(p.oid) INTO v_body, v_definition
    FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
  IF md5(v_body) IS DISTINCT FROM '5a60bdd761aaaaad4b3bf982a3c50f6e' THEN
    RAISE EXCEPTION 'MULTI_DAY_PATCH_SOURCE_DRIFT: fn_tournament_live_seat_acquisition_requires_authority is %, expected 5a60bdd761aaaaad4b3bf982a3c50f6e', md5(v_body)
      USING ERRCODE = '55000';
  END IF;
  v_anchor := E'  IF v_tournament_status NOT IN (''ANNOUNCED'',''REGISTERING'',''RUNNING'') THEN\n';
  IF (length(v_body) - length(replace(v_body, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'MULTI_DAY_PATCH_ANCHOR_NOT_UNIQUE: fn_tournament_live_seat_acquisition_requires_authority' USING ERRCODE = '55000';
  END IF;
  v_patched := replace(v_body, v_anchor,
E'  -- A BAGGED event takes back its bagged players only inside its stage\n'
 '  -- resume (multi-day, 20260924043224): exact marker, incomplete receipt.\n'
 '  IF v_tournament_status NOT IN (''ANNOUNCED'',''REGISTERING'',''RUNNING'')\n'
 '     AND NOT (v_tournament_status = ''BAGGED''\n'
 '              AND EXISTS (\n'
 '                SELECT 1\n'
 '                  FROM public.tournament_stage_resume_receipts r\n'
 '                 WHERE r.tournament_id = v_tournament_id\n'
 '                   AND r.completed_at IS NULL\n'
 '                   AND current_setting(''app.atomic_stage_resume'', true)\n'
 '                       = v_tournament_id::text || '':'' || r.resume_id::text)) THEN\n');
  EXECUTE replace(v_definition, v_body, v_patched);
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_oid) IS DISTINCT FROM 'e234a1ad46b2682cc25d8877e155a17a' THEN
    RAISE EXCEPTION 'MULTI_DAY_PATCH_RESULT_DRIFT: fn_tournament_live_seat_acquisition_requires_authority' USING ERRCODE = '55000';
  END IF;
END
$patch$;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conrelid = 'public.tournaments'::regclass
                    AND c.conname = 'tournaments_status_check'
                    AND NOT c.convalidated
                    AND pg_get_constraintdef(c.oid) LIKE '%''BAGGED''::text%') THEN
    RAISE EXCEPTION 'MULTI_DAY_STATUS_CHECK_NOT_INSTALLED' USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
         AND t.tgname IN ('trg_tournaments_bagged_status_door',
                          'trg_tournament_players_bagged_custody_fence',
                          'zz_freeze_launch_guard')) <> 3 THEN
    RAISE EXCEPTION 'MULTI_DAY_DOORS_NOT_ATTACHED' USING ERRCODE = '55000';
  END IF;
END
$post$;

COMMIT;
