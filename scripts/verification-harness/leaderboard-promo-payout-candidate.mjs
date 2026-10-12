// UNQUALIFIED isolated source proposal. Never installs or executes SQL.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const predecessor = new URL(
  '../../supabase/migrations/20260923144141_a_standalone_club_with_no_opening_seed_settles_with_a_seed_o.sql',
  import.meta.url
);
const signature = 'public.fn_payout_leaderboard(uuid,text,text,timestamptz,timestamptz)';
const rankingSource = new URL(
  '../../supabase/migrations/20260831002500_leaderboard_historical_period_contract.sql',
  import.meta.url
);
export function buildPromoPayoutCandidate(source, ranking = readFileSync(rankingSource, 'utf8')) {
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    '0d9e7e976cd29777b83381f00180bf1963b30662cb130ed9bafa536d7671a0db'
  );
  assert.equal(
    createHash('sha256').update(ranking).digest('hex'),
    '1b268fa4775c2406adaef0eb2cd6d1f88346e36ed48e70a48e8cc6d031d99467'
  );
  const start = 'CREATE OR REPLACE FUNCTION public.fn_payout_leaderboard(';
  const end = '\n$function$;';
  assert.equal(source.split(start).length, 2);
  assert.equal(source.split(end).length, 2);
  let definition = start + source.split(start)[1].split(end)[0] + end;
  function replaceOnce(old, next) {
    assert.equal(definition.split(old).length, 2, 'Reviewed payout anchor changed');
    definition = definition.replace(old, () => next);
  }
  const replay = definition.slice(
    definition.indexOf('  SELECT batch.*'),
    definition.indexOf('  v_plan :=')
  );
  replaceOnce('  v_plan jsonb;', '  v_plan jsonb;\n  v_basis jsonb;\n  v_board jsonb;');
  replaceOnce(
    `  WITH board AS MATERIALIZED (
    SELECT ranked.user_id, ranked.rank
    FROM public.fn_club_leaderboard_by_dates(
      p_club_id, p_metric, v_start, v_end, 1000000, 0
    ) ranked
    WHERE ranked.qualified
  ), tied AS MATERIALIZED (`,
    `  v_basis := public.fn_leaderboard_complete_round_basis(p_club_id, p_period, v_start, v_end);
  IF NOT (v_basis ->> 'basis_version' = 'legacy_v1'
    OR (v_basis ->> 'basis_version' = 'complete_capture_v2'
      AND v_basis -> 'complete' = 'true'::jsonb)) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='LEADERBOARD_COMPLETE_BASIS_REQUIRED';
  END IF;
  -- The public club board and settlement use ONE maintained ranking owner.
  -- That owner selects the same complete basis for closed canonical V2 rounds;
  -- existing promised legacy rounds retain their unchanged selection.
  SELECT COALESCE(jsonb_agg(to_jsonb(ranked) ORDER BY ranked.rank, ranked.user_id), '[]'::jsonb)
    INTO v_board
  FROM public.fn_club_leaderboard_by_dates(p_club_id, p_metric, v_start, v_end, 1000000, 0) ranked;

  WITH board AS MATERIALIZED (
    SELECT ranked.user_id, ranked.rank
    FROM jsonb_to_recordset(v_board) AS ranked(user_id uuid, rank integer, qualified boolean)
    WHERE ranked.qualified
  ), tied AS MATERIALIZED (`
  );
  replaceOnce(
    '  SELECT batch.* INTO v_existing',
    `  -- Serialize the exact historical round identity BEFORE replay lookup.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    format('leaderboard-round:%s:%s:%s', p_club_id, p_period, v_start), 0));

  SELECT batch.* INTO v_existing`
  );
  const fundingStart = definition.indexOf("  IF v_plan ->> 'funding_owner_type' = 'union' THEN");
  const fundingEnd = definition.indexOf(
    "  PERFORM set_config('app.ledger_category', 'leaderboard_payout', true);"
  );
  assert.ok(fundingStart > 0 && fundingEnd > fundingStart);
  const originalFunding = definition.slice(fundingStart, fundingEnd);
  replaceOnce(
    originalFunding,
    `  IF v_plan ->> 'funding_owner_type' = 'union' THEN
    v_union_id := (v_plan ->> 'funding_union_id')::uuid;
    SELECT COALESCE(wallet.promo_wallet, 0) INTO v_promo_available
    FROM public.union_wallets wallet WHERE wallet.union_id = v_union_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'LEADERBOARD_PROMO_WALLET_MISSING|Leaderboard Funding Union Has No Promo Wallet';
    END IF;
  ELSE
    SELECT COALESCE(club.promo_balance, 0) INTO v_promo_available
    FROM public.clubs club WHERE club.id = p_club_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'LEADERBOARD_PROMO_WALLET_MISSING|Leaderboard Club Not Found';
    END IF;
  END IF;
  IF v_promo_available < v_total THEN
    RAISE EXCEPTION
      'LEADERBOARD_PROMO_UNDERFUNDED|Leaderboard Requires % Promo Chips But The Recorded Promo Wallet Holds %',
      v_total, v_promo_available;
  END IF;
  v_promo_debit := v_total;

`
  );
  const debitStart = definition.indexOf('    UPDATE public.clubs\n    SET promo_balance');
  const debitEnd = definition.indexOf('\n  INSERT INTO public.leaderboard_payout_batches');
  assert.ok(debitStart > 0 && debitEnd > debitStart);
  replaceOnce(
    definition.slice(debitStart, debitEnd),
    `    UPDATE public.clubs
    SET promo_balance = promo_balance - v_promo_debit,
        updated_at = now()
    WHERE id = p_club_id;
  END IF;
`
  );
  for (const declaration of [
    '  v_seed_available numeric(18,2) := 0;\n',
    '  v_seed_debit numeric(18,2) := 0;\n',
    '  v_seed_release numeric(18,2) := 0;\n',
    '  v_bank_available numeric(18,2) := 0;\n',
    '  v_overlay_enabled boolean := false;\n',
    '  v_overlay numeric := 0;\n',
  ])
    replaceOnce(declaration, '');
  replaceOnce('  FROM winners;', '  FROM winners\n  WHERE winners.amount > 0;');
  replaceOnce(
    "  IF v_plan ->> 'funding_owner_type' = 'union' THEN\n    v_union_id :=",
    `  -- Freeze the exact resolved program, selected inputs and awards before funds.
  -- A failed settlement rolls this receipt back; no historical row is rewritten.
  INSERT INTO public.leaderboard_round_basis_receipts (
    club_id, period, period_start, period_end, metric,
    program_id, program_version, program_hash, basis_version,
    basis, basis_hash, selected_board, selected_board_hash, winners, winners_hash
  ) VALUES (
    p_club_id, p_period, v_start, v_end, p_metric,
    (v_plan ->> 'program_id')::uuid, (v_plan ->> 'program_version')::integer,
    v_plan ->> 'program_hash', v_basis ->> 'basis_version',
    v_basis, md5(v_basis::text), v_board, md5(v_board::text), v_winners, md5(v_winners::text)
  );

  IF v_plan ->> 'funding_owner_type' = 'union' THEN
    v_union_id :=`
  );
  replaceOnce(
    'v_total, v_seed_debit, v_promo_debit, v_overlay, jsonb_array_length(v_winners)',
    'v_total, 0, v_promo_debit, 0, jsonb_array_length(v_winners)'
  );
  replaceOnce("'seed_funded', v_seed_debit", "'seed_funded', 0");
  replaceOnce("'overlay_funded', v_overlay", "'overlay_funded', 0");
  assert.ok(definition.includes(replay), 'Historical receipt replay changed');
  assert.doesNotMatch(definition, /club_opening_setups|chip_treasury|v_seed_|v_overlay|v_bank_/);
  return `-- UNQUALIFIED disposable-only proposal; no migration version or installation.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
  IF session_user <> 'leaderboard_qualification_bootstrap' OR current_user <> session_user
     OR inet_server_addr() IS NOT NULL OR current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'Disposable bootstrap socket required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('${signature}')
    AND md5(p.prosrc)='2ba8db49240eac826b2f3efe0e262648'
    AND md5(pg_get_functiondef(p.oid))='42b7add95575407dcc35229c3741bd4f'
    AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
    AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
    AND (SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ',' ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type) FROM aclexplode(p.proacl) a)='postgres:EXECUTE,service_role:EXECUTE') THEN
    RAISE EXCEPTION 'Exact payout predecessor security/body drift';
  END IF;
END $guard$;
${definition}
-- CREATE OR REPLACE retains existing ownership and execute ACL.
COMMIT;
`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 2);
    process.stdout.write(buildPromoPayoutCandidate(readFileSync(predecessor, 'utf8')));
  } catch {
    console.error('Unqualified payout source candidate refused: reviewed input changed');
    process.exitCode = 1;
  }
}
