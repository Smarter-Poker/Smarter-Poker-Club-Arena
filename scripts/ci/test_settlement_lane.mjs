import pg from 'pg';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withSettlementLane } from './settlement-lane.mjs';
if (process.env.PGHOST !== '127.0.0.1') throw new Error('Isolated loopback fixture required');
const options = {
  ssl: { rejectUnauthorized: true, ca: readFileSync(process.env.PGSSLROOTCERT, 'utf8') },
};
const a = new pg.Client(options),
  b = new pg.Client(options);
await a.connect();
await b.connect();
try {
  await a.query('CREATE TABLE lane_fixture(id integer)');
  await a.query('BEGIN; SELECT pg_advisory_xact_lock_shared(530090,1)');
  let sent = false;
  await assert.rejects(
    withSettlementLane(b, async () => {
      sent = true;
    }),
    (e) => e.code === '57014'
  );
  assert.equal(sent, false);
  await a.query('ROLLBACK');
  await withSettlementLane(b, async () => {
    assert.equal(
      (await a.query('SELECT pg_try_advisory_xact_lock_shared(530090,1) held')).rows[0].held,
      false
    );
    await b.query('BEGIN; INSERT INTO lane_fixture VALUES(1); COMMIT');
    assert.equal(
      (await a.query('SELECT pg_try_advisory_xact_lock_shared(530090,1) held')).rows[0].held,
      false
    );
  });
  assert.equal(
    (await a.query('SELECT pg_try_advisory_xact_lock_shared(530090,1) held')).rows[0].held,
    true
  );
  await assert.rejects(
    withSettlementLane(b, () =>
      b.query('BEGIN; INSERT INTO lane_fixture VALUES(2); SELECT 1/0; COMMIT')
    ),
    (e) => e.code === '22012'
  );
  assert.equal(
    (await a.query('SELECT pg_try_advisory_xact_lock_shared(530090,1) held')).rows[0].held,
    true
  );
  assert.equal((await a.query('SELECT count(*)::int n FROM lane_fixture')).rows[0].n, 1);
  console.log(
    'PASS bounded admission timeout, money blocking through COMMIT, success/refusal release, rollback'
  );
} finally {
  await a.end();
  await b.end();
}
