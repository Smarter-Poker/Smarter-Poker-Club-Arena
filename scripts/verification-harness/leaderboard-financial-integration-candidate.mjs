// UNTRACKED, UNQUALIFIED PREPARATION. Emits one fresh-restore candidate only.
// Never runs Docker, SQL, a driver, a release or a financial source correction.
// Promotion/runtime belongs to root after faithful preflight is demonstrated.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const auth = 'leaderboard-isolated-authorization-draft.sql';
const payout = 'leaderboard-isolated-payout-regression-draft.sql';
const funding = 'leaderboard-isolated-funding-policy-draft.sql';
const fixture = 'leaderboard-isolated-concurrency-fixture-draft.sql';
const concurrency = 'leaderboard-isolated-concurrency-draft.sh';
const unknown = 'leaderboard-unknown-ack-draft.sh';
const proxy = 'leaderboard-unknown-ack-proxy-draft.mjs';
const diagnostics = 'leaderboard-financial-diagnostics.mjs';
const reviewed = Object.freeze({
  [auth]: '93bfc3e5aea54a901f1861f2d450da4f5fe3d1d74c595d89ffb5de102ebd2ac5',
  [payout]: '00008498b2498578dab08522202ed34078690f7dc6505caed402a822923663b6',
  [funding]: 'd3b0d591994d0c8cc5a0c3b66b984d42241e921cf5c06668f29518c84b3eb756',
  [fixture]: 'c2057bbbbb9b08c860ac82cf02e98171ff9188ab36694dcb672f1abd3f37ed41',
  [concurrency]: 'c734ab9c039bd926a4b854177ea76729d825a57df45506b11ac67a59b57723ea',
  [unknown]: 'd4184e26cb9ad08d63e49dabd8d1fac41d68974544ba88280d8766f37f1f3272',
  [proxy]: '9c50efe5eeb70066d66abfd6c3aedf13867763df6b2818aa76a173048bc1701c',
  [diagnostics]: '3659a7e29421017046f4256bac1339b437c8bca5839e47ef3197c1dbe2e003e6',
});
const modes = Object.freeze({
  payout: [auth, payout, diagnostics],
  funding: [auth, funding, diagnostics],
  concurrency: [auth, fixture, concurrency, diagnostics],
  'unknown-ack': [auth, fixture, unknown, proxy, diagnostics],
});
const baseline = Object.freeze({
  payout:
    'Missing/stale close refusal and positive-only cent-tie awards are proposed, not installed contracts.',
  funding:
    'Promo-only seed/overlay assertions are normative and expected to expose current seed-first/overlay behavior.',
  concurrency:
    'Existing-batch read before the funding lock may unique-violate; this is a failure, never successful replay.',
  'unknown-ack':
    'Copied Node compatibility, actual COMMIT quarantine and durable same-identity retry remain runtime-unverified.',
});
export const readFinancialDraft = (name) =>
  readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

function transactionBoundary(sql, ending) {
  assert.ok(sql.endsWith(`${ending};\n`), 'Reviewed terminal transaction boundary changed');
  assert.equal(sql.match(new RegExp(`^${ending};$`, 'gm'))?.length, 1);
  assert.equal(
    sql.match(new RegExp(`^${ending === 'ROLLBACK' ? 'COMMIT' : 'ROLLBACK'};`, 'gm'))?.length ?? 0,
    0
  );
}

export function buildFinancialCandidate(source, mode, readDraft = readFinancialDraft) {
  assert.equal(typeof source, 'string');
  assert.ok(Object.hasOwn(modes, mode), 'Exactly one reviewed financial mode is required');
  for (const name of modes[mode]) {
    const draft = readDraft(name);
    assert.equal(
      createHash('sha256').update(draft).digest('hex'),
      reviewed[name],
      `Reviewed draft changed: ${name}`
    );
    if (name === auth || name === payout || name === funding)
      transactionBoundary(draft, 'ROLLBACK');
    if (name === fixture) transactionBoundary(draft, 'COMMIT');
  }
  function replaceOnce(anchor, replacement) {
    assert.equal(source.split(anchor).length, 2, 'Reviewed preflight anchor changed');
    source = source.replace(anchor, () => replacement);
  }
  const equivalence =
    'cmp -s "$scratch/source-before.json" "$scratch/isolated.json" || failure \'isolated catalog differs from current source\'';
  const cleanup = "cleanup || failure 'explicit cleanup verification failed'";
  assert.equal(source.split(equivalence).length, 2, 'Full equivalence anchor changed');
  assert.ok(
    source.indexOf('unset DATABASE_URL PGDATABASE PGOPTIONS\n') < source.indexOf(equivalence)
  );
  assert.ok(source.indexOf(equivalence) < source.indexOf(cleanup));
  replaceOnce(
    '# One explicit preflight. Never invoked by a schedule and never calls a payout.',
    `# UNQUALIFIED ${mode} candidate: one fresh restore, never schedule or reuse.
# Expected normative baseline failures remain failures, not accepted qualification.`
  );
  replaceOnce(
    'unset DATABASE_URL PGDATABASE PGOPTIONS\n',
    'unset DATABASE_URL PGDATABASE PGOPTIONS PGHOST PGUSER PGPASSWORD\n'
  );
  const checks = modes[mode]
    .map(
      (name) =>
        `[[ "$(sha256sum "$here/${name}" | cut -d' ' -f1)" == '${reviewed[name]}' ]] || failure 'reviewed ${mode} input changed'`
    )
    .join('\n');
  const reportFailure = (
    path,
    message
  ) => `{ if ! node "$here/leaderboard-financial-diagnostics.mjs" '${mode}' "$scratch/${path}"; then
  echo 'Financial Diagnostic Receipt Refused; Raw Evidence Remains Private.' >&2
fi
failure '${message}'; }`;
  const sqlStream = (
    selected
  ) => `# Remove ONLY the hash-pinned authorization's sole final ROLLBACK.
# The selected companion owns its final rollback/commit. One connection only.
[[ "$(tail -n 1 "$here/${auth}")" == 'ROLLBACK;' && "$(grep -c '^ROLLBACK;$' "$here/${auth}")" == 1 ]] || failure 'authorization transaction boundary changed'
! grep -q '^COMMIT;' "$here/${auth}" || failure 'authorization commit boundary changed'
# Fully prepare private input BEFORE starting a database client. A failed
# authorizer read must never be followed by the companion's COMMIT.
sed '$d' "$here/${auth}" >"$scratch/financial-${mode}-authorization.sql" || failure 'authorization SQL preparation failed'
cat "$scratch/financial-${mode}-authorization.sql" "$here/${selected}" >"$scratch/financial-${mode}-complete.sql" || failure 'complete financial SQL preparation failed'
chmod 600 "$scratch/financial-${mode}-authorization.sql" "$scratch/financial-${mode}-complete.sql" || failure 'private financial SQL permissions unavailable'
timeout 180 docker exec -i "$container" psql -h /tmp -XAtq -U "$bootstrap" -d postgres -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate --file=- <"$scratch/financial-${mode}-complete.sql" >"$scratch/financial-${mode}-fixture.log" 2>&1 || ${reportFailure(`financial-${mode}-fixture.log`, `isolated ${mode} SQL assertions failed`)}`;
  const invocation =
    mode === 'payout' || mode === 'funding'
      ? sqlStream(mode === 'payout' ? payout : funding)
      : mode === 'concurrency'
        ? `bash "$here/${concurrency}" "$container" "$scratch" >"$scratch/financial-${mode}-driver.log" 2>&1 || ${reportFailure(`financial-${mode}-driver.log`, 'isolated concurrency assertions failed')}`
        : `${sqlStream(fixture)}
bash "$here/${unknown}" "$container" "$scratch" >"$scratch/financial-${mode}-driver.log" 2>&1 || ${reportFailure(`financial-${mode}-driver.log`, 'isolated unknown-ack assertions failed')}`;
  replaceOnce(
    cleanup,
    `# Selected mode runs only AFTER full catalog equivalence and source unsetting.
# Payout/funding normative contracts and concurrency races may fail baseline.
# ${baseline[mode]}
# No expected failure is swallowed. Each generated script restores from scratch.
${checks}
node --check "$here/leaderboard-financial-diagnostics.mjs" >/dev/null 2>&1 || failure 'financial diagnostic helper unavailable'
${invocation}
${cleanup}`
  );
  replaceOnce(
    "echo 'This preflight does not qualify Supabase service/auth runtime, synthetic configuration, authorization, funding, payouts, recovery, reconciliation or worker execution.'",
    `echo 'Selected isolated ${mode} draft assertions and owning cleanup completed only. Other modes, production Auth/binary/config parity, full financial qualification and launch completion remain unqualified.'`
  );
  return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 3, 'One explicit mode is required');
    process.stdout.write(
      buildFinancialCandidate(
        readFileSync(new URL('./leaderboard-isolation-preflight.sh', import.meta.url), 'utf8'),
        process.argv[2]
      )
    );
  } catch {
    console.error('Unqualified financial source preparation refused: reviewed source/mode changed');
    process.exitCode = 1;
  }
}
