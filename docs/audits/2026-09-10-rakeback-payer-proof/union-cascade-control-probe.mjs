import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const { Client } = createRequire(import.meta.url)('pg');
assert.match(process.env.PGHOST || '', /^\/tmp\/ca-rakeback-payer\.[A-Za-z0-9]+$/);
const db = new Client({
  host: process.env.PGHOST,
  port: 55473,
  user: 'postgres',
  database: 'payer_test',
});
await db.connect();
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
assert.equal(
  (await q("SELECT inet_server_addr() IS NULL AND current_database()='payer_test' local_only"))[0]
    .local_only,
  true
);
await q("SELECT set_config('request.jwt.claim.role','service_role',false)");
const call = async () =>
  (
    await q(
      "SELECT fn_union_settlement_cascade('00000000-0000-4000-8000-000000900001','2026-08-31T07:00Z','2026-09-07T07:00Z') r"
    )
  )[0].r;
const r2 = { amount: 70, payees: 1, shortfalls: 0 };
const r3 = { amount: 15, payees: 1, shortfalls: 0, source_final: false };
const results = [];
async function reset(a = r2, b = r3, fail = false) {
  await q('DELETE FROM ca_cascade_probe_effects');
  await q('DELETE FROM union_settlement_rounds');
  await q('UPDATE ca_cascade_probe_config SET r2=$1,r3=$2,assert_fails=$3', [a, b, fail]);
}
async function snapshot() {
  const state = {};
  for (const { tablename } of await q(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
  )) {
    assert.match(tablename, /^[a-z_][a-z_0-9]*$/);
    state[tablename] = (
      await q(
        "SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') rows FROM " +
          tablename +
          ' t'
      )
    )[0].rows;
  }
  return state;
}
async function test(name, fn) {
  await fn();
  results.push({ name, pass: true });
  console.log('PASS ' + name);
}
async function rollbackCase(name, a, b, fail, code) {
  await test(name, async () => {
    await reset(a, b, fail);
    const before = await snapshot();
    await assert.rejects(call(), (e) => e.code === code);
    assert.deepEqual(await snapshot(), before);
  });
}
try {
  await test('exact outer provisional path invokes conservation before withholding settlement', async () => {
    await reset();
    const r = await call();
    assert.equal(r.error, 'source_finality_pending');
    assert.deepEqual(
      (await q('SELECT kind FROM ca_cascade_probe_effects ORDER BY kind')).map((x) => x.kind),
      ['assert', 'round1', 'round2', 'round3']
    );
  });
  await test('valid shortfall preserves executed synthetic round effects only after conservation', async () => {
    await reset({ ...r2, shortfalls: 1 });
    const r = await call();
    assert.equal(r.error, 'recipient_shortfalls_remaining');
    assert.equal(
      (await q("SELECT count(*)::int n FROM ca_cascade_probe_effects WHERE kind='assert'"))[0].n,
      1
    );
    assert.equal(
      (await q("SELECT count(*)::int n FROM ca_cascade_probe_effects WHERE kind='settled'"))[0].n,
      0
    );
  });
  await rollbackCase(
    'missing Round2 amount rolls earlier round and audit rows back',
    { payees: 1, shortfalls: 0 },
    r3,
    false,
    '23514'
  );
  await rollbackCase(
    'explicit failed Round2 rolls earlier round and audit rows back',
    { ...r2, success: false, error: 'synthetic_failure' },
    r3,
    false,
    '23514'
  );
  await rollbackCase(
    'missing Round3 payees rolls all prior round and audit rows back',
    r2,
    { amount: 15, shortfalls: 0 },
    false,
    '23514'
  );
  await rollbackCase(
    'explicit failed Round3 rolls all prior round and audit rows back',
    r2,
    { ...r3, success: false, error: 'synthetic_failure' },
    false,
    '23514'
  );
  await rollbackCase(
    'invalid Round2 numeric cast rolls effects back before contract branch',
    { ...r2, amount: 'invalid' },
    r3,
    false,
    '22P02'
  );
  await rollbackCase(
    'invalid Round3 numeric cast rolls effects back before contract branch',
    r2,
    { ...r3, shortfalls: 'invalid' },
    false,
    '22P02'
  );
  await rollbackCase(
    'conservation failure on valid shortfall rolls effects and receipts back',
    { ...r2, shortfalls: 1 },
    r3,
    true,
    '23514'
  );
  await test('exact definition guard rejects repeated patch without modifying the outer function', async () => {
    const before = (
      await q(
        "SELECT md5(prosrc) hash FROM pg_proc WHERE oid='fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure"
      )
    )[0].hash;
    await assert.rejects(
      q(readFileSync(new URL('union-cascade-source-boundary.sql', import.meta.url), 'utf8'))
    );
    await q('ROLLBACK');
    assert.equal(
      (
        await q(
          "SELECT md5(prosrc) hash FROM pg_proc WHERE oid='fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure"
        )
      )[0].hash,
      before
    );
  });
  const names = [
    'fixture.sql',
    'money-guards.sql',
    'source-facts-schema-fixture.sql',
    'source-payer-proposal.sql',
    'source-payer-wrappers.sql',
    'union-auth-fixture.sql',
    'union-cascade-installed.sql',
    'union-cascade-source-boundary.sql',
    'union-cascade-control-fixture.sql',
    'union-cascade-control-probe.mjs',
    'run-local.sh',
  ];
  const inputs = Object.fromEntries(
    names.map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(new URL(name, import.meta.url)))
        .digest('hex'),
    ])
  );
  writeFileSync(
    new URL('union-cascade-control-proof.json', import.meta.url),
    JSON.stringify(
      {
        captured_at: new Date().toISOString(),
        scope:
          'Exact captured outer control flow only, synthetic round effects and conservation dependency. Not actual money, full owner, bank funding, or Union settlement proof.',
        runtime: { node: process.version, postgres: (await q('SELECT version() v'))[0].v },
        inputs,
        passed: results.length,
        results,
      },
      null,
      2
    ) + '\n'
  );
} finally {
  await db.end();
}
