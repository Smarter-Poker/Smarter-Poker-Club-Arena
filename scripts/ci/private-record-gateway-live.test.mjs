import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { qualifyGatewayLive, main, socketConnector } from './private-record-gateway-live.mjs';
const revision = 'a'.repeat(40);
const id = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
function fixture(failure) {
  const calls = [];
  let avatar;
  let healthReads = 0;
  const account = {
    id,
    email: 'ca-customization-cert-postdeploy-owned@example.invalid',
    password: 'never-log-me',
  };
  const token = `e30.${Buffer.from(JSON.stringify({ sub: id, session_id: sessionId })).toString('base64url')}.signature`;
  const environment = {
    SUPABASE_URL: 'https://kuklfnapbkmacvwxktbh.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'never-log-service-key',
    RUNNER_TEMP: '/runner/private',
    GITHUB_ENV: '/runner/env',
  };
  return {
    calls,
    options: {
      revision,
      environment,
      async createAccount() {
        calls.push('create');
        return account;
      },
      async cleanupAccount({ record }) {
        assert.equal(record, account);
        calls.push('cleanup');
        return failure !== 'cleanup';
      },
      async fetchImpl(url, options) {
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        const path = new URL(url).pathname;
        calls.push(path);
        let value;
        if (path.endsWith('/health')) {
          healthReads++;
          value = {
            service: 'private-record-gateway',
            revision: failure === 'revision' ? 'b'.repeat(40) : revision,
            processReachable: true,
            sourceReady: failure !== 'source',
          };
        } else if (path.endsWith('/token')) value = { user: { id }, access_token: token };
        else if (path.endsWith('/user')) value = { id };
        else if (path.endsWith('/fn_join_club')) value = { success: failure !== 'join' };
        else if (path.endsWith('/ca_club_roster_can_subscribe')) value = failure !== 'acl';
        else if (path.endsWith('/ca_member_record_can_subscribe'))
          value = JSON.parse(options.body).topic.endsWith(id);
        else if (path.endsWith('/profiles') && options.method === 'PATCH') {
          assert.equal(options.headers.Authorization, `Bearer ${token}`);
          assert.deepEqual(Object.keys(JSON.parse(options.body)), ['arena_avatar_url']);
          avatar = JSON.parse(options.body).arena_avatar_url;
          return new Response(null, { status: 204 });
        } else if (path.endsWith('/profiles'))
          value = [{ id, arena_avatar_url: failure === 'reader' ? 'wrong' : avatar }];
        else throw new Error('unexpected route');
        return Response.json(value);
      },
      async connect({ url, token: actualToken, origin }) {
        assert.equal(url, 'wss://ca-static.smarter.poker/private-record/ws/channel');
        assert.equal(origin, 'https://smarter.poker');
        assert.equal(actualToken, token);
        let topic;
        return {
          send(value) {
            topic = value.topic;
            calls.push(value.type);
          },
          close() {
            calls.push('close');
          },
          async expect(predicate) {
            const changed = !!avatar;
            const frame = {
              type: changed ? 'PRIVATE_RECORD_CHANGED' : 'PRIVATE_RECORD_STATUS',
              topic,
              ready: true,
            };
            // The change waiter is armed before PATCH, as in the real asynchronous socket.
            if (!predicate(frame)) {
              await new Promise((resolve) => setImmediate(resolve));
            }
            if (failure === 'socket') throw new Error('provider secret must not reach CLI');
            const actual = avatar ? { type: 'PRIVATE_RECORD_CHANGED', topic } : frame;
            assert.equal(predicate(actual), true);
          },
          async expectDenied() {
            calls.push('denied');
            if (failure === 'denial') throw new Error('wrong close');
          },
        };
      },
    },
    get healthReads() {
      return healthReads;
    },
  };
}
test('genuine login route, bounded actor requests, cosmetic-only source and guarded cleanup', async () => {
  const f = fixture();
  const result = await qualifyGatewayLive(f.options);
  assert.equal(result.cleanupVerified, true);
  assert.equal(result.isolatedMidstreamAclRevocation, false);
  assert.equal(result.paidRetirementQualified, false);
  assert.equal(f.healthReads, 2);
  assert.ok(f.calls.indexOf('close') < f.calls.indexOf('cleanup'));
  assert.equal(f.calls.filter((x) => x === 'cleanup').length, 1);
});
for (const failure of ['join', 'acl', 'socket', 'denial', 'reader', 'cleanup']) {
  test(`fails closed and always cleans the owned account on ${failure}`, async () => {
    const f = fixture(failure);
    await assert.rejects(qualifyGatewayLive(f.options));
    assert.equal(f.calls.filter((x) => x === 'cleanup').length, 1);
  });
}
for (const failure of ['revision', 'source']) {
  test(`refuses ${failure} before creating any fixture`, async () => {
    const f = fixture(failure);
    await assert.rejects(qualifyGatewayLive(f.options));
    assert.ok(!f.calls.includes('create'));
  });
}
test('CLI refuses non-provider or unarmed execution before loading a socket or creating accounts', async () => {
  await assert.rejects(main({}));
  await assert.rejects(main({ GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '123' }));
});

class FakeSocket extends EventEmitter {
  static last;
  constructor() {
    super();
    FakeSocket.last = this;
  }
  terminate() {
    this.emit('close', 1006);
  }
  send() {}
}
async function connected() {
  const pending = socketConnector(FakeSocket)({
    url: 'wss://example.invalid',
    token: 'private',
    origin: 'https://smarter.poker',
  });
  FakeSocket.last.emit('open');
  return { peer: await pending, ws: FakeSocket.last };
}
test('socket adapter requires actual 4403 and no private frame for denial', async () => {
  const { peer, ws } = await connected();
  const denied = peer.expectDenied();
  ws.emit('close', 4403);
  await denied;
  const second = await connected();
  second.ws.emit('message', JSON.stringify({ type: 'PRIVATE_RECORD_STATUS' }));
  second.ws.emit('close', 4403);
  await assert.rejects(second.peer.expectDenied());
});
test('socket adapter refuses wrong close and close before open without hanging', async () => {
  const { peer, ws } = await connected();
  ws.emit('close', 1013);
  await assert.rejects(peer.expectDenied());
  const pending = socketConnector(FakeSocket)({
    url: 'wss://example.invalid',
    token: 'private',
    origin: 'https://smarter.poker',
  });
  FakeSocket.last.emit('close', 1006);
  await assert.rejects(pending);
});
