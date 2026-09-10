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
try {
  assert.equal(
    (await db.query("SELECT inet_server_addr() IS NULL AND current_database()='payer_test' ok"))
      .rows[0].ok,
    true
  );
  const original = (
    await db.query(readFileSync(new URL('carry-counterexample.sql', import.meta.url), 'utf8'))
  ).rows[0];
  assert.equal(Number(original.independent_window_cash), 0);
  assert.equal(original.original_bank_windows, 2);
  assert.equal(original.earning_weeks, 1);
  assert.equal(original.cumulative_pool.club_exact, 0.018);
  assert.equal(original.cumulative_pool.released, 0.01);
  assert.equal(original.cumulative_pool.agent_cash, 0.01);
  assert.equal(original.cumulative_pool.player_cash, 0.01);
  const separation = (
    await db.query(`SELECT floor(sum(exact_amount)*100)/100 released FROM
 (VALUES('club-a','union-a','union_rake_wallet',1,.009::numeric),
 ('club-a','union-b','union_rake_wallet',1,.009::numeric),
 ('club-a',NULL,'club_chip_treasury',1,.009::numeric),
 ('club-b','union-a','union_rake_wallet',1,.009::numeric),
 ('club-a','union-a','union_rake_wallet',2,.009::numeric)) x(club_id,union_id,route,generation,exact_amount)
 GROUP BY club_id,union_id,route,generation`)
  ).rows;
  assert.equal(separation.length, 5);
  assert(separation.every((x) => Number(x.released) === 0));
  const slices = (
    await db.query(`SELECT .007::numeric+.003::numeric=.01::numeric AS agent_cash,
 .006::numeric+.004::numeric=.01::numeric AS player_cash,
 .007::numeric<=.007::numeric AND .003::numeric<=.007::numeric AS agent_own_rights,
 .006::numeric<=.006::numeric AND .004::numeric<=.006::numeric AS player_own_rights,
 .01::numeric<=floor((.009::numeric+.009::numeric)*100)/100 AS released_capacity`)
  ).rows[0];
  assert(Object.values(slices).every(Boolean));
  const inputs = Object.fromEntries(
    ['run-counterexample.sh', 'carry-counterexample.mjs', 'carry-counterexample.sql'].map(
      (name) => [
        name,
        createHash('sha256')
          .update(readFileSync(new URL(name, import.meta.url)))
          .digest('hex'),
      ]
    )
  );
  const proof = {
    captured_at: new Date().toISOString(),
    scope:
      'Native NUMERIC counterexample and allocation arithmetic only. No actual bank, Round1 money writer or capacity-owner constraints executed.',
    runtime: { node: process.version, postgres: (await db.query('SELECT version() v')).rows[0].v },
    inputs,
    passed: 3,
    original,
    separation,
    slices,
  };
  writeFileSync(
    new URL('carry-counterexample-proof.json', import.meta.url),
    JSON.stringify(proof, null, 2) + '\n'
  );
  console.log(
    JSON.stringify({
      passed: 3,
      independent_window_cash: original.independent_window_cash,
      cumulative_cash: original.cumulative_pool.released,
    })
  );
} finally {
  await db.end();
}
