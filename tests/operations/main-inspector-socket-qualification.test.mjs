import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { captureMainInspectorBinding } from '../../server/scripts/main-inspector-socket-qualification.mjs';

const main = 777001;
const header =
  'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n';
const row = (local, remote, state, inode) =>
  `0: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000 0 0 ${inode}\n`;
const listener = row('0100007F:240D', '00000000:0000', '0A', 101);
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'main-inspector-kernel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const pid of [main, process.pid]) {
    fs.mkdirSync(join(root, String(pid), 'fd'), { recursive: true });
    fs.mkdirSync(join(root, String(pid), 'ns'));
    fs.mkdirSync(join(root, String(pid), 'net'));
    fs.symlinkSync('net:[111]', join(root, String(pid), 'ns/net'));
    const stat = Buffer.concat([
      Buffer.from(`${pid} (`),
      Buffer.from([0xff, 0x29, 0x20, 0xc3]),
      Buffer.from(`) S ${Array(18).fill('0').join(' ')} 12345\n`),
    ]);
    fs.writeFileSync(join(root, String(pid), 'stat'), stat);
    fs.writeFileSync(join(root, String(pid), 'net/tcp'), header + listener);
    fs.writeFileSync(join(root, String(pid), 'net/tcp6'), header);
  }
  fs.symlinkSync('socket:[101]', join(root, String(main), 'fd/3'));
  return {
    root,
    capture: (options = {}) =>
      captureMainInspectorBinding({
        pid: main,
        deadlineMs: Date.now() + 2000,
        procRoot: root,
        ...options,
      }),
  };
}
function ownPair(root) {
  fs.appendFileSync(
    join(root, String(main), 'net/tcp'),
    row('0100007F:240D', '0100007F:C001', '01', 102) +
      row('0100007F:C001', '0100007F:240D', '01', 103)
  );
  fs.symlinkSync('socket:[102]', join(root, String(main), 'fd/4'));
  fs.symlinkSync('socket:[103]', join(root, String(process.pid), 'fd/5'));
}

test('two complete snapshots bind the MAIN listener with opaque process-name bytes', (t) => {
  const f = fixture(t),
    value = f.capture();
  assert.deepEqual(value, {
    schema: 'main-inspector-socket-binding/v1',
    pid: main,
    startTicks: '12345',
    namespace: 'net:[111]',
    listener: { family: 'tcp', local: '0100007F:240D', inode: '101' },
  });
  assert.equal(Object.isFrozen(value.listener), true);
});
test('only the exact positively owned helper/main pair is accepted after attachment', (t) => {
  const f = fixture(t),
    before = f.capture();
  ownPair(f.root);
  assert.throws(() => f.capture(), /main_inspector_socket_unproved/);
  assert.deepEqual(f.capture({ allowOwnClient: true, expectedBinding: before }), before);
});
test('a foreign or unmapped client is refused even with the own-client mode', (t) => {
  const f = fixture(t);
  ownPair(f.root);
  fs.unlinkSync(join(f.root, String(process.pid), 'fd/5'));
  assert.throws(() => f.capture({ allowOwnClient: true }), /main_inspector_socket_unproved/);
});
test('another debugger connection is refused', (t) => {
  const f = fixture(t);
  ownPair(f.root);
  fs.appendFileSync(
    join(f.root, String(main), 'net/tcp'),
    row('0100007F:240D', '0100007F:C002', '01', 104)
  );
  assert.throws(() => f.capture({ allowOwnClient: true }), /main_inspector_socket_unproved/);
});
test('a shared listener descriptor is not exclusive MAIN ownership', (t) => {
  const f = fixture(t);
  fs.symlinkSync('socket:[101]', join(f.root, String(process.pid), 'fd/6'));
  assert.throws(() => f.capture(), /main_inspector_socket_unproved/);
});
test('a changed listener, PID start, namespace, or malformed stat is refused', (t) => {
  const f = fixture(t),
    before = f.capture();
  assert.throws(
    () => f.capture({ expectedBinding: { ...before, startTicks: '12346' } }),
    /main_inspector_socket_unproved/
  );
  assert.throws(
    () =>
      f.capture({ expectedBinding: { ...before, listener: { ...before.listener, inode: '999' } } }),
    /main_inspector_socket_unproved/
  );
  fs.unlinkSync(join(f.root, String(process.pid), 'ns/net'));
  fs.symlinkSync('net:[112]', join(f.root, String(process.pid), 'ns/net'));
  assert.throws(() => f.capture(), /main_inspector_socket_unproved/);
  fs.writeFileSync(join(f.root, String(main), 'stat'), `${main} (broken) S 0`);
  assert.throws(() => f.capture(), /main_inspector_socket_unproved/);
});
test('wildcard, ambiguous listeners and active connection states are refused', (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    join(f.root, String(main), 'net/tcp'),
    header + listener.replace('0100007F', '00000000')
  );
  assert.throws(() => f.capture(), /main_inspector_socket_unproved/);
  fs.writeFileSync(join(f.root, String(main), 'net/tcp'), header + listener + listener);
  assert.throws(() => f.capture(), /main_inspector_socket_unproved/);
  fs.writeFileSync(
    join(f.root, String(main), 'net/tcp'),
    header + listener + row('0100007F:C001', '0100007F:240D', '02', 0)
  );
  assert.throws(() => f.capture(), /main_inspector_socket_unproved/);
});
test('ownerless completed discovery TIME_WAIT is distinct from an active client', (t) => {
  const f = fixture(t),
    before = f.capture();
  fs.appendFileSync(
    join(f.root, String(main), 'net/tcp'),
    row('0100007F:C001', '0100007F:240D', '06', 0)
  );
  assert.deepEqual(f.capture(), before);
});
test('missing metadata and exhausted absolute deadline refuse without native detail', (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.capture({ deadlineMs: Date.now() - 1 }),
    /^Error: main_inspector_socket_unproved$/
  );
  fs.unlinkSync(join(f.root, String(main), 'net/tcp6'));
  assert.throws(() => f.capture(), /^Error: main_inspector_socket_unproved$/);
});

test(
  'real Linux proc sockets prove a live child listener and identify own and foreign clients',
  {
    skip:
      process.platform !== 'linux' ? 'Linux /proc socket execution required in hosted CI' : false,
  },
  async (t) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `require('node:net').createServer(s=>{s.on('error',()=>{});console.log('accepted');}).listen(0,'127.0.0.1',function(){console.log(this.address().port)});`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child_listener_timeout')), 3000);
      child.stdout.once('data', (chunk) => {
        clearTimeout(timer);
        resolve(Number(String(chunk).trim()));
      });
      child.once('error', reject);
    });
    // The fixture selects two genuine kernel process directories; production
    // always uses the complete container /proc and cannot select members.
    const root = fs.mkdtempSync(join(tmpdir(), 'main-inspector-real-kernel-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.symlinkSync(`/proc/${child.pid}`, join(root, String(child.pid)));
    fs.symlinkSync(`/proc/${process.pid}`, join(root, String(process.pid)));
    const capture = (options = {}) =>
      captureMainInspectorBinding({
        pid: child.pid,
        port,
        deadlineMs: Date.now() + 2000,
        procRoot: root,
        ...options,
      });
    const before = capture();
    const accepted = once(child.stdout, 'data');
    const client = createConnection({ host: '127.0.0.1', port });
    t.after(() => client.destroy());
    await Promise.all([accepted, once(client, 'connect')]);
    assert.throws(() => capture(), /main_inspector_socket_unproved/);
    assert.deepEqual(capture({ allowOwnClient: true, expectedBinding: before }), before);
    const extraAccepted = once(child.stdout, 'data');
    const extra = createConnection({ host: '127.0.0.1', port });
    t.after(() => extra.destroy());
    await Promise.all([extraAccepted, once(extra, 'connect')]);
    assert.throws(
      () => capture({ allowOwnClient: true, expectedBinding: before }),
      /main_inspector_socket_unproved/
    );
  }
);

test('own-client mode never treats a clientless listener as its own session', (t) => {
  const f = fixture(t);
  assert.throws(() => f.capture({ allowOwnClient: true }), /main_inspector_socket_unproved/);
});
test('a loopback IPv6 listener has the same strict ownership contract', (t) => {
  const f = fixture(t);
  fs.writeFileSync(join(f.root, String(main), 'net/tcp'), header);
  fs.writeFileSync(
    join(f.root, String(main), 'net/tcp6'),
    header +
      row(
        '00000000000000000000000001000000:240D',
        '00000000000000000000000000000000:0000',
        '0A',
        101
      )
  );
  assert.equal(f.capture().listener.family, 'tcp6');
});
test('socket file and process census limits refuse before attachment', (t) => {
  const f = fixture(t);
  fs.writeFileSync(join(f.root, String(main), 'net/tcp'), Buffer.alloc(131073, 0x20));
  assert.throws(() => f.capture(), /main_inspector_socket_unproved/);
  fs.writeFileSync(join(f.root, String(main), 'net/tcp'), header + listener);
  for (let i = 800000; i < 800256; i++) fs.mkdirSync(join(f.root, String(i)));
  assert.throws(() => f.capture(), /main_inspector_socket_unproved/);
});
test('invalid coordinates and nonboolean client authority are refused', (t) => {
  const f = fixture(t);
  for (const options of [
    { pid: process.pid },
    { pid: 0 },
    { port: 0 },
    { port: 65536 },
    { allowOwnClient: 'true' },
    { deadlineMs: Infinity },
  ]) {
    assert.throws(() => f.capture(options), /main_inspector_socket_unproved/);
  }
});

test(
  'real Linux MAIN retirement uses the exact kernel-owned client pair and leaves the same process alive',
  {
    skip:
      process.platform !== 'linux'
        ? 'Linux /proc and pinned native Inspector execution required in hosted CI'
        : false,
    timeout: 12000,
  },
  async (t) => {
    const { retireOwnedMainInspector } =
      await import('../../server/scripts/retire-owned-main-inspector.mjs');
    const child = spawn(
      process.execPath,
      [
        '--inspect=127.0.0.1:0',
        '-e',
        `process.on('message', value => { if (value === 'alive-after-close') process.send({alive:true,pid:process.pid}); }); setInterval(()=>{},1000);`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
    );
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    });
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('inspector_child_timeout')), 3000);
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        const match = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      child.once('error', reject);
    });
    const root = fs.mkdtempSync(join(tmpdir(), 'main-inspector-native-retirement-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.symlinkSync(`/proc/${child.pid}`, join(root, String(child.pid)));
    fs.symlinkSync(`/proc/${process.pid}`, join(root, String(process.pid)));
    const port = Number(new URL(endpoint).port);
    const deadlineMs = Date.now() + 5000;
    const binding = captureMainInspectorBinding({
      pid: child.pid,
      port,
      deadlineMs,
      procRoot: root,
    });
    const boundaries = [];
    const result = await retireOwnedMainInspector({
      endpoint,
      expectedPid: child.pid,
      deadlineMs,
      qualify: (stage) => {
        captureMainInspectorBinding({
          pid: child.pid,
          port,
          deadlineMs,
          procRoot: root,
          allowOwnClient: stage === 'close',
          expectedBinding: binding,
        });
        boundaries.push(stage);
        return true;
      },
    });
    assert.deepEqual(boundaries, ['attach', 'close']);
    assert.deepEqual(result, {
      ok: true,
      reason: 'native_close_observed',
      stage: 'complete',
      closeRequested: true,
      closeAcknowledged: true,
      connectionClosed: true,
      retryAllowed: false,
    });
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    const alive = once(child, 'message');
    child.send('alive-after-close');
    assert.deepEqual((await alive)[0], { alive: true, pid: child.pid });
    const probe = createConnection({ host: '127.0.0.1', port });
    t.after(() => probe.destroy());
    assert.equal((await once(probe, 'error'))[0].code, 'ECONNREFUSED');
  }
);

test('kernel refusal identifies only the failed predicate, never native metadata', (t) => {
  const f = fixture(t);
  fs.appendFileSync(
    join(f.root, String(main), 'net/tcp'),
    row('0100007F:240D', '0100007F:C002', '01', 104)
  );
  assert.throws(
    () => f.capture(),
    (error) => {
      assert.equal(error.message, 'main_inspector_socket_unproved');
      assert.equal(error.kernelStep, 'clients');
      assert.deepEqual(Object.keys(error), ['kernelStep']);
      return true;
    }
  );
});

test('kernel metadata read failure keeps only its fixed predicate name', (t) => {
  const f = fixture(t);
  fs.unlinkSync(join(f.root, String(main), 'net/tcp6'));
  assert.throws(
    () => f.capture(),
    (error) => {
      assert.equal(error.message, 'main_inspector_socket_unproved');
      assert.equal(error.kernelStep, 'socket_rows');
      assert.equal(JSON.stringify(error).includes(f.root), false);
      return true;
    }
  );
});
