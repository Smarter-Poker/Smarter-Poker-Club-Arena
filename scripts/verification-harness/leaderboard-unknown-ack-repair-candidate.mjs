// UNQUALIFIED source adapter. Requires committed complete concurrency fixture.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function buildUnknownAckRepairCandidate(
  source = readFileSync(new URL('./leaderboard-unknown-ack-draft.sh', import.meta.url), 'utf8')
) {
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    'd4184e26cb9ad08d63e49dabd8d1fac41d68974544ba88280d8766f37f1f3272'
  );
  const existing = '     OR EXISTS(SELECT 1 FROM public.leaderboard_payouts)';
  assert.equal(source.split(existing).length, 2);
  source = source.replace(
    existing,
    `${existing}
     OR EXISTS(SELECT 1 FROM public.leaderboard_basis_existing_clubs)
     OR (SELECT count(*) FROM public.leaderboard_complete_captures)<>3
     OR (SELECT count(*) FROM public.leaderboard_capture_counters)<>6
     OR EXISTS(SELECT 1 FROM public.leaderboard_round_basis_receipts)`
  );
  const history =
    '    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.wallet_transactions t))::text)';
  assert.equal(source.split(history).length, 3);
  source = source.replaceAll(
    history,
    `    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.wallet_transactions t),
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY club_id,period,period_start) FROM public.leaderboard_round_basis_receipts t))::text)`
  );
  const one = '     OR (SELECT count(*) FROM public.leaderboard_payouts)<>1';
  assert.equal(source.split(one).length, 2);
  source = source.replace(
    one,
    `     OR (SELECT count(*) FROM public.leaderboard_round_basis_receipts WHERE basis_version='complete_capture_v2')<>1
     OR EXISTS(SELECT 1 FROM public.leaderboard_round_basis_receipts WHERE basis_hash IS DISTINCT FROM md5(basis::text) OR selected_board_hash IS DISTINCT FROM md5(selected_board::text) OR winners_hash IS DISTINCT FROM md5(winners::text))
${one}`
  );
  return source;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 2);
    process.stdout.write(buildUnknownAckRepairCandidate());
  } catch {
    console.error('Unknown acknowledgment repair preparation refused');
    process.exitCode = 1;
  }
}
