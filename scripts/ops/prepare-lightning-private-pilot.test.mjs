import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPilotClub,
  assertPilotGame,
  PILOT,
  PILOT_TARGETS,
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
  sb: 0.01,
  bb: 0.02,
  template_name: 'classic',
  enabled: true,
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
const game9 = {
  ...game,
  id: 'private-game-9',
  name: 'Lightning Pilot NLH 9',
  handedness: 9,
  sb: 0.02,
  bb: 0.04,
};
const windowRequest9 = 'fbb0c5d2-5e32-4852-88a1-2077e620a4c3';
const integrityRequest9 = '5ded3c91-dcb0-437a-b192-b072ec7b8ac9';
const oldState = { cluster_mode: 'must_move', lightning_enabled: false };
function controlReceipt(action, clusterId = game.id) {
  const telemetry = action === 'set_integrity_telemetry';
  return {
    ok: true,
    action,
    cluster_id: clusterId,
    request_id:
      clusterId === game9.id
        ? telemetry
          ? integrityRequest9
          : windowRequest9
        : telemetry
          ? integrityRequest
          : windowRequest,
    idempotent: false,
    event_id: clusterId === game9.id ? (telemetry ? 202 : 201) : telemetry ? 102 : 101,
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
                : table === 'clubs'
                  ? club
                  : [game, game9];
          return {
            select() {
              return this;
            },
            filterId: null,
            eq(key, value) {
              if (key === 'id') this.filterId = value;
              return this;
            },
            async maybeSingle() {
              return {
                data:
                  table === 'cash_games' ? (this.filterId === game9.id ? game9 : finalGame) : data,
              };
            },
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
            : replaceReceipt(controlReceipt(args.p_action, args.p_cluster_id), args.p_action),
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
      action !== 'set_shadow_window' || r.request_id !== windowRequest
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

test('prepares both explicitly named private table sizes without changing the original receipt identity', async () => {
  const receipt = await runPilotWithReceipt((r) => r);
  assert.deepEqual(
    receipt.targets?.map((t) => t.handedness),
    [6, 9]
  );
  assert.equal(receipt.clusterId, game.id);
  assert.equal(receipt.windowRequestId, windowRequest);
  assert.equal(receipt.targets[1].clusterId, game9.id);
  assert.equal(receipt.targets[1].windowRequestId, windowRequest9);
  assert.equal(receipt.targets[1].integrityRequestId, integrityRequest9);
});

async function runTwoTargetFlow(estate, options = {}) {
  const calls = [];
  const signedOut = [];
  let clients = 0;
  let rosterReads = 0;
  const ownerRoster = [{ user_id: PILOT.ownerId, status: 'active', role: 'owner' }];
  const factory = () =>
    clients++ === 0
      ? {
          from(table) {
            const filters = {};
            const data = () =>
              table === 'profiles'
                ? { id: PILOT.ownerId, role: 'god', status: 'active', is_horse: false }
                : table === 'club_members'
                  ? rosterReads++ > 0 && options.finalRoster
                    ? options.finalRoster
                    : ownerRoster
                  : table === 'clubs'
                    ? (options.finalClub ?? club)
                    : filters.id
                      ? (options.finalGames?.[filters.id] ??
                        estate.find((g) => g.id === filters.id))
                      : estate;
            return {
              select() {
                return this;
              },
              eq(key, value) {
                filters[key] = value;
                return this;
              },
              maybeSingle: async () => ({ data: data() }),
              then(resolve, reject) {
                return Promise.resolve({ data: data() }).then(resolve, reject);
              },
            };
          },
          async rpc(name, args) {
            calls.push({ name, args });
            return {
              data: {
                ok: true,
                worker_mode: 'off',
                shadow_window_ms: 60000,
                matcher_version: 'm1',
                integrity_telemetry: true,
                ...options.configs?.[args.p_cluster_id],
              },
            };
          },
        }
      : {
          auth: {
            signInWithPassword: async () => ({ data: { user: { id: PILOT.ownerId } } }),
            signOut: async (args) => {
              signedOut.push(args);
              return options.cleanupResult;
            },
          },
          async rpc(name, args) {
            calls.push({ name, args });
            if (name === 'fn_create_club_atomic') return { data: club };
            if (name === 'fn_cash_game_create') {
              const target = PILOT_TARGETS.find((t) => t.gameName === args.p_name);
              assert.ok(target);
              estate.push({
                ...game,
                id: target.handedness === 6 ? game.id : game9.id,
                name: target.gameName,
                handedness: target.handedness,
                sb: args.p_sb,
                bb: args.p_bb,
              });
              return options.creationFault
                ? { data: null, error: { code: 'UNKNOWN_ACK' } }
                : { data: { ok: true } };
            }
            const answer = controlReceipt(args.p_action, args.p_cluster_id);
            return { data: options.replaceReceipt?.(answer, args) ?? answer };
          },
        };
  try {
    const receipt = await preparePilot(
      {
        SP_EMAIL: PILOT.ownerEmail,
        SP_PASS: 'isolated_fixture',
        SUPABASE_URL: 'https://isolated.invalid',
        SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test_fixture',
      },
      factory
    );
    return { receipt, calls };
  } finally {
    assert.deepEqual(signedOut, [{ scope: 'local' }]);
    if (options.inspectCalls) options.inspectCalls(calls);
  }
}

test('target definitions retain all original IDs and use separate stable nine-seat operations and stakes', () => {
  assert.equal(PILOT_TARGETS[0].windowRequestId, windowRequest);
  assert.equal(PILOT_TARGETS[0].integrityRequestId, integrityRequest);
  assert.equal(PILOT_TARGETS[1].windowRequestId, windowRequest9);
  assert.equal(PILOT_TARGETS[1].integrityRequestId, integrityRequest9);
  assert.equal(
    new Set(PILOT_TARGETS.flatMap((t) => [t.windowRequestId, t.integrityRequestId])).size,
    4
  );
  assert.notEqual(PILOT_TARGETS[0].bb, PILOT_TARGETS[1].bb);
  assert.deepEqual(
    PILOT_TARGETS.map((t) => t.handedness),
    [6, 9]
  );
});

test('half-completed preparation creates only named nine-seat target and preserves all ordinary seeded games', async () => {
  const defaults = Array.from({ length: 9 }, (_, n) => ({
    ...game,
    id: `seed-${n}`,
    name: `Default ${n}`,
    handedness: 9,
    ruleset_snapshot: { options: { is_private: false } },
  }));
  const original = JSON.stringify(defaults);
  const estate = [...defaults, game];
  const { receipt, calls } = await runTwoTargetFlow(estate);
  const creations = calls.filter((c) => c.name === 'fn_cash_game_create');
  assert.equal(creations.length, 1);
  assert.deepEqual(creations[0].args, {
    p_club_id: club.id,
    p_template: 'classic',
    p_variant: 'nlh',
    p_sb: 0.02,
    p_bb: 0.04,
    p_handedness: 9,
    p_overrides: { options: { is_private: true }, lightning_enabled: false },
    p_name: game9.name,
    p_must_move: true,
  });
  assert.equal(JSON.stringify(estate.slice(0, 9)), original);
  assert.deepEqual(
    receipt.targets.map((t) => [
      t.handedness,
      t.workerMode,
      t.lightningEnabled,
      t.shadowWindowMs,
      t.integrityTelemetry,
    ]),
    [
      [6, 'off', false, 60000, true],
      [9, 'off', false, 60000, true],
    ]
  );
  const recovered = await runTwoTargetFlow(estate);
  assert.equal(recovered.calls.filter((c) => c.name === 'fn_cash_game_create').length, 0);
  assert.deepEqual(
    recovered.receipt.targets.map((t) => [t.windowRequestId, t.integrityRequestId]),
    receipt.targets.map((t) => [t.windowRequestId, t.integrityRequestId])
  );
});

test('unknown nine-seat creation acknowledgment ends once and explicit recovery reads durable target first', async () => {
  const estate = [game];
  let failedCalls;
  await assert.rejects(
    runTwoTargetFlow(estate, {
      creationFault: true,
      inspectCalls: (calls) => {
        failedCalls = calls;
      },
    }),
    /UNKNOWN_ACK/
  );
  assert.equal(failedCalls.filter((c) => c.name === 'fn_cash_game_create').length, 1);
  assert.equal(estate.filter((g) => g.name === game9.name).length, 1);
  const recovered = await runTwoTargetFlow(estate);
  assert.equal(recovered.calls.filter((c) => c.name === 'fn_cash_game_create').length, 0);
  assert.equal(recovered.receipt.targets[1].clusterId, game9.id);
});

for (const patch of [
  { sb: 0.03 },
  { bb: 0.05 },
  { enabled: false },
  { template_name: 'action' },
  { handedness: 6 },
  { lightning_enabled: true },
  { ruleset_snapshot: { options: { is_private: false } } },
])
  test(`nine-seat target identity refuses drift ${JSON.stringify(patch)}`, () => {
    assert.throws(() => selectPilotGame([game, { ...game9, ...patch }], club.id, PILOT_TARGETS[1]));
  });

test('ambiguous named nine-seat target is rejected before any operator write', async () => {
  let calls;
  await assert.rejects(
    runTwoTargetFlow([game, game9, { ...game9, id: 'duplicate' }], {
      inspectCalls: (seen) => {
        calls = seen;
      },
    }),
    /Ambiguous/
  );
  assert.equal(calls.filter((c) => c.name === 'fn_lightning_operator_control').length, 0);
});

test('never qualifies malformed nine-seat receipts or extends historical compatibility to a new operation', async () => {
  for (const mutation of [
    (r) => ({ ok: true }),
    (r) => ({ ...r, cluster_id: game.id }),
    (r) => ({ ...r, request_id: windowRequest }),
    (r) => ({
      ...r,
      idempotent: true,
      replayed: true,
      before: oldState,
      after: oldState,
      detail: { shadow_window_ms: 60000 },
    }),
  ]) {
    await assert.rejects(
      runTwoTargetFlow([game, game9], {
        replaceReceipt: (r, args) =>
          args.p_cluster_id === game9.id && args.p_action === 'set_shadow_window' ? mutation(r) : r,
      }),
      /Receipt/
    );
  }
});

for (const [label, options] of [
  [
    'activation',
    {
      finalGames: { [game9.id]: { ...game9, cluster_mode: 'lightning', lightning_enabled: true } },
    },
  ],
  ['stake drift', { finalGames: { [game9.id]: { ...game9, bb: 0.05 } } }],
  ['running worker', { configs: { [game9.id]: { worker_mode: 'form' } } }],
  ['public club', { finalClub: { ...club, is_public: true } }],
  [
    'new admission',
    {
      finalRoster: [
        { user_id: PILOT.ownerId, status: 'active', role: 'owner' },
        { user_id: 'new-participant', status: 'active', role: 'member' },
      ],
    },
  ],
])
  test(`final two-target readback refuses ${label}`, async () => {
    await assert.rejects(runTwoTargetFlow([game, game9], options));
  });

test('fresh preparation creates both private sizes through the ordinary authenticated creation door', async () => {
  const estate = [];
  const { receipt, calls } = await runTwoTargetFlow(estate);
  const creations = calls.filter((c) => c.name === 'fn_cash_game_create');
  assert.deepEqual(
    creations.map((c) => [c.args.p_name, c.args.p_handedness, c.args.p_sb, c.args.p_bb]),
    [
      [PILOT.gameName, 6, 0.01, 0.02],
      ['Lightning Pilot NLH 9', 9, 0.02, 0.04],
    ]
  );
  assert.equal(receipt.targets.length, 2);
  assert.equal(estate.length, 2);
});

test('a malformed nine-seat integrity acknowledgment never qualifies the two-target setup', async () => {
  await assert.rejects(
    runTwoTargetFlow([game, game9], {
      replaceReceipt: (r, args) =>
        args.p_cluster_id === game9.id && args.p_action === 'set_integrity_telemetry'
          ? { ...r, after: { ...r.after, integrity_telemetry: false } }
          : r,
    }),
    /Receipt/
  );
});

test('final private club readback must retain the original club ID', async () => {
  await assert.rejects(
    runTwoTargetFlow([game, game9], { finalClub: { ...club, id: 'different-private-club' } }),
    /Final Club Identity/
  );
});

test('setup refuses a failed service-session cleanup instead of reporting success', async () => {
  await assert.rejects(
    runTwoTargetFlow([game, game9], {
      cleanupResult: {
        error: { code: 'ISOLATED_CLEANUP_FAILURE', message: 'raw provider detail must not print' },
      },
    }),
    /Service Session Cleanup Failed/
  );
});

test('setup preserves its primary failure diagnostic when local-session cleanup also fails', async () => {
  await assert.rejects(
    runTwoTargetFlow([game, game9], {
      finalClub: { ...club, is_public: true },
      cleanupResult: { error: { code: 'ISOLATED_CLEANUP_FAILURE' } },
    }),
    (error) => {
      assert.match(error.message, /Pilot Club Identity Or Isolation Configuration Mismatch/);
      assert.match(error.message, /Service Session Cleanup Failed/);
      assert.equal(error.cause.message, 'Pilot Club Identity Or Isolation Configuration Mismatch');
      assert.doesNotMatch(error.message, /ISOLATED_CLEANUP_FAILURE/);
      return true;
    }
  );
});

test('successful null or no-error cleanup outcomes retain setup compatibility', async () => {
  for (const cleanupResult of [null, { error: null }, {}]) {
    const { receipt } = await runTwoTargetFlow([game, game9], { cleanupResult });
    assert.equal(receipt.targets.length, 2);
    assert.equal(receipt.publicLaunch, 'NO_GO');
  }
});
