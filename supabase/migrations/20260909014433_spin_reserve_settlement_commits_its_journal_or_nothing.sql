-- 20260909014433_spin_reserve_settlement_commits_its_journal_or_nothing.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A live Spin (781cc0ee-6a1d-4e31-acaf-4e737661bba1) moved its 3.00 draw
-- out of spin_bonus_pools and wrote the authoritative jackpot_draw row, but
-- fn_ca_autoledger timed out while inserting the matching chip_ledger leg.
-- The trigger caught that exception and allowed the bank update to commit.
-- The escrow therefore never received reserve_in, the winner could not be
-- paid, and a later back-pay sweep was expected to repair the split state.
--
-- The platform-wide strict auto-ledger migration removes that failure mode at
-- the root for every balance store. This migration consumes, but never
-- redefines, that global authority:
--   1. the installed strict fn_ca_autoledger makes every reserve bank write,
--      journal leg and escrow side effect commit together or all roll back;
--   2. every new contribution/jackpot_draw reserve row must already have its
--      exact journal leg in the same transaction;
--   3. the public engine door draws and settles while retaining one reserve
--      lock. It never double-counts the current game's contribution and it
--      returns only after the reserve row, journal leg and escrow agree;
--   4. the two lower-level money functions become owner-only primitives.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '15s';

DO $preflight$
DECLARE
  v_autoledger_hash text;
BEGIN
  IF to_regclass('public.spin_bonus_pools') IS NULL
     OR to_regclass('public.spin_reserve_ledger') IS NULL
     OR to_regclass('public.chip_ledger') IS NULL
     OR to_regclass('public.tournament_escrow') IS NULL
     OR to_regclass('public.tournament_obligations') IS NULL
     OR to_regclass('public.tournament_payouts') IS NULL
     OR to_regclass('public.wallet_transactions') IS NULL
     OR to_regclass('public.club_members') IS NULL
     OR to_regclass('public.financial_alerts') IS NULL
     OR to_regclass('public.ca_drift_incidents') IS NULL
     OR to_regclass('public.tables') IS NULL
     OR to_regclass('public.table_seats') IS NULL
     OR to_regclass('public.tournament_players') IS NULL
     OR to_regclass('public.tournament_launch_receipts') IS NULL
     OR to_regclass('public.hand_history') IS NULL
     OR to_regclass('cron.job') IS NULL
     OR to_regprocedure('public.fn_ca_autoledger()') IS NULL
     OR to_regprocedure('public.fn_ca_guard_seat_creation()') IS NULL
     OR to_regprocedure('public.fn_entry_purchases_frozen()') IS NULL
     OR to_regprocedure('public.fn_lock_daily_mission_user(uuid)') IS NULL
     OR to_regprocedure('public.fn_seat_change_syncs_seat_first_count()') IS NULL
     OR to_regprocedure('public.fn_credit_stalled_seat_first_stacks()') IS NULL
     OR to_regprocedure('public.fn_spin_book_entry(uuid)') IS NULL
     OR to_regprocedure('public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)') IS NULL
     OR to_regprocedure('public.fn_spin_rake_rate(numeric)') IS NULL
     OR to_regprocedure('public.fn_spin_reserve_pool(uuid)') IS NULL
     OR to_regprocedure('public.fn_tournament_primary_table(uuid)') IS NULL
     OR to_regprocedure('public.fn_ca_declare_ledger(text,text,uuid,uuid,text,text[])') IS NULL
     OR to_regprocedure('public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)') IS NULL
     OR to_regprocedure('public.fn_sync_seat_first_player_count(uuid)') IS NULL
     OR to_regprocedure('public.fn_take_seat_and_buy_in(uuid,integer)') IS NULL
     OR to_regprocedure('public.fn_seat_horse_in_seat_first_game(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_seat_late_registrant(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_register_for_tournament(uuid)') IS NULL
     OR to_regprocedure('public.fn_register_for_tournament(uuid,boolean)') IS NULL
     OR to_regprocedure('public.fn_register_for_tournament_with_ticket(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_register_horse_for_tournament(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_register_horse_for_tournament(uuid,uuid,boolean)') IS NULL THEN
    RAISE EXCEPTION 'atomic Spin cutover dependencies are missing';
  END IF;

  SELECT md5(pg_get_functiondef(
           'public.fn_ca_autoledger()'::regprocedure))
    INTO v_autoledger_hash;
  IF v_autoledger_hash IS DISTINCT FROM
       '2ff8923b4c2d8fd3d343cf37acce0f2c' THEN
    RAISE EXCEPTION
      'Spin requires the audited platform-wide strict fn_ca_autoledger from 20260908024909';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'spin_reserve_ledger'
       AND indexname = 'uq_spin_ledger_one_booking_per_game'
  ) THEN
    RAISE EXCEPTION 'one contribution/draw per Spin unique index is missing';
  END IF;

  -- There is no safe automatic interpretation for an in-flight legacy draw
  -- that moved the reserve without its exact leg. Completed damage is handled
  -- by the asserted correction below; an active event must stop this deploy.
  IF EXISTS (
    SELECT 1
      FROM public.tournaments t
      JOIN public.spin_reserve_ledger r
        ON r.tournament_id = t.id AND r.kind = 'jackpot_draw'
      JOIN public.spin_bonus_pools bp ON bp.club_id = r.club_id
     WHERE upper(COALESCE(t.status::text,'')) NOT IN
             ('COMPLETED','CANCELLED','CANCELED')
       AND NOT EXISTS (
         SELECT 1 FROM public.chip_ledger l
          WHERE l.category = 'spin_prize'
            AND l.from_type = 'spin_reserve'
            AND l.from_entity_id = bp.id
            AND l.to_type = 'prize_liability'
            AND l.to_entity_id = t.id
            AND l.amount = round(-r.amount, 2)
       )
  ) THEN
    RAISE EXCEPTION
      'an active Spin already has a reserve draw without its exact journal leg';
  END IF;
END;
$preflight$;

-- Record whether this is the production cutover before repairing either
-- audited incident. Stage two uses this owner-only row as its durable boundary
-- and will not retire the repair payer in production until a different Spin
-- has produced a complete receipt through the new atomic authority.
CREATE TABLE public.tournament_spin_settlement_cutover (
  authority                  text PRIMARY KEY
                                  CHECK (authority = 'fn_spin_draw_and_settle:v1'),
  migration_version          text NOT NULL
                                  CHECK (migration_version = '20260909014433'),
  installed_at               timestamptz NOT NULL,
  audited_tournament_ids     uuid[] NOT NULL,
  production_requires_receipt boolean GENERATED ALWAYS AS
                                  (cardinality(audited_tournament_ids) > 0) STORED,
  CHECK (audited_tournament_ids <@ ARRAY[
    '781cc0ee-6a1d-4e31-acaf-4e737661bba1'::uuid,
    '6d688095-c3c5-4d40-a5a0-952934667732'::uuid
  ])
);

ALTER TABLE public.tournament_spin_settlement_cutover
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_spin_settlement_cutover
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.tournament_spin_settlement_cutover (
  authority, migration_version, installed_at, audited_tournament_ids)
SELECT
  'fn_spin_draw_and_settle:v1',
  '20260909014433',
  transaction_timestamp(),
  ARRAY(
    SELECT expected.id
      FROM (VALUES
        ('781cc0ee-6a1d-4e31-acaf-4e737661bba1'::uuid),
        ('6d688095-c3c5-4d40-a5a0-952934667732'::uuid)
      ) AS expected(id)
     WHERE EXISTS (
       SELECT 1 FROM public.tournaments t WHERE t.id = expected.id)
     ORDER BY expected.id
  );

COMMENT ON TABLE public.tournament_spin_settlement_cutover IS
  'Owner-only stage-one boundary. Production stage two requires a complete three-seat atomic receipt from a different Spin after installed_at.';

-- Do not replace fn_ca_autoledger here. The earlier platform migration owns
-- its globally strict body; a later feature migration that restores the old
-- catch-and-continue implementation would reopen unjournaled movement for
-- every bank, not just Spin.

-- A paid tournament seat is valid at birth or the statement is refused. The
-- old guard asked who the caller was before asking whether a tournament seat
-- carried real chips, so service_role, pg_cron and migrations could insert a
-- zero placeholder and leave a later timer to repair it. Caller identity can
-- authorize a funded write; it can never waive the data invariant.
CREATE OR REPLACE FUNCTION public.fn_ca_guard_seat_creation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $seat_guard$
DECLARE
  v_path text;
  v_creating boolean;
  v_tournament_id uuid;
  v_variant text;
  v_max_players integer;
  v_starting_chips numeric;
BEGIN
  v_creating := (TG_OP = 'INSERT' AND NEW.left_at IS NULL)
             OR (TG_OP = 'UPDATE' AND OLD.left_at IS NOT NULL AND NEW.left_at IS NULL);
  IF NOT v_creating THEN
    RETURN NEW;
  END IF;

  SELECT tb.tournament_id, t.variant, t.max_players, t.starting_chips
    INTO v_tournament_id, v_variant, v_max_players, v_starting_chips
    FROM public.tables tb
    LEFT JOIN public.tournaments t ON t.id = tb.tournament_id
   WHERE tb.id = NEW.table_id;

  IF v_tournament_id IS NOT NULL THEN
    IF NEW.stack IS NULL
       OR NEW.stack::text IN ('NaN','Infinity','-Infinity')
       OR NEW.stack <= 0 THEN
      RAISE EXCEPTION
        'TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK: tournament %, table %, seat %, stack %',
        v_tournament_id, NEW.table_id, NEW.seat_number, NEW.stack
        USING ERRCODE = 'check_violation',
              HINT = 'Create or revive the seat with its paid positive stack in the same database transaction.';
    END IF;

    IF lower(COALESCE(v_variant,'')) = 'spin'
       OR COALESCE(v_max_players,0) <= 2 THEN
      IF v_starting_chips IS NULL
         OR v_starting_chips::text IN ('NaN','Infinity','-Infinity')
         OR v_starting_chips <= 0 THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STARTING_CHIPS_INVALID: tournament %, starting_chips %',
          v_tournament_id, v_starting_chips
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.stack IS DISTINCT FROM v_starting_chips THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS: tournament %, table %, seat %, stack %, expected %',
          v_tournament_id, NEW.table_id, NEW.seat_number, NEW.stack, v_starting_chips
          USING ERRCODE = 'check_violation',
                HINT = 'The paid seat transaction is the only starting-stack authority; no later top-up exists.';
      END IF;
    END IF;
  END IF;

  -- Cash seats with no funded stack preserve their existing reservation path.
  IF COALESCE(NEW.stack,0) <= 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_caller_is_engine() THEN
    RETURN NEW;
  END IF;

  v_path := current_setting('app.money_path', true);
  IF v_path IN ('atomic_table_buyin', 'fn_take_seat_and_buy_in',
                'fn_seat_horse_in_seat_first_game', 'fn_seat_late_registrant',
                'fn_assign_tournament_player_seat_atomic',
                'fn_horse_seat_from_treasury') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'SEAT_NOT_FUNDED: chips may only reach a seat through the engine or a declared money path (path=%, jwt_role=%, app=%, table=%, seat=%, stack=%)',
    COALESCE(NULLIF(v_path, ''), 'none'),
    COALESCE(auth.role(), 'none'),
    COALESCE(NULLIF(current_setting('application_name', true), ''), 'none'),
    NEW.table_id, NEW.seat_number, NEW.stack
    USING ERRCODE = 'check_violation',
          HINT = 'The caller must debit a wallet or treasury and declare app.money_path, or be the engine.';
END;
$seat_guard$;

REVOKE ALL ON FUNCTION public.fn_ca_guard_seat_creation()
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.fn_ca_guard_seat_creation() IS
  'BEFORE-seat authority. Every live tournament seat is positive; every canonical seat-first seat exactly equals tournaments.starting_chips before any caller authorization is considered.';

-- A tournament seat can be born only below one root lock. The old seat-first
-- purchase wrappers, registration wrappers and manager SQL all reached a
-- tournament/table/seat row before fn_sync_seat_first_player_count tried to
-- acquire the terminal-settlement lock. Terminal completion takes that global
-- lock first and then the same parents, so the AFTER-seat sync formed the
-- opposite half of a real deadlock. This helper is deliberately owner-only:
-- public doors below enter here before delegating, and raw service-role DML is
-- rejected by the BEFORE trigger installed after them.
--
-- Daily Missions must stay ahead of every tournament/roster/seat row for a
-- registered -> playing transition. A hand owns that player mutex first. The
-- helper therefore preserves the complete order:
--
--   terminal global -> maintenance shared -> daily-mission user
--     -> launch receipt -> tournament
--
-- It uses ordinary blocking row locks. There is no NOWAIT/deadlock retry or
-- watcher; every canonical writer joins the same hierarchy at its true root.
CREATE OR REPLACE FUNCTION public.fn_ca_lock_tournament_seat_acquisition(
  p_tournament_id uuid,
  p_table_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $seat_acquisition_lock$
DECLARE
  v_tournament_id uuid:=p_tournament_id;
  v_table_tournament_id uuid;
  v_status text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM pg_advisory_xact_lock_shared(530090,1);

  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;

  IF p_user_id IS NOT NULL THEN
    PERFORM public.fn_lock_daily_mission_user(p_user_id);
  END IF;

  IF p_table_id IS NOT NULL THEN
    SELECT tb.tournament_id INTO v_table_tournament_id
      FROM public.tables tb
     WHERE tb.id=p_table_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok',false,'reason','table_not_found');
    END IF;
    IF v_table_tournament_id IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','not_a_tournament_table');
    END IF;
    IF v_tournament_id IS NOT NULL
       AND v_tournament_id IS DISTINCT FROM v_table_tournament_id THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','table_tournament_mismatch');
    END IF;
    v_tournament_id:=v_table_tournament_id;
  END IF;

  IF v_tournament_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_or_table_required');
  END IF;

  -- Launch completion already owns receipt -> tournament. Re-entering these
  -- locks from every seat root makes the historical aa_ launch-proof trigger
  -- a no-op lock acquisition rather than a late inversion.
  PERFORM r.tournament_id
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id=v_tournament_id
   ORDER BY r.tournament_id
   FOR UPDATE;

  SELECT upper(COALESCE(t.status::text,'')) INTO v_status
    FROM public.tournaments t
   WHERE t.id=v_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF v_status NOT IN ('ANNOUNCED','REGISTERING','RUNNING') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_seatable','status',v_status);
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'tournament_id',v_tournament_id,
    'table_id',p_table_id,'status',v_status);
END;
$seat_acquisition_lock$;

REVOKE ALL ON FUNCTION public.fn_ca_lock_tournament_seat_acquisition(
  uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION public.fn_ca_lock_tournament_seat_acquisition(
  uuid,uuid,uuid) IS
  'Owner-only root lock for every tournament seat create/revive path. Global terminal lock, maintenance boundary, Daily Missions player lock, launch receipt and tournament parent are acquired before child rows.';

-- Preserve each audited implementation under a private name, then put the
-- root lock above it. ALTER RENAME is structural ownership, not a function-
-- body overlay: the installed implementation stays byte-for-byte and there is
-- no pg_get_functiondef/string replacement escape hatch.
DO $wrap_take_seat_for_terminal_authority$
BEGIN
  IF to_regprocedure(
       'public.fn_take_seat_and_buy_in_before_terminal_seat_gate(uuid,integer)')
     IS NULL THEN
    ALTER FUNCTION public.fn_take_seat_and_buy_in(uuid,integer)
      RENAME TO fn_take_seat_and_buy_in_before_terminal_seat_gate;
  END IF;
END;
$wrap_take_seat_for_terminal_authority$;

REVOKE ALL ON FUNCTION
  public.fn_take_seat_and_buy_in_before_terminal_seat_gate(uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_take_seat_and_buy_in(
  p_table_id uuid,
  p_seat_number integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions','pg_temp'
SET statement_timeout TO '30s'
AS $take_seat_terminal_gate$
DECLARE
  v_gate jsonb;
BEGIN
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    NULL,p_table_id,auth.uid());
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  RETURN public.fn_take_seat_and_buy_in_before_terminal_seat_gate(
    p_table_id,p_seat_number);
END;
$take_seat_terminal_gate$;

REVOKE ALL ON FUNCTION public.fn_take_seat_and_buy_in(uuid,integer)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_take_seat_and_buy_in(uuid,integer)
  TO authenticated,service_role;

DO $wrap_horse_seat_for_terminal_authority$
BEGIN
  IF to_regprocedure(
       'public.fn_seat_horse_in_seat_first_game_before_terminal_seat_gate(uuid,uuid)')
     IS NULL THEN
    ALTER FUNCTION public.fn_seat_horse_in_seat_first_game(uuid,uuid)
      RENAME TO fn_seat_horse_in_seat_first_game_before_terminal_seat_gate;
  END IF;
END;
$wrap_horse_seat_for_terminal_authority$;

REVOKE ALL ON FUNCTION
  public.fn_seat_horse_in_seat_first_game_before_terminal_seat_gate(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_seat_horse_in_seat_first_game(
  p_tournament_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $horse_seat_terminal_gate$
DECLARE
  v_gate jsonb;
BEGIN
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  RETURN public.fn_seat_horse_in_seat_first_game_before_terminal_seat_gate(
    p_tournament_id,p_user_id);
END;
$horse_seat_terminal_gate$;

REVOKE ALL ON FUNCTION public.fn_seat_horse_in_seat_first_game(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_seat_horse_in_seat_first_game(uuid,uuid)
  TO service_role;

DO $wrap_late_seat_for_terminal_authority$
BEGIN
  IF to_regprocedure(
       'public.fn_seat_late_registrant_before_terminal_seat_gate(uuid,uuid)')
     IS NULL THEN
    ALTER FUNCTION public.fn_seat_late_registrant(uuid,uuid)
      RENAME TO fn_seat_late_registrant_before_terminal_seat_gate;
  END IF;
END;
$wrap_late_seat_for_terminal_authority$;

REVOKE ALL ON FUNCTION
  public.fn_seat_late_registrant_before_terminal_seat_gate(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_seat_late_registrant(
  p_tournament_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $late_seat_terminal_gate$
DECLARE
  v_gate jsonb;
BEGIN
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  RETURN public.fn_seat_late_registrant_before_terminal_seat_gate(
    p_tournament_id,p_user_id);
END;
$late_seat_terminal_gate$;

REVOKE ALL ON FUNCTION public.fn_seat_late_registrant(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_seat_late_registrant(uuid,uuid)
  TO service_role;

DO $wrap_registration_for_terminal_authority$
BEGIN
  IF to_regprocedure(
       'public.fn_register_for_tournament_before_terminal_seat_gate(uuid,boolean)')
     IS NULL THEN
    ALTER FUNCTION public.fn_register_for_tournament(uuid,boolean)
      RENAME TO fn_register_for_tournament_before_terminal_seat_gate;
  END IF;
END;
$wrap_registration_for_terminal_authority$;

REVOKE ALL ON FUNCTION
  public.fn_register_for_tournament_before_terminal_seat_gate(uuid,boolean)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_register_for_tournament(
  p_tournament_id uuid,
  p_seat_first_internal boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $registration_terminal_gate$
DECLARE
  v_gate jsonb;
BEGIN
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,auth.uid());
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  RETURN public.fn_register_for_tournament_before_terminal_seat_gate(
    p_tournament_id,p_seat_first_internal);
END;
$registration_terminal_gate$;

REVOKE ALL ON FUNCTION public.fn_register_for_tournament(uuid,boolean)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_register_for_tournament(uuid,boolean)
  TO service_role;

-- Recompile the authenticated compatibility door against the new public
-- two-argument wrapper. This removes any dependency/cached-plan ambiguity
-- after ALTER FUNCTION renamed the prior implementation in this transaction.
CREATE OR REPLACE FUNCTION public.fn_register_for_tournament(
  p_tournament_id uuid
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $registration_terminal_gate_compat$
  SELECT public.fn_register_for_tournament(p_tournament_id,false)
$registration_terminal_gate_compat$;

REVOKE ALL ON FUNCTION public.fn_register_for_tournament(uuid)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_register_for_tournament(uuid)
  TO authenticated,service_role;

-- 20260909014421 adds noncash ticket admission. Its owner-only core already
-- takes the terminal global lock before money rows, but it did not prelock the
-- launch receipt before its tournament row. Wrap the authenticated door here;
-- every late ticket seat now reaches the same receipt -> tournament prefix.
DO $wrap_ticket_registration_for_terminal_authority$
BEGIN
  IF to_regprocedure(
       'public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid)')
     IS NULL THEN
    ALTER FUNCTION public.fn_register_for_tournament_with_ticket(uuid,uuid)
      RENAME TO fn_register_for_tournament_with_ticket_before_terminal_gate;
  END IF;
END;
$wrap_ticket_registration_for_terminal_authority$;

REVOKE ALL ON FUNCTION
  public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_register_for_tournament_with_ticket(
  p_tournament_id uuid,
  p_ticket_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $ticket_registration_terminal_gate$
DECLARE
  v_gate jsonb;
BEGIN
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,auth.uid());
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  RETURN public.fn_register_for_tournament_with_ticket_before_terminal_gate(
    p_tournament_id,p_ticket_id);
END;
$ticket_registration_terminal_gate$;

REVOKE ALL ON FUNCTION
  public.fn_register_for_tournament_with_ticket(uuid,uuid)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION
  public.fn_register_for_tournament_with_ticket(uuid,uuid)
  TO authenticated,service_role;

-- The service-only three-argument horse registration door can also choose a
-- ticket and late-seat the beneficiary. The two-argument compatibility door
-- delegates to this exact signature, so one wrapper closes both call paths.
DO $wrap_horse_registration_for_terminal_authority$
BEGIN
  IF to_regprocedure(
       'public.fn_register_horse_for_tournament_before_terminal_gate(uuid,uuid,boolean)')
     IS NULL THEN
    ALTER FUNCTION public.fn_register_horse_for_tournament(uuid,uuid,boolean)
      RENAME TO fn_register_horse_for_tournament_before_terminal_gate;
  END IF;
END;
$wrap_horse_registration_for_terminal_authority$;

REVOKE ALL ON FUNCTION
  public.fn_register_horse_for_tournament_before_terminal_gate(uuid,uuid,boolean)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament(
  p_tournament_id uuid,
  p_user_id uuid,
  p_allow_wallet_charge boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions','pg_temp'
SET statement_timeout TO '30s'
AS $horse_registration_terminal_gate$
DECLARE
  v_gate jsonb;
BEGIN
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  RETURN public.fn_register_horse_for_tournament_before_terminal_gate(
    p_tournament_id,p_user_id,p_allow_wallet_charge);
END;
$horse_registration_terminal_gate$;

REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(
  uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_register_horse_for_tournament(
  uuid,uuid,boolean) TO service_role;

-- The rolling two-argument horse caller has no separate implementation. Keep
-- it as an explicit direct delegate to the newly terminal-ordered 3-arg root.
CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament(
  p_tournament_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $horse_registration_terminal_gate_compat$
  SELECT public.fn_register_horse_for_tournament(
    p_tournament_id,p_user_id,true)
$horse_registration_terminal_gate_compat$;

REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_register_horse_for_tournament(uuid,uuid)
  TO service_role;

-- The manager used to create/revive a seat, update its roster link and then
-- write tables.current_players in three independent PostgREST transactions.
-- A failure between them produced a live seat with a lying roster or a roster
-- pointing at no seat. Keep the complete write/proof body in one owner-only
-- core so both the service manager and the authenticated rebuy transaction can
-- use the SAME implementation after entering through the root lock above.
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_seat_cap(
  p_tournament_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $tournament_seat_cap$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_variant text;
  v_format text;
  v_cap integer;
BEGIN
  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
  END IF;
  v_variant:=lower(COALESCE(NULLIF(v_t.game_type,''),'nlh'));
  v_format:=lower(COALESCE(v_t.variant,''));
  v_cap:=CASE
    WHEN v_format='spin' OR upper(COALESCE(v_t.tournament_type,''))='SPIN'
      THEN 3
    WHEN v_format='sng' OR upper(COALESCE(v_t.tournament_type,''))='SNG'
      THEN LEAST(COALESCE(NULLIF(v_t.max_players,0),6),9)
    ELSE LEAST(COALESCE(NULLIF(v_t.table_size,0),9),10)
  END;
  v_cap:=LEAST(v_cap,CASE v_variant
    WHEN 'plo5' THEN 9
    WHEN 'plo6' THEN 7
    ELSE 10
  END);
  RETURN GREATEST(v_cap,2);
END;
$tournament_seat_cap$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_seat_cap(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_assign_tournament_player_seat_locked(
  p_tournament_id uuid,
  p_user_id uuid,
  p_table_id uuid,
  p_seat_number integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $locked_tournament_seat_assignment$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_tp public.tournament_players%ROWTYPE;
  v_table public.tables%ROWTYPE;
  v_live public.table_seats%ROWTYPE;
  v_destination public.table_seats%ROWTYPE;
  v_live_count integer;
  v_stack numeric;
  v_cap integer;
  v_seat_id uuid;
  v_current_players integer;
  v_rows integer;
  v_assigned_at timestamptz;
  v_expected_club_id uuid;
  v_expected_horse_id uuid;
  -- Fresh tournament-seat defaults. A rebuy that keeps its live chair keeps
  -- its own persisted bank; only a newly inserted/revived occupant starts the
  -- same 30-second/four-use state as a physical INSERT.
  v_time_bank_uses integer:=4;
  v_time_bank_seconds integer:=30;
  v_previous_money_path text:=current_setting('app.money_path',true);
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL OR p_table_id IS NULL
     OR p_seat_number IS NULL OR p_seat_number NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'tournament, player, table and legal seat are required'
      USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id;
  IF upper(COALESCE(v_t.status::text,'')) NOT IN ('REGISTERING','RUNNING') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_assignable',
      'status',upper(COALESCE(v_t.status::text,'')));
  END IF;
  v_cap:=public.fn_ca_tournament_seat_cap(p_tournament_id);

  -- Lock the beneficiary and every roster row claiming the requested
  -- coordinate before any table/seat row. This matches terminal settlement's
  -- tournament -> roster -> tables -> seats child order.
  PERFORM tp.id
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND (tp.user_id=p_user_id
       OR (tp.table_id=p_table_id AND tp.seat_number=p_seat_number))
   ORDER BY tp.id
   FOR UPDATE;

  SELECT * INTO v_tp FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','player_not_registered');
  END IF;
  IF v_tp.status::text NOT IN ('registered','playing') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','player_not_assignable','status',v_tp.status::text);
  END IF;

  IF v_tp.status::text='registered' THEN
    v_stack:=COALESCE(v_t.starting_chips,0)
             +GREATEST(COALESCE(v_tp.chips,0),0);
  ELSE
    v_stack:=COALESCE(v_tp.chips,0);
  END IF;
  IF v_stack::text IN ('NaN','Infinity','-Infinity')
     OR v_stack<=0 OR v_stack<>trunc(v_stack)
     OR v_stack>2147483647 THEN
    RETURN jsonb_build_object('ok',false,'reason','player_stack_invalid');
  END IF;

  SELECT * INTO v_table FROM public.tables tb
   WHERE tb.id=p_table_id
   FOR UPDATE;
  IF NOT FOUND OR v_table.tournament_id IS DISTINCT FROM p_tournament_id THEN
    RETURN jsonb_build_object('ok',false,'reason','table_tournament_mismatch');
  END IF;
  IF lower(COALESCE(v_table.status::text,'')) NOT IN
       ('waiting','running','active')
     OR COALESCE(v_table.is_deleted,false)
     OR p_seat_number>LEAST(
          v_cap,GREATEST(2,COALESCE(NULLIF(v_table.max_players,0),v_cap))) THEN
    RETURN jsonb_build_object('ok',false,'reason','table_not_assignable');
  END IF;

  -- A physical row is reusable, but none of its former occupant's identity or
  -- per-session state is. Resolve every derived value while the tournament,
  -- roster and table rows are locked, then write the same complete shape for a
  -- new row and a revived row. Passing the old club_id through the seat stamp
  -- trigger would make it the preferred club and could attribute this entry to
  -- the departed occupant.
  v_expected_club_id:=public.fn_seat_club_for_user(
    p_user_id,p_table_id,v_tp.club_id);
  SELECT CASE WHEN COALESCE(p.is_horse,false) THEN p.id ELSE NULL END
    INTO v_expected_horse_id
    FROM public.profiles p
   WHERE p.id=p_user_id;

  PERFORM s.id
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL
   ORDER BY s.id
   FOR UPDATE OF s;
  SELECT count(*)::integer INTO v_live_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL;
  IF v_live_count>1 THEN
    RAISE EXCEPTION 'tournament player already owns multiple live seats'
      USING ERRCODE='P0404';
  END IF;
  IF v_live_count=1 THEN
    SELECT s.* INTO v_live
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND s.user_id=p_user_id AND s.left_at IS NULL
     FOR UPDATE OF s;
    IF v_live.table_id IS DISTINCT FROM p_table_id
       OR v_live.seat_number IS DISTINCT FROM p_seat_number THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','player_already_seated_elsewhere',
        'table_id',v_live.table_id,'seat_number',v_live.seat_number);
    END IF;
    SELECT count(*)::integer INTO v_current_players
      FROM public.table_seats s
     WHERE s.table_id=p_table_id AND s.left_at IS NULL;
    IF v_live.stack IS DISTINCT FROM v_stack
       OR v_tp.status::text<>'playing'
       OR v_tp.chips IS DISTINCT FROM v_stack::integer
       OR v_tp.table_id IS DISTINCT FROM p_table_id
       OR v_tp.seat_number IS DISTINCT FROM p_seat_number
       OR v_table.current_players IS DISTINCT FROM v_current_players
       OR v_live.joined_at IS NULL THEN
      RAISE EXCEPTION 'existing tournament assignment is not an exact receipt'
        USING ERRCODE='P0404';
    END IF;
    RETURN jsonb_build_object(
      'ok',true,'replayed',true,'tournament_id',p_tournament_id,
      'user_id',p_user_id,'table_id',p_table_id,
      'seat_id',v_live.id,'seat_number',p_seat_number,'stack',v_stack,
      'current_players',v_current_players,'assigned_at',v_live.joined_at);
  END IF;

  SELECT * INTO v_destination FROM public.table_seats s
   WHERE s.table_id=p_table_id AND s.seat_number=p_seat_number
   FOR UPDATE;
  IF FOUND AND v_destination.left_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','seat_taken');
  END IF;

  -- A departed occupant can still carry a stale roster coordinate. Correct
  -- that link inside this assignment transaction; never overwrite a live
  -- seat or leave two active roster rows claiming one chair.
  UPDATE public.tournament_players tp
     SET table_id=NULL,seat_number=NULL
   WHERE tp.tournament_id=p_tournament_id
     AND tp.user_id<>p_user_id
     AND tp.table_id=p_table_id AND tp.seat_number=p_seat_number;

  v_assigned_at:=clock_timestamp();
  PERFORM set_config(
    'app.money_path','fn_assign_tournament_player_seat_atomic',true);
  BEGIN
    IF v_destination.id IS NULL THEN
      INSERT INTO public.table_seats(
        table_id,user_id,player_id,member_id,seat_number,stack,status,
        joined_at,left_at,is_sitting_out,is_away,leave_pending,
        scheduled_leave_hands,horse_id,auto_rebuy,time_bank_remaining,
        time_bank_uses_remaining,club_id,sit_out_at,entry_hold,
        entry_post_agreed)
      VALUES(
        p_table_id,p_user_id,NULL,NULL,p_seat_number,v_stack,'active',
        v_assigned_at,NULL,false,false,false,NULL,v_expected_horse_id,false,
        v_time_bank_seconds,v_time_bank_uses,v_expected_club_id,NULL,NULL,
        false)
      RETURNING id INTO v_seat_id;
    ELSE
      UPDATE public.table_seats s
         SET user_id=p_user_id,player_id=NULL,member_id=NULL,stack=v_stack,
             status='active',joined_at=v_assigned_at,left_at=NULL,
             is_sitting_out=false,is_away=false,leave_pending=false,
             sit_out_at=NULL,scheduled_leave_hands=NULL,
             horse_id=v_expected_horse_id,entry_hold=NULL,
             entry_post_agreed=false,auto_rebuy=false,
             time_bank_remaining=v_time_bank_seconds,
             time_bank_uses_remaining=v_time_bank_uses,
             club_id=v_expected_club_id
       WHERE s.id=v_destination.id AND s.left_at IS NOT NULL
       RETURNING id INTO v_seat_id;
      IF v_seat_id IS NULL THEN
        RAISE EXCEPTION 'vacated tournament seat changed during assignment'
          USING ERRCODE='40001';
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config(
      'app.money_path',COALESCE(v_previous_money_path,''),true);
    RAISE;
  END;
  PERFORM set_config(
    'app.money_path',COALESCE(v_previous_money_path,''),true);

  UPDATE public.tournament_players tp
     SET status='playing',chips=v_stack::integer,
         table_id=p_table_id,seat_number=p_seat_number
   WHERE tp.id=v_tp.id AND tp.status::text IN ('registered','playing');
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament roster changed during seat assignment'
      USING ERRCODE='40001';
  END IF;

  SELECT count(*)::integer INTO v_current_players
    FROM public.table_seats s
   WHERE s.table_id=p_table_id AND s.left_at IS NULL;
  UPDATE public.tables tb
     SET current_players=v_current_players,updated_at=now()
   WHERE tb.id=p_table_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament table vanished during seat assignment'
      USING ERRCODE='40001';
  END IF;

  IF (SELECT count(*) FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND s.user_id=p_user_id AND s.left_at IS NULL)<>1
     OR NOT EXISTS(
       SELECT 1 FROM public.table_seats s
        WHERE s.id=v_seat_id AND s.table_id=p_table_id
          AND s.user_id=p_user_id AND s.seat_number=p_seat_number
          AND s.left_at IS NULL AND s.stack=v_stack
          AND s.player_id IS NULL AND s.member_id IS NULL
          AND s.horse_id IS NOT DISTINCT FROM v_expected_horse_id
          AND s.club_id IS NOT DISTINCT FROM v_expected_club_id
          AND s.time_bank_remaining=v_time_bank_seconds
          AND s.time_bank_uses_remaining=v_time_bank_uses
          AND NOT COALESCE(s.is_sitting_out,false)
          AND NOT COALESCE(s.is_away,false)
          AND NOT COALESCE(s.leave_pending,false)
          AND NOT COALESCE(s.auto_rebuy,false)
          AND s.sit_out_at IS NULL
          AND s.scheduled_leave_hands IS NULL
          AND s.entry_hold IS NULL
          AND NOT s.entry_post_agreed)
     OR NOT EXISTS(
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.id=v_tp.id AND tp.status::text='playing'
          AND tp.chips=v_stack::integer AND tp.table_id=p_table_id
          AND tp.seat_number=p_seat_number)
     OR NOT EXISTS(
       SELECT 1 FROM public.tables tb
        WHERE tb.id=p_table_id AND tb.tournament_id=p_tournament_id
          AND tb.current_players=v_current_players) THEN
    RAISE EXCEPTION 'atomic tournament seat assignment final proof is not exact'
      USING ERRCODE='P0404';
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'replayed',false,'tournament_id',p_tournament_id,
    'user_id',p_user_id,'table_id',p_table_id,'seat_id',v_seat_id,
    'seat_number',p_seat_number,'stack',v_stack,
    'current_players',v_current_players,'assigned_at',v_assigned_at);
END;
$locked_tournament_seat_assignment$;

REVOKE ALL ON FUNCTION public.fn_ca_assign_tournament_player_seat_locked(
  uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;

-- The externally callable manager door owns authorization and the complete
-- global/maintenance/mission/launch/tournament prefix. The private core above
-- cannot be invoked over PostgREST, while the rebuy authority below can reuse
-- it without pretending that a browser JWT is the engine.
CREATE OR REPLACE FUNCTION public.fn_assign_tournament_player_seat_atomic(
  p_tournament_id uuid,
  p_user_id uuid,
  p_table_id uuid,
  p_seat_number integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $atomic_tournament_seat_assignment$
DECLARE
  v_gate jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_assign_tournament_player_seat_atomic requires service authority'
      USING ERRCODE='28000';
  END IF;
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,p_table_id,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  RETURN public.fn_ca_assign_tournament_player_seat_locked(
    p_tournament_id,p_user_id,p_table_id,p_seat_number);
END;
$atomic_tournament_seat_assignment$;

REVOKE ALL ON FUNCTION public.fn_assign_tournament_player_seat_atomic(
  uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_assign_tournament_player_seat_atomic(
  uuid,uuid,uuid,integer) TO service_role;

-- Choose one physical chair while the caller already owns the terminal root
-- and tournament row. Capacity creation, the chosen table row and any reused
-- chair row remain locked until the caller either commits the matching paid
-- seat or rolls its entire purchase back. This helper never assigns chips.
CREATE OR REPLACE FUNCTION public.fn_ca_choose_tournament_seat_locked(
  p_tournament_id uuid,
  p_user_id uuid,
  p_preferred_table_id uuid DEFAULT NULL,
  p_preferred_seat_number integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $choose_tournament_seat_locked$
DECLARE
  v_capacity jsonb;
  v_table_id uuid;
  v_tournament_cap integer;
  v_cap integer;
  v_seat_number integer;
  v_seat_id uuid;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'tournament and player are required for seat selection'
      USING ERRCODE='22023';
  END IF;

  v_capacity:=public.fn_ensure_late_registration_capacity(
    p_tournament_id,0);
  IF COALESCE((v_capacity->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'tournament capacity could not be established: %',
      COALESCE(v_capacity->>'reason','unknown') USING ERRCODE='55000';
  END IF;
  v_tournament_cap:=public.fn_ca_tournament_seat_cap(p_tournament_id);

  SELECT tb.id,
         LEAST(v_tournament_cap,
               GREATEST(2,COALESCE(NULLIF(tb.max_players,0),v_tournament_cap)))
    INTO v_table_id,v_cap
    FROM public.tables tb
   WHERE tb.tournament_id=p_tournament_id
     AND lower(COALESCE(tb.status,'')) IN ('running','waiting','active')
     AND NOT COALESCE(tb.is_deleted,false)
     AND EXISTS (
       SELECT 1
         FROM generate_series(
           1,LEAST(v_tournament_cap,
             GREATEST(2,COALESCE(NULLIF(tb.max_players,0),v_tournament_cap))))
           AS legal(seat_number)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.table_seats occupied
           WHERE occupied.table_id=tb.id
             AND occupied.seat_number=legal.seat_number
             AND occupied.left_at IS NULL))
   ORDER BY (
       SELECT count(*)
         FROM generate_series(
           1,LEAST(v_tournament_cap,
             GREATEST(2,COALESCE(NULLIF(tb.max_players,0),v_tournament_cap))))
           AS legal(seat_number)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.table_seats occupied
           WHERE occupied.table_id=tb.id
             AND occupied.seat_number=legal.seat_number
             AND occupied.left_at IS NULL)) DESC,
     (tb.id=p_preferred_table_id) DESC,
     tb.created_at,tb.id
   LIMIT 1
   FOR UPDATE OF tb;
  IF v_table_id IS NULL THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_CAPACITY_UNAVAILABLE: no legal chair exists for tournament %',
      p_tournament_id USING ERRCODE='55000';
  END IF;

  IF v_table_id=p_preferred_table_id
     AND p_preferred_seat_number BETWEEN 1 AND v_cap
     AND NOT EXISTS (
       SELECT 1 FROM public.table_seats occupied
        WHERE occupied.table_id=v_table_id
          AND occupied.seat_number=p_preferred_seat_number
          AND occupied.left_at IS NULL) THEN
    v_seat_number:=p_preferred_seat_number;
  ELSE
    SELECT legal.seat_number INTO v_seat_number
      FROM generate_series(1,v_cap) AS legal(seat_number)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.table_seats occupied
        WHERE occupied.table_id=v_table_id
          AND occupied.seat_number=legal.seat_number
          AND occupied.left_at IS NULL)
     ORDER BY legal.seat_number
     LIMIT 1;
  END IF;
  IF v_seat_number IS NULL THEN
    RAISE EXCEPTION 'chosen tournament table lost its legal chair'
      USING ERRCODE='40001';
  END IF;

  SELECT s.id INTO v_seat_id
    FROM public.table_seats s
   WHERE s.table_id=v_table_id AND s.seat_number=v_seat_number
   FOR UPDATE;

  RETURN jsonb_build_object(
    'ok',true,'tournament_id',p_tournament_id,'user_id',p_user_id,
    'table_id',v_table_id,'seat_number',v_seat_number,
    'physical_seat_id',v_seat_id,'capacity',v_capacity);
END;
$choose_tournament_seat_locked$;

REVOKE ALL ON FUNCTION public.fn_ca_choose_tournament_seat_locked(
  uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;

-- A service-role PostgREST INSERT/UPDATE used to bypass fn_ca_guard_seat_creation
-- before checking app.money_path. Caller identity is not lock provenance. This
-- earliest BEFORE trigger requires the transaction to already own the exact
-- global lock; it never acquires that lock after PostgreSQL has locked NEW/OLD.
CREATE OR REPLACE FUNCTION
  public.fn_tournament_live_seat_acquisition_requires_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $tournament_seat_acquisition_guard$
DECLARE
  v_tournament_id uuid;
  v_tournament_status text;
  v_key bigint:=hashtextextended(
    'ca:tournament-terminal-settlement:v1',0);
  v_owns_global boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL
       OR (OLD.left_at IS NULL
         AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
         AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id
         AND OLD.seat_number IS NOT DISTINCT FROM NEW.seat_number) THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT tb.tournament_id,upper(COALESCE(t.status::text,''))
    INTO v_tournament_id,v_tournament_status
    FROM public.tables tb
    LEFT JOIN public.tournaments t ON t.id=tb.tournament_id
   WHERE tb.id=NEW.table_id;
  IF v_tournament_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM pg_catalog.pg_locks l
     WHERE l.pid=pg_backend_pid()
       AND l.locktype='advisory'
       AND l.database=(
         SELECT d.oid FROM pg_catalog.pg_database d
          WHERE d.datname=current_database())
       AND l.classid=(((v_key>>32)&4294967295)::oid)
       AND l.objid=((v_key&4294967295)::oid)
       AND l.objsubid=1
       AND l.mode='ExclusiveLock'
       AND l.granted)
    INTO v_owns_global;
  IF NOT COALESCE(v_owns_global,false) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ACQUISITION_REQUIRES_TERMINAL_AUTHORITY'
      USING ERRCODE='55000',
            HINT='Use a canonical tournament seat purchase, registration, move, or assignment RPC.';
  END IF;
  IF v_tournament_status NOT IN ('ANNOUNCED','REGISTERING','RUNNING') THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ACQUISITION_CLOSED: tournament %, status %',
      v_tournament_id,v_tournament_status
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$tournament_seat_acquisition_guard$;

REVOKE ALL ON FUNCTION
  public.fn_tournament_live_seat_acquisition_requires_authority()
  FROM PUBLIC,anon,authenticated,service_role;

DROP TRIGGER IF EXISTS a0_tournament_live_seat_root_guard
  ON public.table_seats;
CREATE TRIGGER a0_tournament_live_seat_root_guard
  BEFORE INSERT OR UPDATE OF table_id,user_id,seat_number,left_at
  ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_tournament_live_seat_acquisition_requires_authority();

COMMENT ON FUNCTION
  public.fn_tournament_live_seat_acquisition_requires_authority() IS
  'Earliest BEFORE-seat fail-closed guard. A tournament seat create/revive or live identity/table change must enter with the terminal global transaction lock already held; raw service-role DML cannot bypass it.';

-- The public rebuy name accumulated four nested wrappers. A later lifecycle
-- wrapper accidentally skipped the only wrapper that closed the knockout
-- generation, and the money core could commit a paid positive roster without
-- a seat for a later manager sweep to discover. Preserve only the audited
-- debit/pool/rake primitive under one explicit owner-only name. The canonical
-- function below owns every gate, candidate, chair and receipt around it.
DO $rename_tournament_chip_purchase_money_core$
BEGIN
  IF to_regprocedure(
       'public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)')
       IS NULL THEN
    IF to_regprocedure(
         'public.process_tournament_rebuy_before_atomic_live_seat_lock(uuid,uuid,text,numeric,numeric,integer,text)')
         IS NULL THEN
      RAISE EXCEPTION 'audited tournament chip-purchase money core is missing';
    END IF;
    ALTER FUNCTION
      public.process_tournament_rebuy_before_atomic_live_seat_lock(
        uuid,uuid,text,numeric,numeric,integer,text)
      RENAME TO fn_ca_process_tournament_chip_purchase_money_v1;
  END IF;
END;
$rename_tournament_chip_purchase_money_core$;

-- One owner-only time policy feeds both accepted-hand prompt creation and the
-- purchase door. This closes the old split where level-bounded tournaments
-- received a prompt but minute-bounded tournaments received NULL forever.
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_rebuy_window(
  p_tournament_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $tournament_rebuy_window$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_now timestamptz:=clock_timestamp();
  v_level_cap integer;
  v_timed_deadline timestamptz;
  v_level_open boolean:=false;
  v_timed_open boolean:=false;
  v_addon_open boolean:=false;
  v_prompt_until timestamptz;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'tournament is required for rebuy-window policy'
      USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_t
    FROM public.tournaments t
   WHERE t.id=p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
  END IF;

  IF upper(COALESCE(v_t.status::text,''))<>'RUNNING'
     OR COALESCE(v_t.prize_pool_finalized,false)
     OR NOT (COALESCE(v_t.is_rebuy,false) OR COALESCE(v_t.is_reentry,false)) THEN
    RETURN jsonb_build_object(
      'open',false,'prompt_until',NULL,'reason','tournament_not_rebuyable');
  END IF;

  v_addon_open:=COALESCE(v_t.add_on_available,false)
    AND COALESCE(v_t.addon_period_triggered,false)
    AND v_t.addon_period_started_at IS NOT NULL
    AND v_t.addon_period_ends_at IS NOT NULL
    AND v_now>=v_t.addon_period_started_at
    AND v_now<v_t.addon_period_ends_at;
  v_level_cap:=COALESCE(
    NULLIF(v_t.rebuy_levels,0),NULLIF(v_t.late_reg_levels,0),0);
  v_level_open:=v_level_cap>0
    AND v_t.current_level IS NOT NULL
    AND v_t.current_level<v_level_cap;
  IF v_level_cap<=0 AND COALESCE(v_t.late_reg_mins,0)>0
     AND v_t.started_at IS NOT NULL THEN
    v_timed_deadline:=v_t.started_at+
      make_interval(mins=>v_t.late_reg_mins);
    v_timed_open:=v_now<v_timed_deadline;
  END IF;

  IF NOT (v_level_open OR v_timed_open OR v_addon_open) THEN
    RETURN jsonb_build_object(
      'open',false,'prompt_until',NULL,'reason','rebuy_window_closed',
      'level_cap',v_level_cap,'addon_open',v_addon_open);
  END IF;
  v_prompt_until:=LEAST(
    v_now+interval '30 seconds',
    GREATEST(
      CASE WHEN v_level_open THEN v_now+interval '30 seconds' END,
      CASE WHEN v_timed_open THEN v_timed_deadline END,
      CASE WHEN v_addon_open THEN v_t.addon_period_ends_at END));
  RETURN jsonb_build_object(
    'open',true,'prompt_until',v_prompt_until,'reason','open',
    'level_cap',v_level_cap,'level_open',v_level_open,
    'timed_open',v_timed_open,'addon_open',v_addon_open);
END;
$tournament_rebuy_window$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_rebuy_window(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

-- Re-emit the private money primitive instead of carrying the renamed body's
-- ordinal key, millisecond duplicate window, home-club substitution and legacy
-- price quote. Every supported call now arrives from the canonical authority
-- below with one exact token and the entry's persisted funding club. The raw
-- function remains owner-only and can commit only as part of that surrounding
-- debit + generation + seat + receipt transaction.
CREATE OR REPLACE FUNCTION public.fn_ca_process_tournament_chip_purchase_money_v1(
  p_tournament_id uuid,
  p_user_id uuid,
  p_rebuy_type text,
  p_cost numeric,
  p_chips numeric,
  p_current_level integer,
  p_client_token text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $tournament_chip_purchase_money$
DECLARE
  v_t record;
  v_p record;
  v_balance numeric;
  v_ratio numeric;
  v_is_bounty boolean;
  v_bounty_head numeric;
  v_base numeric;
  v_fee numeric;
  v_total numeric;
  v_add integer;
  v_new_chips integer;
  v_seat record;
  v_key text;
  v_inserted integer;
  v_cat text;
  v_club uuid;
  v_stack_after numeric;
  v_expected numeric;
  v_fee_ratio numeric;
  v_was_seated boolean:=false;
  v_rows integer;
  v_led_cat text;
  v_led_cp text;
  v_led_ent text;
  v_led_tid text;
BEGIN
  IF NOT (COALESCE(auth.role(),'service_role')='service_role')
     AND (auth.uid() IS NULL OR auth.uid()<>p_user_id) THEN
    RAISE EXCEPTION
      'process_tournament_rebuy: caller may only transact for themselves'
      USING ERRCODE='42501';
  END IF;
  IF p_rebuy_type NOT IN ('rebuy','reentry','addon') THEN
    RAISE EXCEPTION 'Invalid rebuy type: %',p_rebuy_type
      USING ERRCODE='22023';
  END IF;
  IF p_client_token IS NULL OR length(btrim(p_client_token))=0
     OR length(btrim(p_client_token))>128 THEN
    RAISE EXCEPTION 'exact tournament chip-purchase token is required'
      USING ERRCODE='22023';
  END IF;

  SELECT id,name,club_id,status,buy_in_amount,buy_in_fee,starting_chips,
         is_rebuy,is_reentry,add_on_available,addon_period_triggered,
         rebuy_cost,rebuy_chips,rebuy_levels,late_reg_levels,max_rebuys,
         max_reentries,addon_cost,addon_chips,addon_levels,current_level,
         prize_pool,is_bounty,is_pko,is_mystery_bounty,bounty_amount
    INTO v_t
    FROM public.tournaments
   WHERE id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
  END IF;
  IF v_t.status NOT IN ('RUNNING','REGISTERING','ANNOUNCED') THEN
    RAISE EXCEPTION 'Tournament is not accepting chip purchases (status %)',v_t.status;
  END IF;

  SELECT id,chips,status,prize,rebuys,add_on,table_id,club_id
    INTO v_p
    FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not registered in this tournament';
  END IF;
  IF v_p.status='eliminated' AND COALESCE(v_p.prize,0)>0 THEN
    RAISE EXCEPTION
      'Finishing Place Already Paid - A Rebuy Cannot Resurrect A Settled Result';
  END IF;
  v_club:=v_p.club_id;
  IF v_club IS NULL THEN
    RAISE EXCEPTION
      'Tournament entry funding club is missing; refusing a substituted wallet'
      USING ERRCODE='P0404';
  END IF;

  v_cat:=CASE WHEN p_rebuy_type='addon' THEN 'addon' ELSE 'rebuy' END;
  v_key:=CASE WHEN p_rebuy_type='addon'
    THEN 'tourney:'||p_tournament_id::text||':addon:'||p_user_id::text
    ELSE 'tourney:'||p_tournament_id::text||':'||p_rebuy_type||':'||
         p_user_id::text||':tok:'||btrim(p_client_token)
  END;

  IF p_rebuy_type='addon' THEN
    PERFORM 1
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE s.user_id=p_user_id AND s.left_at IS NULL
       AND tb.tournament_id=p_tournament_id
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'No Live Seat For This % - Aborting So No Charge Is Made',p_rebuy_type;
    END IF;
    IF NOT COALESCE(v_t.add_on_available,false) THEN
      RAISE EXCEPTION 'Add-ons are not offered in this tournament';
    END IF;
    IF COALESCE(v_p.add_on,false) THEN
      RAISE EXCEPTION 'Add-on already taken';
    END IF;
    v_base:=COALESCE(NULLIF(v_t.addon_cost,0),v_t.buy_in_amount,0);
    v_add:=COALESCE(NULLIF(v_t.addon_chips,0),v_t.starting_chips,0)::integer;
  ELSE
    IF p_rebuy_type='rebuy' AND NOT COALESCE(v_t.is_rebuy,false) THEN
      RAISE EXCEPTION 'Rebuys are not offered in this tournament';
    END IF;
    IF p_rebuy_type='reentry' AND NOT COALESCE(v_t.is_reentry,false) THEN
      RAISE EXCEPTION 'Re-entries are not offered in this tournament';
    END IF;
    IF p_rebuy_type='rebuy' AND v_t.max_rebuys IS NOT NULL
       AND COALESCE(v_p.rebuys,0)>=v_t.max_rebuys THEN
      RAISE EXCEPTION 'Rebuy limit reached (% of %)',v_p.rebuys,v_t.max_rebuys;
    END IF;
    IF p_rebuy_type='reentry' AND v_t.max_reentries IS NOT NULL
       AND COALESCE(v_p.rebuys,0)>=v_t.max_reentries THEN
      RAISE EXCEPTION
        'Re-entry limit reached (% of %)',v_p.rebuys,v_t.max_reentries;
    END IF;
    IF p_rebuy_type='rebuy'
       AND COALESCE(v_p.chips,0)>COALESCE(v_t.starting_chips,0) THEN
      RAISE EXCEPTION 'Stack too high for a rebuy';
    END IF;
    v_base:=COALESCE(NULLIF(v_t.rebuy_cost,0),v_t.buy_in_amount,0);
    v_add:=COALESCE(NULLIF(v_t.rebuy_chips,0),v_t.starting_chips,0)::integer;
  END IF;

  v_fee_ratio:=CASE
    WHEN COALESCE(v_t.buy_in_amount,0)+COALESCE(v_t.buy_in_fee,0)>0
         AND COALESCE(v_t.buy_in_fee,0)>0
      THEN v_t.buy_in_fee/(v_t.buy_in_amount+v_t.buy_in_fee)
    ELSE 0.1
  END;
  v_ratio:=CASE WHEN p_rebuy_type='addon' THEN 0 ELSE v_fee_ratio END;
  v_total:=round(v_base::numeric);
  -- The total stays a whole chip, while the house cut is floored to cents.
  -- Fractional fees are deliberate: a 1-chip entry pays 0.10 and a 5-chip
  -- entry pays 0.50 without ever exceeding the ten-percent ceiling.
  v_fee:=CASE WHEN v_ratio>0 AND v_total>0
    THEN LEAST(trunc(v_total*v_ratio*100+0.000001)/100,
               trunc(v_total*0.1*100+0.000001)/100)
    ELSE 0
  END;
  v_base:=round(v_total-v_fee,2);
  v_is_bounty:=COALESCE(v_t.is_bounty,false)
    OR COALESCE(v_t.is_pko,false)
    OR COALESCE(v_t.is_mystery_bounty,false);
  IF v_is_bounty AND p_rebuy_type<>'addon' THEN
    v_bounty_head:=LEAST(
      GREATEST(0,round(COALESCE(v_t.bounty_amount,0),2)),v_base);
    v_base:=v_base-v_bounty_head;
  ELSE
    v_bounty_head:=0;
  END IF;
  IF p_cost IS NOT NULL AND abs(p_cost-v_total)>0.01 THEN
    RAISE EXCEPTION
      'Price mismatch: client quoted %, server computed %',p_cost,v_total
      USING ERRCODE='22023';
  END IF;
  IF v_add<=0 OR v_total<0 OR v_fee<0 OR v_base<0 OR v_bounty_head<0
     OR round(v_base+v_bounty_head+v_fee,2)<>round(v_total,2) THEN
    RAISE EXCEPTION 'Tournament chip-purchase quote does not conserve'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
  VALUES(v_key,p_user_id,v_total)
  ON CONFLICT(key) DO NOTHING;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  IF v_inserted=0 THEN
    RETURN jsonb_build_object(
      'success',true,'idempotent',true,'new_stack',v_p.chips,
      'rebuy_type',p_rebuy_type);
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id,v_club);
  SELECT chip_balance INTO v_balance
    FROM public.club_members
   WHERE user_id=p_user_id AND club_id=v_club
   FOR UPDATE;
  IF v_balance IS NULL OR v_balance<v_total THEN
    RAISE EXCEPTION 'Insufficient club chips: need %, have %',
      v_total,COALESCE(v_balance,0);
  END IF;

  v_led_cat:=current_setting('app.ledger_category',true);
  v_led_cp:=current_setting('app.ledger_counterparty',true);
  v_led_ent:=current_setting('app.ledger_counterparty_entity',true);
  v_led_tid:=current_setting('app.ledger_tournament',true);
  PERFORM set_config('app.ledger_category',v_cat,true);
  PERFORM set_config('app.ledger_counterparty','prize_liability',true);
  PERFORM set_config(
    'app.ledger_counterparty_entity',p_tournament_id::text,true);
  PERFORM set_config('app.ledger_tournament',p_tournament_id::text,true);
  UPDATE public.club_members
     SET chip_balance=chip_balance-v_total,updated_at=now()
   WHERE user_id=p_user_id AND club_id=v_club;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'Exact tournament funding wallet changed during debit'
      USING ERRCODE='40001';
  END IF;
  PERFORM set_config('app.ledger_category',COALESCE(v_led_cat,''),true);
  PERFORM set_config('app.ledger_counterparty',COALESCE(v_led_cp,''),true);
  PERFORM set_config(
    'app.ledger_counterparty_entity',COALESCE(v_led_ent,''),true);
  PERFORM set_config('app.ledger_tournament',COALESCE(v_led_tid,''),true);

  IF p_rebuy_type='reentry' THEN
    UPDATE public.tournament_players
       SET chips=v_add,status='playing',eliminated_at=NULL,position=NULL,
           rebuys=COALESCE(rebuys,0)+1
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  ELSIF p_rebuy_type='addon' THEN
    UPDATE public.tournament_players
       SET chips=COALESCE(chips,0)+v_add,add_on=true
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  ELSE
    UPDATE public.tournament_players
       SET chips=COALESCE(chips,0)+v_add,status='playing',
           eliminated_at=NULL,position=NULL,
           rebuys=COALESCE(rebuys,0)+1
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  END IF;
  IF v_new_chips IS NULL THEN
    RAISE EXCEPTION 'Locked tournament roster changed during chip grant'
      USING ERRCODE='40001';
  END IF;

  IF v_bounty_head>0 THEN
    UPDATE public.tournament_players
       SET current_bounty=CASE WHEN p_rebuy_type='reentry'
         THEN v_bounty_head
         ELSE COALESCE(current_bounty,0)+v_bounty_head END
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id;
  END IF;

  SELECT s.id,s.stack INTO v_seat
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE s.user_id=p_user_id AND s.left_at IS NULL
     AND tb.tournament_id=p_tournament_id
   ORDER BY (tb.status IS DISTINCT FROM 'closed') DESC,
            s.joined_at DESC NULLS LAST,s.id DESC
   LIMIT 1;
  IF FOUND THEN
    v_was_seated:=true;
    UPDATE public.table_seats
       SET stack=CASE WHEN p_rebuy_type='reentry'
         THEN v_add ELSE COALESCE(stack,0)+v_add END
     WHERE id=v_seat.id
     RETURNING stack INTO v_stack_after;
    v_expected:=CASE WHEN p_rebuy_type='reentry'
      THEN v_add ELSE COALESCE(v_seat.stack,0)+v_add END;
    IF v_stack_after IS NULL OR v_stack_after<>v_expected THEN
      RAISE EXCEPTION
        'Chip Grant Did Not Land: % Expected Stack %, Seat % Holds % - Aborting So No Charge Is Made',
        p_rebuy_type,v_expected,v_seat.id,v_stack_after;
    END IF;
    UPDATE public.tournament_players
       SET chips=(SELECT stack FROM public.table_seats WHERE id=v_seat.id)::integer
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  ELSIF p_rebuy_type='addon' THEN
    RAISE EXCEPTION
      'Seat Disappeared During % - Aborting So No Charge Is Made',p_rebuy_type;
  END IF;

  UPDATE public.tournaments
     SET prize_pool=COALESCE(prize_pool,0)+v_base,
         bounty_pool=COALESCE(bounty_pool,0)+v_bounty_head
   WHERE id=p_tournament_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'Tournament vanished during chip-purchase pool booking'
      USING ERRCODE='40001';
  END IF;

  IF v_fee>0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records(
      hand_id,table_id,club_id,rake_amount,pot_size,num_players,
      bbj_contribution,is_tournament,tournament_id,source,metadata)
    VALUES(
      NULL,NULL,v_t.club_id,v_fee,v_fee,1,0,true,p_tournament_id,
      'process_tournament_rebuy',jsonb_build_object(
        'kind','tournament_'||p_rebuy_type||'_fee','user_id',p_user_id,
        'entry_club_id',v_club));
    UPDATE public.tournaments
       SET total_rake=COALESCE(total_rake,0)+v_fee
     WHERE id=p_tournament_id;
  END IF;

  INSERT INTO public.wallet_transactions(
    user_id,wallet_type,type,amount,category,description,
    related_entity_id,balance_after)
  VALUES(
    p_user_id,'PLAYER','debit',v_total,v_cat,
    'Tournament '||p_rebuy_type||': '||COALESCE(v_t.name,'tournament')||
      ' ('||v_base||' prize + '||v_bounty_head||' bounty + '||v_fee||
      ' fee) [club wallet]',
    p_tournament_id,v_balance-v_total);

  RETURN jsonb_build_object(
    'success',true,'new_stack',v_new_chips,'rebuy_type',p_rebuy_type,
    'chips_added',v_add,'cost',v_total,'fee',v_fee,'seated',v_was_seated,
    'bounty_head_funded',v_bounty_head);
END;
$tournament_chip_purchase_money$;

REVOKE ALL ON FUNCTION
  public.fn_ca_process_tournament_chip_purchase_money_v1(
    uuid,uuid,text,numeric,numeric,integer,text)
  FROM PUBLIC,anon,authenticated,service_role;

-- The engine allocates every hand from global_hand_number_seq, so hand_number
-- is the immutable, globally monotonic chronology across all tournament tables.
-- Keep table_id in exact evidence joins, while this covering path resolves one
-- player's latest generation without scanning the tournament.
CREATE INDEX IF NOT EXISTS idx_tournament_knockout_candidates_user_hand
  ON public.tournament_knockout_candidates(
    tournament_id,eliminated_user_id,hand_number DESC,id DESC);

-- A purchase may reopen only the latest accepted zero-stack hand for this
-- player. A candidate row by itself is not authority: bind it to both halves
-- of the accepted-hand commit, while deliberately not comparing the internal
-- settlement request key to hand_atomic_commits.hand_id (those ids have
-- different meanings). This helper is read-only and owner-only; the caller
-- re-runs it after locking tournament, roster and every candidate row.
CREATE OR REPLACE FUNCTION
  public.fn_ca_latest_committed_knockout_candidate(
    p_tournament_id uuid,
    p_user_id uuid
  ) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $latest_committed_knockout_candidate$
DECLARE
  v_table_id uuid;
  v_hand_number bigint;
  v_candidate_id uuid;
  v_candidate_hand_id uuid;
  v_settlement_hand_id uuid;
  v_settlement_hand_text text;
  v_atomic_stack text;
  v_settlement_stack text;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'tournament and player are required for knockout evidence'
      USING ERRCODE='22023';
  END IF;

  SELECT c.id,c.table_id,c.hand_number,c.hand_id
    INTO v_candidate_id,v_table_id,v_hand_number,v_candidate_hand_id
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
     AND c.stack_after=0
   ORDER BY c.hand_number DESC,c.id DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'REBUY_KNOCKOUT_CANDIDATE_REQUIRED: no zero-stack generation names this player'
      USING ERRCODE='55000';
  END IF;

  SELECT a.stack_result->>'hand_id',
         a.stack_result->'written'->>p_user_id::text
    INTO v_settlement_hand_text,v_atomic_stack
    FROM public.hand_atomic_commits a
   WHERE a.table_id=v_table_id
     AND a.hand_number=v_hand_number
     AND a.hand_id=v_candidate_hand_id;
  -- fn_ca_settle_hand_stacks_absolute derives this id from md5(... )::uuid.
  -- PostgreSQL UUIDs are canonical hexadecimal but that deterministic hash is
  -- not required to carry RFC version/variant nibbles.
  IF NOT FOUND
     OR COALESCE(v_settlement_hand_text,'')
          !~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(v_atomic_stack,'')!~'^-?[0-9]+([.][0-9]+)?$' THEN
    RAISE EXCEPTION
      'REBUY_ATOMIC_HAND_REQUIRED: candidate is not the exact accepted zero hand'
      USING ERRCODE='P0404';
  END IF;
  IF v_atomic_stack::numeric<>0 THEN
    RAISE EXCEPTION
      'REBUY_ATOMIC_HAND_REQUIRED: candidate hand did not commit a zero stack'
      USING ERRCODE='P0404';
  END IF;
  v_settlement_hand_id:=v_settlement_hand_text::uuid;

  SELECT k.result->'written'->>p_user_id::text
    INTO v_settlement_stack
    FROM public.settlement_idempotency_keys k
   WHERE k.table_id=v_table_id
     AND k.hand_id=v_settlement_hand_id
     AND k.status='succeeded'
     AND k.completed_at IS NOT NULL
     AND k.result->>'table_id'=v_table_id::text
     AND COALESCE(k.result->>'hand_number','')~'^[0-9]+$'
     AND (k.result->>'hand_number')::bigint=v_hand_number;
  IF NOT FOUND
     OR COALESCE(v_settlement_stack,'')!~'^-?[0-9]+([.][0-9]+)?$' THEN
    RAISE EXCEPTION
      'REBUY_SETTLEMENT_RECEIPT_REQUIRED: atomic zero hand has no exact successful settlement'
      USING ERRCODE='P0404';
  END IF;
  IF v_settlement_stack::numeric<>0 THEN
    RAISE EXCEPTION
      'REBUY_SETTLEMENT_RECEIPT_REQUIRED: exact settlement did not commit a zero stack'
      USING ERRCODE='P0404';
  END IF;

  RETURN v_candidate_id;
END;
$latest_committed_knockout_candidate$;

REVOKE ALL ON FUNCTION
  public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.process_tournament_rebuy(
  p_tournament_id uuid,
  p_user_id uuid,
  p_rebuy_type text,
  p_cost numeric,
  p_chips numeric,
  p_current_level integer DEFAULT NULL,
  p_client_token text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $atomic_tournament_chip_purchase$
DECLARE
  v_type text:=lower(btrim(COALESCE(p_rebuy_type,'')));
  v_effective_token text;
  v_receipt_key text;
  v_request jsonb;
  v_existing_request jsonb;
  v_existing_response jsonb;
  v_claim jsonb;
  v_response jsonb;
  v_recorded jsonb;
  v_gate jsonb;
  v_choice jsonb;
  v_assignment jsonb;
  v_t public.tournaments%ROWTYPE;
  v_player public.tournament_players%ROWTYPE;
  v_candidate_peek public.tournament_knockout_candidates%ROWTYPE;
  v_candidate public.tournament_knockout_candidates%ROWTYPE;
  v_live public.table_seats%ROWTYPE;
  v_final_seat public.table_seats%ROWTYPE;
  v_table_id uuid;
  v_seat_number integer;
  v_live_count integer;
  v_pending_count integer;
  v_rebuy_window jsonb;
  v_rows integer;
  v_wake_id bigint;
  v_expected_club_id uuid;
  v_expected_horse_id uuid;
  v_previous_money_path text:=current_setting('app.money_path',true);
BEGIN
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION
      'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE='28000';
  END IF;
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'tournament and player are required'
      USING ERRCODE='22023';
  END IF;
  IF v_type NOT IN ('rebuy','reentry','addon') THEN
    RAISE EXCEPTION 'Invalid rebuy type: %',p_rebuy_type
      USING ERRCODE='22023';
  END IF;
  IF COALESCE(auth.role(),'service_role')<>'service_role'
     AND (auth.uid() IS NULL OR auth.uid()<>p_user_id) THEN
    RAISE EXCEPTION
      'process_tournament_rebuy: caller may only transact for themselves'
      USING ERRCODE='42501';
  END IF;
  IF p_client_token IS NOT NULL
     AND (length(btrim(p_client_token))=0
          OR length(btrim(p_client_token))>128) THEN
    RAISE EXCEPTION 'rebuy prompt token is invalid'
      USING ERRCODE='22023';
  END IF;
  IF v_type<>'addon'
     AND COALESCE(auth.role(),'service_role')<>'service_role'
     AND p_client_token IS NULL THEN
    RAISE EXCEPTION 'a rebuy prompt token is required'
      USING ERRCODE='22023';
  END IF;

  -- Every chip purchase can change the tournament pool, even an add-on that
  -- does not acquire a new chair. Join terminal settlement and maintenance at
  -- their common root before claiming a receipt; an already-committed receipt
  -- can still replay after either boundary without rerunning money.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM pg_advisory_xact_lock_shared(530090,1);

  IF v_type='addon' THEN
    -- Add-ons never create a chair, but their committed receipt must remain
    -- replayable across the maintenance boundary.
    v_receipt_key:='tourney:'||p_tournament_id::text||':addon:'||
      p_user_id::text;
    v_request:=jsonb_build_object(
      'version','v1','tournament_id',p_tournament_id,'user_id',p_user_id,
      'rebuy_type',v_type,'idempotency_key',v_receipt_key);
  ELSIF p_client_token IS NOT NULL
        AND length(btrim(p_client_token))>0 THEN
    v_effective_token:=btrim(p_client_token);
    v_receipt_key:='tourney:'||p_tournament_id::text||':'||v_type||':'||
      p_user_id::text||':tok:'||v_effective_token;
  END IF;

  -- An explicit prompt token names its historical purchase independently of
  -- whichever hand is current now. Read that immutable receipt first, so a
  -- delayed transport retry after later play returns the original answer
  -- instead of trying to bind the token to a newer knockout generation.
  IF v_receipt_key IS NOT NULL THEN
    SELECT r.request,r.response
      INTO v_existing_request,v_existing_response
      FROM public.entry_purchase_idempotency_receipts r
     WHERE r.key_domain='tournament_chip_purchase'
       AND r.idempotency_key=v_receipt_key;
    IF FOUND THEN
      IF v_existing_response IS NULL
         OR v_existing_request->>'version'<>'v1'
         OR v_existing_request->>'tournament_id'<>p_tournament_id::text
         OR v_existing_request->>'user_id'<>p_user_id::text
         OR v_existing_request->>'rebuy_type'<>v_type
         OR v_existing_request->>'idempotency_key'<>v_receipt_key
         OR v_existing_response->>'success'<>'true'
         OR v_existing_response->>'seated'<>'true'
         OR v_existing_response->>'atomic_tournament_chip_purchase'<>'v1'
         OR v_existing_response->>'rebuy_type'<>v_type
         OR v_existing_response->>'table_id' IS NULL
         OR v_existing_response->>'seat_id' IS NULL
         OR v_existing_response->>'stack' IS NULL
         OR (v_type='addon' AND v_existing_request ? 'candidate_id')
         OR (v_type<>'addon' AND (
           v_existing_request->>'candidate_id' IS NULL
           OR v_existing_response->>'candidate_id'<>
              v_existing_request->>'candidate_id'
           OR v_existing_response->>'candidate_state'<>'rebought')) THEN
        RAISE EXCEPTION
          'IDEMPOTENCY_RECEIPT_UNBOUND: historical response is not an atomic tournament purchase proof'
          USING ERRCODE='55000';
      END IF;
      RETURN v_existing_response;
    END IF;
  END IF;

  IF v_type<>'addon' THEN
    -- A rebuy can acquire/revive a chair, so it joins the same global root as
    -- every registration, move and terminal settlement before observing a
    -- candidate. The nonlocking peek derives only an immutable identity; the
    -- exact latest row is re-read under tournament/candidate locks below.
    SELECT * INTO v_candidate_peek
      FROM public.tournament_knockout_candidates c
     WHERE c.id=public.fn_ca_latest_committed_knockout_candidate(
       p_tournament_id,p_user_id);
    IF v_candidate_peek.id IS NULL THEN
      RAISE EXCEPTION
        'REBUY_KNOCKOUT_GENERATION_REQUIRED: no immutable bust authorizes this purchase'
        USING ERRCODE='55000';
    END IF;
    IF v_effective_token IS NULL THEN
      v_effective_token:='candidate:'||v_candidate_peek.id::text;
      v_receipt_key:='tourney:'||p_tournament_id::text||':'||v_type||':'||
        p_user_id::text||':tok:'||v_effective_token;
    END IF;
    v_request:=jsonb_build_object(
      'version','v1','tournament_id',p_tournament_id,'user_id',p_user_id,
      'rebuy_type',v_type,'candidate_id',v_candidate_peek.id,
      'idempotency_key',v_receipt_key);
  END IF;

  v_claim:=public.fn_claim_entry_purchase_receipt(
    'tournament_chip_purchase',v_receipt_key,v_request);
  IF COALESCE((v_claim->>'claimed')::boolean,false) IS NOT TRUE THEN
    v_response:=v_claim->'response';
    IF v_response IS NULL
       OR v_response->>'atomic_tournament_chip_purchase'<>'v1'
       OR v_response->>'success'<>'true'
       OR v_response->>'seated'<>'true'
       OR v_response->>'rebuy_type'<>v_type
       OR v_response->>'table_id' IS NULL
       OR v_response->>'seat_id' IS NULL
       OR v_response->>'stack' IS NULL
       OR (v_type<>'addon' AND
           (v_response->>'candidate_id'<>v_candidate_peek.id::text
            OR v_response->>'candidate_state'<>'rebought')) THEN
      RAISE EXCEPTION
        'IDEMPOTENCY_RECEIPT_UNBOUND: historical response is not an atomic tournament purchase proof'
        USING ERRCODE='55000';
    END IF;
    RETURN v_response;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.wallet_credit_idempotency k
     WHERE k.key=v_receipt_key) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: chip key predates its exact transaction receipt'
      USING ERRCODE='55000';
  END IF;

  IF v_type='addon' THEN
    IF public.fn_entry_purchases_frozen() THEN
      RAISE EXCEPTION
        'PLATFORM_FROZEN: scheduled maintenance has closed add-ons; no chips moved'
        USING ERRCODE='55006';
    END IF;
    SELECT s.table_id INTO v_table_id
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND s.user_id=p_user_id AND s.left_at IS NULL
     ORDER BY s.id
     LIMIT 1;
    IF v_table_id IS NULL THEN
      RAISE EXCEPTION 'Add-on requires one live tournament table'
        USING ERRCODE='55000';
    END IF;
    -- The accepted-hand boundary owns this same table key. During a rolling
    -- database cutover it prevents the old hand body from settling over a paid
    -- grant; after 14534, the hand also takes the terminal root shared before
    -- this key, preserving root -> table -> rows on both paths.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('atomic-table:'||v_table_id::text,0));
    SELECT * INTO v_t FROM public.tournaments t
     WHERE t.id=p_tournament_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;
    IF COALESCE(v_t.prize_pool_finalized,false)
       OR upper(COALESCE(v_t.status::text,'')) NOT IN ('REGISTERING','RUNNING')
       OR NOT COALESCE(v_t.add_on_available,false)
       OR NOT COALESCE(v_t.addon_period_triggered,false)
       OR v_t.addon_period_started_at IS NULL
       OR v_t.addon_period_ends_at IS NULL
       OR clock_timestamp()<v_t.addon_period_started_at
       OR clock_timestamp()>=v_t.addon_period_ends_at THEN
      RAISE EXCEPTION 'Add-On Period Is Closed Or The Prize Pool Is Already Finalized'
        USING ERRCODE='55000';
    END IF;
    SELECT * INTO v_player FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
     FOR UPDATE;
    IF NOT FOUND OR v_player.status::text<>'playing'
       OR COALESCE(v_player.chips,0)<=0 OR COALESCE(v_player.add_on,false) THEN
      RAISE EXCEPTION 'Only one live positive tournament entry may take an add-on'
        USING ERRCODE='55000';
    END IF;
    PERFORM s.id
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
       AND s.left_at IS NULL
     ORDER BY s.id FOR UPDATE OF s;
    SELECT count(*)::integer INTO v_live_count
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
       AND s.left_at IS NULL;
    IF v_live_count<>1 THEN
      RAISE EXCEPTION 'Add-on requires exactly one locked live tournament seat'
        USING ERRCODE='55000';
    END IF;
    SELECT s.* INTO v_live
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
       AND s.left_at IS NULL FOR UPDATE OF s;
    IF v_live.table_id IS DISTINCT FROM v_table_id THEN
      RAISE EXCEPTION 'Add-on live table changed after its atomic-table lock'
        USING ERRCODE='40001';
    END IF;

    v_response:=public.fn_ca_process_tournament_chip_purchase_money_v1(
      p_tournament_id,p_user_id,v_type,p_cost,p_chips,v_t.current_level,
      v_receipt_key);
    IF COALESCE((v_response->>'success')::boolean,false) IS NOT TRUE
       OR COALESCE((v_response->>'idempotent')::boolean,false) THEN
      RAISE EXCEPTION 'tournament add-on money core did not commit a new purchase'
        USING ERRCODE='P0404';
    END IF;
    SELECT * INTO v_player FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id;
    SELECT s.* INTO v_final_seat FROM public.table_seats s
     WHERE s.id=v_live.id;
    IF v_player.status::text<>'playing' OR NOT COALESCE(v_player.add_on,false)
       OR v_final_seat.left_at IS NOT NULL
       OR v_final_seat.user_id IS DISTINCT FROM p_user_id
       OR v_final_seat.stack IS DISTINCT FROM v_player.chips::numeric
       OR v_final_seat.stack<=0 OR v_final_seat.stack<>trunc(v_final_seat.stack) THEN
      RAISE EXCEPTION 'atomic add-on seat/roster proof is not exact'
        USING ERRCODE='P0404';
    END IF;
    v_wake_id:=public.fn_emit_tournament_manager_wake(p_tournament_id,'addon');
    v_response:=v_response||jsonb_build_object(
      'success',true,'seated',true,'atomic_tournament_chip_purchase','v1',
      'rebuy_type',v_type,'seat_id',v_final_seat.id,
      'table_id',v_final_seat.table_id,
      'seat_number',v_final_seat.seat_number,'stack',v_final_seat.stack,
      'manager_wake_id',v_wake_id);
  ELSE
    v_table_id:=v_candidate_peek.table_id;
    PERFORM pg_advisory_xact_lock(
      hashtextextended('atomic-table:'||v_table_id::text,0));
    v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
      p_tournament_id,NULL,p_user_id);
    IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'tournament rebuy root refused: %',
        COALESCE(v_gate->>'reason','unknown') USING ERRCODE='55000';
    END IF;
    SELECT * INTO v_t FROM public.tournaments t
     WHERE t.id=p_tournament_id;
    IF COALESCE(v_t.prize_pool_finalized,false)
       OR upper(COALESCE(v_t.status::text,''))<>'RUNNING' THEN
      RAISE EXCEPTION 'Tournament is not accepting rebuys or re-entries'
        USING ERRCODE='55000';
    END IF;
    v_rebuy_window:=public.fn_ca_tournament_rebuy_window(p_tournament_id);
    IF COALESCE((v_rebuy_window->>'open')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Rebuy period is closed: %',
        COALESCE(v_rebuy_window->>'reason','unknown') USING ERRCODE='55000';
    END IF;

    SELECT * INTO v_player FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
     FOR UPDATE;
    IF NOT FOUND OR v_player.status::text NOT IN ('playing','eliminated')
       OR COALESCE(v_player.chips,0)>0 OR COALESCE(v_player.prize,0)>0 THEN
      RAISE EXCEPTION 'Only the exact unpaid zero-stack entry may rebuy'
        USING ERRCODE='55000';
    END IF;

    PERFORM c.id FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_user_id
     ORDER BY c.hand_number,c.id FOR UPDATE;
    SELECT count(*) FILTER (WHERE c.state='pending')::integer
      INTO v_pending_count
      FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_user_id;
    SELECT * INTO v_candidate
      FROM public.tournament_knockout_candidates c
     WHERE c.id=public.fn_ca_latest_committed_knockout_candidate(
       p_tournament_id,p_user_id);
    IF v_candidate.id IS DISTINCT FROM v_candidate_peek.id
       OR v_candidate.state NOT IN ('pending','eliminated')
       OR (v_type='rebuy' AND v_candidate.state<>'pending')
       OR (v_candidate.state='pending' AND
           (v_pending_count<>1 OR v_player.status::text<>'playing'))
       OR (v_candidate.state='eliminated' AND
           (v_pending_count<>0 OR v_player.status::text<>'eliminated'))
       OR EXISTS (
         SELECT 1 FROM public.tournament_knockout_candidates prior
          WHERE prior.tournament_id=p_tournament_id
            AND prior.eliminated_user_id=p_user_id
            AND (prior.hand_number,prior.id)<
                (v_candidate.hand_number,v_candidate.id)
            AND prior.state<>'rebought') THEN
      RAISE EXCEPTION 'UNRESOLVED_KNOCKOUT_GENERATION_CHAIN'
        USING ERRCODE='P0404';
    END IF;
    IF v_candidate.state='pending'
       AND (v_candidate.rebuy_prompt_until IS NULL
            OR v_candidate.rebuy_prompt_until<=clock_timestamp()) THEN
      RAISE EXCEPTION 'Rebuy or re-entry decision window has closed'
        USING ERRCODE='55000';
    END IF;
    IF (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
        OR COALESCE(v_t.is_mystery_bounty,false))
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_obligations o
          WHERE o.tournament_id=p_tournament_id
            AND o.eliminated_user_id=p_user_id
            AND o.hand_number=v_candidate.hand_number
            AND o.hand_id=v_candidate.hand_id
            AND o.state='settled'
            AND public.fn_bounty_obligation_has_complete_marker(o.id)) THEN
      RAISE EXCEPTION
        'Bounty Settlement Pending - Rebuy Or Re-Entry Cannot Replace This Entry Generation Yet'
        USING ERRCODE='55000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.tournament_obligations o
       WHERE o.tournament_id=p_tournament_id AND o.user_id=p_user_id
         AND o.kind='bubble_protection' AND o.amount_paid=o.amount_owed
         AND o.amount_paid>0 AND o.settled_at IS NOT NULL) THEN
      RAISE EXCEPTION
        'Bubble Protection Already Paid - This Result Cannot Be Resurrected'
        USING ERRCODE='55000';
    END IF;

    PERFORM s.id
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
       AND s.left_at IS NULL
     ORDER BY s.id FOR UPDATE OF s;
    SELECT count(*)::integer INTO v_live_count
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
       AND s.left_at IS NULL;
    IF v_live_count>1 THEN
      RAISE EXCEPTION 'tournament rebuy found multiple live seats'
        USING ERRCODE='P0404';
    ELSIF v_live_count=1 THEN
      SELECT s.* INTO v_live
        FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
       WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
         AND s.left_at IS NULL FOR UPDATE OF s;
      IF v_live.id IS DISTINCT FROM v_candidate.seat_id
         OR v_live.table_id IS DISTINCT FROM v_candidate.table_id
         OR v_live.joined_at IS DISTINCT FROM v_candidate.seat_joined_at
         OR COALESCE(v_live.stack,0)<>0 THEN
        RAISE EXCEPTION 'knockout generation has a different live seat'
          USING ERRCODE='P0404';
      END IF;
      v_table_id:=v_live.table_id;
      v_seat_number:=v_live.seat_number;
    END IF;

    v_response:=public.fn_ca_process_tournament_chip_purchase_money_v1(
      p_tournament_id,p_user_id,v_type,p_cost,p_chips,v_t.current_level,
      v_effective_token);
    IF COALESCE((v_response->>'success')::boolean,false) IS NOT TRUE
       OR COALESCE((v_response->>'idempotent')::boolean,false) THEN
      RAISE EXCEPTION 'tournament rebuy money core did not commit a new purchase'
        USING ERRCODE='P0404';
    END IF;

    -- A seatless eliminated entry is not counted as active capacity until the
    -- money core promotes it. Choose the chair only after that in-transaction
    -- promotion; any capacity/assignment failure below aborts the debit and
    -- every pool leg with it, so a purchase can never commit seatless.
    IF v_live_count=0 THEN
      v_choice:=public.fn_ca_choose_tournament_seat_locked(
        p_tournament_id,p_user_id,v_candidate.table_id,
        (SELECT s.seat_number FROM public.table_seats s
          WHERE s.id=v_candidate.seat_id));
      v_table_id:=(v_choice->>'table_id')::uuid;
      v_seat_number:=(v_choice->>'seat_number')::integer;
    END IF;

    UPDATE public.tournament_knockout_candidates c
       SET state='rebought',resolved_at=clock_timestamp()
     WHERE c.id=v_candidate.id AND c.state=v_candidate.state
       AND c.state IN ('pending','eliminated');
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'exact knockout generation did not close with its purchase'
        USING ERRCODE='40001';
    END IF;
    UPDATE public.tournament_players tp
       SET rebuy_prompt_until=NULL
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id;

    -- An old-pod zero seat can still be live during the rolling window. The
    -- money core fills that locked chair; advancing joined_at begins the new
    -- paid entry generation so a later same-chair bust has a new identity. A
    -- new paid generation is also playable state: clear only lifecycle flags
    -- owned by the expired generation while preserving this player's persisted
    -- time bank and auto-rebuy preference. Naming user_id deliberately reruns
    -- the canonical horse and club stamp triggers for the same occupant.
    IF v_live_count=1 THEN
      v_expected_club_id:=public.fn_seat_club_for_user(
        p_user_id,v_live.table_id,v_player.club_id);
      SELECT CASE WHEN COALESCE(p.is_horse,false) THEN p.id ELSE NULL END
        INTO v_expected_horse_id
        FROM public.profiles p
       WHERE p.id=p_user_id;
      UPDATE public.table_seats s
         SET user_id=p_user_id,player_id=NULL,member_id=NULL,
             joined_at=clock_timestamp(),status='active',
             is_sitting_out=false,is_away=false,leave_pending=false,
             sit_out_at=NULL,scheduled_leave_hands=NULL,
             horse_id=v_expected_horse_id,club_id=v_expected_club_id,
             entry_hold=NULL,entry_post_agreed=false
       WHERE s.id=v_live.id AND s.left_at IS NULL
         AND s.user_id=p_user_id
         AND s.joined_at=v_candidate.seat_joined_at;
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      IF v_rows<>1 THEN
        RAISE EXCEPTION 'rebuy could not advance the live seat generation'
          USING ERRCODE='40001';
      END IF;
    END IF;

    v_assignment:=public.fn_ca_assign_tournament_player_seat_locked(
      p_tournament_id,p_user_id,v_table_id,v_seat_number);
    IF COALESCE((v_assignment->>'ok')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'paid rebuy could not commit its chosen seat: %',
        COALESCE(v_assignment->>'reason','unknown') USING ERRCODE='55000';
    END IF;

    PERFORM s.id
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
       AND s.left_at IS NULL
     ORDER BY s.id FOR UPDATE OF s;
    SELECT count(*)::integer INTO v_live_count
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
       AND s.left_at IS NULL;
    SELECT s.* INTO v_final_seat
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
       AND s.left_at IS NULL;
    SELECT * INTO v_player FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id;
    v_expected_club_id:=public.fn_seat_club_for_user(
      p_user_id,v_final_seat.table_id,v_player.club_id);
    SELECT CASE WHEN COALESCE(p.is_horse,false) THEN p.id ELSE NULL END
      INTO v_expected_horse_id
      FROM public.profiles p
     WHERE p.id=p_user_id;
    IF v_live_count<>1 OR v_final_seat.id IS NULL
       OR v_final_seat.stack IS NULL OR v_final_seat.stack<=0
       OR v_final_seat.stack<>trunc(v_final_seat.stack)
       OR v_final_seat.stack IS DISTINCT FROM v_player.chips::numeric
       OR v_final_seat.status::text<>'active'
       OR COALESCE(v_final_seat.is_sitting_out,false)
       OR COALESCE(v_final_seat.is_away,false)
       OR COALESCE(v_final_seat.leave_pending,false)
       OR v_final_seat.sit_out_at IS NOT NULL
       OR v_final_seat.scheduled_leave_hands IS NOT NULL
       OR v_final_seat.entry_hold IS NOT NULL
       OR v_final_seat.entry_post_agreed
       OR v_final_seat.player_id IS NOT NULL
       OR v_final_seat.member_id IS NOT NULL
       OR v_final_seat.horse_id IS DISTINCT FROM v_expected_horse_id
       OR v_final_seat.club_id IS DISTINCT FROM v_expected_club_id
       OR v_player.status::text<>'playing'
       OR v_player.table_id IS DISTINCT FROM v_final_seat.table_id
       OR v_player.seat_number IS DISTINCT FROM v_final_seat.seat_number
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_knockout_candidates c
          WHERE c.id=v_candidate.id AND c.state='rebought')
       OR EXISTS (
         SELECT 1 FROM public.tournament_knockout_candidates c
          WHERE c.tournament_id=p_tournament_id
            AND c.eliminated_user_id=p_user_id AND c.state='pending')
       OR NOT EXISTS (
         SELECT 1 FROM public.tables tb
          WHERE tb.id=v_final_seat.table_id
            AND tb.current_players=(
              SELECT count(*) FROM public.table_seats s
               WHERE s.table_id=tb.id AND s.left_at IS NULL)) THEN
      RAISE EXCEPTION 'atomic rebuy candidate/seat/roster proof is not exact'
        USING ERRCODE='P0404';
    END IF;
    v_wake_id:=public.fn_emit_tournament_manager_wake(p_tournament_id,v_type);
    v_response:=v_response||jsonb_build_object(
      'success',true,'seated',true,'atomic_tournament_chip_purchase','v1',
      'rebuy_type',v_type,'candidate_id',v_candidate.id,
      'candidate_state','rebought','seat_id',v_final_seat.id,
      'table_id',v_final_seat.table_id,
      'seat_number',v_final_seat.seat_number,'stack',v_final_seat.stack,
      'manager_wake_id',v_wake_id);
  END IF;

  v_recorded:=public.fn_record_entry_purchase_receipt(
    'tournament_chip_purchase',v_receipt_key,v_request,v_response);
  IF v_recorded IS DISTINCT FROM v_response THEN
    RAISE EXCEPTION 'atomic tournament chip-purchase receipt changed at commit'
      USING ERRCODE='P0404';
  END IF;
  PERFORM set_config(
    'app.money_path',COALESCE(v_previous_money_path,''),true);
  RETURN v_recorded;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config(
    'app.money_path',COALESCE(v_previous_money_path,''),true);
  RAISE;
END;
$atomic_tournament_chip_purchase$;

REVOKE ALL ON FUNCTION public.process_tournament_rebuy(
  uuid,uuid,text,numeric,numeric,integer,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.process_tournament_rebuy(
  uuid,uuid,text,numeric,numeric,integer,text) TO authenticated,service_role;

DO $retire_split_tournament_chip_purchase_wrappers$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname NOT IN (
         'process_tournament_rebuy',
         'process_tournament_rebuy_before_maintenance_announcement_gate',
         'process_tournament_rebuy_before_atomic_pool_gate',
         'process_tournament_rebuy_before_bounty_guard_20260907',
         'process_tournament_rebuy_before_one_minute_addon',
         'fn_ca_process_tournament_chip_purchase_money_v1')
       AND (p.prosrc LIKE '%process_tournament_rebuy_before_maintenance_announcement_gate(%'
         OR p.prosrc LIKE '%process_tournament_rebuy_before_atomic_pool_gate(%'
         OR p.prosrc LIKE '%process_tournament_rebuy_before_bounty_guard_20260907(%'
         OR p.prosrc LIKE '%process_tournament_rebuy_before_one_minute_addon(%'
         OR p.prosrc LIKE '%fn_after_tournament_rebuy(%')) THEN
    RAISE EXCEPTION 'an outside function still calls a retired rebuy wrapper';
  END IF;
END;
$retire_split_tournament_chip_purchase_wrappers$;

DROP FUNCTION
  public.process_tournament_rebuy_before_maintenance_announcement_gate(
    uuid,uuid,text,numeric,numeric,integer,text) RESTRICT;
DROP FUNCTION public.process_tournament_rebuy_before_atomic_pool_gate(
  uuid,uuid,text,numeric,numeric,integer,text) RESTRICT;
DROP FUNCTION public.process_tournament_rebuy_before_bounty_guard_20260907(
  uuid,uuid,text,numeric,numeric,integer,text) RESTRICT;
DROP FUNCTION public.process_tournament_rebuy_before_one_minute_addon(
  uuid,uuid,text,numeric,numeric,integer,text) RESTRICT;
DROP FUNCTION public.fn_after_tournament_rebuy(uuid,uuid,text) RESTRICT;

COMMENT ON FUNCTION public.process_tournament_rebuy(
  uuid,uuid,text,numeric,numeric,integer,text) IS
  'Sole rebuy, re-entry and add-on authority. A reported rebuy commits its exact knockout generation, wallet debit, pool/rake legs, positive live seat, roster/table mirrors, manager wake and immutable response receipt in one transaction.';

-- The third paid seat is the entry authority. This is still a private helper
-- because fn_sync_seat_first_player_count invokes it inside the transaction
-- that fills that seat. It refuses anything except one exact three-user roster,
-- three live seats and one exact buy-in debit per roster user. It also returns
-- the two immutable evidence ids instead of treating "already booked" as proof.
CREATE OR REPLACE FUNCTION public.fn_spin_book_entry(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $spin_entry$
DECLARE
  v_t record;
  v_owner uuid;
  v_pool_id uuid;
  v_table_id uuid;
  v_live_seats integer;
  v_seat_users integer;
  v_exact_seat_stacks integer;
  v_roster_users integer;
  v_paid_users integer;
  v_buyin_debits integer;
  v_buyin_total numeric;
  v_collected numeric;
  v_rake_rate numeric;
  v_rake numeric;
  v_reserve_in numeric;
  v_balance numeric;
  v_reserve public.spin_reserve_ledger%ROWTYPE;
  v_reserve_count integer;
  v_journal_id uuid;
  v_journal_count integer;
  v_contrib jsonb;
  v_key text := 'spin:' || p_tournament_id::text || ':entry';
BEGIN
  SELECT t.id, t.club_id, t.buy_in_amount, t.max_players, t.variant,
         t.starting_chips,
         t.tournament_type, t.status
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR (lower(COALESCE(v_t.variant,'')) <> 'spin'
         AND upper(COALESCE(v_t.tournament_type,'')) <> 'SPIN') THEN
    RETURN jsonb_build_object('ok',false,'reason','not_a_spin');
  END IF;
  IF v_t.club_id IS NULL OR COALESCE(v_t.buy_in_amount,0) <= 0
     OR COALESCE(v_t.max_players,0) <> 3
     OR v_t.starting_chips IS NULL
     OR v_t.starting_chips::text IN ('NaN','Infinity','-Infinity')
     OR v_t.starting_chips <= 0
     OR upper(COALESCE(v_t.status::text,'')) IN ('COMPLETED','CANCELLED','CANCELED') THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_spin_contract');
  END IF;

  v_table_id := public.fn_tournament_primary_table(p_tournament_id);
  SELECT count(*), count(DISTINCT s.user_id),
         count(*) FILTER (
           WHERE s.stack IS NOT DISTINCT FROM v_t.starting_chips
             AND s.stack::text NOT IN ('NaN','Infinity','-Infinity')
             AND s.stack > 0)
    INTO v_live_seats, v_seat_users, v_exact_seat_stacks
    FROM public.table_seats s
   WHERE s.table_id = v_table_id AND s.left_at IS NULL;
  SELECT count(DISTINCT tp.user_id)
    INTO v_roster_users
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*) INTO v_paid_users
    FROM (
      SELECT tp.user_id
        FROM public.tournament_players tp
        JOIN public.wallet_transactions w
          ON w.related_entity_id = tp.tournament_id
         AND w.user_id = tp.user_id
         AND w.type = 'debit'
         AND w.category = 'tournament_buyin'
       WHERE tp.tournament_id = p_tournament_id
       GROUP BY tp.user_id
      HAVING round(sum(w.amount),2) = round(v_t.buy_in_amount,2)
    ) paid;
  SELECT count(*), round(COALESCE(sum(w.amount),0),2)
    INTO v_buyin_debits,v_buyin_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
     AND w.type = 'debit'
     AND w.category = 'tournament_buyin';
  IF v_table_id IS NULL OR v_live_seats <> 3 OR v_seat_users <> 3
     OR v_exact_seat_stacks <> 3
     OR v_roster_users <> 3 OR v_paid_users <> 3
     OR v_buyin_debits <> 3
     OR v_buyin_total <> round(v_t.buy_in_amount * 3,2)
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND NOT EXISTS (
            SELECT 1 FROM public.table_seats s
             WHERE s.table_id = v_table_id AND s.left_at IS NULL
               AND s.user_id = tp.user_id)) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','three_paid_seats_required',
      'seats',v_live_seats,'seat_users',v_seat_users,
      'exact_seat_stacks',v_exact_seat_stacks,
      'roster_users',v_roster_users,'paid_users',v_paid_users,
      'buyin_debits',v_buyin_debits,'buyin_total',v_buyin_total);
  END IF;

  -- One lock order for both the seat trigger and the start authority.
  PERFORM 1 FROM public.tournament_escrow
   WHERE tournament_id = p_tournament_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('spin_entry:' || p_tournament_id::text,0));

  v_owner := public.fn_spin_reserve_pool(v_t.club_id);
  SELECT p.id, p.balance INTO v_pool_id, v_balance
    FROM public.spin_bonus_pools p
   WHERE p.club_id = v_owner
   FOR UPDATE;
  IF v_pool_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','no_pool_row','owner_id',v_owner);
  END IF;

  v_collected := round(v_t.buy_in_amount * 3,2);
  v_rake_rate := public.fn_spin_rake_rate(v_t.buy_in_amount);
  v_rake := round(v_collected * v_rake_rate,2);
  v_reserve_in := round(v_collected - v_rake,2);

  SELECT count(*) INTO v_reserve_count
    FROM public.spin_reserve_ledger r
   WHERE r.tournament_id = p_tournament_id AND r.kind = 'contribution';
  IF v_reserve_count > 0 THEN
    IF v_reserve_count <> 1 THEN
      RAISE EXCEPTION 'Spin % has % contribution rows',
        p_tournament_id,v_reserve_count USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_reserve
      FROM public.spin_reserve_ledger r
     WHERE r.tournament_id = p_tournament_id AND r.kind = 'contribution'
     FOR SHARE;
    IF v_reserve.club_id IS DISTINCT FROM v_owner
       OR v_reserve.amount IS DISTINCT FROM v_reserve_in
       OR v_reserve.buy_in IS DISTINCT FROM v_t.buy_in_amount
       OR v_reserve.seats IS DISTINCT FROM 3
       OR v_reserve.house_rake IS DISTINCT FROM v_rake THEN
      RAISE EXCEPTION 'Spin % existing contribution disagrees with its paid entry',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    SELECT count(*) INTO v_journal_count
      FROM public.chip_ledger l
     WHERE l.category = 'spin_entry'
       AND l.from_type = 'prize_liability'
       AND l.from_entity_id = p_tournament_id
       AND l.to_type = 'spin_reserve'
       AND l.to_entity_id = v_pool_id
       AND l.tournament_id = p_tournament_id
       AND l.amount = v_reserve_in;
    IF v_journal_count <> 1 THEN
      RAISE EXCEPTION 'Spin % existing contribution has % exact journals',
        p_tournament_id,v_journal_count USING ERRCODE = 'P0404';
    END IF;
    SELECT l.id INTO v_journal_id
      FROM public.chip_ledger l
     WHERE l.category = 'spin_entry'
       AND l.from_type = 'prize_liability'
       AND l.from_entity_id = p_tournament_id
       AND l.to_type = 'spin_reserve'
       AND l.to_entity_id = v_pool_id
       AND l.tournament_id = p_tournament_id
       AND l.amount = v_reserve_in;
    RETURN jsonb_build_object(
      'ok',true,'reason','already_booked','collected',v_collected,
      'house_rake',v_rake,'reserve_in',v_reserve_in,'balance',v_balance,
      'owner_id',v_owner,'pool_id',v_pool_id,'seats',3,'paid_users',3,
      'entry_reserve_id',v_reserve.id,'entry_journal_id',v_journal_id);
  END IF;

  PERFORM public.fn_ca_declare_ledger(
    'spin_entry','prize_liability',p_tournament_id,NULL,v_key,NULL);
  UPDATE public.spin_bonus_pools
     SET balance = balance + v_reserve_in,
         total_deposited = total_deposited + v_reserve_in,
         spin_count = spin_count + 1,
         highest_stake = GREATEST(highest_stake,v_t.buy_in_amount),
         updated_at = now()
   WHERE id = v_pool_id
   RETURNING balance INTO v_balance;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Spin reserve pool % vanished while booking %',
      v_pool_id,p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.spin_reserve_ledger
    (club_id,tournament_id,kind,amount,balance_after,multiplier,
     buy_in,seats,house_rake,note)
  VALUES
    (v_owner,p_tournament_id,'contribution',v_reserve_in,v_balance,NULL,
     v_t.buy_in_amount,3,v_rake,
     CASE WHEN v_owner = v_t.club_id
          THEN 'three exact paid buy-ins less fixed rake'
          ELSE format('three exact paid buy-ins less fixed rake (club %s)',v_t.club_id)
      END)
  RETURNING * INTO v_reserve;

  SELECT count(*), (array_agg(l.id ORDER BY l.created_at,l.id))[1]
    INTO v_journal_count,v_journal_id
    FROM public.chip_ledger l
   WHERE l.idempotency_key = v_key
     AND l.category = 'spin_entry'
     AND l.from_type = 'prize_liability'
     AND l.from_entity_id = p_tournament_id
     AND l.to_type = 'spin_reserve'
     AND l.to_entity_id = v_pool_id
     AND l.tournament_id = p_tournament_id
     AND l.amount = v_reserve_in;
  IF v_journal_count <> 1 THEN
    RAISE EXCEPTION 'Spin % new contribution has % exact keyed journals',
      p_tournament_id,v_journal_count USING ERRCODE = 'P0404';
  END IF;

  SELECT jsonb_object_agg(tp.user_id::text,v_t.buy_in_amount)
    INTO v_contrib
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF v_rake > 0 THEN
    INSERT INTO public.rake_records
      (hand_id,table_id,club_id,rake_amount,pot_size,num_players,
       bbj_contribution,is_tournament,tournament_id,source,
       player_contributions,metadata)
    VALUES
      (NULL,NULL,v_t.club_id,v_rake,v_collected,3,0,true,p_tournament_id,
       'fn_spin_book_entry',v_contrib,
       jsonb_build_object(
         'kind','spin_rake','buy_in',v_t.buy_in_amount,
         'rake_rate',v_rake_rate,'booked_at','third_paid_seat',
         'reserve_owner',v_owner,'treasury_credited',false,
         'distributed_by','atomic_distribute_rake',
         'rake_per_player',round(v_rake / 3,4),'seats_attributed',3));
  END IF;

  PERFORM set_config('app.ledger_category','',true);
  PERFORM set_config('app.ledger_counterparty','',true);
  PERFORM set_config('app.ledger_counterparty_entity','',true);
  PERFORM set_config('app.ledger_idempotency_key','',true);

  RETURN jsonb_build_object(
    'ok',true,'reason','booked','collected',v_collected,
    'house_rake',v_rake,'reserve_in',v_reserve_in,'balance',v_balance,
    'owner_id',v_owner,'pool_id',v_pool_id,'seats',3,'paid_users',3,
    'entry_reserve_id',v_reserve.id,'entry_journal_id',v_journal_id);
END;
$spin_entry$;

COMMENT ON FUNCTION public.fn_spin_book_entry(uuid) IS
  'Private paid-third-seat primitive. Books one exact three-user Spin entry and returns its immutable reserve+journal evidence. Errors propagate to the seat transaction; no reconciler is part of this path.';

-- The paid third seat and its reserve contribution are one transaction. The
-- previous body caught a refused/failed fn_spin_book_entry call, committed the
-- seat anyway, and asked a sweep to invent the missing booking later. Only the
-- realtime announcement is presentation and remains best-effort; money errors
-- escape this function and roll the seat transaction back.
CREATE OR REPLACE FUNCTION public.fn_sync_seat_first_player_count(
  p_tournament_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $seat_count$
DECLARE
  v_table      uuid;
  v_seats      integer := 0;
  v_seat_first boolean := false;
  v_is_spin    boolean := false;
  v_cap        integer := 0;
  v_variant    text := '';
  v_book       jsonb;
BEGIN
  -- This is an AFTER-seat helper. It must never acquire a new global lock
  -- after PostgreSQL already owns the changed seat row. Every legitimate
  -- create/revive root pre-acquires terminal -> mission -> launch -> tournament,
  -- and the earliest BEFORE trigger refuses a raw writer that did not.
  SELECT (lower(COALESCE(t.variant, '')) = 'spin'
          OR COALESCE(t.max_players, 0) <= 2),
         lower(COALESCE(t.variant, '')) = 'spin',
         COALESCE(t.max_players, 0),
         COALESCE(t.variant, '')
    INTO v_seat_first, v_is_spin, v_cap, v_variant
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Freeze the complete table/seat set before choosing the occupied table.
  -- UUID order is deterministic across every transaction using this owner.
  PERFORM tb.id
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
     AND lower(COALESCE(tb.status, '')) <> 'closed'
   ORDER BY tb.id
   FOR UPDATE;

  PERFORM s.id
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND lower(COALESCE(tb.status, '')) <> 'closed'
     AND s.left_at IS NULL
   ORDER BY s.table_id, s.seat_number, s.id
   FOR UPDATE OF s;

  v_table := public.fn_tournament_primary_table(p_tournament_id);

  IF v_table IS NULL THEN
    IF COALESCE(v_seat_first, false) THEN
      SELECT count(*) INTO v_seats
        FROM public.table_seats s
        JOIN public.tables tb ON tb.id = s.table_id
       WHERE tb.tournament_id = p_tournament_id
         AND s.left_at IS NULL;
      UPDATE public.tournaments SET current_players = v_seats
       WHERE id = p_tournament_id
         AND current_players IS DISTINCT FROM v_seats;
      RETURN v_seats;
    END IF;
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_seats
    FROM public.table_seats
   WHERE table_id = v_table AND left_at IS NULL;

  UPDATE public.tables SET current_players = v_seats
   WHERE id = v_table
     AND current_players IS DISTINCT FROM v_seats;

  IF COALESCE(v_seat_first, false) THEN
    UPDATE public.tournaments SET current_players = v_seats
     WHERE id = p_tournament_id
       AND current_players IS DISTINCT FROM v_seats;
  END IF;

  IF v_is_spin AND v_cap > 0 AND v_seats >= v_cap THEN
    v_book := public.fn_spin_book_entry(p_tournament_id);
    IF COALESCE((v_book->>'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'paid third seat could not book Spin %: %',
        p_tournament_id,v_book USING ERRCODE = 'P0404';
    END IF;
  END IF;

  IF COALESCE(v_seat_first, false)
     AND v_cap > 0 AND v_seats >= v_cap THEN
    BEGIN
      PERFORM realtime.send(
        jsonb_build_object(
          'tournament_id', p_tournament_id,
          'variant', v_variant,
          'max_players', v_cap,
          'paid_seats', v_seats,
          'filled_at', now()
        ),
        'seat_first_ready',
        'seat_first',
        false
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING
        'fn_sync_seat_first_player_count: realtime.send failed for %: %',
        p_tournament_id, SQLERRM;
    END;
  END IF;

  RETURN v_seats;
END;
$seat_count$;

REVOKE ALL ON FUNCTION public.fn_sync_seat_first_player_count(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.fn_sync_seat_first_player_count(uuid) IS
  'Owner-only AFTER-seat invariant. The true seat root owns terminal/mission/launch/tournament locks before row DML; this helper never acquires a late global lock. Paid-third-seat booking refusal propagates.';

-- The AFTER-seat hook is part of the purchase transaction, not a storefront
-- counter updater. The historical body caught every error, committed the paid
-- third seat anyway and left the reserve booking to a repair sweep. A refusal
-- now aborts the seat statement, and the canonical predicate never sweeps a
-- larger SNG merely because its variant is `sng`.
CREATE OR REPLACE FUNCTION public.fn_seat_change_syncs_seat_first_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $seat_change$
DECLARE
  v_table_id uuid;
  v_tid uuid;
BEGIN
  v_table_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.table_id ELSE NEW.table_id END;
  IF v_table_id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT tournament_id INTO v_tid
    FROM public.tables
   WHERE id = v_table_id;
  IF v_tid IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.tournaments t
     WHERE t.id = v_tid
       AND (lower(COALESCE(t.variant,'')) = 'spin'
            OR COALESCE(t.max_players,0) <= 2)
  ) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  PERFORM public.fn_sync_seat_first_player_count(v_tid);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$seat_change$;

REVOKE ALL ON FUNCTION public.fn_seat_change_syncs_seat_first_count()
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.fn_seat_change_syncs_seat_first_count() IS
  'Strict canonical seat-first AFTER-seat hook. Count and paid-third-seat reserve booking succeed in the seat transaction or the seat mutation rolls back.';

-- A second structural assertion sits on the authoritative reserve receipt.
-- The balance trigger writes chip_ledger first; the operational function then
-- writes spin_reserve_ledger. If either side is absent or disagrees, the latter
-- insert aborts and rolls the entire transaction back.
CREATE OR REPLACE FUNCTION public.fn_spin_reserve_row_requires_exact_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $reserve_evidence$
DECLARE
  v_pool_id uuid;
  v_count integer;
  v_key text;
BEGIN
  IF NEW.tournament_id IS NULL
     OR NEW.kind NOT IN ('contribution','jackpot_draw') THEN
    RETURN NEW;
  END IF;

  IF NEW.buy_in IS NULL OR NEW.buy_in <= 0
     OR NEW.seats IS DISTINCT FROM 3
     OR NEW.amount IS NULL
     OR NEW.amount IS DISTINCT FROM round(NEW.amount,2)
     OR (NEW.kind = 'contribution'
         AND (NEW.house_rake IS NULL
              OR NEW.house_rake < 0
              OR NEW.amount IS DISTINCT FROM
                   round(NEW.buy_in * 3 - NEW.house_rake,2)))
     OR (NEW.kind = 'jackpot_draw'
         AND (NEW.multiplier IS NULL
              OR NEW.multiplier <= 0
              OR round(-NEW.amount,2) IS DISTINCT FROM
                   round(NEW.buy_in * NEW.multiplier,2))) THEN
    RAISE EXCEPTION
      'Spin % row for tournament % violates the exact three-seat funded contract',
      NEW.kind,NEW.tournament_id USING ERRCODE = '23514';
  END IF;

  SELECT p.id INTO v_pool_id
    FROM public.spin_bonus_pools p
   WHERE p.club_id = NEW.club_id;
  IF v_pool_id IS NULL THEN
    RAISE EXCEPTION 'Spin reserve row has no pool for owner %', NEW.club_id
      USING ERRCODE = 'P0404';
  END IF;

  v_key := 'spin:' || NEW.tournament_id::text
           || CASE WHEN NEW.kind = 'contribution' THEN ':entry' ELSE ':draw' END;

  SELECT count(*) INTO v_count
    FROM public.chip_ledger l
   WHERE l.category = CASE WHEN NEW.kind = 'contribution'
                           THEN 'spin_entry' ELSE 'spin_prize' END
     AND l.from_type = CASE WHEN NEW.kind = 'contribution'
                            THEN 'prize_liability' ELSE 'spin_reserve' END
     AND l.from_entity_id = CASE WHEN NEW.kind = 'contribution'
                                 THEN NEW.tournament_id ELSE v_pool_id END
     AND l.to_type = CASE WHEN NEW.kind = 'contribution'
                          THEN 'spin_reserve' ELSE 'prize_liability' END
     AND l.to_entity_id = CASE WHEN NEW.kind = 'contribution'
                               THEN v_pool_id ELSE NEW.tournament_id END
     AND l.tournament_id = NEW.tournament_id
     -- Stage 1 is database-first: the still-live old engine does not set the
     -- draw key before calling fn_spin_settle_game. Accept only NULL as its
     -- narrow compatibility shape; any non-NULL key must be the deterministic
     -- key. Stage 2 tightens this after the combined-RPC engine is verified.
     AND (l.idempotency_key = v_key OR l.idempotency_key IS NULL)
     AND l.amount = round(abs(NEW.amount), 2)
     AND CASE WHEN NEW.kind = 'contribution'
              THEN l.post_to_balance IS NOT DISTINCT FROM NEW.balance_after
              ELSE l.post_from_balance IS NOT DISTINCT FROM NEW.balance_after
          END;

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'Spin % row for tournament % requires one exact journal leg; found %',
      NEW.kind, NEW.tournament_id, v_count USING ERRCODE = 'P0404';
  END IF;
  RETURN NEW;
END;
$reserve_evidence$;

REVOKE ALL ON FUNCTION public.fn_spin_reserve_row_requires_exact_journal()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS spin_reserve_row_requires_exact_journal
  ON public.spin_reserve_ledger;
CREATE TRIGGER spin_reserve_row_requires_exact_journal
  BEFORE INSERT ON public.spin_reserve_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_spin_reserve_row_requires_exact_journal();

-- A contribution or draw is a receipt, not mutable state. Cancellation keeps
-- its product lifecycle by appending surplus_return/reversal evidence; it does
-- not rewrite the original draw.
CREATE OR REPLACE FUNCTION public.fn_spin_reserve_receipt_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $immutable_reserve$
BEGIN
  IF OLD.kind IN ('contribution','jackpot_draw') THEN
    RAISE EXCEPTION 'Spin reserve receipt % (%) is immutable',OLD.id,OLD.kind
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$immutable_reserve$;

REVOKE ALL ON FUNCTION public.fn_spin_reserve_receipt_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS spin_reserve_receipt_is_immutable
  ON public.spin_reserve_ledger;
CREATE TRIGGER spin_reserve_receipt_is_immutable
  BEFORE UPDATE OR DELETE ON public.spin_reserve_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_spin_reserve_receipt_is_immutable();

-- The reserve draw is the immutable money fact; the tournament columns are
-- its published contract. Stage 1 still permits the live old engine's one
-- post-settlement stamp, but only when it makes the row exactly equal to the
-- single draw. Once all three fields are present and coherent, they freeze.
CREATE OR REPLACE FUNCTION public.fn_spin_tournament_contract_is_draw()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $spin_contract$
DECLARE
  v_count integer;
  v_multiplier numeric;
  v_prize numeric;
  v_old_sealed boolean;
BEGIN
  IF NEW.spin_multiplier IS NOT DISTINCT FROM OLD.spin_multiplier
     AND NEW.prize_pool IS NOT DISTINCT FROM OLD.prize_pool
     AND NEW.spin_locked_tiers IS NOT DISTINCT FROM OLD.spin_locked_tiers THEN
    RETURN NEW;
  END IF;
  IF lower(COALESCE(NEW.variant,'')) <> 'spin'
     AND upper(COALESCE(NEW.tournament_type,'')) <> 'SPIN' THEN
    RETURN NEW;
  END IF;

  SELECT count(*),min(r.multiplier),min(round(-r.amount,2))
    INTO v_count,v_multiplier,v_prize
    FROM public.spin_reserve_ledger r
   WHERE r.tournament_id = NEW.id AND r.kind = 'jackpot_draw';
  IF v_count <> 1
     OR NEW.spin_multiplier IS DISTINCT FROM v_multiplier
     OR NEW.prize_pool IS DISTINCT FROM v_prize THEN
    RAISE EXCEPTION
      'Spin % tournament contract must equal its one immutable reserve draw',
      NEW.id USING ERRCODE = 'P0404';
  END IF;

  v_old_sealed := OLD.spin_multiplier IS NOT DISTINCT FROM v_multiplier
                  AND OLD.prize_pool IS NOT DISTINCT FROM v_prize
                  AND OLD.spin_locked_tiers IS NOT NULL;
  IF v_old_sealed THEN
    RAISE EXCEPTION 'Spin % published draw contract is immutable',NEW.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$spin_contract$;

REVOKE ALL ON FUNCTION public.fn_spin_tournament_contract_is_draw()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS spin_tournament_contract_is_draw ON public.tournaments;
CREATE TRIGGER spin_tournament_contract_is_draw
  BEFORE UPDATE OF spin_multiplier,prize_pool,spin_locked_tiers
  ON public.tournaments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_spin_tournament_contract_is_draw();

-- One public money authority. It books the paid entry, retains the reserve row
-- lock while drawing, settles that draw, and proves both durable records before
-- returning. The old two-RPC window allowed another Spin to consume the pool
-- between draw and settle and counted the current entry twice when entry had
-- already been booked at the third seat.
CREATE OR REPLACE FUNCTION public.fn_spin_draw_and_settle(
  p_tournament_id uuid,
  p_tiers jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
SET statement_timeout TO '30s'
AS $spin_authority$
DECLARE
  v_t record;
  v_table_id uuid;
  v_paid_seats integer;
  v_seat_users integer;
  v_exact_seat_stacks integer;
  v_paid_users integer;
  v_roster_users integer;
  v_exact_roster_stacks integer;
  v_buyin_debits integer;
  v_buyin_total numeric;
  v_book jsonb;
  v_settle jsonb;
  v_owner uuid;
  v_pool_id uuid;
  v_available numeric;
  v_highest_stake numeric;
  v_rake_rate numeric;
  v_reserve_in numeric;
  v_tier jsonb;
  v_multiplier numeric;
  v_frequency numeric;
  v_threshold numeric;
  v_prize numeric;
  v_total numeric := 0;
  v_roll numeric;
  v_acc numeric := 0;
  v_pick numeric := NULL;
  v_eligible jsonb := '[]'::jsonb;
  v_locked jsonb := '[]'::jsonb;
  v_seen numeric[] := ARRAY[]::numeric[];
  v_booked_multiplier numeric;
  v_booked_draw numeric;
  v_leg_count integer;
  v_draw_existed boolean := false;
  v_entry_reserve_id uuid;
  v_entry_journal_id uuid;
  v_draw_reserve_id uuid;
  v_draw_journal_id uuid;
  v_escrow_reserve_out numeric;
  v_escrow_reserve_in numeric;
  v_escrow_prize_balance numeric;
  v_row_count integer;
  v_draw_key text := 'spin:' || p_tournament_id::text || ':draw';
BEGIN
  IF p_tournament_id IS NULL
     OR p_tiers IS NULL
     OR jsonb_typeof(p_tiers) <> 'array'
     OR jsonb_array_length(p_tiers) = 0 THEN
    RAISE EXCEPTION 'Spin draw-and-settle requires a tournament and tier array'
      USING ERRCODE = '22023';
  END IF;

  SELECT t.id, t.club_id, t.buy_in_amount, t.max_players, t.variant,
         t.tournament_type, t.status, t.spin_multiplier, t.prize_pool,
         t.spin_locked_tiers, t.starting_chips
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Spin tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF lower(COALESCE(v_t.variant,'')) <> 'spin'
     AND upper(COALESCE(v_t.tournament_type,'')) <> 'SPIN' THEN
    RAISE EXCEPTION 'tournament % is not a Spin', p_tournament_id
      USING ERRCODE = '22023';
  END IF;
  IF COALESCE(v_t.club_id, '00000000-0000-0000-0000-000000000000'::uuid)
       = '00000000-0000-0000-0000-000000000000'::uuid
     OR COALESCE(v_t.buy_in_amount,0) <= 0
     OR COALESCE(v_t.max_players,0) <> 3
     OR v_t.starting_chips IS NULL
     OR v_t.starting_chips::text IN ('NaN','Infinity','-Infinity')
     OR v_t.starting_chips <= 0 THEN
    RAISE EXCEPTION 'Spin % has invalid club, buy-in, seat or starting-stack contract',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  IF upper(COALESCE(v_t.status::text,'')) IN
       ('COMPLETED','CANCELLED','CANCELED') THEN
    RAISE EXCEPTION 'Spin % cannot draw from status %',
      p_tournament_id, v_t.status USING ERRCODE = '55000';
  END IF;

  v_table_id := public.fn_tournament_primary_table(p_tournament_id);
  SELECT count(*), count(DISTINCT s.user_id),
         count(*) FILTER (
           WHERE s.stack IS NOT DISTINCT FROM v_t.starting_chips
             AND s.stack::text NOT IN ('NaN','Infinity','-Infinity')
             AND s.stack > 0)
    INTO v_paid_seats, v_seat_users, v_exact_seat_stacks
    FROM public.table_seats s
   WHERE s.table_id = v_table_id AND s.left_at IS NULL;
  SELECT count(DISTINCT tp.user_id),
         count(*) FILTER (
           WHERE tp.status = 'playing'
             AND tp.chips IS NOT DISTINCT FROM v_t.starting_chips
             AND tp.chips::text NOT IN ('NaN','Infinity','-Infinity')
             AND tp.chips > 0
             AND s.user_id IS NOT NULL
             AND tp.table_id IS NOT DISTINCT FROM s.table_id
             AND tp.seat_number IS NOT DISTINCT FROM s.seat_number)
    INTO v_roster_users, v_exact_roster_stacks
    FROM public.tournament_players tp
    LEFT JOIN public.table_seats s
      ON s.table_id = v_table_id
     AND s.user_id = tp.user_id
     AND s.left_at IS NULL
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*) INTO v_paid_users
    FROM (
      SELECT tp.user_id
        FROM public.tournament_players tp
        JOIN public.wallet_transactions w
          ON w.related_entity_id = tp.tournament_id
         AND w.user_id = tp.user_id
         AND w.type = 'debit'
         AND w.category = 'tournament_buyin'
       WHERE tp.tournament_id = p_tournament_id
       GROUP BY tp.user_id
      HAVING round(sum(w.amount),2) = round(v_t.buy_in_amount,2)
    ) paid;
  SELECT count(*), round(COALESCE(sum(w.amount),0),2)
    INTO v_buyin_debits,v_buyin_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
     AND w.type = 'debit'
     AND w.category = 'tournament_buyin';
  IF v_table_id IS NULL OR v_paid_seats <> 3 OR v_seat_users <> 3
     OR v_exact_seat_stacks <> 3
     OR v_roster_users <> 3
     OR v_exact_roster_stacks <> 3
     OR v_paid_users <> 3
     OR v_buyin_debits <> 3
     OR v_buyin_total <> round(v_t.buy_in_amount * 3,2)
     OR EXISTS (
       SELECT 1
         FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND NOT EXISTS (
            SELECT 1 FROM public.table_seats s
             WHERE s.table_id = v_table_id
               AND s.left_at IS NULL
               AND s.user_id = tp.user_id
          )
     ) THEN
    RAISE EXCEPTION
      'Spin % is not exactly three paid rostered starting stacks (% seats, % exact seat stacks, % seat users, % roster users, % exact roster stacks, % paid users, % debits, % total)',
      p_tournament_id, v_paid_seats, v_exact_seat_stacks, v_seat_users,
      v_roster_users, v_exact_roster_stacks, v_paid_users, v_buyin_debits,v_buyin_total
      USING ERRCODE = '55000';
  END IF;

  -- fn_spin_book_entry owns the escrow -> advisory -> reserve lock order. The
  -- outer transaction retains every lock it takes through the draw below.
  v_book := public.fn_spin_book_entry(p_tournament_id);
  IF COALESCE((v_book->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Spin % entry booking refused: %', p_tournament_id, v_book
      USING ERRCODE = 'P0404';
  END IF;
  BEGIN
    v_entry_reserve_id := (v_book->>'entry_reserve_id')::uuid;
    v_entry_journal_id := (v_book->>'entry_journal_id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Spin % entry returned no immutable evidence ids: %',
      p_tournament_id,v_book USING ERRCODE = 'P0404';
  END;

  v_owner := public.fn_spin_reserve_pool(v_t.club_id);
  SELECT p.id, p.balance, GREATEST(p.highest_stake, v_t.buy_in_amount)
    INTO v_pool_id, v_available, v_highest_stake
    FROM public.spin_bonus_pools p
   WHERE p.club_id = v_owner
   FOR UPDATE;
  IF v_pool_id IS NULL THEN
    RAISE EXCEPTION 'Spin % reserve pool is missing', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;

  v_rake_rate := public.fn_spin_rake_rate(v_t.buy_in_amount);
  v_reserve_in := round(v_t.buy_in_amount * 3 * (1 - v_rake_rate), 2);
  IF NOT EXISTS (
       SELECT 1 FROM public.spin_reserve_ledger r
        WHERE r.tournament_id = p_tournament_id
          AND r.kind = 'contribution'
          AND r.club_id = v_owner
          AND r.amount = v_reserve_in
     )
     OR (SELECT count(*) FROM public.chip_ledger l
          WHERE l.category = 'spin_entry'
            AND l.from_type = 'prize_liability'
            AND l.from_entity_id = p_tournament_id
            AND l.to_type = 'spin_reserve'
            AND l.to_entity_id = v_pool_id
            AND l.amount = v_reserve_in) <> 1 THEN
    RAISE EXCEPTION 'Spin % entry did not produce exact reserve evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT r.multiplier, round(-r.amount,2)
    INTO v_booked_multiplier, v_booked_draw
    FROM public.spin_reserve_ledger r
   WHERE r.tournament_id = p_tournament_id AND r.kind = 'jackpot_draw'
   ORDER BY r.created_at, r.id
   LIMIT 1;
  v_draw_existed := v_booked_multiplier IS NOT NULL;

  IF v_booked_multiplier IS NULL THEN
    IF COALESCE(v_t.spin_multiplier,0) > 0 THEN
      RAISE EXCEPTION
        'Spin % row carries multiplier % without an authoritative reserve draw',
        p_tournament_id, v_t.spin_multiplier USING ERRCODE = 'P0404';
    END IF;

    FOR v_tier IN SELECT value FROM jsonb_array_elements(p_tiers) LOOP
      BEGIN
        v_multiplier := (v_tier->>'multiplier')::numeric;
        v_frequency := (v_tier->>'freq')::numeric;
        v_threshold := COALESCE((v_tier->>'reserveThresholdX')::numeric,0);
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Spin % tier is not numeric: %',
          p_tournament_id, v_tier USING ERRCODE = '22023';
      END;
      IF v_multiplier IS NULL OR v_multiplier <= 0
         OR v_frequency IS NULL OR v_frequency < 0
         OR v_threshold < 0
         OR v_multiplier = ANY(v_seen) THEN
        RAISE EXCEPTION 'Spin % tier is invalid or duplicated: %',
          p_tournament_id, v_tier USING ERRCODE = '23514';
      END IF;
      v_seen := array_append(v_seen, v_multiplier);
      v_prize := round(v_t.buy_in_amount * v_multiplier, 2);

      -- v_available already includes this event's contribution. The retired
      -- draw RPC added v_reserve_in a second time whenever entry was booked.
      IF v_available < v_prize THEN
        v_locked := v_locked || jsonb_build_object(
          'multiplier',v_multiplier,'reason','unaffordable',
          'unlocksAt',round(v_prize,2));
      ELSIF v_threshold > 0
            AND v_available < v_multiplier * v_highest_stake * v_threshold THEN
        v_locked := v_locked || jsonb_build_object(
          'multiplier',v_multiplier,'reason','threshold',
          'unlocksAt',round(v_multiplier * v_highest_stake * v_threshold,2));
      ELSE
        v_eligible := v_eligible || v_tier;
        v_total := v_total + v_frequency;
      END IF;
    END LOOP;

    IF v_total <= 0 OR jsonb_array_length(v_eligible) = 0 THEN
      RAISE EXCEPTION 'Spin % has no eligible funded tier at reserve %',
        p_tournament_id, v_available USING ERRCODE = '55000';
    END IF;

    v_roll := (('x' || encode(extensions.gen_random_bytes(6),'hex'))::bit(48)::bigint)::numeric
              / 281474976710656::numeric * v_total;
    FOR v_tier IN SELECT value FROM jsonb_array_elements(v_eligible) LOOP
      v_acc := v_acc + (v_tier->>'freq')::numeric;
      IF v_roll < v_acc THEN
        v_pick := (v_tier->>'multiplier')::numeric;
        EXIT;
      END IF;
    END LOOP;
    IF v_pick IS NULL THEN
      v_pick := (v_eligible -> (jsonb_array_length(v_eligible)-1)
                            ->> 'multiplier')::numeric;
    END IF;

    PERFORM set_config('app.ledger_idempotency_key',v_draw_key,true);
    v_settle := public.fn_spin_settle_game(
      p_tournament_id, v_t.club_id, v_t.buy_in_amount, 3,
      v_pick, v_rake_rate);
    PERFORM set_config('app.ledger_idempotency_key','',true);
    v_booked_multiplier := v_pick;
    v_booked_draw := round(v_t.buy_in_amount * v_pick,2);
  ELSE
    -- The lower-level primitive returns and verifies the immutable booked
    -- truth; it never draws again on a retry.
    PERFORM set_config('app.ledger_idempotency_key',v_draw_key,true);
    v_settle := public.fn_spin_settle_game(
      p_tournament_id, v_t.club_id, v_t.buy_in_amount, 3,
      v_booked_multiplier, v_rake_rate);
    PERFORM set_config('app.ledger_idempotency_key','',true);
    v_locked := COALESCE(v_t.spin_locked_tiers,'[]'::jsonb);
  END IF;

  IF COALESCE((v_settle->>'ok')::boolean,false) IS NOT TRUE
     OR (v_settle->>'multiplier') IS NOT NULL
        AND (v_settle->>'multiplier')::numeric <> v_booked_multiplier
     OR COALESCE((v_settle->>'pool_covered')::numeric,0) <> v_booked_draw
     OR COALESCE((v_settle->>'operator_shortfall')::numeric,0) <> 0 THEN
    RAISE EXCEPTION 'Spin % did not settle its exact funded draw: %',
      p_tournament_id, v_settle USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), (array_agg(r.id ORDER BY r.created_at,r.id))[1]
    INTO v_row_count,v_draw_reserve_id
    FROM public.spin_reserve_ledger r
   WHERE r.tournament_id = p_tournament_id
     AND r.kind = 'jackpot_draw'
     AND r.club_id = v_owner
     AND r.multiplier = v_booked_multiplier
     AND r.buy_in = v_t.buy_in_amount
     AND r.seats = 3
     AND round(-r.amount,2) = v_booked_draw;
  IF v_row_count <> 1 THEN
    RAISE EXCEPTION 'Spin % draw evidence is not exact after settlement',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), (array_agg(l.id ORDER BY l.created_at,l.id))[1]
    INTO v_leg_count,v_draw_journal_id
    FROM public.chip_ledger l
    JOIN public.spin_reserve_ledger r ON r.id = v_draw_reserve_id
   WHERE l.category = 'spin_prize'
     AND l.from_type = 'spin_reserve'
     AND l.from_entity_id = v_pool_id
     AND l.to_type = 'prize_liability'
     AND l.to_entity_id = p_tournament_id
     AND l.tournament_id = p_tournament_id
     AND l.amount = v_booked_draw
     AND l.post_from_balance IS NOT DISTINCT FROM r.balance_after
     AND (v_draw_existed OR l.idempotency_key = v_draw_key);
  IF v_leg_count <> 1 THEN
    RAISE EXCEPTION 'Spin % draw has % exact journal legs',
      p_tournament_id,v_leg_count USING ERRCODE = 'P0404';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM public.spin_reserve_ledger r
        WHERE r.id = v_entry_reserve_id
          AND r.tournament_id = p_tournament_id
          AND r.kind = 'contribution'
          AND r.club_id = v_owner
          AND r.amount = v_reserve_in)
     OR NOT EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.id = v_entry_journal_id
          AND l.tournament_id = p_tournament_id
          AND l.category = 'spin_entry'
          AND l.amount = v_reserve_in) THEN
    RAISE EXCEPTION 'Spin % entry receipt ids do not resolve to exact evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT e.reserve_out,e.reserve_in,e.prize_balance
    INTO v_escrow_reserve_out,v_escrow_reserve_in,v_escrow_prize_balance
    FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_escrow_reserve_out IS DISTINCT FROM v_reserve_in
     OR v_escrow_reserve_in IS DISTINCT FROM v_booked_draw
     OR v_escrow_prize_balance IS DISTINCT FROM v_booked_draw THEN
    RAISE EXCEPTION
      'Spin % escrow does not equal entry %, draw % (out %, in %, prize %)',
      p_tournament_id,v_reserve_in,v_booked_draw,
      v_escrow_reserve_out,v_escrow_reserve_in,v_escrow_prize_balance
      USING ERRCODE = 'P0404';
  END IF;

  IF COALESCE(v_t.spin_multiplier,0) > 0
     AND v_t.spin_multiplier IS DISTINCT FROM v_booked_multiplier THEN
    RAISE EXCEPTION 'Spin % row multiplier % disagrees with immutable draw %',
      p_tournament_id,v_t.spin_multiplier,v_booked_multiplier
      USING ERRCODE = 'P0404';
  END IF;
  IF COALESCE(v_t.spin_multiplier,0) > 0
     AND v_t.prize_pool IS DISTINCT FROM v_booked_draw THEN
    RAISE EXCEPTION 'Spin % row prize pool % disagrees with immutable draw %',
      p_tournament_id,v_t.prize_pool,v_booked_draw USING ERRCODE = 'P0404';
  END IF;

  -- Stage 2 keys the immutable tournament-contract trigger to this authority.
  -- Stage 1 does not require the marker yet because the still-live old engine
  -- must be able to finish its database-first rolling cutover.
  PERFORM set_config(
    'app.spin_settlement_authority',p_tournament_id::text,true);
  UPDATE public.tournaments
     SET spin_multiplier = v_booked_multiplier,
         prize_pool = v_booked_draw,
         spin_locked_tiers = v_locked
   WHERE id = p_tournament_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  PERFORM set_config('app.spin_settlement_authority','',true);
  IF v_row_count <> 1 THEN
    RAISE EXCEPTION 'Spin % tournament contract could not be stamped',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT p.balance INTO v_available
    FROM public.spin_bonus_pools p WHERE p.id = v_pool_id;

  RETURN v_settle || jsonb_build_object(
    'ok',true,
    'money_path','fn_spin_draw_and_settle',
    'tournament_id',p_tournament_id,
    'seats',3,
    'paid_users',v_paid_users,
    'multiplier',v_booked_multiplier,
    'prize_pool',v_booked_draw,
    'pool_covered',v_booked_draw,
    'operator_shortfall',0,
    'draw_amount',v_booked_draw,
    'entry_amount',v_reserve_in,
    'reserve_in',v_reserve_in,
    'house_rake',round(v_t.buy_in_amount * 3 * v_rake_rate,2),
    'reserve_balance',v_available,
    'pool_id',v_pool_id,
    'entry_reserve_id',v_entry_reserve_id,
    'entry_journal_id',v_entry_journal_id,
    'draw_reserve_id',v_draw_reserve_id,
    'draw_journal_id',v_draw_journal_id,
    'escrow_reserve_out',v_escrow_reserve_out,
    'escrow_reserve_in',v_escrow_reserve_in,
    'escrow_prize_balance',v_escrow_prize_balance,
    'tournament_multiplier',v_booked_multiplier,
    'tournament_prize_pool',v_booked_draw,
    'locked',v_locked,
    'eligible_count',jsonb_array_length(v_eligible),
    'owner_id',v_owner);
END;
$spin_authority$;

REVOKE ALL ON FUNCTION public.fn_spin_draw_and_settle(uuid,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_draw_and_settle(uuid,jsonb)
  TO service_role;

-- Exact historical correction: this completed 3x Spin debited the reserve and
-- wrote its immutable draw row, but the strict journal leg never landed. Put
-- that already-moved 3.00 into this event's escrow, then pay the already-owed
-- winner only through the owner-only raw cash authority. Every observed fact
-- is asserted first; an unexpected or partially repaired shape aborts.
DO $repair_781cc0ee$
DECLARE
  v_tid constant uuid := '781cc0ee-6a1d-4e31-acaf-4e737661bba1';
  v_winner constant uuid := 'c402b38e-7ba6-40bf-a2d3-d65376d28ccf';
  v_entry_id constant uuid := 'f5e018ab-d15d-4d6c-bda0-270e97daf8eb';
  v_draw_id constant uuid := 'd6eba15c-04b2-47f2-a168-731d4f433696';
  v_obligation_id constant uuid := 'd367f526-d950-4b4a-af4d-07793000d7c6';
  v_expected_pool constant uuid := '2d968239-acdd-4a2c-99f2-a369ff37ae31';
  v_club uuid;
  v_owner uuid;
  v_pool_id uuid;
  v_balance_after numeric;
  v_journals integer;
  v_suspense integer;
  v_paid numeric;
  v_wallet_before numeric;
  v_wallet_after numeric;
  v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = v_tid) THEN
    RETURN; -- clean replay has no production incident row
  END IF;

  PERFORM 1 FROM public.tournaments WHERE id = v_tid FOR UPDATE;
  IF (SELECT count(*) FROM public.tournaments t
       WHERE t.id = v_tid
         AND lower(COALESCE(t.variant,'')) = 'spin'
         AND upper(COALESCE(t.status::text,'')) = 'COMPLETED'
         AND t.buy_in_amount = 1
         AND t.max_players = 3
         AND t.spin_multiplier = 3
         AND t.prize_pool = 3) <> 1
     OR (SELECT count(*) FROM public.tournament_players tp
          WHERE tp.tournament_id = v_tid) <> 3
     OR (SELECT count(*) FROM public.tournament_players tp
          WHERE tp.tournament_id = v_tid AND tp.user_id = v_winner
            AND tp.position = 1 AND tp.prize = 3) <> 1
     OR (SELECT count(*) FROM public.wallet_transactions w
          WHERE w.related_entity_id = v_tid AND w.type = 'debit'
            AND w.category = 'tournament_buyin') <> 3
     OR (SELECT round(COALESCE(sum(w.amount),0),2)
           FROM public.wallet_transactions w
          WHERE w.related_entity_id = v_tid AND w.type = 'debit'
            AND w.category = 'tournament_buyin') <> 3 THEN
    RAISE EXCEPTION 'Spin % no longer has the asserted three-seat 3x contract',v_tid;
  END IF;

  SELECT t.club_id,r.club_id,p.id,r.balance_after
    INTO v_club,v_owner,v_pool_id,v_balance_after
    FROM public.tournaments t
    JOIN public.spin_reserve_ledger r ON r.id = v_draw_id
    JOIN public.spin_bonus_pools p ON p.club_id = r.club_id
   WHERE t.id = v_tid
     AND r.tournament_id = v_tid
     AND r.kind = 'jackpot_draw'
     AND r.amount = -3
     AND r.multiplier = 3
     AND r.buy_in = 1
     AND r.seats = 3;
  IF NOT FOUND OR v_pool_id IS DISTINCT FROM v_expected_pool
     OR (SELECT count(*) FROM public.spin_reserve_ledger r
          WHERE r.tournament_id = v_tid AND r.kind = 'jackpot_draw') <> 1
     OR (SELECT count(*) FROM public.spin_reserve_ledger r
          WHERE r.id = v_entry_id AND r.tournament_id = v_tid
            AND r.kind = 'contribution' AND r.club_id = v_owner
            AND r.amount = 2.76 AND r.buy_in = 1 AND r.seats = 3
            AND r.house_rake = 0.24) <> 1 THEN
    RAISE EXCEPTION 'Spin % reserve evidence moved since the incident probe',v_tid;
  END IF;

  SELECT count(*) INTO v_journals
    FROM public.chip_ledger l
   WHERE l.category = 'spin_prize'
     AND l.from_type = 'spin_reserve' AND l.from_entity_id = v_pool_id
     AND l.to_type = 'prize_liability' AND l.to_entity_id = v_tid
     AND l.tournament_id = v_tid AND l.amount = 3;
  SELECT count(*) INTO v_suspense
    FROM public.chip_ledger l
   WHERE l.category = 'adjustment'
     AND l.from_type = 'spin_reserve' AND l.from_entity_id = v_pool_id
     AND l.to_type = 'settlement_suspense' AND l.amount = 3
     AND l.post_from_balance IS NOT DISTINCT FROM v_balance_after;
  SELECT round(COALESCE(sum(p.amount),0),2) INTO v_paid
    FROM public.tournament_payouts p WHERE p.tournament_id = v_tid;

  IF v_journals = 0 THEN
    IF v_suspense <> 0 OR v_paid <> 0
       OR (SELECT count(*) FROM public.tournament_obligations o
            WHERE o.id = v_obligation_id AND o.tournament_id = v_tid
              AND o.kind = 'place' AND o.place = 1 AND o.user_id = v_winner
              AND o.amount_owed = 3 AND o.amount_paid = 0) <> 1
       OR (SELECT count(*) FROM public.tournament_escrow e
            WHERE e.tournament_id = v_tid AND e.reserve_out = 2.76
              AND e.reserve_in = 0 AND e.prize_out = 0
              AND e.prize_balance = 0) <> 1 THEN
      RAISE EXCEPTION 'Spin % is not in the exact unpaid/missing-journal state',v_tid;
    END IF;

    SELECT cm.chip_balance INTO v_wallet_before
      FROM public.club_members cm
     WHERE cm.club_id = v_club AND cm.user_id = v_winner
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Spin % winner wallet is missing',v_tid;
    END IF;

    INSERT INTO public.chip_ledger
      (performed_by,from_type,from_entity_id,from_label,
       to_type,to_entity_id,to_label,amount,category,club_id,
       description,pre_from_balance,post_from_balance,tournament_id,
       idempotency_key,metadata)
    VALUES
      ('2d1cd6c3-5700-4af9-a271-d4863fdab20d',
       'spin_reserve',v_pool_id,'spin_bonus_pools.balance',
       'prize_liability',v_tid,'tournaments.prize_pool',3,'spin_prize',v_club,
       'Authoritative missing Spin draw journal for 781cc0ee; reserve row d6eba15c already moved exactly 3.00 and no suspense leg or payout existed.',
       v_balance_after + 3,v_balance_after,v_tid,
       'spin:' || v_tid::text || ':draw',
       jsonb_build_object('migration','20260909014433',
                          'reserve_draw_id',v_draw_id,
                          'historical_correction',true));

    IF (SELECT count(*) FROM public.chip_ledger l
         WHERE l.idempotency_key = 'spin:' || v_tid::text || ':draw'
           AND l.category = 'spin_prize' AND l.amount = 3
           AND l.from_entity_id = v_pool_id AND l.to_entity_id = v_tid) <> 1
       OR (SELECT count(*) FROM public.tournament_escrow e
            WHERE e.tournament_id = v_tid AND e.reserve_out = 2.76
              AND e.reserve_in = 3 AND e.prize_out = 0
              AND e.prize_balance = 3) <> 1 THEN
      RAISE EXCEPTION 'Spin % journal did not fund its escrow atomically',v_tid;
    END IF;

    v_result := public.fn_ca_settle_tournament_place_raw(v_tid,1,v_winner,3);
    IF COALESCE((v_result->>'fully_settled')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Spin % winner did not settle in full: %',v_tid,v_result;
    END IF;
    SELECT cm.chip_balance INTO v_wallet_after
      FROM public.club_members cm
     WHERE cm.club_id = v_club AND cm.user_id = v_winner;
    IF v_wallet_after - v_wallet_before <> 3 THEN
      RAISE EXCEPTION 'Spin % winner received %, expected 3',
        v_tid,v_wallet_after-v_wallet_before;
    END IF;
  ELSIF v_journals <> 1 OR v_suspense <> 0 OR v_paid <> 3 THEN
    RAISE EXCEPTION 'Spin % has an unexpected partial/duplicate correction',v_tid;
  END IF;

  IF (SELECT count(*) FROM public.tournament_payouts p
       WHERE p.tournament_id = v_tid AND p.user_id = v_winner
         AND p."position" = 1 AND p.amount = 3) <> 1
     OR (SELECT count(*) FROM public.tournament_obligations o
          WHERE o.id = v_obligation_id AND o.tournament_id = v_tid
            AND o.user_id = v_winner AND o.kind = 'place' AND o.place = 1
            AND o.amount_owed = 3 AND o.amount_paid = 3
            AND o.settled_at IS NOT NULL) <> 1
     OR (SELECT count(*) FROM public.tournament_escrow e
          WHERE e.tournament_id = v_tid AND e.reserve_out = 2.76
            AND e.reserve_in = 3 AND e.prize_out = 3
            AND e.prize_balance = 0) <> 1 THEN
    RAISE EXCEPTION 'Spin % did not finish with one exact paid receipt',v_tid;
  END IF;
END;
$repair_781cc0ee$;

-- Exact historical acceptance: this legacy 10x event paid 10.00 in total
-- against an immutable 10.00 reserve draw while tournaments.prize_pool still
-- said 3.00. The 9.40 winner payment and 0.60 runner-up payment are accepted;
-- no clawback and no additional 0.60 payment. Normalize only the stale winner
-- obligation and close every alert/incident for this known shape.
DO $accept_6d688095$
DECLARE
  v_tid constant uuid := '6d688095-c3c5-4d40-a5a0-952934667732';
  v_actual_winner uuid;
  v_actual_runner uuid;
  v_total_before numeric;
  v_wallet_before numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = v_tid) THEN
    RETURN;
  END IF;

  PERFORM 1 FROM public.tournaments WHERE id = v_tid FOR UPDATE;
  SELECT tp.user_id INTO v_actual_winner FROM public.tournament_players tp
   WHERE tp.tournament_id = v_tid AND tp.position = 1;
  SELECT tp.user_id INTO v_actual_runner FROM public.tournament_players tp
   WHERE tp.tournament_id = v_tid AND tp.position = 2;
  -- Full ids are intentionally read from the immutable finish rows; the
  -- incident handoff carried their prefixes only. Refuse any different payout
  -- shape rather than inventing the suffixes in a data migration.
  IF v_actual_winner::text NOT LIKE 'a70a0d4c-%'
     OR v_actual_runner::text NOT LIKE 'bbcaaed4-%'
     OR (SELECT count(*) FROM public.tournaments t
          WHERE t.id = v_tid AND lower(COALESCE(t.variant,'')) = 'spin'
            AND upper(COALESCE(t.status::text,'')) = 'COMPLETED'
            AND t.buy_in_amount = 1 AND t.max_players = 3
            AND t.spin_multiplier = 10 AND t.prize_pool = 3) <> 1
     OR (SELECT count(*) FROM public.spin_reserve_ledger r
          WHERE r.tournament_id = v_tid AND r.kind = 'contribution'
            AND r.amount = 2.76 AND r.buy_in = 1 AND r.seats = 3
            AND r.house_rake = 0.24) <> 1
     OR (SELECT count(*) FROM public.spin_reserve_ledger r
          WHERE r.tournament_id = v_tid AND r.kind = 'jackpot_draw'
            AND r.amount = -10 AND r.multiplier = 10
            AND r.buy_in = 1 AND r.seats = 3) <> 1
     OR (SELECT count(*) FROM public.chip_ledger l
          WHERE l.tournament_id = v_tid AND l.category = 'spin_prize'
            AND l.from_type = 'spin_reserve'
            AND l.to_type = 'prize_liability' AND l.to_entity_id = v_tid
            AND l.amount = 10) <> 1
     OR (SELECT count(*) FROM public.tournament_escrow e
          WHERE e.tournament_id = v_tid AND e.reserve_out = 2.76
            AND e.reserve_in = 10 AND e.prize_out = 10
            AND e.prize_balance = 0) <> 1 THEN
    RAISE EXCEPTION 'Spin % no longer matches the accepted legacy 10x evidence',v_tid;
  END IF;

  SELECT round(COALESCE(sum(p.amount),0),2) INTO v_total_before
    FROM public.tournament_payouts p WHERE p.tournament_id = v_tid;
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = v_tid AND w.type = 'credit'
     AND w.category = 'prize';
  IF v_total_before <> 10 OR v_wallet_before <> 10
     OR (SELECT round(COALESCE(sum(p.amount),0),2)
           FROM public.tournament_payouts p
          WHERE p.tournament_id = v_tid AND p.user_id = v_actual_winner) <> 9.40
     OR (SELECT round(COALESCE(sum(p.amount),0),2)
           FROM public.tournament_payouts p
          WHERE p.tournament_id = v_tid AND p.user_id = v_actual_runner) <> 0.60
     OR (SELECT count(*) FROM public.tournament_obligations o
          WHERE o.tournament_id = v_tid AND o.kind = 'place' AND o.place = 1
            AND o.user_id = v_actual_winner AND o.amount_paid = 9.40
            AND o.amount_owed IN (9.40,10.00)) <> 1
     OR (SELECT count(*) FROM public.tournament_obligations o
          WHERE o.tournament_id = v_tid AND o.kind = 'place' AND o.place = 2
            AND o.user_id = v_actual_runner AND o.amount_paid = 0.60
            AND o.amount_owed = 0.60) <> 1 THEN
    RAISE EXCEPTION 'Spin % payout/obligation evidence moved; no automatic action is safe',v_tid;
  END IF;

  UPDATE public.tournament_obligations o
     SET amount_owed = 9.40,
         amount_paid = 9.40,
         source = 'accepted_historical_spin_overpayment_no_clawback',
         settled_at = COALESCE(o.settled_at,now()),
         updated_at = now()
   WHERE o.tournament_id = v_tid AND o.kind = 'place' AND o.place = 1
     AND o.user_id = v_actual_winner AND o.amount_paid = 9.40
     AND o.amount_owed IN (9.40,10.00);

  UPDATE public.financial_alerts f
     SET resolved = true,
         resolved_at = COALESCE(f.resolved_at,now()),
         resolution = COALESCE(NULLIF(f.resolution,'') || ' | ','')
           || 'Accepted historical Spin payout: immutable reserve draw and total payout are both 10.00. Legacy prize_pool remained 3.00; winner 9.40 plus runner-up 0.60 is final. No clawback and no further 0.60 payment. Root fixed by fn_spin_draw_and_settle (20260909014433).'
   WHERE f.context->>'tournament_id' = v_tid::text
      OR f.context#>>'{rows,0,tournament_id}' = v_tid::text
      OR f.message ILIKE '%' || v_tid::text || '%'
      OR f.message ILIKE '%6d688095%';

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved',
         resolved_at = COALESCE(i.resolved_at,now()),
         auto_repair_status = 'not_applicable',
         root_cause = 'Legacy Spin row retained prize_pool 3.00 after an exact 10.00 reserve draw and 10.00 total payout.',
         correction_ref = '20260909014433:accepted-no-clawback-no-further-payment',
         resolution = 'Accepted historical payout; no chips moved. Winner obligation normalized from 10.00 owed / 9.40 paid to its final 9.40 receipt; runner-up remains paid 0.60.'
   WHERE i.tournament_id = v_tid
      OR i.metadata->>'tournament_id' = v_tid::text;

  IF (SELECT round(COALESCE(sum(p.amount),0),2)
        FROM public.tournament_payouts p WHERE p.tournament_id = v_tid)
       IS DISTINCT FROM v_total_before
     OR (SELECT round(COALESCE(sum(w.amount),0),2)
           FROM public.wallet_transactions w
          WHERE w.related_entity_id = v_tid AND w.type = 'credit'
            AND w.category = 'prize') IS DISTINCT FROM v_wallet_before
     OR (SELECT count(*) FROM public.tournament_obligations o
          WHERE o.tournament_id = v_tid AND o.kind = 'place' AND o.place = 1
            AND o.user_id = v_actual_winner AND o.amount_owed = 9.40
            AND o.amount_paid = 9.40 AND o.settled_at IS NOT NULL) <> 1 THEN
    RAISE EXCEPTION 'Spin % acceptance moved chips or left a stale obligation',v_tid;
  END IF;
END;
$accept_6d688095$;

-- RETIRE THE STACK REPAIR, WITHOUT A GAP.
--
-- The job's session advisory lock is taken first. That waits for a running
-- invocation to finish and makes every newly-started tick take its `-1` branch.
-- SHARE locks then hold all writers behind this transaction while the durable
-- seat invariants and the exact old-job candidate set are proven. Only a clean
-- database may lose the fallback; no row is changed to manufacture that proof.
DO $retire_stack_repair$
DECLARE
  v_source text;
  v_job record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('credit-stalled-seat-first-stacks'));

  -- Keep a scheduler writer from recreating the job after the final scan but
  -- before COMMIT. SHARE conflicts with cron.schedule/unschedule's row writes;
  -- this transaction can still delete the rows it has proved and owns.
  LOCK TABLE cron.job IN SHARE MODE;
  LOCK TABLE public.tournaments IN SHARE MODE;
  LOCK TABLE public.tables IN SHARE MODE;
  LOCK TABLE public.table_seats IN SHARE MODE;
  LOCK TABLE public.tournament_players IN SHARE MODE;
  LOCK TABLE public.hand_history IN SHARE MODE;

  SELECT p.prosrc INTO v_source
    FROM pg_proc p
   WHERE p.oid = 'public.fn_ca_guard_seat_creation()'::regprocedure;
  IF v_source NOT LIKE '%TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK%'
     OR v_source NOT LIKE '%SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS%'
     OR NOT EXISTS (
       SELECT 1
         FROM pg_trigger tr
        WHERE tr.tgrelid = 'public.table_seats'::regclass
          AND tr.tgname = 'trg_ca_guard_seat_creation'
          AND tr.tgfoid = 'public.fn_ca_guard_seat_creation()'::regprocedure
          AND NOT tr.tgisinternal
          AND tr.tgenabled <> 'D'
     ) THEN
    RAISE EXCEPTION 'the paid-seat root invariant is not armed';
  END IF;

  SELECT p.prosrc INTO v_source
    FROM pg_proc p
   WHERE p.oid = 'public.fn_seat_change_syncs_seat_first_count()'::regprocedure;
  IF v_source LIKE '%EXCEPTION WHEN OTHERS%'
     OR v_source LIKE '%IN (''spin'', ''sng'')%'
     OR v_source NOT LIKE '%PERFORM public.fn_sync_seat_first_player_count(v_tid)%'
     OR NOT EXISTS (
       SELECT 1
         FROM pg_trigger tr
        WHERE tr.tgrelid = 'public.table_seats'::regclass
          AND tr.tgname = 'trg_seat_change_syncs_seat_first_count'
          AND tr.tgfoid = 'public.fn_seat_change_syncs_seat_first_count()'::regprocedure
          AND NOT tr.tgisinternal
          AND tr.tgenabled <> 'D'
     ) THEN
    RAISE EXCEPTION 'the strict paid-third-seat authority is not armed';
  END IF;

  -- Byte-for-byte predicate of the retiring function. Production evidence on
  -- 2026-09-08 found zero candidates; this locked check makes that observation
  -- a commit precondition rather than a deployment note.
  IF EXISTS (
    SELECT 1
      FROM public.tournaments t
     WHERE upper(COALESCE(t.status::text,'')) = 'RUNNING'
       AND COALESCE(t.starting_chips,0) > 0
       AND t.started_at IS NOT NULL
       AND t.started_at < now() - interval '60 seconds'
       AND NOT EXISTS (
         SELECT 1
           FROM public.tables tb
           JOIN public.hand_history hh ON hh.table_id = tb.id
          WHERE tb.tournament_id = t.id)
       AND EXISTS (
         SELECT 1
           FROM public.table_seats s
           JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = t.id AND s.left_at IS NULL)
       AND NOT EXISTS (
         SELECT 1
           FROM public.table_seats s
           JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = t.id
            AND s.left_at IS NULL
            AND COALESCE(s.stack,0) > 0)
  ) THEN
    RAISE EXCEPTION 'stack repair backlog is not zero';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournaments t
      JOIN public.tables tb ON tb.tournament_id = t.id
      JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
     WHERE upper(COALESCE(t.status::text,'')) IN ('ANNOUNCED','REGISTERING','RUNNING')
       AND NOT EXISTS (
         SELECT 1 FROM public.hand_history hh WHERE hh.table_id = tb.id)
       AND (s.stack IS NULL
            OR s.stack::text IN ('NaN','Infinity','-Infinity')
            OR s.stack <= 0)
  ) THEN
    RAISE EXCEPTION 'a live pre-deal tournament seat is not positive';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournaments t
      JOIN public.tables tb ON tb.tournament_id = t.id
      JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
     WHERE upper(COALESCE(t.status::text,'')) IN ('ANNOUNCED','REGISTERING','RUNNING')
       AND (lower(COALESCE(t.variant,'')) = 'spin'
            OR COALESCE(t.max_players,0) <= 2)
       AND NOT EXISTS (
         SELECT 1 FROM public.hand_history hh WHERE hh.table_id = tb.id)
       AND (t.starting_chips IS NULL
            OR t.starting_chips::text IN ('NaN','Infinity','-Infinity')
            OR t.starting_chips <= 0
            OR s.stack IS DISTINCT FROM t.starting_chips)
  ) THEN
    RAISE EXCEPTION 'seat-first stack invariant is not clean';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournaments t
      JOIN public.tables tb ON tb.tournament_id = t.id
      JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = t.id AND tp.user_id = s.user_id
     WHERE upper(COALESCE(t.status::text,'')) IN ('ANNOUNCED','REGISTERING','RUNNING')
       AND (lower(COALESCE(t.variant,'')) = 'spin'
            OR COALESCE(t.max_players,0) <= 2)
       AND NOT EXISTS (
         SELECT 1 FROM public.hand_history hh WHERE hh.table_id = tb.id)
       AND (tp.user_id IS NULL
            OR tp.status IS DISTINCT FROM 'playing'
            OR tp.chips IS DISTINCT FROM t.starting_chips
            OR tp.table_id IS DISTINCT FROM s.table_id
            OR tp.seat_number IS DISTINCT FROM s.seat_number)
  ) OR EXISTS (
    SELECT 1
      FROM public.tournaments t
      JOIN public.tournament_players tp ON tp.tournament_id = t.id
     WHERE upper(COALESCE(t.status::text,'')) IN ('ANNOUNCED','REGISTERING','RUNNING')
       AND (lower(COALESCE(t.variant,'')) = 'spin'
            OR COALESCE(t.max_players,0) <= 2)
       AND tp.status IN ('registered','playing')
       AND NOT EXISTS (
         SELECT 1
           FROM public.table_seats s
           JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = t.id
            AND s.user_id = tp.user_id
            AND s.left_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'seat-first seat and roster authority are not in exact parity';
  END IF;

  FOR v_job IN
    SELECT j.jobid
      FROM cron.job j
     WHERE regexp_replace(lower(COALESCE(j.jobname,'')),'[^a-z0-9]+','','g')
             = 'creditstalledseatfirststacks'
        OR lower(COALESCE(j.command,'')) LIKE '%fn_credit_stalled_seat_first_stacks%'
     ORDER BY j.jobid
  LOOP
    IF NOT cron.unschedule(v_job.jobid) THEN
      RAISE EXCEPTION 'could not unschedule stack repair job %', v_job.jobid;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM cron.job j
     WHERE regexp_replace(lower(COALESCE(j.jobname,'')),'[^a-z0-9]+','','g')
             = 'creditstalledseatfirststacks'
        OR lower(COALESCE(j.command,'')) LIKE '%fn_credit_stalled_seat_first_stacks%'
  ) THEN
    RAISE EXCEPTION 'stack repair cron remains scheduled';
  END IF;

END;
$retire_stack_repair$;

DROP FUNCTION public.fn_credit_stalled_seat_first_stacks() RESTRICT;

DO $verify_stack_repair_retired$
BEGIN
  IF to_regprocedure('public.fn_credit_stalled_seat_first_stacks()') IS NOT NULL THEN
    RAISE EXCEPTION 'stack repair function remains executable';
  END IF;
END;
$verify_stack_repair_retired$;

-- ROLLING CUTOVER, STAGE 1. The database migration lands before the new
-- server. Keep the old engine's three service-role RPC grants intact until
-- that server has published, called the combined authority successfully and
-- been independently verified. The separable stage-2 migration owns the
-- lower-level Spin RPC revocations; the unrelated stack-credit cron is safely
-- retired above because its root seat invariant lands in this transaction.
-- Browser roles remain barred.
REVOKE ALL ON FUNCTION public.fn_spin_draw_multiplier(
  uuid,numeric,jsonb,numeric,integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_spin_settle_game(
  uuid,uuid,numeric,integer,numeric,numeric)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_spin_book_entry(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_draw_multiplier(
  uuid,numeric,jsonb,numeric,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_spin_settle_game(
  uuid,uuid,numeric,integer,numeric,numeric)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_spin_book_entry(uuid)
  TO service_role;

COMMENT ON FUNCTION public.fn_spin_draw_and_settle(uuid,jsonb) IS
  'Sole service-role Spin draw/settlement authority. Verifies three paid seats, books entry, draws against the locked real reserve, settles, and proves reserve+journal evidence in one transaction.';
COMMENT ON FUNCTION public.fn_spin_draw_multiplier(uuid,numeric,jsonb,numeric,integer) IS
  'Stage-1 rolling compatibility door for the live old engine. Retired and dropped only by the post-publish stage-2 Spin cleanup.';
COMMENT ON FUNCTION public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric) IS
  'Stage-1 rolling compatibility door and raw primitive beneath fn_spin_draw_and_settle. Becomes owner-only in post-publish stage 2.';
COMMENT ON FUNCTION public.fn_spin_book_entry(uuid) IS
  'Stage-1 rolling compatibility door and paid-third-seat primitive. Becomes owner-only in post-publish stage 2.';

INSERT INTO public.ca_money_rpc_registry (proname,status,notes) VALUES
  ('fn_assign_tournament_player_seat_atomic','approved',
   'Service-only tournament seat+roster+table-count assignment. It derives the locked roster stack and enters through the terminal/mission/launch parent lock root; callers cannot choose chips.'),
  ('fn_ca_assign_tournament_player_seat_locked','system',
   'Owner-only implementation beneath the canonical assignment and tournament chip-purchase roots. It commits one locked seat, roster mirror and exact table count or rolls the transaction back.'),
  ('process_tournament_rebuy','approved',
   'Sole authenticated/service tournament rebuy, re-entry and add-on authority. One transaction binds its knockout generation, debit, pool/rake, positive seat, mirrors, wake and immutable response receipt.'),
  ('fn_ca_process_tournament_chip_purchase_money_v1','system',
   'Owner-only debit/pool/rake primitive beneath process_tournament_rebuy. It has no PostgREST ACL and the canonical root supplies a mandatory per-generation key.'),
  ('fn_ca_tournament_rebuy_window','system',
   'Owner-only level/minute/add-on-window policy shared by accepted-hand prompt creation and the canonical rebuy authority.'),
  ('process_tournament_rebuy_before_maintenance_announcement_gate','retired',
   'Dropped after the consolidated tournament chip-purchase authority installed; no executable compatibility path remains.'),
  ('process_tournament_rebuy_before_atomic_pool_gate','retired',
   'Dropped after the consolidated tournament chip-purchase authority installed; no executable compatibility path remains.'),
  ('process_tournament_rebuy_before_bounty_guard_20260907','retired',
   'Dropped after the consolidated tournament chip-purchase authority installed; no executable compatibility path remains.'),
  ('process_tournament_rebuy_before_one_minute_addon','retired',
   'Dropped after the consolidated tournament chip-purchase authority installed; no executable compatibility path remains.'),
  ('fn_after_tournament_rebuy','retired',
   'Dropped. The sole purchase transaction now closes its exact knockout generation directly before it can commit.'),
  ('fn_spin_draw_and_settle','approved',
   'Sole service-role Spin draw and reserve settlement authority; one locked transaction and exact receipt.'),
  ('fn_spin_draw_multiplier','legacy',
   'Stage-1 rolling compatibility only; stage 2 drops it after combined-RPC engine verification.'),
  ('fn_spin_settle_game','approved',
   'Stage-1 compatibility plus raw primitive beneath fn_spin_draw_and_settle; stage 2 makes it owner-only.'),
  ('fn_spin_book_entry','approved',
   'Stage-1 compatibility plus raw entry primitive beneath the database full-seat hook and fn_spin_draw_and_settle; stage 2 makes it owner-only.')
ON CONFLICT (proname) DO UPDATE
  SET status = EXCLUDED.status, notes = EXCLUDED.notes;

DO $verify_authority$
DECLARE
  v_source text;
  v_autoledger_hash text;
BEGIN
  IF (SELECT count(*)
        FROM public.tournament_spin_settlement_cutover c
       WHERE c.authority = 'fn_spin_draw_and_settle:v1'
         AND c.migration_version = '20260909014433'
         AND c.installed_at = transaction_timestamp()
         AND c.audited_tournament_ids <@ ARRAY[
           '781cc0ee-6a1d-4e31-acaf-4e737661bba1'::uuid,
           '6d688095-c3c5-4d40-a5a0-952934667732'::uuid
         ]) <> 1
     OR has_table_privilege(
          'service_role','public.tournament_spin_settlement_cutover','SELECT') THEN
    RAISE EXCEPTION 'atomic Spin cutover watermark is missing or exposed';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_spin_draw_and_settle(uuid,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_spin_draw_and_settle(uuid,jsonb)','EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_spin_draw_and_settle(uuid,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'atomic Spin authority has unsafe ACLs';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.fn_spin_draw_multiplier(uuid,numeric,jsonb,numeric,integer)','EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)','EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_spin_book_entry(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'stage-1 rolling compatibility was revoked before server publish';
  END IF;
  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid = 'public.fn_spin_draw_and_settle(uuid,jsonb)'::regprocedure;
  IF v_source NOT LIKE '%fn_spin_book_entry%'
     OR v_source NOT LIKE '%FOR UPDATE%'
     OR v_source NOT LIKE '%fn_spin_settle_game%'
     OR v_source NOT LIKE '%v_exact_seat_stacks%'
     OR v_source NOT LIKE '%v_exact_roster_stacks%'
     OR v_source NOT LIKE '%operator_shortfall%'
     OR v_source ~* 'EXCEPTION[[:space:]]+WHEN[[:space:]]+OTHERS[[:space:]]+THEN[[:space:]]+NULL([[:space:]]|;)'
     OR v_source LIKE '%v_available + v_reserve_in%' THEN
    RAISE EXCEPTION 'atomic Spin authority lost a required invariant';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tr
     WHERE tr.tgrelid = 'public.spin_reserve_ledger'::regclass
       AND tr.tgname = 'spin_reserve_row_requires_exact_journal'
       AND NOT tr.tgisinternal AND tr.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Spin reserve exact-journal trigger is not armed';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid='public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'::regprocedure;
  IF position('ca:tournament-terminal-settlement:v1' IN v_source)=0
     OR position('pg_advisory_xact_lock_shared(530090,1)' IN v_source)=0
     OR position('public.fn_lock_daily_mission_user(p_user_id)' IN v_source)=0
     OR position('FROM public.tournament_launch_receipts r' IN v_source)=0
     OR position('FROM public.tournaments t' IN v_source)=0
     OR position('ca:tournament-terminal-settlement:v1' IN v_source)
          > position('pg_advisory_xact_lock_shared(530090,1)' IN v_source)
     OR position('pg_advisory_xact_lock_shared(530090,1)' IN v_source)
          > position('public.fn_lock_daily_mission_user(p_user_id)' IN v_source)
     OR position('public.fn_lock_daily_mission_user(p_user_id)' IN v_source)
          > position('FROM public.tournament_launch_receipts r' IN v_source)
     OR position('FROM public.tournament_launch_receipts r' IN v_source)
          > position('FROM public.tournaments t' IN v_source)
     OR v_source LIKE '%NOWAIT%'
     OR v_source LIKE '%deadlock_detected%'
     OR v_source LIKE '%lock_not_available%'
     OR v_source LIKE '%pg_sleep%' THEN
    RAISE EXCEPTION 'tournament seat root lock order is incomplete or retry based';
  END IF;
  IF has_function_privilege(
       'service_role',
       'public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'owner-only tournament seat root lock is exposed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tr
     WHERE tr.tgrelid='public.table_seats'::regclass
       AND tr.tgname='a0_tournament_live_seat_root_guard'
       AND tr.tgfoid=
         'public.fn_tournament_live_seat_acquisition_requires_authority()'::regprocedure
       AND tr.tgtype=23
       AND NOT tr.tgisinternal AND tr.tgenabled<>'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger tr
     WHERE tr.tgrelid='public.table_seats'::regclass
       AND tr.tgname='aa_tournament_live_seat_proof_lock'
       AND 'a0_tournament_live_seat_root_guard'<tr.tgname
       AND NOT tr.tgisinternal AND tr.tgenabled<>'D'
  ) THEN
    RAISE EXCEPTION 'earliest tournament seat acquisition guard is not armed';
  END IF;
  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_tournament_live_seat_acquisition_requires_authority()'::regprocedure;
  IF v_source NOT LIKE '%FROM pg_catalog.pg_locks l%'
     OR v_source NOT LIKE '%l.pid=pg_backend_pid()%'
     OR v_source NOT LIKE '%l.objsubid=1%'
     OR v_source NOT LIKE '%TOURNAMENT_SEAT_ACQUISITION_REQUIRES_TERMINAL_AUTHORITY%'
     OR v_source LIKE '%pg_try_advisory%'
     OR has_function_privilege(
       'service_role',
       'public.fn_tournament_live_seat_acquisition_requires_authority()',
       'EXECUTE') THEN
    RAISE EXCEPTION 'tournament seat acquisition guard can acquire late or is exposed';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)'::regprocedure;
  IF position('public.fn_caller_is_engine()' IN v_source)=0
     OR position('public.fn_ca_lock_tournament_seat_acquisition(' IN v_source)=0
     OR position('public.fn_ca_assign_tournament_player_seat_locked(' IN v_source)=0
     OR position('public.fn_caller_is_engine()' IN v_source)
          > position('public.fn_ca_lock_tournament_seat_acquisition(' IN v_source)
     OR position('public.fn_ca_lock_tournament_seat_acquisition(' IN v_source)
          > position('public.fn_ca_assign_tournament_player_seat_locked(' IN v_source)
     OR v_source LIKE '%INSERT INTO public.table_seats%'
     OR v_source LIKE '%UPDATE public.table_seats%'
     OR v_source LIKE '%UPDATE public.tournament_players%'
     OR v_source LIKE '%UPDATE public.tables%'
     OR has_function_privilege(
       'anon',
       'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'atomic tournament seat assignment wrapper lost its root/private-core/ACL contract';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_ca_tournament_seat_cap(uuid)'::regprocedure;
  IF position('WHEN v_format=''spin''' IN v_source)=0
     OR position('THEN 3' IN v_source)=0
     OR position('WHEN v_format=''sng''' IN v_source)=0
     OR position('NULLIF(v_t.max_players,0),6' IN v_source)=0
     OR position('NULLIF(v_t.table_size,0),9' IN v_source)=0
     OR position('WHEN ''plo5'' THEN 9' IN v_source)=0
     OR position('WHEN ''plo6'' THEN 7' IN v_source)=0
     OR position('RETURN GREATEST(v_cap,2)' IN v_source)=0
     OR has_function_privilege(
       'service_role','public.fn_ca_tournament_seat_cap(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'owner-only tournament seat cap lost its format/deck contract';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)'::regprocedure;
  IF position('FROM public.tournaments t' IN v_source)=0
     OR position('FROM public.tournament_players tp' IN v_source)=0
     OR position('FROM public.tables tb' IN v_source)=0
     OR position('FROM public.table_seats s' IN v_source)=0
     OR position('FROM public.tournaments t' IN v_source)
          > position('FROM public.tournament_players tp' IN v_source)
     OR position('FROM public.tournament_players tp' IN v_source)
          > position('FROM public.tables tb' IN v_source)
     OR position('FROM public.tables tb' IN v_source)
          > position('FROM public.table_seats s' IN v_source)
     OR v_source NOT LIKE '%UPDATE public.tournament_players tp%'
     OR v_source NOT LIKE '%UPDATE public.tables tb%'
     OR v_source NOT LIKE '%INSERT INTO public.table_seats%'
     OR v_source NOT LIKE '%v_stack:=COALESCE(v_t.starting_chips,0)%'
     OR v_source NOT LIKE '%atomic tournament seat assignment final proof is not exact%'
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'owner-only tournament assignment core lost its lock/write/proof contract';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)'::regprocedure;
  IF position('public.fn_ensure_late_registration_capacity(' IN v_source)=0
     OR position('FROM public.tables tb' IN v_source)=0
     OR position('FOR UPDATE OF tb' IN v_source)=0
     OR position('FROM public.table_seats s' IN v_source)=0
     OR v_source NOT LIKE '%TOURNAMENT_SEAT_CAPACITY_UNAVAILABLE%'
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'owner-only tournament seat chooser lost its capacity/lock contract';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)'::regprocedure;
  IF position('FROM public.settlement_idempotency_keys k' IN v_source)=0
     OR position('FROM public.tournament_knockout_candidates c' IN v_source)=0
     OR position('FROM public.hand_atomic_commits a' IN v_source)=0
     OR position('ORDER BY c.hand_number DESC,c.id DESC' IN v_source)=0
     OR position('a.table_id=v_table_id' IN v_source)=0
     OR position('a.hand_number=v_hand_number' IN v_source)=0
     OR position('a.hand_id=v_candidate_hand_id' IN v_source)=0
     OR position('a.stack_result->>''hand_id''' IN v_source)=0
     OR position('k.table_id=v_table_id' IN v_source)=0
     OR position('k.hand_id=v_settlement_hand_id' IN v_source)=0
     OR position('k.status=''succeeded''' IN v_source)=0
     OR position('k.completed_at IS NOT NULL' IN v_source)=0
     OR position('k.result->>''table_id''=v_table_id::text' IN v_source)=0
     OR position('REBUY_ATOMIC_HAND_REQUIRED' IN v_source)=0
     OR position('REBUY_SETTLEMENT_RECEIPT_REQUIRED' IN v_source)=0
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'owner-only rebuy evidence resolver lost exact accepted-hand proof';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid='public.fn_ca_tournament_rebuy_window(uuid)'::regprocedure;
  IF position('NULLIF(v_t.rebuy_levels,0)' IN v_source)=0
     OR position('NULLIF(v_t.late_reg_levels,0)' IN v_source)=0
     OR position('make_interval(mins=>v_t.late_reg_mins)' IN v_source)=0
     OR position('v_t.addon_period_started_at' IN v_source)=0
     OR position('v_t.addon_period_ends_at' IN v_source)=0
     OR position('v_prompt_until:=LEAST' IN v_source)=0
     OR has_function_privilege(
       'service_role','public.fn_ca_tournament_rebuy_window(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'owner-only rebuy-window policy lost level/minute/add-on parity';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure;
  IF position('p_client_token IS NULL OR length(btrim(p_client_token))=0'
       IN v_source)=0
     OR position('length(btrim(p_client_token))>128' IN v_source)=0
     OR position('v_club:=v_p.club_id' IN v_source)=0
     OR position('refusing a substituted wallet' IN v_source)=0
     OR position('v_was_seated:=true' IN v_source)=0
     OR position('''seated'',v_was_seated' IN v_source)=0
     OR position('trunc(v_total*v_ratio*100+0.000001)/100' IN v_source)=0
     OR position('trunc(v_total*0.1*100+0.000001)/100' IN v_source)=0
     OR position(
          'round(COALESCE(v_t.bounty_amount,0),2)' IN v_source)=0
     OR v_source ~* 'GREATEST[[:space:]]*\([[:space:]]*1[[:space:]]*,[[:space:]]*round[[:space:]]*\([[:space:]]*v_total'
     OR v_source ~* 'double_submit_collapsed|1500 milliseconds|:\#|v_legacy|fn_player_home_club'
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE') THEN
    RAISE EXCEPTION
      'private tournament money core kept a legacy token, wallet or quote substitute';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure;
  IF position('public.fn_caller_session_is_live()' IN v_source)=0
     OR position('SESSION_REVOKED' IN v_source)=0
     OR position('ca:tournament-terminal-settlement:v1' IN v_source)=0
     OR position('pg_advisory_xact_lock_shared(530090,1)' IN v_source)=0
     OR position('public.fn_claim_entry_purchase_receipt(' IN v_source)=0
     OR position('public.fn_entry_purchases_frozen()' IN v_source)=0
     OR position('public.fn_record_entry_purchase_receipt(' IN v_source)=0
     OR position('FROM public.entry_purchase_idempotency_receipts r' IN v_source)=0
     OR position('public.fn_ca_process_tournament_chip_purchase_money_v1(' IN v_source)=0
     OR (length(v_source)-length(replace(v_source,'atomic-table:','')))
          /length('atomic-table:')<>2
     OR position('v_table_id:=v_candidate_peek.table_id' IN v_source)=0
     OR position('Add-on live table changed after its atomic-table lock' IN v_source)=0
     OR position('public.fn_ca_latest_committed_knockout_candidate(' IN v_source)=0
     OR position('public.fn_ca_choose_tournament_seat_locked(' IN v_source)=0
     OR position('public.fn_ca_assign_tournament_player_seat_locked(' IN v_source)=0
     OR position('UPDATE public.tournament_knockout_candidates c' IN v_source)=0
     OR position(
          'v_final_seat.club_id IS DISTINCT FROM v_expected_club_id'
          IN v_source)=0
     OR position('public.fn_emit_tournament_manager_wake(' IN v_source)=0
     OR position('atomic_tournament_chip_purchase' IN v_source)=0
     OR position('FROM public.entry_purchase_idempotency_receipts r' IN v_source)
          > position('public.fn_ca_latest_committed_knockout_candidate(' IN v_source)
     OR position('public.fn_claim_entry_purchase_receipt(' IN v_source)
          > position('public.fn_entry_purchases_frozen()' IN v_source)
     OR NOT EXISTS (
       SELECT 1 FROM pg_indexes i
        WHERE i.schemaname='public'
          AND i.indexname='idx_tournament_knockout_candidates_user_hand'
          AND i.indexdef LIKE '%(tournament_id, eliminated_user_id, hand_number DESC, id DESC)%')
     OR v_source LIKE '%double_submit_collapsed%'
     OR v_source LIKE '%:#%'
     OR v_source LIKE '%process_tournament_rebuy_before_%'
     OR has_function_privilege(
       'anon',
       'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'authenticated',
       'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'canonical tournament chip purchase lost atomic generation/seat/receipt authority';
  END IF;
  IF to_regprocedure(
       'public.process_tournament_rebuy_before_maintenance_announcement_gate(uuid,uuid,text,numeric,numeric,integer,text)') IS NOT NULL
     OR to_regprocedure(
       'public.process_tournament_rebuy_before_atomic_pool_gate(uuid,uuid,text,numeric,numeric,integer,text)') IS NOT NULL
     OR to_regprocedure(
       'public.process_tournament_rebuy_before_bounty_guard_20260907(uuid,uuid,text,numeric,numeric,integer,text)') IS NOT NULL
     OR to_regprocedure(
       'public.process_tournament_rebuy_before_one_minute_addon(uuid,uuid,text,numeric,numeric,integer,text)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_after_tournament_rebuy(uuid,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'a retired tournament chip-purchase wrapper or after-hook remains installed';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid='public.fn_take_seat_and_buy_in(uuid,integer)'::regprocedure;
  IF v_source NOT LIKE '%fn_ca_lock_tournament_seat_acquisition%'
     OR v_source NOT LIKE '%fn_take_seat_and_buy_in_before_terminal_seat_gate%'
     OR has_function_privilege(
       'anon','public.fn_take_seat_and_buy_in(uuid,integer)','EXECUTE')
     OR NOT has_function_privilege(
       'authenticated','public.fn_take_seat_and_buy_in(uuid,integer)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_take_seat_and_buy_in(uuid,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'human seat-first root is not terminal ordered or has wrong ACL';
  END IF;
  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_seat_horse_in_seat_first_game(uuid,uuid)'::regprocedure;
  IF v_source NOT LIKE '%fn_ca_lock_tournament_seat_acquisition%'
     OR v_source NOT LIKE '%fn_seat_horse_in_seat_first_game_before_terminal_seat_gate%'
     OR has_function_privilege(
       'authenticated',
       'public.fn_seat_horse_in_seat_first_game(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_seat_horse_in_seat_first_game(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'horse seat-first root is not terminal ordered or has wrong ACL';
  END IF;
  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid='public.fn_seat_late_registrant(uuid,uuid)'::regprocedure;
  IF v_source NOT LIKE '%fn_ca_lock_tournament_seat_acquisition%'
     OR v_source NOT LIKE '%fn_seat_late_registrant_before_terminal_seat_gate%'
     OR has_function_privilege(
       'authenticated','public.fn_seat_late_registrant(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_seat_late_registrant(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'late-seat root is not terminal ordered or has wrong ACL';
  END IF;
  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid='public.fn_register_for_tournament(uuid,boolean)'::regprocedure;
  IF v_source NOT LIKE '%fn_ca_lock_tournament_seat_acquisition%'
     OR v_source NOT LIKE '%fn_register_for_tournament_before_terminal_seat_gate%'
     OR has_function_privilege(
       'authenticated','public.fn_register_for_tournament(uuid,boolean)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_register_for_tournament(uuid,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'wallet registration root is not terminal ordered or has wrong ACL';
  END IF;
  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid='public.fn_register_for_tournament(uuid)'::regprocedure;
  IF v_source NOT LIKE '%public.fn_register_for_tournament(p_tournament_id,false)%'
     OR has_function_privilege(
       'anon','public.fn_register_for_tournament(uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'authenticated','public.fn_register_for_tournament(uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_register_for_tournament(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'authenticated registration compatibility root bypasses terminal order';
  END IF;
  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_register_for_tournament_with_ticket(uuid,uuid)'::regprocedure;
  IF v_source NOT LIKE '%fn_ca_lock_tournament_seat_acquisition%'
     OR v_source NOT LIKE '%fn_register_for_tournament_with_ticket_before_terminal_gate%'
     OR has_function_privilege(
       'anon','public.fn_register_for_tournament_with_ticket(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'authenticated',
       'public.fn_register_for_tournament_with_ticket(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_register_for_tournament_with_ticket(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'ticket registration root is not terminal ordered or has wrong ACL';
  END IF;
  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_register_horse_for_tournament(uuid,uuid,boolean)'::regprocedure;
  IF v_source NOT LIKE '%fn_ca_lock_tournament_seat_acquisition%'
     OR v_source NOT LIKE '%fn_register_horse_for_tournament_before_terminal_gate%'
     OR has_function_privilege(
       'authenticated',
       'public.fn_register_horse_for_tournament(uuid,uuid,boolean)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_register_horse_for_tournament(uuid,uuid,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'horse registration root is not terminal ordered or has wrong ACL';
  END IF;
  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid='public.fn_register_horse_for_tournament(uuid,uuid)'::regprocedure;
  IF v_source NOT LIKE '%public.fn_register_horse_for_tournament(%'
     OR v_source NOT LIKE '%p_tournament_id,p_user_id,true%'
     OR has_function_privilege(
       'authenticated','public.fn_register_horse_for_tournament(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_register_horse_for_tournament(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'horse registration compatibility root bypasses terminal order';
  END IF;

  IF has_function_privilege(
       'service_role',
       'public.fn_take_seat_and_buy_in_before_terminal_seat_gate(uuid,integer)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_seat_horse_in_seat_first_game_before_terminal_seat_gate(uuid,uuid)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_seat_late_registrant_before_terminal_seat_gate(uuid,uuid)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_register_for_tournament_before_terminal_seat_gate(uuid,boolean)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_register_horse_for_tournament_before_terminal_gate(uuid,uuid,boolean)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'a pre-terminal tournament seat implementation remains callable';
  END IF;

  SELECT md5(pg_get_functiondef(
           'public.fn_ca_autoledger()'::regprocedure))
    INTO v_autoledger_hash;
  IF v_autoledger_hash IS DISTINCT FROM
       '2ff8923b4c2d8fd3d343cf37acce0f2c' THEN
    RAISE EXCEPTION
      'Spin changed or lost the platform-wide strict auto-ledger authority';
  END IF;
  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid = 'public.fn_sync_seat_first_player_count(uuid)'::regprocedure;
  IF v_source NOT LIKE '%v_book := public.fn_spin_book_entry%'
     OR v_source NOT LIKE '%paid third seat could not book Spin%'
     OR v_source LIKE '%ca:tournament-terminal-settlement:v1%'
     OR v_source NOT LIKE '%FOR UPDATE%'
     OR v_source LIKE '%IN (''spin'', ''sng'')%'
     OR v_source LIKE '%deadlock_detected%'
     OR v_source LIKE '%pg_sleep%'
     OR v_source LIKE '%spin_entry_refused:%'
     OR v_source LIKE '%spin_entry_threw:%'
     OR has_function_privilege(
       'service_role','public.fn_sync_seat_first_player_count(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'paid-third-seat helper catches, retries, locks globally, or is exposed';
  END IF;
  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid = 'public.fn_ca_guard_seat_creation()'::regprocedure;
  IF v_source NOT LIKE '%TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK%'
     OR v_source NOT LIKE '%SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS%'
     OR position('TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK' IN v_source)
          > position('public.fn_caller_is_engine()' IN v_source) THEN
    RAISE EXCEPTION 'paid-seat stack invariant is missing or follows a caller bypass';
  END IF;
  IF to_regprocedure('public.fn_credit_stalled_seat_first_stacks()') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM cron.job j
        WHERE regexp_replace(lower(COALESCE(j.jobname,'')),'[^a-z0-9]+','','g')
                = 'creditstalledseatfirststacks'
           OR lower(COALESCE(j.command,'')) LIKE '%fn_credit_stalled_seat_first_stacks%'
     ) THEN
    RAISE EXCEPTION 'the retired stack repair remains installed or scheduled';
  END IF;
END;
$verify_authority$;

COMMIT;
