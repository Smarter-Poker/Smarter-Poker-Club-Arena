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

test('schema-only fixture restores authoritative journal policy before intact opening grants', () => {
  const sql = generateFixture(ids);
  const owner = readFileSync(
    new URL(
      '../../supabase/migrations/20260911161027_the_supply_meter_counts_the_tickets_it_issued.sql',
      import.meta.url
    ),
    'utf8'
  );
  const start = owner.indexOf(
    'INSERT INTO public.ca_chip_store_coverage (store, treatment, counted_by, notes) VALUES'
  );
  const end = owner.indexOf('ON CONFLICT (store) DO NOTHING;', start);
  assert.ok(start >= 0 && end > start);
  assert.ok(sql.includes(owner.slice(start, end).trim() + ';'));
  assert.ok(
    sql.indexOf('INSERT INTO public.ca_chip_store_coverage') <
      sql.indexOf('INSERT INTO public.clubs')
  );
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM public\.ca_chip_store_coverage\)/);
  assert.match(sql, /count\(\*\) FROM public\.ca_chip_store_coverage\) <> 25/);
  assert.match(sql, /40b1c33a12d5b5e84c69844054b7514d/);
  assert.match(
    sql,
    /INSERT INTO public\.clubs \(id, name, owner_id, is_union, union_id, chip_treasury\)/
  );
  assert.equal((sql.match(/(?:true|false), NULL, 0\)/g) || []).length, 3);
  assert.match(sql, /DO \$opening_balances\$/);
  assert.match(sql, /chip_treasury=100000\) <> 2/);
  assert.ok(!/DISABLE TRIGGER|ledger_autoskip|session_replication_role/i.test(sql));
});

test('opening and retirement journal actors are actual generated signup identities', () => {
  const sql = generateFixture(ids);
  const claims = `'{"sub":"${ids[0]}","role":"service_role"}'`;
  assert.equal(sql.split(claims).length - 1, 2);
  assert.ok(sql.indexOf(claims) < sql.indexOf('INSERT INTO public.clubs'));
  assert.equal(sql.split(`'request.jwt.claim.sub', '${ids[0]}', true`).length - 1, 2);
  assert.ok(!sql.includes("'request.jwt.claim.sub', '', true"));
  assert.ok(!sql.includes('2d1cd6c3-5700-4af9-a271-d4863fdab20d'));
});

test('club opening declarations are consumed in three separate statements before commit', () => {
  const sql = generateFixture(ids);
  const section = sql.slice(
    sql.indexOf('-- Create each club'),
    sql.indexOf('DO $opening_balances$')
  );
  const statements = section.split(';').filter((part) => part.includes('INSERT INTO public.clubs'));
  assert.equal(statements.length, 3);
  for (const statement of statements) {
    assert.equal((statement.match(/INSERT INTO public\.clubs/g) || []).length, 1);
    assert.equal((statement.match(/(?:true|false), NULL, 0\)/g) || []).length, 1);
  }
  assert.equal((sql.match(/ISOLATED_AUTH_FIXTURE_STAGE=club-create/g) || []).length, 1);
  assert.ok(sql.indexOf('SET CONSTRAINTS ALL IMMEDIATE;') < sql.lastIndexOf('COMMIT;'));
  assert.ok(!/DISABLE TRIGGER|ledger_autoskip|session_replication_role/i.test(sql));
});
