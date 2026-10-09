// UNQUALIFIED source preparation only. Never executes SQL, Docker or a release.
// Original financial baseline modes remain unchanged and must retain failures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const preflightHash = '68c4dbc9db011e9285175492867ee431c778649c4e2d72dad199489e321a2efe';
const auth = 'leaderboard-isolated-authorization-draft.sql';
const capture = 'leaderboard-capture-basis-candidate.sql';
const ranking = 'leaderboard-complete-ranking-candidate.mjs';
const payout = 'leaderboard-promo-payout-candidate.mjs';
const config = 'leaderboard-promo-config-candidate.mjs';
const opening = 'leaderboard-promo-opening-candidate.mjs';
const adapter = 'leaderboard-capture-payout-fixture-candidate.mjs';
const repairDiagnostics = 'leaderboard-repair-financial-diagnostics.mjs';
const consolidated = 'leaderboard-consolidated-migration-candidate.mjs';
const postimage = 'leaderboard-consolidated-postimage-candidate.sql';
const compatibility = 'leaderboard-capture-basis-regression-candidate.sql';
const openingFixture = 'leaderboard-isolated-opening-policy-draft.sql';
const workerFixture = 'leaderboard-isolated-worker-regression-candidate.sql';
const historicalFixture = 'leaderboard-isolated-historical-replay-candidate.sql';
const concurrencyFixture = 'leaderboard-isolated-concurrency-fixture-draft.sql';
const completeFixtureAdapter = 'leaderboard-complete-concurrency-fixture-candidate.mjs';
const concurrencyAdapter = 'leaderboard-concurrency-repair-candidate.mjs';
const unknownAckAdapter = 'leaderboard-unknown-ack-repair-candidate.mjs';
const concurrencyBaseline = 'leaderboard-isolated-concurrency-draft.sh';
const unknownAckBaseline = 'leaderboard-unknown-ack-draft.sh';
const unknownAckProxy = 'leaderboard-unknown-ack-proxy-draft.mjs';
// Freeze receipts are reviewed whole-input bytes, not runtime qualification.
const reviewed = Object.freeze({
  [auth]: 'c014b653863a6427dae7e97dfcac69a09aa903cff85bda114f8a37fcb7bbad92',
  [capture]: 'd942ae27470d77666f1209a82dd137fe630d2af431f1babc03d444462a9502bc',
  [ranking]: '63a92bb2e01298dab850ddd15f65ce71742bdcbe24084007beee213b579ba1dc',
  [payout]: '18ffcc9db372bc49d83e37cb42a812ddc919532807af1444678524d7cb4ba8df',
  [config]: '5c81d18b10cea37854d8bb84f0453cd76c00d9da082bf0f890abc33ab6d8f2bd',
  [opening]: 'ec53053f330856156395c4f0c95ee94e4950c34e8f6ea4047b35fe2fd7bb78b3',
  [adapter]: 'c42b0620d6c05d69fc5589e3bd8c89f0305186e347a668f3ae9ae9f432812953',
  [repairDiagnostics]: 'd449d4108207a44e665752369aee24bd1a7b0663078274b8a98a3c0e27e9912b',
  [consolidated]: '3142633c836966b32234cb7606d4e5c8d79f11b18fa75017e6d1ef80843e9807',
  [postimage]: '0212896886873d10c9dc073865f13e544f496e8d38a5e924ab1d3f41e7277f1c',
  [compatibility]: 'a1654508e9a44b849d6ccd67afed6173fe50300488b232e8c028c82ff8f06e6e',
  [openingFixture]: '40ec7d17deda73f27cad1706f44f212288d7781767eabb1c2d05258c3e622047',
  [workerFixture]: '2dada967cdb8bff98c8f8904f3b4d99e0a64eb67eba76a0ff4787236a92d4163',
  [historicalFixture]: '686ceb495005478eb6b44efdabee0e3f666c1fc7d23b45cc04f1d84d0ed688ab',
  [concurrencyFixture]: 'c2057bbbbb9b08c860ac82cf02e98171ff9188ab36694dcb672f1abd3f37ed41',
  [completeFixtureAdapter]: 'a34d0e22319530580af03e45c3c22dbd0879d95ea7d00a44948cdb1bd5805b38',
  [concurrencyAdapter]: '7774fefd0ae702fdb597d29163a8f3f63d97d44db61d4a4d7db44c8bcc6cfef5',
  [unknownAckAdapter]: '21ae62940a2f2d1933179e47e5c21abf53e544c57514f83b2058273ea5fbf997',
  [concurrencyBaseline]: 'bc53be816d77e89d04c25602e3d8dc12fe6cecfe853d02f08f5663ccda0b2192',
  [unknownAckBaseline]: '9d9bbbf814dcf7f8badf68c5b6325782f304c06dcf38231e4035192b31684f9c',
  [unknownAckProxy]: 'd94d01708225596d90d2ee892d2634d995078cc1d6f7ac604fae9e56ac8227b5',
});
const modes = Object.freeze({
  'v2-payout': [
    auth,
    capture,
    ranking,
    payout,
    config,
    opening,
    adapter,
    repairDiagnostics,
    consolidated,
  ],
  'capture-compatibility': [auth, capture, compatibility],
  opening: [
    auth,
    capture,
    ranking,
    payout,
    config,
    opening,
    openingFixture,
    consolidated,
    repairDiagnostics,
  ],
  worker: [
    auth,
    capture,
    ranking,
    payout,
    config,
    opening,
    concurrencyFixture,
    workerFixture,
    consolidated,
  ],
  'historical-replay': [
    auth,
    capture,
    ranking,
    payout,
    config,
    opening,
    historicalFixture,
    consolidated,
  ],
  concurrency: [
    auth,
    capture,
    ranking,
    payout,
    config,
    opening,
    concurrencyFixture,
    workerFixture,
    completeFixtureAdapter,
    concurrencyAdapter,
    concurrencyBaseline,
    consolidated,
  ],
  'unknown-ack': [
    auth,
    capture,
    ranking,
    payout,
    config,
    opening,
    concurrencyFixture,
    workerFixture,
    completeFixtureAdapter,
    unknownAckAdapter,
    unknownAckBaseline,
    unknownAckProxy,
    consolidated,
  ],
});
export const readRepairInput = (name) =>
  readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const hash = (source) => createHash('sha256').update(source).digest('hex');
export function candidateFunctionBodyMd5(sql, name) {
  assert.ok(
    [
      'fn_complete_club_opening_setup',
      'fn_publish_leaderboard_reward_program',
      'fn_payout_leaderboard',
    ].includes(name)
  );
  const header = `CREATE OR REPLACE FUNCTION public.${name}(`;
  assert.equal(sql.split(header).length, 2, 'Exactly one candidate function required');
  const matches = [
    ...sql.matchAll(
      new RegExp(
        `^CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\nAS \\$function\\$([\\s\\S]*?)^\\$function\\$;`,
        'gm'
      )
    ),
  ];
  assert.equal(matches.length, 1, 'Exact generated function body boundary required');
  return createHash('md5').update(matches[0][1]).digest('hex');
}
function transaction(source, ending) {
  assert.ok(source.endsWith(`${ending};\n`));
  assert.equal(source.match(new RegExp(`^${ending};$`, 'gm'))?.length, 1);
  assert.doesNotMatch(source, new RegExp(`^${ending === 'COMMIT' ? 'ROLLBACK' : 'COMMIT'};`, 'm'));
}

export function buildFinancialRepairCandidate(source, mode, readInput = readRepairInput) {
  assert.equal(hash(source), preflightHash, 'Reviewed maintained preflight changed');
  assert.ok(Object.hasOwn(modes, mode), 'Exactly one reviewed candidate mode required');
  const selectedInputs =
    mode === 'capture-compatibility' ? modes[mode] : [...modes[mode], postimage];
  for (const name of selectedInputs) {
    const input = readInput(name);
    assert.equal(hash(input), reviewed[name], `Reviewed candidate input changed: ${name}`);
    if (
      name === auth ||
      name === compatibility ||
      name === openingFixture ||
      name === workerFixture ||
      name === postimage
    )
      transaction(input, 'ROLLBACK');
    if (name === capture || name === concurrencyFixture) transaction(input, 'COMMIT');
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
  const checks = selectedInputs
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
  if (mode === 'historical-replay') {
    preparation = `${prepareCapture}
${prepareGenerator(ranking, 'ranking')}
${prepareGenerator(payout, 'payout')}
${prepareGenerator(config, 'config')}
${prepareGenerator(opening, 'opening')}
${prepareAuth}
opening_body=$(node "$here/leaderboard-financial-repair-integration-candidate.mjs" --body-md5 "$scratch/repair-opening.sql" fn_complete_club_opening_setup) || failure 'opening body identity preparation refused'
publish_body=$(node "$here/leaderboard-financial-repair-integration-candidate.mjs" --body-md5 "$scratch/repair-config.sql" fn_publish_leaderboard_reward_program) || failure 'publication body identity preparation refused'
payout_body=$(node "$here/leaderboard-financial-repair-integration-candidate.mjs" --body-md5 "$scratch/repair-payout.sql" fn_payout_leaderboard) || failure 'payout body identity preparation refused'
[[ "$opening_body" =~ ^[0-9a-f]{32}$ && "$publish_body" =~ ^[0-9a-f]{32}$ && "$payout_body" =~ ^[0-9a-f]{32}$ ]] || failure 'candidate body identity invalid'
cp "$scratch/repair-authorization.sql" "$scratch/repair-historical-before.sql" || failure 'historical bootstrap preparation failed'
printf '%s\\n' '\\set historical_before true' >>"$scratch/repair-historical-before.sql" || failure 'historical before selection failed'
cat "$here/${historicalFixture}" >>"$scratch/repair-historical-before.sql" || failure 'historical before input preparation failed'
printf '%s\\n' '\\set historical_before false' "\\set candidate_opening_body_md5 $opening_body" "\\set candidate_publish_body_md5 $publish_body" "\\set candidate_payout_body_md5 $payout_body" >"$scratch/repair-historical-after.sql" || failure 'historical after selection failed'
cat "$here/${historicalFixture}" >>"$scratch/repair-historical-after.sql" || failure 'historical after input preparation failed'`;
    invocation = [
      'historical-before',
      'capture',
      'ranking',
      'payout',
      'config',
      'opening',
      'historical-after',
    ]
      .map(invoke)
      .join('\n');
  } else if (mode === 'concurrency' || mode === 'unknown-ack') {
    const driverAdapter = mode === 'concurrency' ? concurrencyAdapter : unknownAckAdapter;
    preparation = `${prepareCapture}
${prepareGenerator(ranking, 'ranking')}
${prepareGenerator(payout, 'payout')}
${prepareGenerator(config, 'config')}
${prepareGenerator(opening, 'opening')}
${prepareAuth}
${prepareGenerator(completeFixtureAdapter, 'complete-companion')}
cat "$scratch/repair-authorization.sql" "$scratch/repair-complete-companion.sql" >"$scratch/repair-bootstrap.sql" || failure 'complete candidate bootstrap preparation failed'
node "$here/${driverAdapter}" >"$scratch/repair-driver-original.sh" || failure 'candidate driver preparation refused'
[[ "$(grep -c '^here=' "$scratch/repair-driver-original.sh")" == 1 ]] || failure 'candidate harness boundary changed'
# Fixed replacement only; no host path is interpolated into generated code.
# Keep this variable literal for expansion only by the owned child driver.
# shellcheck disable=SC2016
sed 's@^here=.*@here="\${LEADERBOARD_REPAIR_HARNESS:?}"@' "$scratch/repair-driver-original.sh" >"$scratch/repair-driver.sh" || failure 'private driver harness binding failed'
chmod 600 "$scratch/repair-driver-original.sh" "$scratch/repair-driver.sh" || failure 'private driver permissions unavailable'
bash -n "$scratch/repair-driver.sh" || failure 'candidate driver syntax refused'
shellcheck "$scratch/repair-driver.sh" || failure 'candidate driver safeguards refused'`;
    invocation = ['capture', 'ranking', 'payout', 'config', 'opening'].map(invoke).join('\n');
    // Concurrency consumes the parent's complete private bootstrap input.
    // Unknown-ack owns no setup, so its complete bootstrap runs explicitly.
    if (mode === 'unknown-ack') invocation += '\n' + invoke('bootstrap');
    invocation += `\nLEADERBOARD_REPAIR_HARNESS="$here" bash "$scratch/repair-driver.sh" "$container" "$scratch" || failure 'isolated prospective driver failed'`;
  } else if (mode === 'worker') {
    preparation = `${prepareCapture}
${prepareGenerator(ranking, 'ranking')}
${prepareGenerator(payout, 'payout')}
${prepareGenerator(config, 'config')}
${prepareGenerator(opening, 'opening')}
${prepareAuth}
# The unchanged whole-pinned companion owns the sole synthetic COMMIT.
cat "$scratch/repair-authorization.sql" "$here/${concurrencyFixture}" >"$scratch/repair-bootstrap.sql" || failure 'worker complete bootstrap preparation failed'
cp "$here/${workerFixture}" "$scratch/repair-fixture.sql" || failure 'worker fixture preparation failed'`;
    invocation = ['capture', 'ranking', 'payout', 'config', 'opening', 'bootstrap', 'fixture']
      .map(invoke)
      .join('\n');
  } else if (mode === 'v2-payout') {
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
    preparation = `${prepareCapture}
${prepareGenerator(ranking, 'ranking')}
${prepareGenerator(payout, 'payout')}
${prepareGenerator(config, 'config')}
${prepareGenerator(opening, 'opening')}
${prepareAuth}
cat "$scratch/repair-authorization.sql" "$here/${openingFixture}" >"$scratch/repair-fixture.sql" || failure 'opening complete input preparation failed'`;
    invocation = ['capture', 'ranking', 'payout', 'config', 'opening', 'fixture']
      .map(invoke)
      .join('\n');
  }
  if (mode !== 'capture-compatibility') {
    const splitInstall = ['capture', 'ranking', 'payout', 'config', 'opening']
      .map(invoke)
      .join('\n');
    assert.equal(
      invocation.split(splitInstall).length,
      2,
      'One complete install sequence required'
    );
    invocation = invocation.replace(
      splitInstall,
      [invoke('consolidated'), invoke('postimage')].join('\n')
    );
    preparation += `\nprintf '%s\\n' 'SET ROLE postgres;' >"$scratch/repair-consolidated.sql" || failure 'consolidated owner preparation failed'
node "$here/${consolidated}" >>"$scratch/repair-consolidated.sql" || failure 'exact consolidated migration preparation refused'
printf '%s\\n' 'RESET ROLE;' >>"$scratch/repair-consolidated.sql" || failure 'consolidated owner reset preparation failed'
[[ "$(tail -n 1 "$here/${postimage}")" == 'ROLLBACK;' && "$(grep -c '^ROLLBACK;$' "$here/${postimage}")" == 1 ]] || failure 'postimage terminal boundary changed'
cp "$here/${postimage}" "$scratch/repair-postimage.sql" || failure 'postimage private input preparation failed'`;
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
${
  mode === 'v2-payout' || mode === 'opening'
    ? `    if [[ "$stage" == fixture ]]; then
      node "$here/${repairDiagnostics}" '${mode}' "$scratch/repair-$stage.log" || failure 'prospective verdict evidence refused'
    fi`
    : ''
}
    printf 'Isolated Candidate Stage Completed: %s\\n' "$stage"
  else
    status=$?
${
  mode === 'v2-payout' || mode === 'opening'
    ? `    if [[ "$stage" == fixture ]]; then
      node "$here/${repairDiagnostics}" '${mode}' "$scratch/repair-$stage.log" || printf '%s\\n' 'Financial Repair Diagnostic: unknown; private evidence outside reviewed contract' >&2
    fi`
    : ''
}
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
    if (process.argv[2] === '--body-md5') {
      assert.equal(process.argv.length, 5);
      process.stdout.write(
        candidateFunctionBodyMd5(readFileSync(process.argv[3], 'utf8'), process.argv[4])
      );
    } else {
      assert.equal(process.argv.length, 3);
      process.stdout.write(
        buildFinancialRepairCandidate(
          readRepairInput('leaderboard-isolation-preflight.sh'),
          process.argv[2]
        )
      );
    }
  } catch {
    console.error('Isolated repair source preparation refused; no runtime qualification');
    process.exitCode = 1;
  }
}
