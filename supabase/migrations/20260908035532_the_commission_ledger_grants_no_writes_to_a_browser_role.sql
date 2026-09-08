BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '170s';

/* PHASE 7 OF 8 (UNION ACCOUNTING) - THE COMMISSION LEDGER GRANTS NO WRITES
   TO A BROWSER ROLE.
   ---------------------------------------------------------------------------
   FOUND while re-reading every authority over agent_commissions for the
   round-2 model change (20260908025653). The two commission tables carried
   the full default grant set for the browser roles:

     agent_commissions              anon          DELETE, INSERT, SELECT, UPDATE
     agent_commissions              authenticated DELETE, INSERT, SELECT, UPDATE
     agent_commission_settlements   authenticated DELETE, INSERT, SELECT, UPDATE

   WHAT THIS IS, STATED HONESTLY: defence in depth, not a live hole. RLS is
   enabled on both tables (relrowsecurity = true, verified 2026-09-08), and
   every policy on them is SELECT-only for authenticated -
   agent_reads_own_commissions, union_overseer_read, acs_agent_reads_own,
   acs_union_overseer_read - with writes reserved to service_role by
   agent_commissions_service_only and acs_service_only. anon holds no policy
   at all, so its grants were already unreachable. Nobody can write these
   tables from a browser today, and no incident is being reported here.

   WHY IT IS STILL WORTH REMOVING. The grant is the half of the pair that
   nobody looks at. RLS is what everyone checks and a policy is a visible,
   reviewed object; a table-level INSERT grant is invisible in pg_policies and
   survives every policy rewrite. The day somebody adds a permissive policy to
   let an agent acknowledge a row - the ordinary next request on this table -
   the grant is already there and the write lands on the money ledger. Two
   things would have to be wrong for that to bite, and this removes one of
   them permanently. This is the same reasoning, and the same shape, as
   20260906091809 (cashier_trade_ledger_is_role_scoped) and 20260906091646;
   the REVOKE ALL / re-GRANT idiom below is taken from those deliberately, so
   the estate has one way of saying this rather than two.

   anon loses SELECT as well, matching what 20260906091809 did to
   chip_transactions: a signed-out browser has no business reading a
   commission ledger, and no policy grants it a row today, so nothing that
   works now stops working.

   NOTHING BREAKS. Every writer is SECURITY DEFINER owned by postgres and so
   does not consult the caller's table grants at all - verified 2026-09-08:
   fn_agent_claim_commission, fn_settle_round2_club_to_agents and
   fn_club_unclaimable_commission all report prosecdef = true, owner postgres.
   The engine writes as service_role, which keeps every privilege below.

   PROVED BEFORE IT WAS COMMITTED (section 11.5). The REVOKE was executed
   inside a single self-aborting DO block on production and rolled back by its
   own RAISE; the block reported, and this migration reproduces:

     before  anon:DELETE,INSERT,SELECT,UPDATE | authenticated:DELETE,INSERT,SELECT,UPDATE
     after   anon:(none)                      | authenticated:SELECT

   GRANT/REVOKE does not fire pgrst_ddl_watch, so this costs no PostgREST
   schema reload (CLAUDE.md section 2, rule 5).
*/

REVOKE ALL PRIVILEGES ON TABLE public.agent_commissions
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.agent_commission_settlements
  FROM PUBLIC, anon, authenticated;

-- The reads the four SELECT policies exist to serve. RLS still decides which
-- rows; this only decides that the verb is legal.
GRANT SELECT ON TABLE public.agent_commissions              TO authenticated;
GRANT SELECT ON TABLE public.agent_commission_settlements   TO authenticated;

-- The engine and every SECURITY DEFINER path settle through service_role.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_commissions
  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_commission_settlements
  TO service_role;

/* The migration asserts its own postcondition, so it aborts rather than
   reporting success if the board moved underneath it. */
DO $assert$
DECLARE
  bad_writes  int;
  kept_reads  int;
  kept_writes int;
BEGIN
  SELECT count(*) INTO bad_writes
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('agent_commissions','agent_commission_settlements')
    AND grantee IN ('anon','authenticated','PUBLIC')
    AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES');
  IF bad_writes <> 0 THEN
    RAISE EXCEPTION 'a browser role still holds % write grant(s) on the commission ledger', bad_writes;
  END IF;

  SELECT count(*) INTO kept_reads
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('agent_commissions','agent_commission_settlements')
    AND grantee = 'authenticated' AND privilege_type = 'SELECT';
  IF kept_reads <> 2 THEN
    RAISE EXCEPTION 'authenticated must keep SELECT on both commission tables, found %', kept_reads;
  END IF;

  SELECT count(*) INTO kept_writes
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('agent_commissions','agent_commission_settlements')
    AND grantee = 'service_role'
    AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE');
  IF kept_writes <> 8 THEN
    RAISE EXCEPTION 'service_role must keep all four verbs on both tables, found %', kept_writes;
  END IF;
END
$assert$;

COMMIT;
