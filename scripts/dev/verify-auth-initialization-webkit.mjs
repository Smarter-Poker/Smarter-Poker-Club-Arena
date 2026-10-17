/** Explicit local qualification only: no production identity, requests or writes. */
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { webkit } from '@playwright/test';

const bundle = buildSync({
  entryPoints: [resolve(process.argv[2] || 'node_modules/@supabase/auth-js/dist/module/index.js')],
  nodePaths: [resolve('node_modules')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'FixtureAuth',
  write: false,
  logLevel: 'silent',
}).outputFiles[0].text;
const server = createServer((request, response) => {
  if (request.url === '/sdk.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(bundle);
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><script src="/sdk.js"></script>');
  }
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
let browser;
try {
  browser = await webkit.launch({ headless: true });
  const context = await browser.newContext();
  const owner = await context.newPage();
  const subject = await context.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  await owner.goto(origin);
  await subject.goto(origin);
  await owner.evaluate(() => {
    window.fixtureHolding = false;
    window.fixtureOwner = navigator.locks.request('lock:sdk-recovery-native', () => {
      window.fixtureHolding = true;
      return new Promise((resolve) => {
        window.fixtureRelease = resolve;
      });
    });
  });
  await owner.waitForFunction(() => window.fixtureHolding, { timeout: 5_000 });
  const first = await subject.evaluate(async () => {
    window.fixtureReads = [];
    window.fixtureClient = new FixtureAuth.AuthClient({
      url: 'https://auth-fixture.invalid/auth/v1',
      storageKey: 'sdk-recovery-native',
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
      lockAcquireTimeout: 50, // Local controlled acquisition refusal, never production config.
      storage: {
        async getItem(key) {
          const state = await navigator.locks.query();
          window.fixtureReads.push(
            state.held.filter((lock) => lock.name === 'lock:sdk-recovery-native').length
          );
          return localStorage.getItem(key);
        },
        setItem: (key, value) => localStorage.setItem(key, value),
        removeItem: (key) => localStorage.removeItem(key),
      },
    });
    try {
      await window.fixtureClient.getSession();
      return 'unexpected-success';
    } catch (error) {
      return error.name;
    }
  });
  assert.equal(first, 'AbortError');
  await owner.evaluate(async () => {
    window.fixtureRelease();
    await window.fixtureOwner;
  });
  const recovered = await subject.evaluate(async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => window.fixtureClient.getSession())
    );
    return {
      errors: results.map((result) => result.error),
      sessions: results.map((result) => result.data.session),
      reads: window.fixtureReads,
    };
  });
  assert.deepEqual(recovered.errors, [null, null, null, null]);
  assert.deepEqual(recovered.sessions, [null, null, null, null]);
  assert.ok(recovered.reads.length > 0);
  assert.ok(
    recovered.reads.every((held) => held === 1),
    'Every SDK storage read must remain under the native exclusive lock'
  );
  const final = await subject.evaluate(() => navigator.locks.query());
  assert.equal(final.held.filter((lock) => lock.name === 'lock:sdk-recovery-native').length, 0);
  assert.equal(final.pending.filter((lock) => lock.name === 'lock:sdk-recovery-native').length, 0);
  console.log(
    JSON.stringify({
      first,
      recoveredRequests: 4,
      storageReadsUnderNativeLock: recovered.reads.length,
      finalHeld: 0,
      finalPending: 0,
    })
  );
} finally {
  await browser?.close();
  await new Promise((closed) => server.close(closed));
}
