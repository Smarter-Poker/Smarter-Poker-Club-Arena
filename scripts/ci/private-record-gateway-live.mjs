#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createProductionE2EAccount,
  cleanupProductionE2EAccount,
} from './production-e2e-account.mjs';

const CLUB = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const ORIGIN = 'https://smarter.poker';
const BASE = 'https://ca-static.smarter.poker/private-record';
const KEY = 'sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx';
const PRODUCTION = 'https://kuklfnapbkmacvwxktbh.supabase.co';

/** Finite live certificate. All account lifecycle writes use the existing reserved owner. */
export async function qualifyGatewayLive({
  revision,
  environment,
  fetchImpl,
  connect,
  createAccount = createProductionE2EAccount,
  cleanupAccount = cleanupProductionE2EAccount,
}) {
  assert.match(revision, /^[0-9a-f]{40}$/);
  assert.equal(environment.SUPABASE_URL?.replace(/\/$/, ''), PRODUCTION);
  assert.ok(
    environment.SUPABASE_SERVICE_ROLE_KEY && environment.RUNNER_TEMP && environment.GITHUB_ENV
  );
  let deadline = Date.now() + 120_000;
  const boundedFetch = (url, options = {}) => {
    assert.ok(Date.now() < deadline, 'gateway proof deadline');
    const signal = AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now())));
    return fetchImpl(url, {
      ...options,
      redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal,
    });
  };
  async function json(url, options = {}) {
    const response = await boundedFetch(url, options);
    assert.ok(response.ok, 'gateway proof request refused');
    if (response.status === 204) return null;
    assert.ok(response.body, 'gateway proof response body missing');
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        assert.ok(bytes <= 131072, 'gateway proof response too large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
  }
  async function health() {
    const value = await json(`${BASE}/health?proof=${randomUUID()}`, {
      headers: { 'Cache-Control': 'no-cache' },
    });
    assert.equal(value.service, 'private-record-gateway');
    assert.equal(value.revision, revision);
    assert.equal(value.processReachable, true);
    assert.equal(value.sourceReady, true);
  }
  const sockets = [];
  let account;
  let creationAttempted = false;
  let passed = false;
  let cleanupVerified = false;
  // Existing helper retries remain finite inside this stricter overall budget.
  const wait = async (milliseconds) => {
    assert.ok(Date.now() + milliseconds < deadline, 'gateway proof wait budget');
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  };
  try {
    await health();
    creationAttempted = true;
    account = await createAccount({ environment, fetchImpl: boundedFetch, wait });
    assert.match(account.email, /^ca-customization-cert-postdeploy-.*@example\.invalid$/);
    assert.match(account.id, /^[0-9a-f-]{36}$/);
    const session = await json(`${PRODUCTION}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: account.email, password: account.password }),
    });
    assert.equal(session.user?.id, account.id);
    assert.ok(typeof session.access_token === 'string');
    const claims = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url'));
    assert.equal(claims.sub, account.id);
    assert.match(claims.session_id, /^[0-9a-f-]{36}$/);
    const headers = {
      apikey: KEY,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    };
    const actor = (route, body) =>
      json(`${PRODUCTION}/rest/v1/${route}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    const user = await json(`${PRODUCTION}/auth/v1/user`, { headers });
    assert.equal(user.id, account.id);
    const join = await actor('rpc/fn_join_club', { p_club_id: CLUB });
    assert.ok(!join?.error && join?.success !== false, 'fixture public join refused');
    const topic = `club-roster:${CLUB}`;
    assert.equal(await actor('rpc/ca_club_roster_can_subscribe', { topic }), true);
    const allowed = await connect({
      url: `${BASE.replace('https:', 'wss:')}/ws/channel`,
      token: session.access_token,
      origin: ORIGIN,
    });
    sockets.push(allowed);
    allowed.send({ type: 'JOIN_PRIVATE_RECORD', topic });
    await allowed.expect(
      (frame) =>
        frame.type === 'PRIVATE_RECORD_STATUS' && frame.topic === topic && frame.ready === true
    );
    const ownTopic = `member-record:${CLUB}:${account.id}`;
    assert.equal(await actor('rpc/ca_member_record_can_subscribe', { topic: ownTopic }), true);
    allowed.send({ type: 'JOIN_PRIVATE_RECORD', topic: ownTopic });
    await allowed.expect(
      (frame) =>
        frame.type === 'PRIVATE_RECORD_STATUS' && frame.topic === ownTopic && frame.ready === true
    );
    const foreignTopic = `member-record:${CLUB}:${randomUUID()}`;
    assert.equal(await actor('rpc/ca_member_record_can_subscribe', { topic: foreignTopic }), false);
    const denied = await connect({
      url: `${BASE.replace('https:', 'wss:')}/ws/channel`,
      token: session.access_token,
      origin: ORIGIN,
    });
    sockets.push(denied);
    denied.send({ type: 'JOIN_PRIVATE_RECORD', topic: foreignTopic });
    await denied.expectDenied();
    for (const avatar of [
      '/avatars/table/free_ninja@2x.webp',
      '/avatars/table/free_shark@2x.webp',
    ]) {
      const changed = allowed.expect(
        (frame) => frame.type === 'PRIVATE_RECORD_CHANGED' && frame.topic === ownTopic
      );
      // Observe rejection immediately, even if the cosmetic write itself fails.
      void changed.catch(() => {});
      await json(`${PRODUCTION}/rest/v1/profiles?id=eq.${account.id}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ arena_avatar_url: avatar }),
      });
      await changed;
      const rows = await json(
        `${PRODUCTION}/rest/v1/profiles?select=id,arena_avatar_url&id=eq.${account.id}`,
        { headers }
      );
      assert.deepEqual(rows, [{ id: account.id, arena_avatar_url: avatar }]);
    }
    await health();
    passed = true;
  } finally {
    for (const socket of sockets) socket.close();
    deadline = Date.now() + 90_000;
    // A setup failure can precede the helper returning its account. Recover its
    // durable reserved record through the same guarded cleanup owner.
    if (account) {
      cleanupVerified = await cleanupAccount({
        environment,
        fetchImpl: boundedFetch,
        wait,
        record: account,
      });
      assert.equal(cleanupVerified, true, 'reserved fixture cleanup not verified');
    } else if (creationAttempted) {
      await cleanupAccount({ environment, fetchImpl: boundedFetch, wait });
    }
  }
  assert.ok(passed && cleanupVerified);
  return {
    schema: 1,
    component: 'private-record-gateway-live',
    revision,
    genuineAuthAndSession: true,
    allowedRosterReady: true,
    deniedForeignTopic: true,
    cosmeticSourceInvalidation: true,
    readerReadback: true,
    cleanupVerified,
    isolatedMidstreamAclRevocation: false,
    paidRetirementQualified: false,
  };
}

/** No protocols, tokens, URLs or provider exceptions are ever emitted. */
export function socketConnector(WebSocket) {
  return ({ url, token, origin }) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url, ['bearer', token], {
        origin,
        handshakeTimeout: 8000,
        maxPayload: 16384,
      });
      const frames = [];
      let closed;
      let opened = false;
      let waiter;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('gateway socket open timeout'));
      }, 10_000);
      const wake = () => waiter?.();
      ws.on('error', () => {
        closed = -1;
        clearTimeout(timer);
        wake();
        reject(new Error('gateway socket failed'));
      });
      ws.on('close', (code) => {
        closed = code;
        clearTimeout(timer);
        wake();
        if (!opened) reject(new Error('gateway socket closed before open'));
      });
      ws.on('message', (raw) => {
        try {
          frames.push(JSON.parse(String(raw)));
        } catch {
          closed = -1;
          ws.terminate();
        }
        if (frames.length > 128) {
          closed = -1;
          ws.terminate();
        }
        wake();
      });
      async function until(check) {
        const limit = Date.now() + 12_000;
        for (;;) {
          if (check()) return;
          assert.equal(closed, undefined, 'gateway socket closed before proof');
          const remaining = limit - Date.now();
          assert.ok(remaining > 0, 'gateway frame timeout');
          await new Promise((done) => {
            const timeout = setTimeout(() => {
              waiter = undefined;
              done();
            }, remaining);
            waiter = () => {
              clearTimeout(timeout);
              waiter = undefined;
              done();
            };
          });
        }
      }
      ws.once('open', () => {
        opened = true;
        clearTimeout(timer);
        resolve({
          send: (value) => ws.send(JSON.stringify(value)),
          close: () => ws.terminate(),
          expect: (predicate) =>
            until(() => {
              const index = frames.findIndex(predicate);
              if (index < 0) return false;
              frames.splice(0, index + 1);
              return true;
            }),
          expectDenied: () =>
            until(() => {
              assert.equal(frames.length, 0, 'denied topic emitted a private frame');
              if (closed === undefined) return false;
              assert.equal(closed, 4403, 'denied topic wrong close code');
              return true;
            }),
        });
      });
    });
}

export async function main(environment = process.env) {
  assert.equal(environment.GITHUB_ACTIONS, 'true');
  assert.match(environment.GITHUB_RUN_ID || '', /^[0-9]+$/);
  assert.equal(environment.PRIVATE_RECORD_GATEWAY_LIVE_CHECK, '1');
  const require = createRequire(new URL('../../server/package.json', import.meta.url));
  const result = await qualifyGatewayLive({
    revision: environment.EXPECTED_GATEWAY_REVISION,
    environment,
    fetchImpl: fetch,
    connect: socketConnector(require('ws')),
  });
  await writeFile(
    join(environment.RUNNER_TEMP, 'private-record-gateway-live.json'),
    `${JSON.stringify(result)}\n`,
    { mode: 0o600 }
  );
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error('private record gateway live proof failed; fixture recovery may be required');
      process.exitCode = 1;
    });
}
