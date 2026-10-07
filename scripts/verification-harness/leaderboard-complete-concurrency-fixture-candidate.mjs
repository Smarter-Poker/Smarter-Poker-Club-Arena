// UNQUALIFIED source-only adapter. Emits SQL; never invokes a database.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const hash = (input) => createHash('sha256').update(input).digest('hex');
export function buildCompleteConcurrencyFixture(
  source = read('leaderboard-isolated-concurrency-fixture-draft.sql'),
  captureFixture = read('leaderboard-isolated-worker-regression-candidate.sql')
) {
  assert.equal(hash(source), 'c2057bbbbb9b08c860ac82cf02e98171ff9188ab36694dcb672f1abd3f37ed41');
  assert.equal(
    hash(captureFixture),
    '2dada967cdb8bff98c8f8904f3b4d99e0a64eb67eba76a0ff4787236a92d4163'
  );
  const marker = '  -- Synthetic historical complete captures are not historical producer proof.\n';
  assert.equal(captureFixture.split(marker).length, 2);
  const inserts = captureFixture.split(marker)[1].split('  SET LOCAL ROLE service_role;')[0];
  assert.ok(inserts.includes('INSERT INTO public.leaderboard_capture_counters'));
  assert.ok(source.endsWith('SET CONSTRAINTS ALL IMMEDIATE;\nCOMMIT;\n'));
  assert.equal(source.match(/^COMMIT;$/gm)?.length, 1);
  assert.doesNotMatch(source, /^ROLLBACK;$/m);
  const addition = `DO $complete_captures$ BEGIN
  IF EXISTS(SELECT 1 FROM public.leaderboard_basis_existing_clubs)
    OR EXISTS(SELECT 1 FROM public.leaderboard_complete_captures)
    OR EXISTS(SELECT 1 FROM public.leaderboard_capture_counters) THEN
    RAISE EXCEPTION 'Exact empty V2 synthetic capture preimage required';
  END IF;
${inserts}END $complete_captures$;
`;
  return source.replace(
    'SET CONSTRAINTS ALL IMMEDIATE;\nCOMMIT;\n',
    addition + 'SET CONSTRAINTS ALL IMMEDIATE;\nCOMMIT;\n'
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 2);
    process.stdout.write(buildCompleteConcurrencyFixture());
  } catch {
    console.error('Complete concurrency fixture preparation refused');
    process.exitCode = 1;
  }
}
