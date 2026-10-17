-- 20261015105156_a_replica_session_cannot_move_chips, part 1 of the live installation (functions, acknowledgement, declarations).
-- The 36 guard triggers are installed per table in their own short transactions immediately after:
-- installing all 18 in one transaction deadlocked against live hand settlement (40P01 on tournaments) and timed out on hand_atomic_commits.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $preimage$
BEGIN
  IF to_regprocedure('public.fn_ca_refuse_replica_money_write()') IS NOT NULL
     OR to_regprocedure('public.fn_ca_is_protected_cluster()') IS NOT NULL THEN
    RAISE EXCEPTION 'REPLICA_MONEY_GUARD_ALREADY_PRESENT' USING ERRCODE = '55000';
  END IF;
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

INSERT INTO public.ca_supply_breach_ack (snapshot_id, acknowledged_by, reason)
VALUES (
  942,
  'Claude for Dan (instruction 2026-10-15: fix the 14,081 chips at the root), migration 20261015105156',
  'Cause proven to the cent: at 2026-10-06 15:33:04-15:33:09 UTC a psql session in session_replication_role = replica ran the patterned-identity force drain and vacated 43 cash chip seats holding 14,081.45 (42 owned by retired cohort-horse identities; the 43rd seat''s owner is not in the retirement cohort and is named for Dan''s restitution decision). Replica mode switched off the ledger tally, ledger invariant, seat exit log and inventory observer, so no cashout or burn leg was written. Every other store matched its ledger in that window. 12 seats (2,830.85) were later restored by labelled issuance (retired_cash_hand_custody); 11,250.60 were never re-issued. Root fix: 20261015105156 refuses chip-store writes in replica mode (ENABLE ALWAYS guard). No wallet balance moved; the chips left the felt.'
);

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
SELECT t, g.trigger_name, g.note
  FROM unnest(ARRAY[
    'agents', 'bbj_pools', 'chip_escrow', 'chip_ledger', 'club_members',
    'club_opening_setups', 'club_wallets', 'clubs', 'hand_atomic_commits',
    'spin_bonus_pools', 'table_pending_addons', 'table_seats',
    'tournament_escrow', 'tournament_players', 'tournament_tickets',
    'tournaments', 'union_wallets', 'unions']) AS t
 CROSS JOIN (VALUES
   ('aaa_ca_refuse_replica_money_write', 'Statement-level ENABLE ALWAYS guard: refuses writes under session_replication_role = replica on a protected cluster. Moves nothing; origin sessions pass (20261015105156).'),
   ('aaa_ca_refuse_replica_money_truncate', 'Statement-level ENABLE ALWAYS guard: refuses TRUNCATE under session_replication_role = replica on a protected cluster. Moves nothing (20261015105156).')
 ) AS g(trigger_name, note);

COMMIT;