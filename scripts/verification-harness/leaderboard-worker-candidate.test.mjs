// Source contracts only; actual PostgreSQL qualification remains required.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const predecessor = readFileSync(
  new URL(
    '../../supabase/migrations/20260906084547_leaderboard_phase_4_promo_only_settlement_truth.sql',
    import.meta.url
  ),
  'utf8'
);
const worker = predecessor
  .split('CREATE OR REPLACE FUNCTION public.fn_settle_due_leaderboards()')[1]
  .split('\n$function$;')[0];
const fixture = readFileSync(
  new URL('./leaderboard-isolated-worker-regression-candidate.sql', import.meta.url),
  'utf8'
);

test('unchanged authoritative worker already retains exact typed capture messages with compatible code', () => {
  assert.equal(
    createHash('sha256').update(predecessor).digest('hex'),
    '302eea84933d55be7ab8789d86345c63214fdfdb1ea4614075a30a4657427a8d'
  );
  assert.equal(
    createHash('md5')
      .update(worker.split('AS $function$')[1] + '\n')
      .digest('hex'),
    '8f2b1c2ff47e45431be6fee4639f9cb8'
  );
  assert.match(worker, /ELSE 'settlement_error'/);
  assert.match(worker, /left\(v_error_message, 500\), v_error_code/);
  assert.match(worker, /EXCEPTION WHEN OTHERS THEN/);
  assert.match(worker, /attempt_count = public\.leaderboard_payout_failures\.attempt_count \+ 1/);
  assert.match(worker, /WHERE NOT EXISTS \([\s\S]*leaderboard_payout_batches/);
});

test('worker fixture refuses source/nonempty/legacy installation and rolls back all mutations', () => {
  for (const guard of [
    'leaderboard_qualification_bootstrap',
    'inet_server_addr() IS NOT NULL',
    'leaderboard_basis_existing_clubs',
    'leaderboard_payout_batches',
    'leaderboard_complete_captures',
    'md5(p.prosrc)',
  ])
    assert.ok(fixture.includes(guard));
  assert.equal(fixture.match(/^BEGIN;$/gm)?.length, 1);
  assert.equal(fixture.match(/^ROLLBACK;$/gm)?.length, 1);
  assert.doesNotMatch(fixture, /^COMMIT;$/m);
  assert.doesNotMatch(
    fixture,
    /DELETE FROM|DISABLE TRIGGER|cron\.schedule|CREATE OR REPLACE FUNCTION public/
  );
});

test('missing/invalid actual worker and repeated unpaid boundary cannot move financial state', () => {
  assert.ok(fixture.includes("error_message='LEADERBOARD_CAPTURE_UNAVAILABLE'"));
  assert.ok(fixture.includes("error_message='LEADERBOARD_CAPTURE_INVALID'"));
  assert.ok(fixture.includes('attempt_count=1'));
  assert.ok(fixture.includes('attempt_count=2'));
  assert.ok(fixture.includes('attempt_count=3'));
  assert.equal(
    fixture.match(/pg_temp\.worker_money_digest\(\) IS DISTINCT FROM before_digest/g)?.length,
    3
  );
  assert.match(fixture, /EXCEPTION WHEN SQLSTATE 'Q0001' THEN NULL/);
  assert.equal(fixture.match(/result:=public\.fn_settle_due_leaderboards\(\)/g)?.length, 5);
});

test('actual worker success independently reconciles both rounds and frozen no-op replay', () => {
  assert.ok(fixture.includes('ORDER BY club_id,user_id) FROM public.club_members t'));
  assert.doesNotMatch(fixture, /ORDER BY id\) FROM public\.club_members/);
  for (const field of [
    'sum(total_paid)',
    'sum(promo_funded)',
    'sum(seed_funded+overlay_funded)',
    'sum(chip_balance)',
    "to_type='leaderboard_round'",
    "from_type='leaderboard_round'",
    "key LIKE 'leaderboard:%'",
    "basis_version='complete_capture_v2'",
    'resolved_at IS NULL',
  ])
    assert.ok(fixture.includes(field));
  assert.ok(fixture.includes('pg_temp.worker_money_digest() IS DISTINCT FROM paid_digest'));
  assert.match(fixture, /SET LOCAL ROLE service_role;/);
});
