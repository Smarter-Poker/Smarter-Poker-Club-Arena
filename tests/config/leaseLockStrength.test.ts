import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { offenders } from '../../scripts/ci/check-lease-lock-strength.mjs';
const bad = 'SELECT 1 FROM public.engine_table_leases l FOR SHARE;';
const json = '$snapshot$' + JSON.stringify({ definition: bad }) + '$snapshot$::jsonb';
const record = fs.readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260912111633_cash_lease_canonical_ownership_and_heartbeat.sql'
  ),
  'utf8'
);
test('exact installed historical bytes are data, not unsafe executed locks', () => {
  assert.equal(
    createHash('sha256').update(record).digest('hex'),
    'ff0019970249c73395606aeb3a451003da558010d45147bdb51ea82d64d28cf9'
  );
  assert.equal(offenders(record).length, 0);
});
for (const rel of ['engine_table_leases', 'engine_tournament_leases'])
  test('actual top-level bad lock ' + rel, () =>
    assert.equal(offenders(`SELECT 1 FROM public.${rel} l FOR SHARE;`).length, 1)
  );
for (const lock of ['FOR KEY SHARE', 'FOR NO KEY UPDATE', 'FOR UPDATE'])
  test('legitimate lock ' + lock, () =>
    assert.equal(offenders(bad.replace('FOR SHARE', lock)).length, 0)
  );
for (const sql of [
  bad,
  `DO $do$ BEGIN PERFORM 1 FROM public.engine_table_leases FOR SHARE; END $do$;`,
  `CREATE FUNCTION f() RETURNS void AS $body$ BEGIN PERFORM 1 FROM public.engine_table_leases FOR SHARE; END $body$ LANGUAGE plpgsql;`,
  `CREATE FUNCTION f() RETURNS SETOF integer LANGUAGE sql AS $$ ${bad} $$;`,
  `DO $$ BEGIN EXECUTE $query$${bad}$query$; END $$;`,
])
  test('executable SQL remains refused ' + sql.slice(0, 30), () =>
    assert.equal(offenders(sql).length, 1)
  );
for (const tag of ['snapshot', 'expected', 'arbitrary_123', ''])
  test('typed JSON data regardless of tag ' + tag, () => {
    const q =
      '$' +
      tag +
      '$' +
      JSON.stringify({ definition: bad, nested: '-- comment /* text */' }) +
      '$' +
      tag +
      '$::jsonb';
    assert.equal(offenders(`DO $outer$ DECLARE v jsonb; BEGIN v := ${q}; END $outer$;`).length, 0);
  });
test('snapshot followed by actual bad SQL refuses', () =>
  assert.equal(
    offenders(
      `DO $outer$ DECLARE v jsonb; BEGIN v := ${json}; ${bad.replace('SELECT', 'PERFORM')} END $outer$;`
    ).length,
    1
  ));
test('installed record plus bad SQL refuses', () =>
  assert.equal(offenders(record + '\n' + bad).length, 1));
test('unsafe replacement of real safe lock in installed record refuses', () => {
  assert.ok(record.includes('FOR UPDATE;'));
  assert.equal(offenders(record.replace(/\n {3}FOR UPDATE;/, '\n   FOR SHARE;')).length, 1);
});
test('JSON cast supports json and pg_catalog qualified', () =>
  assert.equal(
    offenders('SELECT ' + json.replace('::jsonb', '::pg_catalog.json') + ';').length,
    0
  ));
test('unknown dollar string retains conservative detection', () =>
  assert.equal(offenders('SELECT $x$' + bad + '$x$;').length, 1));
test('malformed JSON is not masked', () =>
  assert.equal(offenders('SELECT $x$' + bad + '$x$::jsonb;').length, 1));
test('ordinary comment only remains ignored', () =>
  assert.equal(offenders('-- ' + bad + '\nSELECT 1;').length, 0));
test('quoted single literal remains ignored', () =>
  assert.equal(offenders("SELECT '" + bad + "';").length, 0));
test('OF another relation stays allowed and lease OF refuses', () => {
  const s =
    'SELECT 1 FROM public.tournaments t JOIN public.engine_table_leases l ON true FOR SHARE OF ';
  assert.equal(offenders(s + 't;').length, 0);
  assert.equal(offenders(s + 'l;').length, 1);
});
for (const expression of [
  '$j${"definition":"SELECT 1 FROM public.engine_table_leases l FOR SHARE;"}$j$::jsonb ->> \'definition\'',
  '$j$"SELECT 1 FROM public.engine_table_leases l FOR SHARE;"$j$::jsonb #>> \'{}\'',
  '$j${"definition":"SELECT 1 FROM public.engine_table_leases l FOR SHARE;"}$j$::pg_catalog.json ->> \'definition\'',
]) {
  test('EXECUTE extracted JSON remains visible ' + expression.slice(0, 20), () =>
    assert.equal(offenders('DO $body$ BEGIN EXECUTE (' + expression + '); END $body$;').length, 1)
  );
  test('top-level EXECUTE expression remains visible ' + expression.slice(0, 20), () =>
    assert.equal(offenders('EXECUTE (' + expression + ');').length, 1)
  );
}
test('JSON assignment before later EXECUTE stays conservative', () =>
  assert.equal(
    offenders(`DO $b$ DECLARE v jsonb; BEGIN v := ${json}; EXECUTE (v ->> 'definition'); END $b$;`)
      .length,
    1
  ));
test('EXECUTE format with semicolon string cannot reset statement context', () =>
  assert.equal(
    offenders(`DO $b$ BEGIN EXECUTE format('%s; SELECT 1;',(${json} ->> 'definition')); END $b$;`)
      .length,
    1
  ));
for (const suffix of ['$custom', 'é', '中', '_custom', '1', '𐀀'])
  test('unknown PostgreSQL type continuation ' + suffix, () =>
    assert.equal(offenders('SELECT ' + json + suffix + ';').length, 1)
  );
for (const type of ['json', 'jsonb', 'pg_catalog.json', 'pg_catalog.jsonb'])
  test('exact JSON type ' + type, () =>
    assert.equal(offenders('SELECT ' + json.replace('::jsonb', '::' + type) + ';').length, 0)
  );
test('comment ends at real newline before executable SQL', () =>
  assert.equal(offenders('-- explanation\n' + bad).length, 1));

for (const suffix of ['.custom', ' []', ' . custom'])
  test('non-scalar or further-qualified type refused ' + suffix, () =>
    assert.equal(offenders('SELECT ' + json + suffix + ';').length, 1)
  );
