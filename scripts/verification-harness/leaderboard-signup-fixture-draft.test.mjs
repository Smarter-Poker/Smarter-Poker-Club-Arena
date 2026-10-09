import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateFixture } from './leaderboard-signup-fixture-draft.mjs';
const ids = Array.from(
  { length: 5 },
  (_, i) => `99000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`
);
test('actual signup IDs replace all fixture actors without auth writes or saved programs', () => {
  const sql = generateFixture(ids);
  for (const id of ids) assert.ok(sql.includes(id));
  assert.ok(!sql.includes('90000000-0000-4000-8000-'));
  assert.match(sql, /fn_ca_burn/);
  assert.match(sql, /fn_join_club/);
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM public\.ca_mint_policy\)/);
  assert.match(sql, /VALUES \(1, 100000, 300000, 1, 1,/);
  assert.ok(sql.indexOf('DO $mint_policy$') < sql.indexOf('INSERT INTO public.clubs'));
  assert.match(sql, /FULL JOIN signup_fixture_identity/);
  assert.ok(!/fn_save_leaderboard|fn_publish_leaderboard|INSERT INTO auth\.users/.test(sql));
  assert.ok(sql.endsWith('COMMIT;\n'));
});
test('invalid, duplicate and excess identities are refused', () => {
  for (const input of [
    [],
    [...ids, ids[0]],
    ids.map(() => ids[0]),
    ["x'; COMMIT; --", ...ids.slice(1)],
  ])
    assert.throws(() => generateFixture(input));
});
test('template boundary duplication or body drift refuses generation', () => {
  const source = readFileSync(
    new URL('./leaderboard-isolated-authorization-draft.sql', import.meta.url),
    'utf8'
  );
  assert.throws(() =>
    generateFixture(ids, source.replace('VALUES (1, 100000,', 'VALUES (1, 100001,'))
  );
  assert.throws(() => generateFixture(ids, source.replace('300000, 1, 1', '300001, 1, 1')));
  assert.throws(() => generateFixture(ids, source + '\nDO $matrix$'));
});

test('actual signup and all financial actors use the existing certification domain', () => {
  const sql = generateFixture(ids);
  for (let i = 1; i <= 5; i++) assert.ok(sql.includes(`lb-real-auth-${i}@smarter-poker.invalid`));
  for (const file of [
    'leaderboard-real-auth-launcher-draft.mjs',
    'leaderboard-real-auth-draft.mjs',
    'leaderboard-isolated-authorization-draft.sql',
  ]) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.ok(text.includes('@smarter-poker.invalid'), file);
    assert.ok(!text.includes('@example.invalid'), file);
  }
  assert.match(sql, /SELECT count\(\*\) FROM public\.profiles\) <> 5/);
  assert.match(sql, /EXISTS \(SELECT 1 FROM public\.signup_errors\)/);
});
