import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const sql = readFileSync(
  new URL('./leaderboard-isolated-historical-replay-candidate.sql', import.meta.url),
  'utf8'
);
const source = readFileSync(
  new URL(
    '../../supabase/migrations/20260923143157_the_opening_seed_funds_round_one_and_an_owner_may_allow_a_cl.sql',
    import.meta.url
  ),
  'utf8'
);
test('two-stage historical recovery uses the pinned original real opening and durable evidence', () => {
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    '2cdd4a18c315290da99012c98dc244996db4de4799ffa738d11a5c82a3b88840'
  );
  assert.match(sql, /\\if :historical_before/);
  assert.equal(sql.match(/^COMMIT;$/gm).length, 1);
  assert.equal(sql.match(/^ROLLBACK;$/gm).length, 1);
  assert.match(sql, /session_user<>'leaderboard_qualification_bootstrap'/);
  assert.match(sql, /inet_server_addr\(\) IS NOT NULL/);
  assert.match(sql, /leaderboard_seed_remaining[^\n]*IS DISTINCT FROM 100/);
  assert.match(sql, /chip_treasury[^\n]*IS DISTINCT FROM 99900/);
  assert.match(sql, /promo_balance[^\n]*IS DISTINCT FROM 0/);
  assert.doesNotMatch(
    sql,
    /INSERT INTO public\.(?:leaderboard_payouts|leaderboard_payout_batches|chip_ledger)|DELETE FROM public\.|DISABLE TRIGGER/
  );
  assert.match(sql, /opening_replay IS DISTINCT FROM proof.opening_replay/);
  assert.match(sql, /publication_replay IS DISTINCT FROM proof.publication_replay/);
  assert.match(sql, /digest\(\) IS DISTINCT FROM proof.image/);
});
test('original payout creates paid historical evidence and candidate replays exact immutable response', () => {
  assert.match(sql, /Exact original unpaid historical fixture required/);
  assert.ok(sql.includes("<>'2ba8db49240eac826b2f3efe0e262648'"));
  assert.equal(sql.match(/:=public\.fn_payout_leaderboard\(/g).length, 5);
  assert.match(sql, /program_id=historical_program/);
  assert.match(sql, /payout_amount=10/);
  assert.match(sql, /seed_funded'\)::numeric IS DISTINCT FROM 10/);
  assert.match(sql, /promo_balance[^\n]*IS DISTINCT FROM 90/);
  assert.match(sql, /payout_replay IS DISTINCT FROM proof\.payout_replay/);
  assert.ok(sql.includes(":'candidate_payout_body_md5'"));
  assert.ok(sql.includes("='2ba8db49240eac826b2f3efe0e262648'"));
  for (const relation of [
    'leaderboard_payouts',
    'leaderboard_payout_batches',
    'leaderboard_payout_failures',
    'player_stats_snapshots',
  ])
    assert.ok(sql.includes(`'${relation}'`));
  assert.match(sql, /to_jsonb\(m\)-'joined_at'/);
  assert.match(sql, /to_jsonb\(c\)-'created_at'/);
  assert.doesNotMatch(
    sql,
    /UPDATE public\.leaderboard_reward_program_versions|INSERT INTO public\.leaderboard_payout(?:s|_batches)|clock_timestamp\s*\([^)]*[^)]\)/
  );
});
test('unpaid original monthly program crosses exact existing-club installation inventory without fabricated captures', () => {
  const before = sql.split('\\else')[0];
  const after = sql.split('\\else')[1];
  assert.match(before, /fn_leaderboard_period_window\('monthly',-2\)/);
  assert.match(before, /least\(starts,monthly_start\)-1/);
  assert.match(before, /monthly_end>=starts/);
  assert.match(before, /snapshot_date IN\(monthly_start,monthly_end\)/);
  assert.match(before, /Original unpaid monthly program selection differs/);
  assert.match(before, /monthly_board:=jsonb_build_array\(jsonb_build_object/);
  assert.match(
    before,
    /'rank_change',0,'qualified',true,'rank',1,'total_ranked',1,'baseline_date',monthly_start/
  );
  assert.doesNotMatch(before, /fn_club_leaderboard_by_dates/);
  assert.match(after, /leaderboard_basis_existing_clubs WHERE club_id=club/);
  assert.match(
    after,
    /proof\.period_start<weekly_v2_from AND proof\.monthly_start<monthly_v2_from/
  );
  assert.match(
    after,
    /fn_leaderboard_complete_round_basis\(club,'weekly',proof\.period_start,proof\.period_end\)/
  );
  assert.match(
    after,
    /fn_leaderboard_complete_round_basis\(club,'monthly',proof\.monthly_start,proof\.monthly_end\)/
  );
  assert.match(after, /extract\(day FROM proof\.monthly_start\)<>1/);
  assert.match(after, /proof\.monthly_end<>\(proof\.monthly_start\+interval '1 month'\)::date/);
  assert.match(after, /proof\.monthly_end>\(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'\)::date/);
  assert.doesNotMatch(
    sql,
    /INSERT INTO public\.leaderboard_(?:complete_captures|capture_counters)|UPDATE public\.leaderboard_basis/
  );
});
test('candidate executes new legacy settlement with independent board, exact cents and Promo-only journal', () => {
  const after = sql.split('\\else')[1];
  assert.match(after, /board IS DISTINCT FROM proof\.monthly_board/);
  assert.match(after, /monthly_plan->>'program_hash' IS DISTINCT FROM proof\.monthly_hash/);
  assert.match(
    after,
    /SET LOCAL ROLE service_role;\s+response:=public\.fn_payout_leaderboard\(club,'monthly','profit'/
  );
  assert.match(after, /'promo_funded'\)::numeric IS DISTINCT FROM 10/);
  assert.match(after, /'seed_funded'\)::numeric IS DISTINCT FROM 0/);
  assert.match(after, /'overlay_funded'\)::numeric IS DISTINCT FROM 0/);
  assert.match(after, /promo_balance[^\n]*IS DISTINCT FROM 80/);
  assert.match(after, /chip_treasury[^\n]*IS DISTINCT FROM 99900/);
  assert.match(after, /leaderboard_seed_remaining[^\n]*IS DISTINCT FROM 0/);
  assert.match(after, /AND r\.basis_version='legacy_v1' AND r\.basis=legacy_verify\.basis/);
  assert.match(after, /r\.selected_board=proof\.monthly_board/);
  assert.match(after, /r\.winners=legacy_verify\.winners/);
  assert.match(after, /r\.selected_board_hash=md5\(r\.selected_board::text\)/);
  assert.match(after, /r\.winners_hash=md5\(r\.winners::text\)/);
  assert.doesNotMatch(
    after,
    /(?:selected_board_hash=md5\(proof\.monthly_board|winners_hash=md5\(legacy_verify\.winners)/
  );
  assert.match(after, /pre_from_balance=90 AND post_from_balance=80/);
  assert.match(after, /pre_to_balance=10 AND post_to_balance=20/);
  for (const table of [
    'wallet_credit_idempotency',
    'wallet_transactions',
    'leaderboard_payouts',
    'leaderboard_payout_batches',
  ])
    assert.ok(after.includes(`FROM public.${table}`));
  assert.match(
    after,
    /program_version=proof\.monthly_version AND program_hash=proof\.monthly_hash/
  );
});
test('new legacy replay preserves original paid rows and self-aborts to the exact preimage', () => {
  const after = sql.split('\\else')[1];
  assert.match(after, /IS DISTINCT FROM original_batch/);
  assert.match(after, /IS DISTINCT FROM original_payouts/);
  assert.match(after, /paid_image:=leaderboard_historical_fixture\.digest\(\)/);
  assert.match(
    after,
    /SET LOCAL ROLE service_role;\s+replay:=public\.fn_payout_leaderboard\(club,'monthly','profit'/
  );
  assert.match(after, /IS DISTINCT FROM paid_image/);
  assert.match(after, /IS DISTINCT FROM receipt/);
  assert.match(
    after,
    /SET CONSTRAINTS ALL IMMEDIATE;\s+RAISE EXCEPTION USING ERRCODE='Q0004',MESSAGE='UnpaidLegacySettlementPassedAndRolledBack'/
  );
  assert.match(after, /EXCEPTION WHEN SQLSTATE 'Q0004' THEN legacy_passed:=true/);
  assert.match(
    after,
    /IF NOT legacy_passed OR leaderboard_historical_fixture\.digest\(\) IS DISTINCT FROM proof\.image/
  );
  assert.match(after, /Unpaid legacy settlement did not roll back to exact historical preimage/);
  assert.equal(sql.match(/^COMMIT;$/gm).length, 1);
  assert.equal(sql.match(/^ROLLBACK;$/gm).length, 1);
  assert.doesNotMatch(
    sql,
    /DELETE FROM public\.|DISABLE TRIGGER|UPDATE public\.(?:clubs SET (?:promo_balance|chip_treasury)|club_members SET chip_balance)/
  );
});
test('candidate identities and exact new-overlay refusal cannot silently reuse predecessor', () => {
  for (const pin of ['578960fee3c325b9c724e976bed968f4', 'ef4ab9935eb3681ba4f1ab068a8b65fd'])
    assert.ok(sql.includes(`='${pin}'`) && sql.includes(`       <>'${pin}'`));
  for (const argument of ['candidate_opening_body_md5', 'candidate_publish_body_md5'])
    assert.ok(sql.includes(`:'${argument}'`));
  assert.match(sql, /EXCEPTION WHEN SQLSTATE '22023'/);
  assert.match(sql, /IF NOT rejected OR/);
  assert.match(sql, /SET CONSTRAINTS ALL IMMEDIATE/);
  assert.match(source, /IF FOUND THEN[\s\S]*?'already_completed', true/);
  assert.ok(
    sql.includes('LEADERBOARD_PROMO_ONLY|Club Bank Overlay Is Not Allowed For Leaderboard Prizes')
  );
});
