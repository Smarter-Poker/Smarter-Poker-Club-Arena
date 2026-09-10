import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { Client } = createRequire(import.meta.url)('pg');
const host = process.env.POKER_CLOCK_PROBE_SOCKET;
assert.ok(
  host?.startsWith('/tmp/') ||
    host?.startsWith('/var/folders/') ||
    host?.startsWith('/private/var/folders/')
);
const c = new Client({
  host,
  port: Number(process.env.POKER_CLOCK_PROBE_PORT),
  database: 'postgres',
  statement_timeout: 8000,
});
await c.connect();
const e = '11111111-1111-4111-8111-111111111111',
  epoch = '22222222-2222-4222-8222-222222222222';
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  owner2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const op = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  epoch2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const base = Date.parse('2026-09-10T00:00:00Z'),
  at = (n) => new Date(base + n * 1000).toISOString();
const q = (sql, params = []) => c.query(sql, params);
const one = async (sql, p = []) => (await q(sql, p)).rows[0];
const evidence = [];
async function reset({ sync = false, adopt = true } = {}) {
  await q(
    'TRUNCATE tables,tournaments,tournament_table_origins,tournament_launch_receipts,audit_clock_publications,audit_clock_operations,audit_clock_trace,audit_clock_epochs,audit_clock_pauses,audit_clock_thaw_epoch_bindings,audit_clock_thaw_windows,engine_maintenance_thaws,engine_maintenance_thaw_targets'
  );
  await q('UPDATE audit_clock_freeze SET frozen=false');
  await q('INSERT INTO tournaments(id,level_started_at,on_break) VALUES($1,$2,$3)', [
    e,
    at(0),
    sync,
  ]);
  if (adopt) await q('SELECT audit_clock_publish($1,$2,0)', [e, op]);
  await q('INSERT INTO audit_clock_epochs(tournament_id,epoch_id,base_anchor) VALUES($1,$2,$3)', [
    e,
    epoch,
    at(0),
  ]);
}
const pause = (start, id = owner, kind = 'addon') =>
  q(
    'INSERT INTO audit_clock_pauses(tournament_id,epoch_id,owner_id,kind,started_at) VALUES($1,$2,$3,$4,$5)',
    [e, epoch, id, kind, at(start)]
  );
const thaw = (start, seconds, mode = 'broad', close = true) =>
  q('SELECT audit_apply_thaw($1,$2,$3,$4) AS result', [at(start), seconds, mode, close]);
const close = (end, id = owner) => one('SELECT audit_close_pause($1,$2) AS amount', [id, at(end)]);
const anchor = async () =>
  Number(
    (
      await one(
        'SELECT extract(epoch FROM level_started_at-$2::timestamptz) AS seconds FROM tournaments WHERE id=$1',
        [e, at(0)]
      )
    ).seconds
  );
async function refuses(sql, p, code, label) {
  try {
    await q(sql, p);
    assert.fail(label + ' accepted');
  } catch (err) {
    assert.equal(err.code, code, label + ': ' + err.message);
  }
}
async function check(name, run) {
  await run();
  evidence.push({ case: name, pass: true });
}
try {
  await check('Four Maintenance Helpers Execute Exact Captured Bodies', async () => {
    const catalog = JSON.parse(
      fs.readFileSync(
        new URL('../../docs/audits/2026-09-10-k01-maintenance-credit-catalog.json', import.meta.url)
      )
    );
    for (const f of catalog.functions.filter((x) => !x.signature.startsWith('fn_thaw_platform('))) {
      assert.equal(
        (
          await one('SELECT md5(prosrc) AS md5 FROM pg_proc WHERE oid=$1::regprocedure', [
            f.signature,
          ])
        ).md5,
        f.body_md5
      );
    }
  });
  await check('Snapshot Binds Exact Epoch Before Broad Credit', async () => {
    await reset();
    await thaw(50, 20);
    assert.equal(
      (
        await one('SELECT epoch_id FROM audit_clock_thaw_epoch_bindings WHERE tournament_id=$1', [
          e,
        ])
      ).epoch_id,
      epoch
    );
    assert.equal(await anchor(), 20);
    assert.equal(
      Number(
        (
          await one(
            "SELECT credited_seconds FROM engine_maintenance_thaw_targets WHERE step='level_started_at'"
          )
        ).credited_seconds
      ),
      20
    );
  });
  await check('Broad Credit And Add-On Resume Count Their Union Once', async () => {
    await reset();
    await pause(40);
    await thaw(50, 20);
    assert.equal(Number((await close(120)).amount), 60);
    assert.equal(await anchor(), 80);
  });
  await check(
    'Incremental Future Target Rebase Subtracts Only Actual Credited Suffix',
    async () => {
      await reset();
      await pause(40);
      await thaw(50, 20, 'broad', false);
      await thaw(50, 40, 'suffix', false);
      assert.equal(await anchor(), 40);
      await thaw(50, 60, 'suffix', true);
      assert.equal(await anchor(), 60);
      assert.equal(Number((await close(120)).amount), 20);
      assert.equal(await anchor(), 80);
    }
  );
  await check('Two Maintenance Windows In One Epoch Never Double Count Local Pause', async () => {
    await reset();
    await pause(40);
    await thaw(50, 20);
    await thaw(90, 10);
    assert.equal(await anchor(), 30);
    assert.equal(Number((await close(120)).amount), 50);
    assert.equal(await anchor(), 80);
  });
  await check('Overlapping Add-On And Synchronized Owners Receive Union Credit', async () => {
    await reset();
    await pause(40);
    await pause(80, owner2, 'synchronized');
    assert.equal(Number((await close(100)).amount), 60);
    assert.equal(Number((await close(140, owner2)).amount), 40);
    assert.equal(await anchor(), 100);
  });
  await check(
    'Synchronized Snapshot Exclusion Is Proved By Actual Snapshot And Checkpoint',
    async () => {
      await reset({ sync: true });
      await pause(40, owner, 'synchronized');
      await thaw(50, 20);
      assert.equal(
        (
          await one(
            "SELECT count(*)::int AS n FROM engine_maintenance_thaw_targets WHERE step='level_started_at'"
          )
        ).n,
        0
      );
      assert.equal(await anchor(), 0);
      assert.equal(Number((await close(120)).amount), 80);
      assert.equal(await anchor(), 80);
    }
  );
  await check('Pause Resume Refuses Before A Partial Thaw Is Final', async () => {
    await reset();
    await pause(40);
    await thaw(50, 20, 'broad', false);
    await thaw(50, 40, 'suffix', false);
    await refuses('SELECT audit_close_pause($1,$2)', [owner, at(120)], '55000', 'partial thaw');
    assert.equal(
      (await one('SELECT ended_at FROM audit_clock_pauses WHERE owner_id=$1', [owner])).ended_at,
      null
    );
    assert.equal(await anchor(), 40);
    await thaw(50, 60, 'suffix', true);
    assert.equal(Number((await close(120)).amount), 20);
  });
  await check('Lost Resume Response Replays Without Adding Credit', async () => {
    await reset();
    await pause(40);
    await thaw(50, 20);
    assert.equal(Number((await close(120)).amount), 60);
    assert.equal(Number((await close(120)).amount), 60);
    assert.equal(await anchor(), 80);
    await refuses(
      'SELECT audit_close_pause($1,$2)',
      [owner, at(125)],
      '22023',
      'pause conflicting replay'
    );
  });
  await check(
    'Delayed Old Maintenance Retry Resolves And Cannot Extend A Closed Window',
    async () => {
      await reset();
      await pause(40);
      await thaw(50, 20);
      await close(120);
      assert.equal((await thaw(50, 20)).rows[0].result.replayed, true);
      assert.equal(await anchor(), 80);
      await refuses(
        'SELECT audit_apply_thaw($1,30,$2,true)',
        [at(50), 'suffix'],
        '55000',
        'late rebase'
      );
      assert.equal(await anchor(), 80);
    }
  );
  await check('Old Epoch Maintenance Cannot Credit A New Level', async () => {
    await reset();
    await thaw(50, 20, 'broad', false);
    // Deliberately hostile state: model an illicit transition during unclosed maintenance.
    await q('UPDATE audit_clock_epochs SET epoch_id=$1 WHERE tournament_id=$2', [epoch2, e]);
    await refuses(
      'SELECT audit_apply_thaw($1,40,$2,true)',
      [at(50), 'suffix'],
      '55000',
      'old epoch suffix'
    );
    assert.equal(await anchor(), 20);
  });
  await check('Old Epoch Local Pause Cannot Credit A New Level', async () => {
    await reset();
    await pause(40);
    await q('UPDATE audit_clock_epochs SET epoch_id=$1 WHERE tournament_id=$2', [epoch2, e]);
    await refuses(
      'SELECT audit_close_pause($1,$2)',
      [owner, at(120)],
      '55000',
      'old epoch local resume'
    );
    assert.equal(await anchor(), 0);
  });
  await check('Adoption Preserves Existing Durable Pause Start', async () => {
    await reset({ adopt: false });
    await pause(40);
    await q('SELECT audit_clock_publish($1,$2,0)', [e, epoch2]);
    assert.equal(Number((await close(120)).amount), 80);
    assert.equal(await anchor(), 80);
  });
  await check('Pause Beginning Before Epoch Receives Only Epoch Overlap', async () => {
    await reset();
    await pause(-20);
    assert.equal(Number((await close(30)).amount), 30);
    assert.equal(await anchor(), 30);
  });
  await check('Earlier Pause Receipt Replays After Another Owner Was Credited', async () => {
    await reset();
    await pause(40);
    await pause(80, owner2, 'synchronized');
    assert.equal(Number((await close(100)).amount), 60);
    assert.equal(Number((await close(140, owner2)).amount), 40);
    assert.equal(Number((await close(100)).amount), 60);
    assert.equal(await anchor(), 100);
  });
  await check(
    'Actual Broad Helper Failure Rolls Back Snapshot Binding And All Credit',
    async () => {
      await reset();
      await pause(40);
      await q(
        "CREATE FUNCTION audit_fail_thaw_anchor() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.level_started_at IS DISTINCT FROM OLD.level_started_at THEN RAISE EXCEPTION 'injected actual thaw writer failure'; END IF;RETURN NEW;END$$;CREATE TRIGGER zzzz_fail_thaw_anchor BEFORE UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION audit_fail_thaw_anchor()"
      );
      await refuses(
        'SELECT audit_apply_thaw($1,20,$2,true)',
        [at(50), 'broad'],
        'P0001',
        'actual helper last write failure'
      );
      for (const table of [
        'engine_maintenance_thaws',
        'engine_maintenance_thaw_targets',
        'audit_clock_thaw_epoch_bindings',
        'audit_clock_thaw_windows',
      ]) {
        assert.equal((await one('SELECT count(*)::int AS n FROM ' + table)).n, 0);
      }
      assert.equal(await anchor(), 0);
      await q(
        'DROP TRIGGER zzzz_fail_thaw_anchor ON tournaments;DROP FUNCTION audit_fail_thaw_anchor()'
      );
    }
  );
  await check('Concurrent Pause Retry Rechecks The Durable Owner After Its Lock Wait', async () => {
    const peer = new Client({
      host,
      port: Number(process.env.POKER_CLOCK_PROBE_PORT),
      database: 'postgres',
      statement_timeout: 8000,
    });
    await peer.connect();
    try {
      for (const repeatedEnd of [120, 125]) {
        await reset();
        await pause(40);
        await thaw(50, 20);
        await q('BEGIN');
        assert.equal(Number((await close(120)).amount), 60);
        const pending = peer
          .query('SELECT audit_close_pause($1,$2) AS amount', [owner, at(repeatedEnd)])
          .then(
            (r) => ({ amount: Number(r.rows[0].amount) }),
            (err) => ({ code: err.code })
          );
        let observed = false;
        for (let i = 0; i < 250; i++) {
          const row = await one('SELECT pg_blocking_pids($1) AS blockers', [peer.processID]);
          if (row.blockers.includes(c.processID)) {
            observed = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(observed, true, 'pause retry must reach an observed owner gate wait');
        await q('COMMIT');
        const result = await pending;
        if (repeatedEnd === 120) assert.equal(result.amount, 60);
        else assert.equal(result.code, '22023');
        assert.equal(await anchor(), 80);
      }
    } finally {
      await q('ROLLBACK');
      await peer.end();
    }
  });
  const output = {
    captured_at: new Date().toISOString(),
    scope:
      'Disposable epoch and pause credit design; exact snapshot, checkpoint, suffix and reconnect SQL with minimal empty dependent tables',
    passed: evidence.length,
    actual_maintenance_helper_bodies: 4,
    production_writes: false,
    complete_clock_implemented: false,
    evidence,
    limitations: [
      'Five-argument outer ownership, admission freeze, future release hold and current production triggers are not executed',
      'Timestamp inputs and audit write witnesses are test controls, not production APIs',
      'Epoch and target binding ACLs, manager lifecycle, actual adoption and native paid/settlement composition remain unimplemented',
      'Partial completion modeled by withholding fixture finalization, not by forcing a real four-second checkpoint budget',
    ],
  };
  fs.writeFileSync(
    '/tmp/codex-k01-clock-pause-epoch-results.json',
    JSON.stringify(output, null, 2) + '\n'
  );
  console.log(
    JSON.stringify({
      passed: output.passed,
      actual_maintenance_helper_bodies: 4,
      production_writes: false,
    })
  );
} finally {
  await c.end();
}
