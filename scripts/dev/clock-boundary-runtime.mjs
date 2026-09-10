import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const host = process.env.POKER_CLOCK_PROBE_SOCKET;
assert.ok(
  host?.startsWith('/var/folders/') ||
    host?.startsWith('/private/var/folders/') ||
    host?.startsWith('/tmp/')
);
const config = {
  host,
  port: Number(process.env.POKER_CLOCK_PROBE_PORT),
  database: 'postgres',
  statement_timeout: 8000,
};
const clients = await Promise.all(
  ['observer', 'member', 'publisher'].map(async (name) => {
    const c = new Client({ ...config, application_name: 'clock-boundary-' + name });
    await c.connect();
    return c;
  })
);
const [o, a, b] = clients;
const e = '11111111-1111-4111-8111-111111111111',
  e2 = '22222222-2222-4222-8222-222222222222';
const t = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  t2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const op = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  op2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const evidence = [];
const q = (c, s, p = []) => c.query(s, p);
const one = async (c, s, p = []) => (await q(c, s, p)).rows[0];
const publish = (c, delta = 1, operation = op, event = e) =>
  q(c, 'SELECT audit_clock_publish($1,$2,$3) AS outcome', [event, operation, delta]);
async function reset({ inactive = false, open = false } = {}) {
  await Promise.all([q(a, 'ROLLBACK'), q(b, 'ROLLBACK')]);
  await q(o, 'ALTER TABLE tables ENABLE TRIGGER a0_tournament_clock_membership_gate');
  await q(
    o,
    'TRUNCATE tables,tournaments,tournament_table_origins,tournament_launch_receipts,audit_clock_publications,audit_clock_operations,audit_clock_trace,audit_clock_paid_entry'
  );
  await q(
    o,
    'UPDATE audit_clock_wallet SET balance=100;UPDATE audit_clock_freeze SET frozen=false'
  );
  await q(
    o,
    "INSERT INTO tournaments(id,level_started_at) VALUES($1,'2026-09-10 00:00Z'),($2,'2026-09-10 00:00Z')",
    [e, e2]
  );
  await q(o, 'INSERT INTO tournament_launch_receipts VALUES($1,$3,$3,now()),($2,$3,$3,now())', [
    e,
    e2,
    op,
  ]);
  await q(o, 'INSERT INTO tables(id,tournament_id,status) VALUES($1,$2,$3)', [
    t,
    e,
    open ? 'running' : 'closed',
  ]);
  if (inactive) await q(o, 'INSERT INTO audit_clock_publications VALUES($1,false,0)', [e]);
}
async function refuses(c, sql, params, code, label) {
  try {
    await q(c, sql, params);
    assert.fail(label + ' unexpectedly accepted');
  } catch (err) {
    assert.equal(err.code, code, label + ': ' + err.message);
  }
}
async function waitBlocked(c, blocker, label) {
  const start = Date.now();
  while (Date.now() - start < 2500) {
    const row = await one(
      o,
      'SELECT wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1',
      [c.processID]
    );
    if (row?.wait_event_type === 'Lock' && row.blockers.includes(blocker.processID)) {
      evidence.push({ barrier: label, wait_event: row.wait_event });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(label + ' did not reach an observed lock wait');
}
async function check(name, run) {
  await run();
  evidence.push({ case: name, pass: true });
}
try {
  await check('Captured Launch And Durable Evidence Bodies Are Exact', async () => {
    const capture = JSON.parse(
      fs.readFileSync(
        new URL('../../docs/audits/2026-09-10-k01-clock-membership-catalog.json', import.meta.url)
      )
    );
    for (const f of capture.functions) {
      const row = await one(
        o,
        'SELECT md5(prosrc) AS md5 FROM pg_proc WHERE oid=$1::regprocedure',
        [f.signature]
      );
      assert.equal(row.md5, f.body_md5);
    }
    const first = await one(
      o,
      "SELECT tgname FROM pg_trigger WHERE tgrelid='tables'::regclass AND NOT tgisinternal AND (tgtype&2)=2 ORDER BY tgname LIMIT 1"
    );
    assert.equal(first.tgname, 'a0_tournament_clock_membership_gate');
  });
  await check('Baseline Reproduces Inactive Reopen Outside Activation Scan', async () => {
    await reset();
    await q(o, 'ALTER TABLE tables DISABLE TRIGGER a0_tournament_clock_membership_gate');
    await q(a, 'BEGIN');
    await q(a, "UPDATE tables SET status='waiting',small_blind=1,big_blind=2 WHERE id=$1", [t]);
    await publish(b);
    await q(a, 'COMMIT');
    const r = await one(
      o,
      'SELECT t.big_blind AS table_blind,p.big_blind AS parent_blind FROM tables t JOIN tournaments p ON p.id=t.tournament_id WHERE t.id=$1',
      [t]
    );
    assert.equal(Number(r.table_blind), 2);
    assert.equal(Number(r.parent_blind), 40);
  });
  for (const inactive of [false, true]) {
    await check(
      (inactive ? 'Inactive' : 'Absent') + ' Publication Reopen Serializes Before First Activation',
      async () => {
        await reset({ inactive });
        await q(a, 'BEGIN');
        await q(a, "UPDATE tables SET status='waiting',small_blind=1,big_blind=2 WHERE id=$1", [t]);
        const pending = publish(b);
        await waitBlocked(
          b,
          a,
          'activation waits for ' + (inactive ? 'inactive' : 'absent') + ' membership gate'
        );
        await q(a, 'COMMIT');
        await pending;
        const r = await one(o, 'SELECT big_blind FROM tables WHERE id=$1', [t]);
        assert.equal(Number(r.big_blind), 40);
      }
    );
  }
  await check('Activated Insert Derives Current Blinds', async () => {
    await reset();
    await publish(b);
    await q(a, 'INSERT INTO tables(id,tournament_id,small_blind,big_blind) VALUES($1,$2,1,2)', [
      t2,
      e,
    ]);
    assert.equal(
      Number((await one(o, 'SELECT big_blind FROM tables WHERE id=$1', [t2])).big_blind),
      40
    );
  });
  await check('Activation First Refuses Whole Conflicting Entry Transaction', async () => {
    await reset();
    await q(b, 'BEGIN');
    await publish(b);
    await q(a, 'BEGIN');
    await q(a, 'UPDATE audit_clock_wallet SET balance=balance-10');
    await q(a, 'INSERT INTO audit_clock_paid_entry VALUES($1,10)', [op2]);
    await refuses(
      a,
      "UPDATE tables SET status='waiting',big_blind=2 WHERE id=$1",
      [t],
      '40001',
      'early event gate'
    );
    await q(a, 'ROLLBACK');
    await q(b, 'COMMIT');
    assert.equal(Number((await one(o, 'SELECT balance FROM audit_clock_wallet')).balance), 100);
    assert.equal((await one(o, 'SELECT count(*)::int AS n FROM audit_clock_paid_entry')).n, 0);
  });
  await check('Absent Publication Legacy Parent Write Holds Activation Barrier', async () => {
    await reset();
    await q(a, 'BEGIN');
    await q(a, "UPDATE tournaments SET level_started_at='2026-09-10 00:01Z' WHERE id=$1", [e]);
    const pending = publish(b, 0);
    await waitBlocked(b, a, 'adopt waits for legacy anchor write');
    await q(a, 'COMMIT');
    await pending;
    assert.equal(
      (
        await one(o, 'SELECT level_started_at FROM tournaments WHERE id=$1', [e])
      ).level_started_at.toISOString(),
      '2026-09-10T00:01:00.000Z'
    );
    await refuses(
      a,
      "UPDATE tournaments SET level_started_at='2026-09-10 00:02Z' WHERE id=$1",
      [e],
      '55000',
      'active legacy anchor'
    );
  });
  await check('Existing Launch Receipt Inversion Escapes Before Parent Wait', async () => {
    await reset({ open: true });
    await q(a, 'BEGIN');
    await q(a, 'SELECT 1 FROM tournament_launch_receipts WHERE tournament_id=$1 FOR UPDATE', [e]);
    const pending = publish(b);
    await waitBlocked(b, a, 'publisher waits for existing launch receipt');
    await refuses(
      a,
      'UPDATE tournaments SET current_level=current_level WHERE id=$1',
      [e],
      '40001',
      'launch owner takes event gate'
    );
    await q(a, 'ROLLBACK');
    await pending;
  });
  await check('Parent First Capacity Escapes Before Existing Launch Trigger', async () => {
    await reset({ open: true });
    await q(a, 'BEGIN');
    await q(a, 'SELECT 1 FROM tournaments WHERE id=$1 FOR UPDATE', [e]);
    const pending = publish(b);
    await waitBlocked(b, a, 'publisher waits for legacy parent');
    await refuses(
      a,
      'INSERT INTO tables(id,tournament_id) VALUES($1,$2)',
      [t2, e],
      '40001',
      'capacity early guard'
    );
    await q(a, 'ROLLBACK');
    await pending;
  });
  await check('Child First Close Escapes Before Any Parent Wait', async () => {
    await reset({ open: true });
    await q(a, 'BEGIN');
    await q(a, 'SELECT 1 FROM tables WHERE id=$1 FOR UPDATE', [t]);
    const pending = publish(b);
    await waitBlocked(b, a, 'publisher waits for existing child row');
    await refuses(
      a,
      "UPDATE tables SET status='closed' WHERE id=$1",
      [t],
      '40001',
      'child close early guard'
    );
    await q(a, 'ROLLBACK');
    await pending;
  });
  await check('Inactive Gate Also Refuses Occupied Publication And Parent Rows', async () => {
    await reset({ inactive: true });
    await q(a, 'BEGIN');
    await q(a, 'SELECT 1 FROM audit_clock_publications WHERE tournament_id=$1 FOR UPDATE', [e]);
    await refuses(
      b,
      "UPDATE tables SET status='waiting' WHERE id=$1",
      [t],
      '40001',
      'publication inversion'
    );
    await q(a, 'ROLLBACK');
    await q(a, 'BEGIN');
    await q(a, 'SELECT 1 FROM tournaments WHERE id=$1 FOR UPDATE', [e]);
    await refuses(
      b,
      "UPDATE tables SET status='waiting' WHERE id=$1",
      [t],
      '40001',
      'parent inversion'
    );
    await q(a, 'ROLLBACK');
  });
  await check('Every Reassignment Direction Preserves Existing Immutability', async () => {
    await reset({ open: true });
    await q(o, 'INSERT INTO tables(id) VALUES($1)', [t2]);
    for (const [id, event] of [
      [t, e2],
      [t, null],
      [t2, e],
    ])
      await refuses(
        a,
        'UPDATE tables SET tournament_id=$1 WHERE id=$2',
        [event, id],
        '55000',
        'membership identity'
      );
    await refuses(a, 'DELETE FROM tables WHERE id=$1', [t], '55000', 'durable deletion');
  });
  await check('Terminal Close Cannot Reopen Or Revive', async () => {
    await reset({ open: true });
    await q(o, "UPDATE tournaments SET status='COMPLETED',ended_at=now() WHERE id=$1", [e]);
    await q(
      o,
      "UPDATE tables SET status='closed',lifecycle='closed',current_players=0 WHERE id=$1",
      [t]
    );
    await refuses(
      a,
      "UPDATE tables SET status='waiting',lifecycle='waiting' WHERE id=$1",
      [t],
      '55000',
      'terminal reopen'
    );
  });
  await check('Replay Original Remains Separate From Current Level', async () => {
    await reset({ open: true });
    await publish(a);
    await publish(a, 1, op2);
    const { outcome } = await one(a, 'SELECT audit_clock_publish($1,$2,1) AS outcome', [e, op]);
    assert.equal(outcome.original.level, 2);
    assert.equal(outcome.current.current_level, 3);
    await refuses(a, 'SELECT audit_clock_publish($1,$2,2)', [e, op], '22023', 'conflicting replay');
  });
  await check('Last Table Failure Rolls Back Parent Tables Activation And Receipt', async () => {
    await reset({ open: true });
    await q(o, 'INSERT INTO tables(id,tournament_id) VALUES($1,$2)', [t2, e]);
    await q(
      o,
      "CREATE FUNCTION audit_clock_fail_last() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.id='" +
        t2 +
        "' THEN RAISE EXCEPTION 'injected last table failure'; END IF;RETURN NEW;END$$;CREATE TRIGGER zzzz_clock_last_failure BEFORE UPDATE ON tables FOR EACH ROW EXECUTE FUNCTION audit_clock_fail_last()"
    );
    await refuses(a, 'SELECT audit_clock_publish($1,$2,1)', [e, op], 'P0001', 'last table');
    assert.equal(
      (await one(o, 'SELECT current_level FROM tournaments WHERE id=$1', [e])).current_level,
      1
    );
    assert.equal((await one(o, 'SELECT count(*)::int AS n FROM audit_clock_operations')).n, 0);
    assert.equal((await one(o, 'SELECT count(*)::int AS n FROM audit_clock_publications')).n, 0);
    assert.deepEqual(
      (await q(o, 'SELECT big_blind FROM tables ORDER BY id')).rows.map((r) => Number(r.big_blind)),
      [20, 20]
    );
    await q(
      o,
      'DROP TRIGGER zzzz_clock_last_failure ON tables;DROP FUNCTION audit_clock_fail_last()'
    );
  });
  await check('Persistent Freeze Is Checked After The Maintenance Wait', async () => {
    await reset();
    await q(a, 'BEGIN');
    await q(a, 'SELECT pg_advisory_xact_lock(530090,1)');
    const pending = publish(b).then(
      () => ({ accepted: true }),
      (err) => ({ code: err.code })
    );
    await waitBlocked(b, a, 'publisher waits for maintenance owner');
    await q(a, 'UPDATE audit_clock_freeze SET frozen=true');
    await q(a, 'COMMIT');
    assert.equal((await pending).code, '55000');
  });
  const output = {
    captured_at: new Date().toISOString(),
    scope:
      'Disposable activation and membership protocol only; partial production trigger composition',
    production_writes: false,
    complete_clock_implemented: false,
    actual_catalog_functions: 4,
    passed: evidence.filter((x) => x.case).length,
    observed_lock_barriers: evidence.filter((x) => x.barrier).length,
    evidence,
    limitations: [
      'No production lease or durable pause implementation',
      'No actual financial schema or paid-entry RPC composition',
      'No full terminal, settlement, G/B/T or atomic-table wait graph',
      'Prototype operation and activation ACLs are not a production authorization design',
    ],
  };
  fs.writeFileSync(
    '/tmp/codex-k01-clock-boundary-results.json',
    JSON.stringify(output, null, 2) + '\n'
  );
  console.log(
    JSON.stringify({
      passed: output.passed,
      observed_lock_barriers: output.observed_lock_barriers,
      production_writes: false,
    })
  );
} finally {
  await Promise.allSettled(clients.map((c) => c.end()));
}
