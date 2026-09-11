import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  ENGINE_READINESS_TIMEOUT_MS,
  waitForExactEngineReady,
} from '../../operations/release/native/component-semantic-readiness.mjs';

const sourceSha = 'a'.repeat(40);
async function localHealth(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    healthUrl: `http://127.0.0.1:${server.address().port}/health`,
    request: {
      async get(url, { timeout }) {
        const result = await fetch(url, {
          signal: AbortSignal.timeout(Math.max(1, Math.floor(timeout))),
        });
        return { status: () => result.status, json: () => result.json() };
      },
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('actual local health becomes ready after startup without replacing its source', async () => {
  let requests = 0;
  const fixture = await localHealth((_request, response) => {
    requests++;
    response.writeHead(requests === 1 ? 503 : 200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify(
        requests === 1
          ? { releaseSha: '' }
          : {
              releaseSha: sourceSha,
              running: requests >= 3,
            }
      )
    );
  });
  try {
    const receipt = await waitForExactEngineReady({ ...fixture, sourceSha });
    assert.equal(requests, 3);
    assert.equal(receipt.observations, 3);
    assert.equal(receipt.timeout_ms, 90000);
    assert.equal(receipt.source_sha, sourceSha);
    assert.equal(receipt.running, true);
    assert.ok(receipt.elapsed_ms >= 0 && receipt.elapsed_ms < ENGINE_READINESS_TIMEOUT_MS);
  } finally {
    await fixture.close();
  }
});

test('a wrong nonempty source is refused immediately even on a startup response', async () => {
  let requests = 0,
    sleeps = 0;
  const fixture = await localHealth((_request, response) => {
    requests++;
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ releaseSha: 'b'.repeat(40), running: false }));
  });
  try {
    await assert.rejects(
      waitForExactEngineReady({
        ...fixture,
        sourceSha,
        sleep: async () => {
          sleeps++;
        },
      }),
      /RELEASE_SEMANTIC_ENGINE_SOURCE_MISMATCH/
    );
    assert.equal(requests, 1);
    assert.equal(sleeps, 0);
  } finally {
    await fixture.close();
  }
});

test('startup transport failures exhaust the original ninety-second bound', async () => {
  let elapsed = 0;
  const timeouts = [];
  await assert.rejects(
    waitForExactEngineReady({
      sourceSha,
      healthUrl: 'http://fixture.invalid/health',
      now: () => elapsed,
      sleep: async (milliseconds) => {
        elapsed += milliseconds;
      },
      request: {
        async get(_url, { timeout }) {
          assert.ok(timeout > 0 && timeout <= 3000);
          assert.ok(timeout <= ENGINE_READINESS_TIMEOUT_MS - elapsed);
          timeouts.push(timeout);
          elapsed += timeout;
          throw new Error('startup transport timeout');
        },
      },
    }),
    /RELEASE_SEMANTIC_ENGINE_READINESS_TIMEOUT/
  );
  assert.equal(elapsed, ENGINE_READINESS_TIMEOUT_MS);
  assert.ok(timeouts.length > 1);
});

test('a correct but late health response cannot reset or exceed the readiness budget', async () => {
  let elapsed = 0;
  await assert.rejects(
    waitForExactEngineReady({
      sourceSha,
      healthUrl: 'http://fixture.invalid/health',
      now: () => elapsed,
      request: {
        async get() {
          elapsed = ENGINE_READINESS_TIMEOUT_MS + 1;
          return {
            status: () => 200,
            json: async () => ({ releaseSha: sourceSha, running: true }),
          };
        },
      },
    }),
    /RELEASE_SEMANTIC_ENGINE_READINESS_TIMEOUT/
  );
});

test('running without an exact source never qualifies before timeout', async () => {
  let elapsed = 0;
  await assert.rejects(
    waitForExactEngineReady({
      sourceSha,
      healthUrl: 'http://fixture.invalid/health',
      now: () => elapsed,
      sleep: async (milliseconds) => {
        elapsed += milliseconds;
      },
      request: {
        async get() {
          return { status: () => 200, json: async () => ({ releaseSha: '', running: true }) };
        },
      },
    }),
    /RELEASE_SEMANTIC_ENGINE_READINESS_TIMEOUT/
  );
  assert.equal(elapsed, ENGINE_READINESS_TIMEOUT_MS);
});
