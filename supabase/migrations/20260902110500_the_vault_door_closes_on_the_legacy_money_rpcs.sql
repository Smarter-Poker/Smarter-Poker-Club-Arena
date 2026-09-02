-- ═══════════════════════════════════════════════════════════════════════════
--  THE VAULT DOOR CLOSES ON THE LEGACY MONEY RPCS
--  Restart to-do list (#2563) item 8. Single transaction per DDL policy.
--  NOTE: GRANT/REVOKE do not fire pgrst_ddl_watch (CLAUDE.md 2.x rule 5),
--  so this entire migration causes ZERO schema-cache reloads.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The freeze audit's read of MIGRATION FILES suggested roughly thirty legacy
-- SECURITY DEFINER money functions were still browser-executable. The LIVE
-- database, measured with has_function_privilege before this ran, disagreed:
-- of 29 existing overloads across these 35 names, anon could execute 0 and
-- authenticated exactly ONE - fn_union_distribute_promo(uuid,text,uuid,
-- numeric,uuid,text), which moves promo chips union-wide and has no caller
-- anywhere. A prior hardening pass had closed the rest, invisibly: nothing
-- in the grant tables SAID so, because the closure was a schema-default
-- change rather than explicit revokes.
--
-- So this migration is one live closure plus belt-and-braces on all 29. The
-- explicit REVOKE + service_role GRANT makes the closed state visible and
-- deliberate rather than an accident of defaults, and a future agent reading
-- pg_proc grants sees a decision, not an absence. Measured after: anon 0,
-- authenticated 0, service_role 29 of 29.
--
-- EVERY NAME BELOW WAS VERIFIED CALLER-FREE BEFORE REVOCATION, three ways:
--   * no `supabase.rpc('<name>')` anywhere in club-arena `src/`;
--   * no caller anywhere in the engine (`server/src/`);
--   * no caller in the World Hub repo (`pages/`, `src/`) - and the nine
--     legacy names that ARE still called from World Hub API routes were
--     checked to use SUPABASE_SERVICE_ROLE_KEY exclusively, so they keep
--     working through the service_role grant issued here.
-- Names that turned out to have live browser callers during verification
-- (`atomic_table_addon`, `fn_bbj_promo_payout_atomic`) are NOT in this list.
--
-- Mechanism: a DO block resolves every overload of every name from pg_proc
-- and revokes/grants by exact signature, so an overload added under a
-- different argument list cannot slip through, and a name that does not
-- exist in production is skipped rather than failing the batch.

BEGIN;

DO $$
DECLARE
  fn RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY[
        -- wallet writers with no caller anywhere
        'mass_fund_horses',
        'add_to_player_wallet',
        'deduct_player_wallet',
        'wallet_internal_transfer',
        'atomic_wallet_transfer',
        'atomic_tournament_register',
        'atomic_tournament_unregister',
        'log_wallet_transaction',
        'lock_chips_for_table',
        'unlock_chips_from_table',
        'claim_daily_bonus',
        -- club treasury / rake writers with no caller anywhere
        'increment_club_chip_pool',
        'increment_club_rake',
        'increment_rake_generated',
        'credit_club_rake_to_treasury',   -- engine-called; service_role keeps it
        'transfer_chips',
        'distribute_chips',               -- WH API route; service_role keeps it
        'deduct_agent_balance',
        'deduct_marketplace_chips',
        'fn_credit_chips',                -- WH API routes; service_role keeps them
        'fn_transfer_chips',
        'fn_union_distribute_promo',
        -- seats and horses
        'seat_horse',
        'schedule_horse_leave',
        'promote_next_waitlisted_player',
        'atomic_seat_horse',
        -- tournament money
        'execute_pot_drops',
        'distribute_tournament_prizes',
        'finalize_settlement_period',
        'promo_apply_playthrough',        -- engine-called; service_role keeps it
        -- the legacy cashout family (superseded by fn_cashout_request/approve/release)
        'fn_request_cashout',
        'fn_complete_cashout',
        'fn_agent_approve_cashout',
        'fn_approve_cashout_atomic',
        'fn_cancel_cashout_atomic'
      ])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.sig);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'vault door: % function overload(s) closed to browsers', v_count;
END $$;

COMMIT;
