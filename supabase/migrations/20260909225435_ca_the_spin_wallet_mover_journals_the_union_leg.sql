-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260909225435; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260909225435   (the stamp IS the apply time, UTC: 2026-09-09 22:54:35)
--   name        ca_the_spin_wallet_mover_journals_the_union_leg
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 4049 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260909225435 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_spin_move_owner_wallet
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SPIN WALLET MOVER JOURNALS THE UNION LEG IT MOVES
 *  2026-09-09
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * union_wallets holds the balance; union_wallet_transactions is the domain
 * journal that has to explain it, and fn_union_treasury_selftest reconciles
 * one against the other.
 *
 * fn_spin_move_owner_wallet moved a union wallet and wrote no journal row at
 * all. Worse, its caller fn_spin_settle_game sets
 * app.ledger_autoskip_union_wallets around the call, which also suppresses the
 * chip_ledger twin - so the movement was invisible in BOTH journals. Nothing
 * downstream could see it and nothing could reconcile it.
 *
 * The leg is written here now, in the same statement's transaction as the
 * balance change, with balance_after taken from the UPDATE's own RETURNING
 * clause rather than a second read - the idiom fn_union_debit_wallet_zd3core
 * already uses. A separately-read balance_after is how the journal ends up
 * describing a balance that a concurrent writer has already moved.
 *
 * app.uwt_selfjournal is set around the write so a future backstop trigger
 * knows this door journals for itself. The club branch is untouched: club
 * money is journalled elsewhere.
 */

CREATE OR REPLACE FUNCTION public.fn_spin_move_owner_wallet(
  p_owner_id uuid, p_owner_kind text, p_wallet text, p_delta numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_after numeric;
BEGIN
  /* ZERO-DRIFT phase 6: declare the ledger identity of the spin margin flow.
     Positive delta = spin margin landing with the owner (rake, from the spin
     reserve); negative delta = the owner funding the spin pool (overlay). */
  PERFORM public.fn_ca_declare_ledger(
    CASE WHEN p_delta >= 0 THEN 'rake' ELSE 'overlay' END, 'spin_reserve');

  IF p_owner_kind = 'union' THEN
    IF p_wallet NOT IN ('chip_balance','promo_wallet','rake_wallet','spin_reserve_wallet') THEN
      RAISE EXCEPTION 'unknown union wallet %', p_wallet;
    END IF;

    PERFORM set_config('app.uwt_selfjournal', '1', true);

    EXECUTE format(
      'UPDATE public.union_wallets SET %I = %I + $1, updated_at = now()
        WHERE union_id = $2 AND %I + $1 >= 0 RETURNING %I',
      p_wallet, p_wallet, p_wallet, p_wallet)
      INTO v_after USING p_delta, p_owner_id;

    IF v_after IS NOT NULL AND round(p_delta, 2) <> 0 THEN
      INSERT INTO public.union_wallet_transactions
        (union_id, wallet, direction, amount, balance_after, tx_type, notes)
      VALUES
        (p_owner_id, p_wallet,
         CASE WHEN p_delta > 0 THEN 'credit' ELSE 'debit' END,
         abs(round(p_delta, 2)), v_after,
         CASE WHEN p_delta > 0 THEN 'spin_seed_return' ELSE 'spin_pool_funding' END,
         CASE WHEN p_delta > 0
              THEN 'Spin reserve seed instalment returned to the union '
                || p_wallet || ' (fn_spin_move_owner_wallet)'
              ELSE 'Union ' || p_wallet || ' funded the spin reserve '
                || '(fn_spin_move_owner_wallet)' END);
    END IF;

    PERFORM set_config('app.uwt_selfjournal', '', true);
  ELSE
    IF p_wallet NOT IN ('chip_treasury','promo_balance') THEN
      RAISE EXCEPTION 'unknown club wallet %', p_wallet;
    END IF;
    EXECUTE format(
      'UPDATE public.clubs SET %I = COALESCE(%I,0) + $1
        WHERE id = $2 AND COALESCE(%I,0) + $1 >= 0 RETURNING %I',
      p_wallet, p_wallet, p_wallet, p_wallet)
      INTO v_after USING p_delta, p_owner_id;
  END IF;
  RETURN v_after;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_spin_move_owner_wallet(uuid, text, text, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_spin_move_owner_wallet(uuid, text, text, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.fn_spin_move_owner_wallet(uuid, text, text, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_move_owner_wallet(uuid, text, text, numeric) TO service_role;
