import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPlayerPin,
  renderHand,
  openPlayerSession,
  validatePlayer,
  witnessPlayer,
  acceptPlayerTerms,
  CONSENT_PLAYERS,
} from './lightning-pilot-player.mjs';
import { readFileSync } from 'node:fs';

function termsPage(initial = 'not_accepted', identity = true) {
  let status = initial;
  const calls = [];
  const dialog = {
    waitFor: async () => calls.push('visible'),
    locator: () => ({ evaluate: async () => calls.push('scroll') }),
    getByRole: (role) =>
      role === 'checkbox'
        ? { check: async () => calls.push('check') }
        : {
            click: async () => {
              calls.push('accept');
              status = 'accepted';
            },
          },
  };
  return {
    calls,
    page: {
      waitForFunction: async () => {},
      locator: () => ({ getAttribute: async () => status }),
      evaluate: async (_fn, args) => {
        calls.push('identity');
        Object.defineProperty(calls, 'identityId', { value: args.id, configurable: true });
        return identity;
      },
      getByRole: () => dialog,
    },
  };
}
test('player consent default refuses an owed gate without writing', async () => {
  const f = termsPage();
  await assert.rejects(
    acceptPlayerTerms(f.page, { user: { id: pin.playerId } }, pin, 'https://example.invalid')
  );
  assert.deepEqual(f.calls, []);
});
test('authorized pinned player accepts through visible normal UI and confirmed gate', async () => {
  const f = termsPage();
  const r = await acceptPlayerTerms(
    f.page,
    { user: { id: pin.playerId }, access_token: 'fixture-only' },
    pin,
    'https://example.invalid',
    true
  );
  assert.equal(r.acceptedNow, true);
  assert.deepEqual(f.calls, ['identity', 'visible', 'scroll', 'check', 'accept']);
});
test('accepted gate makes no duplicate acceptance request', async () => {
  const f = termsPage('accepted');
  assert.equal(
    (
      await acceptPlayerTerms(
        f.page,
        { user: { id: pin.playerId } },
        pin,
        'https://example.invalid',
        true
      )
    ).acceptedNow,
    false
  );
  assert.deepEqual(f.calls, []);
});
test('browser identity mismatch refuses consent before any UI write', async () => {
  const f = termsPage('not_accepted', false);
  await assert.rejects(
    acceptPlayerTerms(f.page, { user: { id: pin.playerId } }, pin, 'https://example.invalid', true)
  );
  assert.deepEqual(f.calls, ['identity']);
  await assert.rejects(
    acceptPlayerTerms(f.page, { user: { id: pin.clubId } }, pin, 'https://example.invalid', true)
  );
});
const pin = {
  playerId: '0097309f-2864-4d09-b02b-56bca012a9c3',
  poolSessionId: '11111111-1111-4111-8111-111111111111',
  clubId: 'e14bc9f7-736d-425f-8f2c-e78305ebac1d',
  clusterId: 'babb43f1-368e-406f-a97a-a0d5013648b2',
};
function fixture(change = {}) {
  const calls = [];
  const rows = {
    clubs: {
      id: pin.clubId,
      owner_id: '2d1cd6c3-5700-4af9-a271-d4863fdab20d',
      name: 'Lightning Internal Pilot',
      is_public: false,
      requires_approval: true,
    },
    cash_games: {
      id: pin.clusterId,
      club_id: pin.clubId,
      name: 'Lightning Pilot NLH Action 6',
      template_name: 'action',
      handedness: 6,
      sb: 0.01,
      bb: 0.02,
      variant: 'nlh',
      enabled: true,
      must_move: true,
      ruleset_snapshot: {
        template: 'action',
        variant: 'nlh',
        regular_ante: 'sb',
        vpip_floor: 30,
        vpip_window: 10,
        bombs: { enabled: true, trigger: 'timed_15m', ante_bb: 2, boards: 2 },
        options: { is_private: true },
      },
      cluster_mode: 'lightning',
      lightning_enabled: true,
    },
    profiles: { id: pin.playerId, is_horse: true, status: 'active' },
    club_members: { user_id: pin.playerId, role: 'player', status: 'active', chip_balance: 10 },
    lightning_pool_session: {
      id: pin.poolSessionId,
      player_id: pin.playerId,
      cluster_id: pin.clusterId,
      state: 'active',
      exited_at: null,
    },
    ...change,
  };
  const user = { id: pin.playerId, email: 'existing@bot.smarter.poker' };
  const client = {
    auth: {
      verifyOtp: async () => ({ data: { user, session: { user, access_token: 'fixture-only' } } }),
      getUser: async () => ({ data: { user } }),
      signOut: async (opts) => {
        calls.push(opts);
        return {};
      },
    },
    rpc: async () => ({
      data: [{ pool_session_id: pin.poolSessionId, cluster_id: pin.clusterId }],
    }),
  };
  const admin = {
    from: (table) => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: rows[table] }) };
      return q;
    },
    auth: {
      admin: {
        getUserById: async () => ({ data: { user } }),
        generateLink: async () => ({
          data: { user, properties: { hashed_token: 'fixture-only' } },
        }),
      },
    },
  };
  return { admin, client, calls };
}
test('no unspecified or outside-pilot participant can be selected', () => {
  assert.doesNotThrow(() => assertPlayerPin(pin));
  for (const p of [null, {}, { ...pin, clubId: pin.playerId }, { ...pin, clusterId: 'not-a-uuid' }])
    assert.throws(() => assertPlayerPin(p));
});
test('existing funded active pilot scope is read before login', async () => {
  const f = fixture();
  assert.equal(
    (await openPlayerSession(f.admin, () => f.client, 'https://example.invalid', pin)).session.user
      .id,
    pin.playerId
  );
});
for (const [table, row] of [
  ['profiles', { id: pin.playerId, is_horse: false }],
  ['club_members', { user_id: pin.playerId, role: 'player', status: 'pending', chip_balance: 0 }],
  [
    'lightning_pool_session',
    {
      id: pin.poolSessionId,
      player_id: pin.playerId,
      cluster_id: pin.clusterId,
      state: 'closed',
      exited_at: 'now',
    },
  ],
]) {
  test(`changed ${table} refuses before authentication`, async () => {
    const f = fixture({ [table]: row });
    await assert.rejects(validatePlayer(f.admin, pin));
  });
}
test('identity mismatch cleans only the created synthetic session', async () => {
  const f = fixture();
  f.client.auth.getUser = async () => ({ data: { user: { id: pin.clubId } } });
  await assert.rejects(openPlayerSession(f.admin, () => f.client, 'https://example.invalid', pin));
  assert.deepEqual(f.calls, [{ scope: 'local' }]);
});
test('only actual outgoing room render identities qualify; no card-bearing frames retained', () => {
  const hand = pin.playerId;
  assert.equal(
    renderHand(
      JSON.stringify({ type: 'RENDER_ACK', tableId: pin.poolSessionId, hand_id: hand }),
      pin.poolSessionId
    ),
    hand
  );
  for (const payload of [
    'garbage',
    JSON.stringify({ type: 'STATE', hand_id: hand }),
    JSON.stringify({ type: 'RENDER_ACK', tableId: pin.clubId, hand_id: hand }),
  ])
    assert.equal(renderHand(payload, pin.poolSessionId), null);
});

test('fixtures match maintained SQL, UI sender and HTTP producer contracts', () => {
  const source = (name) => readFileSync(new URL('../../' + name, import.meta.url), 'utf8');
  const schema = source(
    'supabase/migrations/20260920235343_lightning_phase_2_the_pool_the_instance_the_reservation_and_.sql'
  );
  assert.match(schema, /state IN \([\s\S]*?'active'/);
  assert.match(schema, /hand_id\s+uuid/);
  const sessions = source(
    'supabase/migrations/20261007212735_lightning_phase_8_multi_table_limits_session_statistics_pool.sql'
  );
  const body = sessions.slice(
    sessions.indexOf('CREATE OR REPLACE FUNCTION public.fn_lightning_my_sessions()'),
    sessions.indexOf('-- 6. POOL STATUS')
  );
  for (const key of [
    'pool_session_id',
    'cluster_id',
    'name',
    'stakes',
    'variant',
    'stack',
    'in_hand',
  ])
    assert.ok(body.includes("'" + key + "'"));
  assert.match(body, /coalesce\(jsonb_agg/);
  assert.match(
    source('src/services/GameServerAPI.ts'),
    /JSON.stringify\(\{ tableId, action, amount, idempotencyKey, actionContext \}\)/
  );
  assert.match(source('server/src/handlers/action.ts'), /result.success.*\? 200 : 400/);
  assert.match(
    source('src/services/EngineStateClient.ts'),
    /type: 'RENDER_ACK', tableId: this.opts.tableId, hand_id: handId/
  );
});

function fakeBrowser(refused = false) {
  let frame,
    respond,
    serial = 1;
  const calls = [];
  const emit = () =>
    frame({
      payload: JSON.stringify({
        type: 'RENDER_ACK',
        tableId: pin.poolSessionId,
        hand_id: `11111111-1111-4111-8111-${String(serial++).padStart(12, '0')}`,
      }),
    });
  const page = {
    waitForFunction: async () => {},
    locator: () => ({ getAttribute: async () => 'accepted' }),
    on: (type, fn) => {
      assert.equal(type, 'websocket');
      fn({
        on: (event, cb) => {
          assert.equal(event, 'framesent');
          frame = cb;
        },
      });
    },
    goto: async (url) => {
      calls.push(url);
      emit();
    },
    setViewportSize: async () => emit(),
    evaluate: async () => ({ clientWidth: 375, scrollWidth: 375 }),
    getByTestId: (selector) => ({
      waitFor: async () => {},
      click: async (options) => {
        if (options.trial) return;
        const kind = selector === 'lightning-fold' ? 'fast_fold' : 'fold_watch';
        calls.push(kind);
        const response = {
          ok: () => !refused,
          json: async () => ({ success: !refused }),
          url: () => 'https://engine.smarter.poker/action',
          request: () => ({
            method: () => 'POST',
            postDataJSON: () => ({ tableId: pin.poolSessionId, action: kind }),
          }),
        };
        respond(response);
        if (!refused) emit();
      },
    }),
    waitForResponse: (predicate) =>
      new Promise((resolve) => {
        respond = (r) => {
          assert.equal(predicate(r), true);
          resolve(r);
        };
      }),
  };
  const chromium = {
    launch: async () => ({
      close: async () => calls.push('closed'),
      newContext: async () => ({ addInitScript: async () => {}, newPage: async () => page }),
    }),
  };
  return { chromium, calls };
}
test('finite browser witness traverses six normal UI actions and actual next-render observations', async () => {
  const f = fixture(),
    b = fakeBrowser();
  const r = await witnessPlayer({
    admin: f.admin,
    createClient: () => f.client,
    chromium: b.chromium,
    url: 'https://example.invalid',
    pin,
  });
  assert.equal(r.status, 'observed');
  assert.equal(r.scope, 'sample_only');
  assert.equal(r.devices.length, 3);
  assert.equal(
    r.devices.flatMap((d) => d.actions).filter((a) => a.accepted && a.nextHand === 'observed')
      .length,
    6
  );
  assert.equal(b.calls.filter((v) => ['fast_fold', 'fold_watch'].includes(v)).length, 6);
  assert.deepEqual(f.calls, [{ scope: 'local' }]);
});
test('a horse/action race refuses honestly, stops further action and cleans its local session', async () => {
  const f = fixture(),
    b = fakeBrowser(true);
  const r = await witnessPlayer({
    admin: f.admin,
    createClient: () => f.client,
    chromium: b.chromium,
    url: 'https://example.invalid',
    pin,
  });
  assert.equal(r.status, 'unknown');
  assert.equal(r.devices[0].actions[0].accepted, false);
  assert.equal(b.calls.filter((v) => ['fast_fold', 'fold_watch'].includes(v)).length, 1);
  assert.deepEqual(f.calls, [{ scope: 'local' }]);
});

test('Samantha consent requires exact authorized pin and matching browser identity', async () => {
  const samantha = { ...pin, playerId: 'a23ca5c9-b748-482f-9b59-9db35f7aa996' };
  assert.deepEqual(CONSENT_PLAYERS, [pin.playerId, samantha.playerId]);
  assert.equal(Object.isFrozen(CONSENT_PLAYERS), true);
  const f = termsPage();
  const result = await acceptPlayerTerms(
    f.page,
    { user: { id: samantha.playerId } },
    samantha,
    'https://example.invalid',
    true
  );
  assert.equal(result.acceptedNow, true);
  assert.equal(f.calls.identityId, samantha.playerId);
  assert.deepEqual(Array.from(f.calls), ['identity', 'visible', 'scroll', 'check', 'accept']);
  const noFlag = termsPage();
  await assert.rejects(
    acceptPlayerTerms(
      noFlag.page,
      { user: { id: samantha.playerId } },
      samantha,
      'https://example.invalid'
    )
  );
  assert.deepEqual(noFlag.calls, []);
  for (const [actorPin, sessionId] of [
    [samantha, pin.playerId],
    [{ ...pin, playerId: pin.poolSessionId }, pin.poolSessionId],
  ]) {
    const denied = termsPage();
    await assert.rejects(
      acceptPlayerTerms(
        denied.page,
        { user: { id: sessionId } },
        actorPin,
        'https://example.invalid',
        true
      )
    );
    assert.deepEqual(denied.calls, []);
  }
});

test('Classic cannot be selected as an active Lightning pilot before authentication', async () => {
  const valid = fixture();
  const game = (await valid.admin.from('cash_games').maybeSingle()).data;
  const f = fixture({ cash_games: { ...game, template_name: 'classic' } });
  await assert.rejects(openPlayerSession(f.admin, () => f.client, 'https://example.invalid', pin));
  assert.deepEqual(f.calls, []);
});
