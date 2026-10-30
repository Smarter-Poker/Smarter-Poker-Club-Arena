import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  retireOwnedMainInspector,
  OWNED_MAIN_INSPECTOR_CLOSE_EXPRESSION,
} from '../../server/scripts/retire-owned-main-inspector.mjs';

const endpoint = 'ws://127.0.0.1:9229/11111111-1111-1111-1111-111111111111';
function fixture(mode = 'success') {
  const socket = new EventTarget();
  socket.readyState = 0;
  const sent = [];
  let localCloses = 0;
  socket.close = () => {
    localCloses++;
    socket.readyState = 3;
    socket.dispatchEvent(new Event('close'));
  };
  socket.send = (bytes) => {
    const request = JSON.parse(bytes);
    sent.push(request);
    const native = request.params.expression === OWNED_MAIN_INSPECTOR_CLOSE_EXPRESSION;
    if (native && mode === 'lost_ack') {
      queueMicrotask(() => socket.dispatchEvent(new Event('close')));
      return;
    }
    if (native && mode === 'timeout') return;
    queueMicrotask(() => {
      socket.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            id: request.id,
            result: {
              result: native
                ? { type: 'undefined' }
                : {
                    type: 'number',
                    value: mode === 'wrong_pid' ? 99999 : 12345,
                  },
            },
          }),
        })
      );
      if (native && mode !== 'lost_close')
        queueMicrotask(() => {
          socket.readyState = 3;
          socket.dispatchEvent(new Event('close'));
        });
    });
  };
  return {
    sent,
    localCloses: () => localCloses,
    socket,
    createWebSocket: () => {
      queueMicrotask(() => {
        socket.readyState = 1;
        socket.dispatchEvent(new Event('open'));
      });
      return socket;
    },
  };
}

test('qualified transport emits only PID read and fixed close, waits native close', async () => {
  const f = fixture(),
    stages = [];
  const result = await retireOwnedMainInspector({
    endpoint,
    expectedPid: 12345,
    deadlineMs: Date.now() + 1000,
    createWebSocket: f.createWebSocket,
    qualify: (stage, context) => {
      stages.push(stage);
      assert.equal(context.expectedPid, 12345);
      if (stage === 'close') assert.equal(context.socket, f.socket);
      return true;
    },
  });
  assert.deepEqual(stages, ['attach', 'close']);
  assert.equal(result.ok, true);
  assert.equal(result.closeAcknowledged, true);
  assert.equal(result.connectionClosed, true);
  assert.equal(result.retryAllowed, false);
  assert.equal(f.localCloses(), 0);
  assert.deepEqual(
    f.sent.map((x) => [x.method, x.params.expression]),
    [
      ['Runtime.evaluate', 'process.pid'],
      ['Runtime.evaluate', OWNED_MAIN_INSPECTOR_CLOSE_EXPRESSION],
    ]
  );
});

for (const mode of ['wrong_pid', 'lost_ack', 'lost_close', 'timeout']) {
  test(`${mode} refuses without replay or competing native/local close`, async () => {
    const f = fixture(mode);
    const result = await retireOwnedMainInspector({
      endpoint,
      expectedPid: 12345,
      deadlineMs: Date.now() + 70,
      qualify: () => true,
      createWebSocket: f.createWebSocket,
    });
    assert.equal(result.ok, false);
    assert.equal(result.retryAllowed, false);
    assert.equal(f.sent.length, mode === 'wrong_pid' ? 1 : 2);
    assert.equal(f.localCloses(), mode === 'wrong_pid' ? 1 : 0);
    assert.equal(result.closeAcknowledged, mode === 'lost_close');
    if (mode === 'lost_ack') assert.equal(result.connectionClosed, true);
  });
}

for (const refusedAt of ['attach', 'close']) {
  test(`foreign/unknown kernel qualification at ${refusedAt} never sends native close`, async () => {
    const f = fixture();
    const result = await retireOwnedMainInspector({
      endpoint,
      expectedPid: 12345,
      deadlineMs: Date.now() + 1000,
      qualify: (stage) => stage !== refusedAt,
      createWebSocket: f.createWebSocket,
    });
    assert.equal(result.reason, 'qualification_refused');
    assert.equal(result.closeRequested, false);
    assert.equal(f.sent.length, refusedAt === 'attach' ? 0 : 1);
  });
}

test('invalid endpoint/PID/deadline/callback refuse before connection', async () => {
  for (const change of [
    { endpoint: endpoint.replace('127.0.0.1', 'example.com') },
    { endpoint: endpoint + '?x=1' },
    { endpoint: endpoint.replace('/1111', '/abcd@1111') },
    { expectedPid: process.pid },
    { expectedPid: 0 },
    { deadlineMs: Date.now() - 1 },
    { deadlineMs: Date.now() + 41000 },
    { qualify: undefined },
  ]) {
    let connected = false;
    const result = await retireOwnedMainInspector({
      endpoint,
      expectedPid: 12345,
      deadlineMs: Date.now() + 1000,
      qualify: () => true,
      ...change,
      createWebSocket: () => {
        connected = true;
        throw Error('must not connect');
      },
    });
    assert.equal(result.ok, false);
    assert.equal(connected, false);
  }
});

test('qualification cannot outlive the absolute deadline or authorize a late close', async () => {
  const f = fixture();
  const result = await retireOwnedMainInspector({
    endpoint,
    expectedPid: 12345,
    deadlineMs: Date.now() + 30,
    qualify: () => new Promise((resolve) => setTimeout(() => resolve(true), 60)),
    createWebSocket: f.createWebSocket,
  });
  assert.equal(result.reason, 'deadline_exhausted');
  assert.equal(f.sent.length, 0);
});

test('actual child Inspector closes while same process and game witness survive', async (t) => {
  const child = spawn(
    process.execPath,
    [
      '--inspect=127.0.0.1:0',
      '-e',
      'let games=0;process.on("message",m=>{if(m==="state")process.send({pid:process.pid,games});});setInterval(()=>{},1000)',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: process.env.PATH } }
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  });
  const target = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(Error('child inspector startup timeout')), 3000);
    child.stderr.on('data', (data) => {
      output += data;
      const match = output.match(/ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once('error', reject);
  });
  const read = async () => {
    const response = once(child, 'message');
    child.send('state');
    return (await response)[0];
  };
  assert.deepEqual(await read(), { pid: child.pid, games: 0 });
  const result = await retireOwnedMainInspector({
    endpoint: target,
    expectedPid: child.pid,
    deadlineMs: Date.now() + 3000,
    qualify: () => true,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.closeAcknowledged, true);
  assert.equal(result.connectionClosed, true);
  assert.deepEqual(await read(), { pid: child.pid, games: 0 });
  await assert.rejects(fetch(target.replace('ws:', 'http:').replace(/\/[^/]+$/, '/json/list')));
  assert.equal(child.exitCode, null);
});
