// UNQUALIFIED source preparation only. Never executes SQL, Docker or a release.
// Original financial baseline modes remain unchanged and must retain failures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const preflightHash = '6fdb912844c6fd7824fd750b5b8e1bdbe274f945d625339f83a8b230a910bfcd';
const auth = 'leaderboard-isolated-authorization-draft.sql';
const capture = 'leaderboard-capture-basis-candidate.sql';
const ranking = 'leaderboard-complete-ranking-candidate.mjs';
const payout = 'leaderboard-promo-payout-candidate.mjs';
const config = 'leaderboard-promo-config-candidate.mjs';
const opening = 'leaderboard-promo-opening-candidate.mjs';
const adapter = 'leaderboard-capture-payout-fixture-candidate.mjs';
const compatibility = 'leaderboard-capture-basis-regression-candidate.sql';
const openingFixture = 'leaderboard-isolated-opening-policy-draft.sql';
// Freeze receipts are reviewed whole-input bytes, not runtime qualification.
const reviewed = Object.freeze({
  [auth]: 'ccfec476677cbf23164646149a2a3f713b01f66e4cb1607c2e5b1d851e5ae3a9',
  [capture]: 'd942ae27470d77666f1209a82dd137fe630d2af431f1babc03d444462a9502bc',
  [ranking]: '63a92bb2e01298dab850ddd15f65ce71742bdcbe24084007beee213b579ba1dc',
  [payout]: '18ffcc9db372bc49d83e37cb42a812ddc919532807af1444678524d7cb4ba8df',
  [config]: 'f10e5fc33461c47cd710347f8e17e692b8bdd83206faf92e73511f98c0fa8e6c',
  [opening]: 'ec53053f330856156395c4f0c95ee94e4950c34e8f6ea4047b35fe2fd7bb78b3',
  [adapter]: '5c4792524b4c0f1b4c0b7b28de25e3cfaab22159edf87755a25a3c7ab5e8cc1b',
  [compatibility]: '3e5440f6b4f52d71e429ba2be7d71c814c329eb5caa9ae17aa3602dd8aa8aa63',
  [openingFixture]: '40ec7d17deda73f27cad1706f44f212288d7781767eabb1c2d05258c3e622047',
});
const modes = Object.freeze({
  'v2-payout': [auth, capture, ranking, payout, config, opening, adapter],
  'capture-compatibility': [auth, capture, compatibility],
  opening: [auth, config, opening, openingFixture],
});
export const readRepairInput = (name) =>
  readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const hash = (source) => createHash('sha256').update(source).digest('hex');
function transaction(source, ending) {
  assert.ok(source.endsWith(`${ending};\n`));
  assert.equal(source.match(new RegExp(`^${ending};$`, 'gm'))?.length, 1);
  assert.doesNotMatch(source, new RegExp(`^${ending === 'COMMIT' ? 'ROLLBACK' : 'COMMIT'};`, 'm'));
}

export function buildFinancialRepairCandidate(source, mode, readInput = readRepairInput) {
  assert.equal(hash(source), preflightHash, 'Reviewed maintained preflight changed');
  assert.ok(Object.hasOwn(modes, mode), 'Exactly one reviewed candidate mode required');
  for (const name of modes[mode]) {
    const input = readInput(name);
    assert.equal(hash(input), reviewed[name], `Reviewed candidate input changed: ${name}`);
    if (name === auth || name === compatibility || name === openingFixture)
      transaction(input, 'ROLLBACK');
    if (name === capture) transaction(input, 'COMMIT');
  }
  function once(anchor, replacement) {
    assert.equal(source.split(anchor).length, 2, 'Unique maintained boundary changed');
    source = source.replace(anchor, () => replacement);
  }
  const equivalence =
    'cmp -s "$scratch/source-before.json" "$scratch/isolated.json" || failure \'isolated catalog differs from current source\'';
  const cleanup = "cleanup || failure 'explicit cleanup verification failed'";
  assert.equal(source.split(equivalence).length, 2);
  assert.ok(
    source.indexOf('unset DATABASE_URL PGDATABASE PGOPTIONS\n') < source.indexOf(equivalence)
  );
  assert.ok(source.indexOf(equivalence) < source.indexOf(cleanup));
  once(
    '# One explicit preflight. Never invoked by a schedule and never calls a payout.',
    `# UNQUALIFIED ${mode} repair candidate: explicit fresh isolated restore only.`
  );
  once(
    'unset DATABASE_URL PGDATABASE PGOPTIONS\n',
    'unset DATABASE_URL PGDATABASE PGOPTIONS PGHOST PGUSER PGPASSWORD\n'
  );
  const checks = modes[mode]
    .map(
      (name) =>
        `[[ "$(sha256sum "$here/${name}" | cut -d' ' -f1)" == '${reviewed[name]}' ]] || failure 'reviewed candidate input changed'`
    )
    .join('\n');
  const prepareGenerator = (name, selected) =>
    `node "$here/${name}" >"$scratch/repair-${selected}.sql" || failure 'candidate SQL preparation refused'`;
  const prepareCapture = `# SET ROLE is scoped to this installer connection only. New objects belong
# to postgres; later bootstrap guards remain current_user=session_user.
printf '%s\\n' 'SET ROLE postgres;' >"$scratch/repair-capture.sql" || failure 'capture role preparation failed'
cat "$here/${capture}" >>"$scratch/repair-capture.sql" || failure 'capture SQL preparation failed'
printf '%s\\n' 'RESET ROLE;' >>"$scratch/repair-capture.sql" || failure 'capture role reset preparation failed'`;
  const prepareAuth = `[[ "$(tail -n 1 "$here/${auth}")" == 'ROLLBACK;' && "$(grep -c '^ROLLBACK;$' "$here/${auth}")" == 1 ]] || failure 'authorization terminal boundary changed'
! grep -q '^COMMIT;' "$here/${auth}" || failure 'authorization commit boundary changed'
sed '$d' "$here/${auth}" >"$scratch/repair-authorization.sql" || failure 'authorization preparation failed'`;
  const invoke = (selected) => `repair_sql '${selected}' "$scratch/repair-${selected}.sql"`;
  let preparation;
  let invocation;
  if (mode === 'v2-payout') {
    preparation = `${prepareCapture}
${prepareGenerator(ranking, 'ranking')}
${prepareGenerator(payout, 'payout')}
${prepareGenerator(config, 'config')}
${prepareGenerator(opening, 'opening')}
${prepareAuth}
${prepareGenerator(adapter, 'payout-fixture')}
cat "$scratch/repair-authorization.sql" "$scratch/repair-payout-fixture.sql" >"$scratch/repair-fixture.sql" || failure 'payout complete input preparation failed'`;
    invocation = ['capture', 'ranking', 'payout', 'config', 'opening', 'fixture']
      .map(invoke)
      .join('\n');
  } else if (mode === 'capture-compatibility') {
    preparation = `${prepareAuth}
# Sole verified ROLLBACK becomes a COMMIT only in the owned disposable DB.
cp "$scratch/repair-authorization.sql" "$scratch/repair-bootstrap.sql" || failure 'disposable bootstrap preparation failed'
printf '%s\\n' 'COMMIT;' >>"$scratch/repair-bootstrap.sql" || failure 'disposable commit preparation failed'
${prepareCapture}
cp "$here/${compatibility}" "$scratch/repair-fixture.sql" || failure 'compatibility input preparation failed'`;
    invocation = ['bootstrap', 'capture', 'fixture'].map(invoke).join('\n');
  } else {
    preparation = `${prepareGenerator(config, 'config')}
${prepareGenerator(opening, 'opening')}
${prepareAuth}
cat "$scratch/repair-authorization.sql" "$here/${openingFixture}" >"$scratch/repair-fixture.sql" || failure 'opening complete input preparation failed'`;
    invocation = ['config', 'opening', 'fixture'].map(invoke).join('\n');
  }
  once(
    cleanup,
    `# Candidate invocation only AFTER original full catalog equivalence.
${checks}
# Prepare every private SQL input before admitting ANY candidate client.
${preparation}
chmod 600 "$scratch"/repair-*.sql || failure 'private candidate input permissions unavailable'
repair_sql() {
  local stage="$1" input="$2" status state='unknown' line
  if timeout 180 docker exec -i "$container" psql -h /tmp -XAtq -U "$bootstrap" -d postgres -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate <"$input" >"$scratch/repair-$stage.log" 2>&1; then
    printf 'Isolated Candidate Stage Completed: %s\\n' "$stage"
  else
    status=$?
    # Bounded private read; never expose arbitrary SQL, identifiers or values.
    while IFS= read -r line; do
      if [[ "$line" =~ ^(ERROR|FATAL|PANIC):[[:space:]]+([0-9A-Z]{5})[[:space:]]*$ ]]; then state="\${BASH_REMATCH[2]}"; break; fi
    done < <(head -c 65536 "$scratch/repair-$stage.log")
    printf 'Isolated Candidate Failure: Mode=%s Stage=%s SQLSTATE=%s Exit=%s\\n' '${mode}' "$stage" "$state" "$status" >&2
    failure 'isolated candidate assertions or installation failed'
  fi
}
${invocation}
${cleanup}`
  );
  once(
    "echo 'This preflight does not qualify Supabase service/auth runtime, synthetic configuration, authorization, funding, payouts, recovery, reconciliation or worker execution.'",
    `echo 'Selected isolated ${mode} candidate assertions and verified cleanup completed only. Original baseline, production installation, Auth parity, worker/UI, concurrency and unknown-ack qualification remain separate.'`
  );
  return source;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 3);
    process.stdout.write(
      buildFinancialRepairCandidate(
        readRepairInput('leaderboard-isolation-preflight.sh'),
        process.argv[2]
      )
    );
  } catch {
    console.error('Isolated repair source preparation refused; no runtime qualification');
    process.exitCode = 1;
  }
}
