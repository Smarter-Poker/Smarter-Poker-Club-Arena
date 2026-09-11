import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import {
  ServiceSupervisor,
  closeFixtureResources,
} from '../../operations/release/fixture/fixture-server.mjs';

test('a failed resource close still retires readiness and observes the real child exit', async () =>
  owned(async (supervisor, root) => {
    const child = await supervisor.start('cleanup-service', process.execPath, [
      '-e',
      'setInterval(()=>{},1000)',
    ]);
    const readyFile = path.join(root, 'ready.json');
    await writeFile(readyFile, JSON.stringify({ pid: child.pid }));
    let bridgeClosed = false;
    await assert.rejects(
      closeFixtureResources({
        retireReady: () => rm(readyFile),
        actors: {
          close() {
            throw new Error('PRIVATE ACTOR FAILURE');
          },
        },
        gateway: {
          async close() {
            throw new Error('PRIVATE GATEWAY FAILURE');
          },
        },
        bridge: {
          async close() {
            bridgeClosed = true;
          },
        },
        supervisor,
      }),
      /FIXTURE_CLEANUP_FAILED/
    );
    await assert.rejects(readFile(readyFile), { code: 'ENOENT' });
    assert.equal(bridgeClosed, true);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(supervisor.stopped, true);
  }));

test('a hung resource close cannot delay real child cleanup and never reports success', async () =>
  owned(async (supervisor) => {
    const child = await supervisor.start('cleanup-service', process.execPath, [
      '-e',
      'setInterval(()=>{},1000)',
    ]);
    let gatewayClosed = false;
    await assert.rejects(
      closeFixtureResources(
        {
          retireReady() {
            throw new Error('PRIVATE READINESS FAILURE');
          },
          actors: { close: () => new Promise(() => {}) },
          gateway: {
            async close() {
              gatewayClosed = true;
            },
          },
          supervisor,
        },
        500
      ),
      /FIXTURE_CLEANUP_DEADLINE/
    );
    assert.equal(gatewayClosed, true);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(supervisor.stopped, true);
  }));

async function owned(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fixture-supervisor-'));
  const supervisor = new ServiceSupervisor({ logRoot: root, env: { PATH: '/usr/bin:/bin' } });
  try {
    await callback(supervisor, root);
  } finally {
    await supervisor.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('native child failure retires readiness instead of silently restarting', async () =>
  owned(async (supervisor, root) => {
    await supervisor.start('failing-service', process.execPath, [
      '-e',
      'process.stderr.write("private-test-secret");setTimeout(()=>process.exit(7),25)',
    ]);
    assert.equal(await supervisor.failed, 'failing-service');
    assert.throws(() => supervisor.assertHealthy(), /fixture service failed/);
    assert.equal(supervisor.children.length, 1);
    assert.equal(
      await readFile(path.join(root, 'failing-service.log'), 'utf8'),
      'private-test-secret'
    );
    assert.equal((await stat(path.join(root, 'failing-service.log'))).mode & 0o777, 0o600);
  }));

test('native child environment contains only explicitly supplied values', async () =>
  owned(async (supervisor) => {
    const previous = process.env.FIXTURE_TEST_PARENT_SECRET;
    process.env.FIXTURE_TEST_PARENT_SECRET = 'not-for-child';
    try {
      const result = await supervisor.command(
        process.execPath,
        [
          '-e',
          'process.stdout.write(JSON.stringify({ inherited: process.env.FIXTURE_TEST_PARENT_SECRET ?? null, own: process.env.FIXTURE_TEST_LOCAL_VALUE }))',
        ],
        { FIXTURE_TEST_LOCAL_VALUE: 'local-only' }
      );
      assert.deepEqual(JSON.parse(result.stdout), { inherited: null, own: 'local-only' });
    } finally {
      if (previous === undefined) delete process.env.FIXTURE_TEST_PARENT_SECRET;
      else process.env.FIXTURE_TEST_PARENT_SECRET = previous;
    }
  }));

test('readiness cannot pass after the original deadline', async () =>
  owned(async (supervisor) => {
    await assert.rejects(
      supervisor.until(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return true;
      }, 1),
      /deadline expired/
    );
  }));

test('shutdown waits for the owned child and prevents later starts', async () =>
  owned(async (supervisor) => {
    const child = await supervisor.start('service', process.execPath, [
      '-e',
      'setInterval(()=>{},1000)',
    ]);
    await supervisor.close();
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(supervisor.failure, null);
    await assert.rejects(supervisor.start('second', process.execPath, []), /fixture stopped/);
  }));

test('unsafe log names and absent executables refuse service startup', async () =>
  owned(async (supervisor) => {
    await assert.rejects(supervisor.start('../outside', process.execPath, []));
    await assert.rejects(supervisor.start('missing', '/this-program-does-not-exist', []));
    assert.equal(await supervisor.failed, 'missing');
    assert.equal(supervisor.children[0].pid, undefined);
    const started = Date.now();
    await supervisor.close();
    assert.ok(Date.now() - started < 1000, 'a spawn error owns no process to signal or await');
  }));

test('termination interrupts an owned in-flight native command and collects its child', async () =>
  owned(async (supervisor) => {
    const command = supervisor.command(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    const refused = assert.rejects(command, { name: 'AbortError' });
    const child = supervisor.children[0];
    assert.ok(child.pid > 0);
    await new Promise((resolve) => child.once('spawn', resolve));
    const started = Date.now();
    supervisor.fail('termination');
    await refused;
    await supervisor.close();
    assert.ok(Date.now() - started < 3000, 'command must not wait for its 90-second timeout');
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  }));

test('a successful tracked native command does not poison service readiness', async () =>
  owned(async (supervisor) => {
    const result = await supervisor.command(process.execPath, [
      '-e',
      'process.stdout.write("done")',
    ]);
    assert.equal(result.stdout, 'done');
    supervisor.assertHealthy();
    assert.equal(supervisor.children.length, 1);
    assert.equal(supervisor.children[0].exitCode, 0);
  }));

async function awaitMarker(file, value) {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      if ((await readFile(file, 'utf8')) === value) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    assert.ok(Date.now() < deadline, 'owned child did not reach its signal checkpoint');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const kind of ['service', 'command']) {
  test(
    `shutdown observes SIGKILL exit of a native SIGTERM-ignoring ${kind}`,
    { timeout: 15000 },
    async () =>
      owned(async (supervisor, root) => {
        const ready = path.join(root, 'ready');
        const terminated = path.join(root, 'terminated');
        const program = [
          'const fs = require("node:fs");',
          'process.on("SIGTERM", () => fs.writeFileSync(process.argv[2], "SIGTERM"));',
          'fs.writeFileSync(process.argv[1], "ready");',
          'setInterval(() => {}, 1000);',
        ].join('\n');
        let refused;
        if (kind === 'service') {
          await supervisor.start('ignoring-service', process.execPath, [
            '-e',
            program,
            ready,
            terminated,
          ]);
        } else {
          refused = assert.rejects(
            supervisor.command(process.execPath, ['-e', program, ready, terminated]),
            { name: 'AbortError' }
          );
        }
        const child = supervisor.children[0];
        await awaitMarker(ready, 'ready');
        let observedExit = false;
        child.once('exit', () => {
          observedExit = true;
        });
        const started = Date.now();
        const closing = supervisor.close();
        // A real acknowledgement proves SIGTERM reached an installed handler;
        // awaiting only execFile's AbortError must not satisfy child cleanup.
        await awaitMarker(terminated, 'SIGTERM');
        assert.equal(observedExit, false);
        assert.equal(child.exitCode, null);
        assert.equal(child.signalCode, null);
        await closing;
        await refused;
        assert.equal(observedExit, true, 'close must not resolve before the owned exit event');
        assert.equal(child.signalCode, 'SIGKILL');
        assert.ok(Date.now() - started < 10000, 'shutdown must not await the command timeout');
        const closedAt = Date.now();
        await supervisor.close();
        assert.ok(Date.now() - closedAt < 1000, 'already collected children must close promptly');
      })
  );
}

test('shutdown rejects when an owned child never reports exit after escalation', async (context) => {
  const supervisor = new ServiceSupervisor();
  const signals = [];
  // Model only an unavailable OS exit notification; no real PID is signalled.
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null,
    signalCode: null,
    kill: (signal) => {
      signals.push(signal);
      return true;
    },
  });
  supervisor.children.push(child);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const closing = supervisor.close();
  const rejected = assert.rejects(closing, /owned child exit was not observed after SIGKILL/);
  assert.deepEqual(signals, ['SIGTERM']);
  context.mock.timers.tick(5000);
  await Promise.resolve();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  context.mock.timers.tick(5000);
  await rejected;
  assert.equal(child.listenerCount('exit'), 0, 'deadline must remove its temporary listeners');
});

test('an absent command executable does not delay shutdown', async () =>
  owned(async (supervisor) => {
    await assert.rejects(supervisor.command('/this-command-does-not-exist', []), {
      code: 'ENOENT',
    });
    assert.equal(supervisor.children[0].pid, undefined);
    const started = Date.now();
    await supervisor.close();
    assert.ok(Date.now() - started < 1000);
  }));
