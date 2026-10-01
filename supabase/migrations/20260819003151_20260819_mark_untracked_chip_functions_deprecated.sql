-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819003151 "20260819_mark_untracked_chip_functions_deprecated"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5ab95515f013f5099661f003ff1546ac of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Five orphaned chip functions move money and write NO audit row.
--
-- Requirement: every chip movement must land in a transaction report. These
-- five mutate balances without inserting into chip_transactions, chip_ledger,
-- club_wallet_transactions, union_wallet_transactions or wallet_transactions:
--
--   add_chips                      no log, no balance guard
--   deduct_chip_balance            no log
--   increment_club_chip_pool       no log, cannot refuse (no error path)
--   increment_union_chip_balance   no log
--   transfer_promo_union_to_agent  no log, no row lock, no balance guard
--
-- REACHABILITY - all three paths checked, all empty:
--   * application:  0 `.rpc('<name>')` call sites across club-arena/src,
--                   club-arena/server/src, World Hub pages+src, workers/src
--   * triggers:     0 (pg_depend -> pg_trigger)
--   * SQL callers:  0 (no other pg_proc body references them)
--   * privileges:   service_role only; NOT callable by authenticated or anon
--
-- So they are dead today - not an active leak. They are left in place rather
-- than dropped because dropping money functions on the strength of a
-- reachability proof is a bigger bet than the problem warrants, and the
-- bodies are the record of what the old flows did.
--
-- What they ARE is a trap: each is a ready-made way to move chips with no
-- audit trail, and the supported equivalents already exist and do it properly
-- (fn_credit_chips, fn_debit_chips, fn_transfer_chips, distribute_chips,
-- fn_union_send_chips_to_club, transfer_chips_agent_to_player - all of which
-- log, lock FOR UPDATE, and guard balances).
--
-- COMMENT ON is the proportionate mitigation: visible to anyone inspecting the
-- schema or generating types, zero runtime risk, fully reversible.
-- ============================================================================

DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT unnest(ARRAY['add_chips','deduct_chip_balance','increment_club_chip_pool',
                               'increment_union_chip_balance','transfer_promo_union_to_agent']) AS f
  LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n2 ON n2.oid=p.pronamespace
                WHERE n2.nspname='public' AND p.proname=r.f) THEN
      n := n + 1;
    END IF;
  END LOOP;
  IF n = 0 THEN
    RAISE EXCEPTION 'Pre-flight: none of the five exist - schema differs from the audit.';
  END IF;
  RAISE NOTICE 'Pre-flight: % of 5 present.', n;
END $$;

DO $$
DECLARE r record; v_note text;
BEGIN
  v_note := 'DEPRECATED 2026-08-19 - DO NOT USE. Moves chips WITHOUT writing any '
         || 'transaction record, so the movement never reaches the transaction '
         || 'reports. Verified dead: 0 app callers, 0 triggers, 0 SQL callers, '
         || 'service_role-only. Use the audited equivalents instead: '
         || 'fn_credit_chips / fn_debit_chips / fn_transfer_chips / '
         || 'distribute_chips / fn_union_send_chips_to_club / '
         || 'transfer_chips_agent_to_player - all log, lock FOR UPDATE and guard balances.';

  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname IN ('add_chips','deduct_chip_balance','increment_club_chip_pool',
                         'increment_union_chip_balance','transfer_promo_union_to_agent')
  LOOP
    EXECUTE format('COMMENT ON FUNCTION %s IS %L', r.sig, v_note);
  END LOOP;
END $$;

DO $$
DECLARE v_missing int;
BEGIN
  SELECT count(*) INTO v_missing
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('add_chips','deduct_chip_balance','increment_club_chip_pool',
                       'increment_union_chip_balance','transfer_promo_union_to_agent')
     AND COALESCE(obj_description(p.oid,'pg_proc'),'') !~ 'DEPRECATED 2026-08-19';

  IF v_missing > 0 THEN
    RAISE EXCEPTION 'Post-apply: % function(s) did not receive the deprecation comment.', v_missing;
  END IF;

  -- They must remain unreachable from the browser.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname IN ('add_chips','deduct_chip_balance','increment_club_chip_pool',
                         'increment_union_chip_balance','transfer_promo_union_to_agent')
       AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
            OR has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION 'Post-apply: one of the untracked chip functions is client-callable.';
  END IF;

  RAISE NOTICE 'Post-apply OK: all five marked DEPRECATED and unreachable from clients.';
END $$;
