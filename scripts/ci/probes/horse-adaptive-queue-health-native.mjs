import assert from 'node:assert/strict';

export async function exerciseQueueHealth({ c, readHealth }) {
  // Isolated fixture only. Create exact queue-state combinations without
  // manufacturing a production batch or claiming they are accepted actions.
  await c.query('TRUNCATE horse_adaptive_journal_work');
  const empty = await readHealth();
  assert.equal(empty.status, 'snapshot');
  assert.equal(empty.unfinished, 0);
  await c.query(`INSERT INTO horse_adaptive_journal_work(batch_key,batch_digest,observations,payload,state,available_at,created_at,lease_token,lease_until,attempts,completed_at) VALUES
    (repeat('1',64),repeat('a',64),0,'queued','queued',clock_timestamp()-interval '1 second',clock_timestamp()-interval '2 minutes',NULL,NULL,2,NULL),
    (repeat('2',64),repeat('b',64),0,'wait','queued',clock_timestamp()+interval '1 minute',clock_timestamp(),NULL,NULL,0,NULL),
    (repeat('3',64),repeat('c',64),0,'expired','leased',clock_timestamp(),clock_timestamp(),gen_random_uuid(),clock_timestamp()-interval '1 second',4,NULL),
    (repeat('4',64),repeat('d',64),0,'active','leased',clock_timestamp(),clock_timestamp(),gen_random_uuid(),clock_timestamp()+interval '1 minute',1,NULL),
    (repeat('5',64),repeat('e',64),0,'quarantine','quarantined',clock_timestamp(),clock_timestamp(),NULL,NULL,6,NULL),
    (repeat('6',64),repeat('f',64),0,NULL,'completed',clock_timestamp(),clock_timestamp(),NULL,NULL,1,clock_timestamp())`);
  await c.query('SET ROLE service_role');
  const sample = await readHealth();
  await c.query('RESET ROLE');
  assert.equal(sample.status, 'snapshot');
  assert.deepEqual(
    [
      sample.unfinished,
      sample.queued,
      sample.leased,
      sample.quarantined,
      sample.ready,
      sample.expiredLeases,
      sample.bufferedBytes,
      sample.maxAttempts,
    ],
    [5, 2, 2, 1, 2, 1, 33, 6]
  );
  assert.ok(sample.oldestWorkAgeMs >= 120000);
  const result = [
    {
      case: 'global queue health separates delayed/ready work, active/expired leases and quarantine, excludes completed history and returns only bounded aggregates',
      passed: true,
    },
  ];
  for (const role of ['anon', 'authenticated']) {
    await c.query('SET ROLE ' + role);
    await assert.rejects(
      c.query('SELECT fn_horse_adaptive_journal_work_health()'),
      (e) => e.code === '42501'
    );
    await c.query('RESET ROLE');
  }
  await c.query('TRUNCATE horse_adaptive_journal_work');
  await c.query(
    "INSERT INTO horse_adaptive_journal_work(batch_key,batch_digest,observations,payload) SELECT lpad(to_hex(n),64,'0'),repeat('a',64),0,'x' FROM generate_series(1,257)n"
  );
  assert.deepEqual(await readHealth(), { status: 'unavailable', reason: 'queue_budget_exceeded' });
  await c.query('TRUNCATE horse_adaptive_journal_work');
  await c.query(
    "INSERT INTO horse_adaptive_journal_work(batch_key,batch_digest,observations,payload) SELECT lpad(to_hex(n),64,'0'),repeat('a',64),0,repeat('x',14000000) FROM generate_series(1,5)n"
  );
  assert.deepEqual(await readHealth(), { status: 'unavailable', reason: 'queue_budget_exceeded' });
  result.push({
    case: 'row and byte budget violations are explicitly unavailable, never a truncated empty/healthy sample; app roles cannot call health RPC',
    passed: true,
  });
  await c.query('TRUNCATE horse_adaptive_journal_work');
  return result;
}
