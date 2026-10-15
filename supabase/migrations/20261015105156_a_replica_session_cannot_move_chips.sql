-- 20261015105156_a_replica_session_cannot_move_chips.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  A REPLICA SESSION CANNOT MOVE CHIPS (2026-10-15)
-- ===========================================================================
--
-- THE BREACH. Supply snapshot 942 (2026-10-06 16:05:00 UTC) read
-- unexplained = -14,081.45. fn_audit_supply_breaches has reported it as
-- critical every night since, because nobody wrote a ca_supply_breach_ack row.
--
-- WHERE THE CHIPS WENT, MEASURED TO THE CENT (re-derived 2026-10-15, read only):
--
--   * Every store in the meter agrees with its chip_ledger legs over window
--     941 -> 942 except the cash felt: the ledger says the felt grew by
--     16,590.39 and the seats grew by 2,508.94. The difference is exactly
--     -14,081.45. The felt also agrees with its legs in every hour before
--     and after (937..944 checked).
--   * The seats that left it: 43 cash chip seats whose left_at was stamped
--     between 15:33:04.808 and 15:33:09.584 UTC, holding 14,081.45 in all
--     (read from union_pnl_inventory_events before_row on their later
--     DELETE/UPDATE, plus the two rows still present). 42 of them belong to
--     identities in smarter_private.patterned_identity_retirements (cohort
--     'horse'); one seat's owner is not in that cohort and is reported to
--     Dan rather than assumed to be a horse. None has a ca_seat_stack_exits row, a table_cashout leg, an
--     inventory event for the stamp itself, or a ledger-tally finding.
--   * The mechanism: a psql session (role postgres) that had run
--     SET session_replication_role = replica executed the patterned-identity
--     force drain (20261007132903 quotes it from postgres_logs). Every guard
--     on these tables is an ordinary ENABLED ('O') trigger - the ledger tally
--     zy_ca_tally_balance_move, the commit-time invariant
--     zz_ca_balance_has_its_ledger_row, the exit log trg_log_seat_stack_exit,
--     the autoledger and the inventory observer - and an 'O' trigger does not
--     fire in replica mode. So the seats were vacated with their stacks, no
--     cashout and no burn was written, and nothing refused it.
--   * 12 of those seats (2,830.85) were in hands in flight and were restored
--     by labelled issuance (smarter_private.retired_cash_hand_custody,
--     20261006184554 / 20261007000750 / 20261007002407). The other
--     11,250.60 were never re-issued. Incident closure 20261009233939
--     recorded the cause but not this acknowledgement.
--
-- WHY THE EARLIER FIXES DID NOT CLOSE IT. #6315 taught the maintained
-- producer (scripts/admin/retire-patterned-identities.sql) to refuse replica
-- mode, and 20261007132903 made one tournament stamp ENABLE ALWAYS. Neither
-- stops a foreign session that sets replica mode and writes a chip store:
-- every money guard is still 'O' today.
--
-- THE FIX, AT THE ROOT. One statement-level guard, ENABLE ALWAYS, on every
-- table that holds chips or the seats and entries that own them. In replica
-- mode on a protected cluster it refuses INSERT, UPDATE, DELETE and TRUNCATE
-- before a row is touched, so the bypass that lost these chips now fails
-- loudly instead of succeeding silently. Ordinary (origin) sessions pay one
-- setting read per statement and behave exactly as before.
--
-- WHY NOT JUST ENABLE ALWAYS THE EXISTING GUARDS. The CI qualification
-- clusters (scripts/ci/**, created by initdb on a temp socket) seed fixtures
-- with SET LOCAL session_replication_role = replica on these same tables;
-- making the tally fire there would refuse every one of them. The guard
-- below is scoped to a protected cluster instead: this production cluster by
-- its system identifier, and any hosted Supabase cluster by cluster_name
-- 'main' (so a restore to new hardware stays protected). A temp initdb
-- cluster has neither and keeps working.
--
-- THE ACKNOWLEDGEMENT. Snapshot 942 is acknowledged in ca_supply_breach_ack
-- with the evidence above. The acknowledgement explains; it moves nothing.
-- Whether the 11,250.60 is re-issued to the fleet is a separate money
-- decision for Dan, not taken here.
--
-- WHAT THIS DOES NOT STOP. A session that can ALTER TABLE ... DISABLE
-- TRIGGER can still disable this guard explicitly. That is a DDL act, logged
-- by ca_ddl_watchdog_log, not a setting flipped in passing.
--
-- One short transaction (CLAUDE.md production DDL policy): one schema reload.
--
-- LIVE INSTALLATION (2026-10-15 13:05-13:14 UTC, Dan: "APPLY THE MIGRATION").
-- Production installed this in pieces, not as the single transaction below:
-- one transaction taking all 18 table locks timed out on hand_atomic_commits
-- and then deadlocked against live hand settlement on tournaments (40P01).
-- So the functions, the acknowledgement and the declarations went in first,
-- then each table's two guards in its own short transaction (lock_timeout
-- 2-3s). Read back: 36 of 36 guards tgenabled = 'A'; fn_audit_supply_breaches
-- returns []. The Management API role may not set session_replication_role at
-- all (42501), so the replica-mode write proof below runs only for a role that
-- can reach the bypass; the catalogue proof runs always. A fresh CI cluster
-- has no traffic, so this file stays one transaction.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $preimage$
BEGIN
  IF to_regprocedure('public.fn_ca_refuse_replica_money_write()') IS NOT NULL
     OR to_regprocedure('public.fn_ca_is_protected_cluster()') IS NOT NULL THEN
    RAISE EXCEPTION 'REPLICA_MONEY_GUARD_ALREADY_PRESENT' USING ERRCODE = '55000';
  END IF;
  -- The breach being acknowledged is the one measured above, unchanged.
  IF NOT EXISTS (SELECT 1 FROM public.ca_supply_snapshots
                  WHERE id = 942 AND round(unexplained, 2) = -14081.45
                    AND taken_at = '2026-10-06 16:05:00.373331+00') THEN
    RAISE EXCEPTION 'SUPPLY_BREACH_942_PREIMAGE_CHANGED' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_supply_breach_ack WHERE snapshot_id = 942) THEN
    RAISE EXCEPTION 'SUPPLY_BREACH_942_ALREADY_ACKNOWLEDGED' USING ERRCODE = '55000';
  END IF;
END
$preimage$;

CREATE FUNCTION public.fn_ca_is_protected_cluster()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
  SELECT current_setting('cluster_name', true) = 'main'
      OR (SELECT system_identifier::text FROM pg_control_system()) = '7581440907192989109';
$function$;

COMMENT ON FUNCTION public.fn_ca_is_protected_cluster() IS
  'True on production (its system identifier) and on any hosted Supabase cluster (cluster_name main). False on a temp initdb CI cluster. Read by fn_ca_refuse_replica_money_write.';

REVOKE ALL ON FUNCTION public.fn_ca_is_protected_cluster() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_is_protected_cluster() TO service_role;

CREATE FUNCTION public.fn_ca_refuse_replica_money_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  -- Nested, not AND: an origin session (every real write) reads one setting
  -- and leaves; the cluster identity is read only in replica mode.
  IF current_setting('session_replication_role') <> 'replica' THEN
    RETURN NULL;
  END IF;
  IF public.fn_ca_is_protected_cluster() THEN
    RAISE EXCEPTION 'REFUSED: % on public.% under session_replication_role = replica',
      TG_OP, TG_TABLE_NAME
      USING ERRCODE = '42501',
            DETAIL  = 'Replica mode switches off every ordinary trigger on this table: the ledger tally, the commit-time ledger invariant, the seat exit log and the inventory observer. On 2026-10-06 15:33 UTC that is how 43 cash seats holding 14,081.45 chips were vacated with no cashout and no burn.',
            HINT    = 'Move chips through their door in an origin session. The door writes the balance and its chip_ledger leg in one transaction.';
  END IF;
  RETURN NULL;
END
$function$;

COMMENT ON FUNCTION public.fn_ca_refuse_replica_money_write() IS
  'Statement-level ENABLE ALWAYS guard on every chip store: refuses writes made under session_replication_role = replica on a protected cluster (20261015105156).';

REVOKE ALL ON FUNCTION public.fn_ca_refuse_replica_money_write() FROM PUBLIC, anon, authenticated, service_role;

DO $guard$
DECLARE
  t text;
  v_tables CONSTANT text[] := ARRAY[
    'agents', 'bbj_pools', 'chip_escrow', 'chip_ledger', 'club_members',
    'club_opening_setups', 'club_wallets', 'clubs', 'hand_atomic_commits',
    'spin_bonus_pools', 'table_pending_addons', 'table_seats',
    'tournament_escrow', 'tournament_players', 'tournament_tickets',
    'tournaments', 'union_wallets', 'unions'];
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'REPLICA_MONEY_GUARD_TABLE_MISSING %', t USING ERRCODE = '55000';
    END IF;
    EXECUTE format(
      'CREATE TRIGGER aaa_ca_refuse_replica_money_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_refuse_replica_money_write()', t);
    EXECUTE format(
      'CREATE TRIGGER aaa_ca_refuse_replica_money_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_refuse_replica_money_write()', t);
    -- An ordinary trigger is exactly what replica mode skips. ALWAYS is the fix.
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER aaa_ca_refuse_replica_money_write', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER aaa_ca_refuse_replica_money_truncate', t);
  END LOOP;
END
$guard$;

-- THE PROOF, IN THIS TRANSACTION. Every guard must read back as ALWAYS. Then,
-- if this role is allowed to enter replica mode at all, enter it and attempt a
-- write that matches no row: a statement-level trigger fires anyway, so on a
-- protected cluster it must be refused. A role that may not set
-- session_replication_role (the Management API's, measured 2026-10-15) cannot
-- reach the bypass in the first place, so that branch proves the catalogue
-- only. No row is touched either way.
DO $proof$
DECLARE
  v_refused boolean := false;
  v_can_replica boolean := true;
BEGIN
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgname IN ('aaa_ca_refuse_replica_money_write', 'aaa_ca_refuse_replica_money_truncate')
         AND t.tgenabled = 'A') <> 36 THEN
    RAISE EXCEPTION 'REPLICA_MONEY_GUARD_NOT_ALWAYS' USING ERRCODE = '55000';
  END IF;
  IF NOT public.fn_ca_is_protected_cluster() THEN
    RETURN;  -- a CI cluster: the guard is deliberately inert there.
  END IF;
  BEGIN
    PERFORM set_config('session_replication_role', 'replica', true);
  EXCEPTION WHEN insufficient_privilege THEN
    v_can_replica := false;
  END;
  IF NOT v_can_replica THEN
    RETURN;
  END IF;
  BEGIN
    UPDATE public.table_seats SET stack = stack WHERE false;
  EXCEPTION WHEN insufficient_privilege THEN
    v_refused := SQLERRM LIKE 'REFUSED: UPDATE on public.table_seats under session_replication_role = replica%';
  END;
  PERFORM set_config('session_replication_role', 'origin', true);
  IF NOT v_refused THEN
    RAISE EXCEPTION 'REPLICA_MONEY_GUARD_DID_NOT_REFUSE' USING ERRCODE = '55000';
  END IF;
END
$proof$;

INSERT INTO public.ca_supply_breach_ack (snapshot_id, acknowledged_by, reason)
VALUES (
  942,
  'Claude for Dan (instruction 2026-10-15: fix the 14,081 chips at the root), migration 20261015105156',
  'Cause proven to the cent: at 2026-10-06 15:33:04-15:33:09 UTC a psql session in session_replication_role = replica ran the patterned-identity force drain and vacated 43 cash chip seats holding 14,081.45 (42 owned by retired cohort-horse identities; the 43rd seat''s owner is not in the retirement cohort and is named for Dan''s restitution decision). Replica mode switched off the ledger tally, ledger invariant, seat exit log and inventory observer, so no cashout or burn leg was written. Every other store matched its ledger in that window. 12 seats (2,830.85) were later restored by labelled issuance (retired_cash_hand_custody); 11,250.60 were never re-issued. Root fix: 20261015105156 refuses chip-store writes in replica mode (ENABLE ALWAYS guard). No wallet balance moved; the chips left the felt.'
);

-- Every guard trigger is declared on the money-trigger register in this same
-- migration (check-money-trigger-declared).
INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES
  ('agents', 'aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
  ('agents', 'aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).'),
  ('bbj_pools', 'aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
  ('bbj_pools', 'aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).'),
  ('chip_escrow', 'aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
  ('chip_escrow', 'aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).'),
  ('chip_ledger', 'aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
  ('chip_ledger', 'aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).'),
  ('club_members', 'aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
  ('club_members', 'aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).'),
  ('club_opening_setups', 'aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
  ('club_opening_setups', 'aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).'),
  ('club_wallets', 'aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
  ('club_wallets', 'aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).'),
  ('clubs', 'aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
  ('clubs', 'aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).'),
  ('hand_atomic_commits', 'aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
  ('hand_atomic_commits', 'aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).'),
  ('spin_bonus_pools', 'aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
  ('spin_bonus_pools', 'aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).'),
  ('table_pending_addons', 'aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
  ('table_pending_addons', 'aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).'),
  ('table_seats', 'aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
  ('table_seats', 'aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).'),
  ('tournament_escrow', 'aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
  ('tournament_escrow', 'aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).'),
  ('tournament_players', 'aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
  ('tournament_players', 'aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).'),
  ('tournament_tickets', 'aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
  ('tournament_tickets', 'aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).'),
  ('tournaments', 'aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
  ('tournaments', 'aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).'),
  ('union_wallets', 'aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
  ('union_wallets', 'aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).'),
  ('unions', 'aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
  ('unions', 'aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).');

-- @live-proof: (SELECT count(*) FROM pg_trigger t WHERE t.tgname IN ('aaa_ca_refuse_replica_money_write','aaa_ca_refuse_replica_money_truncate') AND t.tgenabled = 'A') = 36
-- @live-proof: EXISTS (SELECT 1 FROM public.ca_supply_breach_ack WHERE snapshot_id = 942)

COMMIT;
