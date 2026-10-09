// UNQUALIFIED source-only driver adapter; no execution or release actions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildPromoPayoutCandidate, predecessor } from './leaderboard-promo-payout-candidate.mjs';
const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const hash = (input) => createHash('sha256').update(input).digest('hex');
export function buildConcurrencyRepairCandidate(
  source = read('leaderboard-isolated-concurrency-draft.sh')
) {
  assert.equal(hash(source), 'c734ab9c039bd926a4b854177ea76729d825a57df45506b11ac67a59b57723ea');
  assert.equal(
    hash(read('leaderboard-promo-payout-candidate.mjs')),
    '18ffcc9db372bc49d83e37cb42a812ddc919532807af1444678524d7cb4ba8df'
  );
  const sql = buildPromoPayoutCandidate(readFileSync(predecessor, 'utf8'));
  const header = 'CREATE OR REPLACE FUNCTION public.fn_payout_leaderboard(';
  assert.equal(sql.split(header).length, 2);
  const body = sql.split(header)[1].split('AS $function$')[1].split('$function$;')[0];
  assert.ok(body.includes("format('leaderboard-round:%s:%s:%s'"));
  const bodyHash = createHash('md5').update(body).digest('hex');
  function once(old, next) {
    assert.equal(source.split(old).length, 2);
    source = source.replace(old, () => next);
  }
  once(
    'readonly fixture="$here/leaderboard-isolated-concurrency-fixture-draft.sql"',
    'readonly fixture="$scratch/repair-bootstrap.sql"'
  );
  const prepareStart = source.indexOf('[[ "$(tail -n 1 "$auth")"');
  const prepareEnd = source.indexOf('\n# Refuse absent/rollback-only/wrong fixtures', prepareStart);
  assert.ok(prepareStart > 0 && prepareEnd > prepareStart);
  once(
    source.slice(prepareStart, prepareEnd),
    `# Consume the parent's complete private input prepared before installer clients.
[[ -f "$fixture" && ! -L "$fixture" && "$(stat -c '%a' "$fixture")" == 600 ]] || exit 1
[[ "$(tail -n 1 "$fixture")" == 'COMMIT;' && "$(grep -c '^COMMIT;$' "$fixture")" == 1 ]] || exit 1
! grep -q '^ROLLBACK;' "$fixture" || exit 1
sql <"$fixture" >"$scratch/concurrency-create.log" 2>&1`
  );
  once('readonly auth="$here/leaderboard-isolated-authorization-draft.sql"\n', '');
  once('readonly here\n', 'readonly here\n[[ -d "$here" ]] || exit 1\n');
  once("'2ba8db49240eac826b2f3efe0e262648'", `'${bodyHash}'`);
  const start = source.indexOf('  count="$(printf "WITH RECURSIVE blocked AS');
  const finish = source.indexOf('\n  sleep 0.1', start);
  assert.ok(start > 0 && finish > start);
  once(
    source.slice(start, finish),
    `  count="$(printf "WITH actors AS (SELECT pid,application_name,wait_event_type,wait_event FROM pg_stat_activity WHERE application_name IN ('lb-funding-holder','lb-concurrency-A','lb-concurrency-B')), funding AS (SELECT a.pid FROM actors a WHERE a.application_name IN ('lb-concurrency-A','lb-concurrency-B') AND a.wait_event_type='Lock' AND a.wait_event IN ('transactionid','tuple') AND EXISTS(SELECT 1 FROM actors h WHERE h.application_name='lb-funding-holder' AND h.pid=ANY(pg_blocking_pids(a.pid)))), replay AS (SELECT a.pid FROM actors a WHERE a.application_name IN ('lb-concurrency-A','lb-concurrency-B') AND a.wait_event_type='Lock' AND a.wait_event='advisory' AND EXISTS(SELECT 1 FROM funding f WHERE f.pid=ANY(pg_blocking_pids(a.pid)))) SELECT (SELECT count(*) FROM funding)::text || '|' || (SELECT count(*) FROM replay)::text;\\n" | sql)"
  if [[ "$count" == '1|1' ]]; then ready=true; break; fi`
  );
  // Extend both independent replay digests with immutable V2 basis receipts.
  const history =
    "    'history',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.wallet_transactions t)";
  assert.equal(source.split(history).length, 3);
  source = source.replaceAll(
    history,
    `${history},
    'basis',(SELECT jsonb_agg(to_jsonb(t) ORDER BY club_id,period,period_start) FROM public.leaderboard_round_basis_receipts t)`
  );
  once(
    '     OR (SELECT count(*) FROM public.leaderboard_payouts) <> 1',
    `     OR (SELECT count(*) FROM public.leaderboard_round_basis_receipts WHERE basis_version='complete_capture_v2') <> 1
     OR EXISTS(SELECT 1 FROM public.leaderboard_round_basis_receipts WHERE basis_hash IS DISTINCT FROM md5(basis::text) OR selected_board_hash IS DISTINCT FROM md5(selected_board::text) OR winners_hash IS DISTINCT FROM md5(winners::text))
     OR (SELECT count(*) FROM public.leaderboard_payouts) <> 1`
  );
  once(
    '     OR (SELECT count(*) FROM public.leaderboard_payouts)<>2',
    `     OR (SELECT count(*) FROM public.leaderboard_round_basis_receipts WHERE basis_version='complete_capture_v2')<>2
     OR (SELECT count(*) FROM public.leaderboard_payouts)<>2`
  );
  once(
    '# EXPECTED POSSIBLE BASELINE FAILURE: current payout reads the existing batch\n# before taking the funding-row lock; concurrent admission can unique-violate\n# in one caller. Safe no-double-payment alone is not successful replay behavior.',
    '# UNQUALIFIED prospective V2 proof: one funding waiter and one exact-round\n# advisory waiter. Baseline source remains unchanged; runtime qualification required.'
  );
  once(
    '# existing batches before this lock; both blocked calls therefore crossed that\n# read. A changed function must be reviewed before this source-specific proof.',
    '# exact round is locked BEFORE replay. One contender owns that lock while\n# blocked on funds; the other must wait on its exact advisory owner.'
  );
  // Existing result, money, worker lock/exclusion and process ownership are unchanged.
  return source;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 2);
    process.stdout.write(buildConcurrencyRepairCandidate());
  } catch {
    console.error('Concurrency repair preparation refused; no runtime qualification');
    process.exitCode = 1;
  }
}
