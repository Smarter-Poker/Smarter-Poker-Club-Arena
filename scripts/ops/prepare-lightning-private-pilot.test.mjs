import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPilotClub,
  assertPilotGame,
  PILOT,
  pilotServiceFetch,
  selectPilotGame,
  preparePilot,
} from './prepare-lightning-private-pilot.mjs';
const club = {
  id: 'private-club',
  owner_id: PILOT.ownerId,
  name: PILOT.name,
  is_public: false,
  requires_approval: true,
  union_id: null,
};
const game = {
  id: 'private-game',
  club_id: club.id,
  union_id: null,
  name: PILOT.gameName,
  handedness: 6,
  variant: 'nlh',
  must_move: true,
  ruleset_snapshot: { options: { is_private: true } },
  lightning_enabled: false,
  cluster_mode: 'must_move',
};
test('requires the existing service owner, private standalone club and admission approval', () => {
  assert.doesNotThrow(() => assertPilotClub(club));
  for (const patch of [
    { owner_id: 'personal' },
    { is_public: true },
    { requires_approval: false },
    { union_id: 'public-union' },
    { name: 'Other Club' },
  ]) {
    assert.throws(() => assertPilotClub({ ...club, ...patch }));
  }
});

const windowRequest = 'aaf6c3a2-b098-4d65-8e47-647a6834900b';
const integrityRequest = 'b5e5c106-183e-4f9c-a37b-d72189567369';
const oldState = { cluster_mode: 'must_move', lightning_enabled: false };
function controlReceipt(action) {
  const telemetry = action === 'set_integrity_telemetry';
  return {
    ok: true,
    action,
    cluster_id: game.id,
    request_id: telemetry ? integrityRequest : windowRequest,
    idempotent: false,
    event_id: telemetry ? 102 : 101,
    before: { ...oldState, shadow_window_ms: 300000, integrity_telemetry: false },
    after: { ...oldState, shadow_window_ms: 60000, integrity_telemetry: telemetry },
  };
}
async function runPilotWithReceipt(replaceReceipt, finalGame = game, finalMembers) {
  let clients = 0;
  const signedOut = [];
  let rosterReads = 0;
  const factory = () => {
    if (clients++ === 0)
      return {
        from(table) {
          const data =
            table === 'profiles'
              ? { id: PILOT.ownerId, role: 'god', status: 'active', is_horse: false }
              : table === 'club_members'
                ? rosterReads++ > 0 && finalMembers
                  ? finalMembers
                  : [{ user_id: PILOT.ownerId, status: 'active', role: 'owner' }]
                : [game];
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            maybeSingle: async () => ({ data: table === 'cash_games' ? finalGame : data }),
            then(resolve, reject) {
              return Promise.resolve({ data }).then(resolve, reject);
            },
          };
        },
        rpc: async () => ({
          data: {
            ok: true,
            worker_mode: 'off',
            shadow_window_ms: 60000,
            matcher_version: 'm1',
            integrity_telemetry: true,
          },
        }),
      };
    return {
      auth: {
        signInWithPassword: async () => ({ data: { user: { id: PILOT.ownerId } } }),
        signOut: async (args) => {
          signedOut.push(args);
        },
      },
      rpc: async (name, args) => ({
        data:
          name === 'fn_create_club_atomic'
            ? club
            : replaceReceipt(controlReceipt(args.p_action), args.p_action),
      }),
    };
  };
  try {
    return await preparePilot(
      {
        SP_EMAIL: PILOT.ownerEmail,
        SP_PASS: 'isolated_fixture',
        SUPABASE_URL: 'https://isolated.invalid',
        SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test_fixture',
      },
      factory
    );
  } finally {
    assert.deepEqual(signedOut, [{ scope: 'local' }]);
  }
}

for (const [name, replace] of [
  ['empty success', () => ({ ok: true })],
  ['different cluster', (r) => ({ ...r, cluster_id: 'different-cluster' })],
  ['different action', (r) => ({ ...r, action: 'pause' })],
  ['different request', (r) => ({ ...r, request_id: 'different-request' })],
  ['missing state', (r) => ({ ...r, after: null })],
  ['blank state mode', (r) => ({ ...r, after: { ...r.after, cluster_mode: '' } })],
  ['missing mutation audit', (r) => ({ ...r, event_id: null })],
  ['contradictory window', (r) => ({ ...r, after: { ...r.after, shadow_window_ms: 60001 } })],
])
  test(`pilot never qualifies ${name} even when current configuration already matches`, async () => {
    await assert.rejects(runPilotWithReceipt(replace), /Receipt/);
  });

test('pilot never qualifies a contradictory telemetry receipt', async () => {
  await assert.rejects(
    runPilotWithReceipt((r, action) =>
      action === 'set_integrity_telemetry'
        ? { ...r, after: { ...r.after, integrity_telemetry: false } }
        : r
    ),
    /Receipt/
  );
});

test('pilot qualifies complete current receipts through the original setup flow', async () => {
  const receipt = await runPilotWithReceipt((r) => r);
  assert.equal(receipt.windowRequestId, windowRequest);
  assert.equal(receipt.integrityRequestId, integrityRequest);
  assert.equal(receipt.windowEventId, 101);
  assert.equal(receipt.integrityTelemetry, true);
});

for (const already of [false, true])
  test(`pilot preserves historical window replay (already=${already})`, async () => {
    const receipt = await runPilotWithReceipt((r, action) =>
      action !== 'set_shadow_window'
        ? r
        : {
            ...r,
            idempotent: true,
            replayed: true,
            already,
            event_id: already ? null : 101,
            before: oldState,
            after: oldState,
            detail: already ? {} : { shadow_window_ms: 60000 },
          }
    );
    assert.equal(receipt.windowEventId, already ? null : 101);
    assert.equal(receipt.shadowWindowMs, 60000);
  });

test('pilot qualifies legitimate new ALREADY receipts without fabricating an event', async () => {
  const receipt = await runPilotWithReceipt((r) => ({
    ...r,
    idempotent: true,
    already: true,
    event_id: null,
    before: r.after,
  }));
  assert.equal(receipt.windowEventId, null);
  assert.equal(receipt.integrityEventId, null);
});

test('pilot refuses ALREADY when its before and after states differ', async () => {
  await assert.rejects(
    runPilotWithReceipt((r) => ({
      ...r,
      idempotent: true,
      already: true,
      event_id: null,
    })),
    /Receipt/
  );
});

test('pilot refuses activation that occurs after its initial game check', async () => {
  await assert.rejects(
    runPilotWithReceipt((r) => r, { ...game, cluster_mode: 'lightning', lightning_enabled: true }),
    /Already Active/
  );
});

test('pilot refuses participant admission that occurs after its initial roster check', async () => {
  await assert.rejects(
    runPilotWithReceipt((r) => r, game, [
      { user_id: PILOT.ownerId, status: 'active', role: 'owner' },
      { user_id: 'new-participant', status: 'active', role: 'member' },
    ]),
    /Participants/
  );
});

for (const action of ['set_shadow_window', 'set_integrity_telemetry'])
  test(`pilot reports ${action} contention as pending with the same operation ID`, async () => {
    await assert.rejects(
      runPilotWithReceipt((r, current) =>
        current === action
          ? { ok: false, code: 'REQUEST_IN_PROGRESS', request_id: r.request_id }
          : r
      ),
      /Still In Progress; Retry The Same Operation ID/
    );
  });
test('refuses unrelated games, public games and activation during provisioning recovery', () => {
  assert.doesNotThrow(() => assertPilotGame(game, club.id));
  for (const patch of [
    { club_id: 'other' },
    { union_id: 'public-union' },
    { handedness: 9 },
    { must_move: false },
    { ruleset_snapshot: { options: { is_private: false } } },
    { lightning_enabled: true },
    { cluster_mode: 'lightning' },
  ]) {
    assert.throws(() => assertPilotGame({ ...game, ...patch }, club.id));
  }
});

test('service readback uses the configured key generation and drops caller authentication', async () => {
  for (const key of ['sb_secret_current', 'legacy.jwt.key']) {
    let seen;
    const run = pilotServiceFetch(key, async (_url, init) => {
      seen = init.headers;
      return { ok: true };
    });
    await run('https://configured-project/rest/v1/profiles', {
      headers: {
        Authorization: 'Bearer wrong-user',
        'Content-Type': 'application/json',
        'x-smarter-data-actor': 'wrong-actor',
      },
    });
    assert.equal(seen.apikey, key);
    assert.equal(seen.Authorization, key.startsWith('sb_secret_') ? undefined : `Bearer ${key}`);
    assert.equal(seen['x-smarter-data-actor'], 'service');
    assert.equal(seen['Content-Type'] || seen['content-type'], 'application/json');
  }
});

test('preserves normal seeded games and recovers only the specifically named private pilot', () => {
  const defaults = Array.from({ length: 9 }, (_, n) => ({
    ...game,
    id: `default-${n}`,
    name: `Default Game ${n}`,
    ruleset_snapshot: { options: { is_private: false } },
  }));
  assert.equal(selectPilotGame(defaults, club.id), null);
  assert.equal(selectPilotGame([...defaults, game], club.id), game);
  assert.throws(() => selectPilotGame([...defaults, game, { ...game, id: 'duplicate' }], club.id));
  assert.throws(() => selectPilotGame([...defaults, { ...game, club_id: 'other' }], club.id));
  assert.throws(() =>
    selectPilotGame(
      [...defaults, { ...game, ruleset_snapshot: { options: { is_private: false } } }],
      club.id
    )
  );
  assert.throws(() =>
    selectPilotGame([...defaults, { ...game, lightning_enabled: true }], club.id)
  );
});
