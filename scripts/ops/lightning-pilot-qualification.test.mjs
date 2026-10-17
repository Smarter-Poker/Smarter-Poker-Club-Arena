import './lightning-pilot-replay-sample.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  collectQualification,
  observe,
  selectTargets,
  servingIdentities,
  servingStable,
  runQualification,
  collectPopulatedTargets,
  parsePopulatedClusterIds,
} from './lightning-pilot-qualification.mjs';
import { PILOT } from './prepare-lightning-private-pilot.mjs';
function templateSnapshot(template) {
  const action = template === 'action';
  return {
    template,
    variant: 'nlh',
    regular_ante: action ? 'sb' : 'bb',
    vpip_floor: action ? 30 : 50,
    vpip_window: 10,
    bombs: {
      enabled: true,
      trigger: action ? 'timed_15m' : 'every_orbit',
      ante_bb: action ? 2 : 3,
      boards: 2,
    },
    options: { is_private: true },
  };
}
const clubId = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
const gameId = 'babb43f1-368e-406f-a97a-a0d5013648b2';
const game9 = '90000000-0000-4000-8000-000000000009';
const outsiderId = '70000000-0000-4000-8000-000000000007';
const tableId = 'd78448e2-42da-4bd0-b702-98f8b37d6da7';
const revision = 'a'.repeat(40);
// game() is the Action target and game(9) the Madness target. Both are six
// seats since 2026-10-17; the argument keeps its old meaning of "the second
// target" so every fixture below still names the same game.
const game = (which = 6) => ({
  id: which === 6 ? gameId : game9,
  name: `Lightning Pilot NLH ${which === 6 ? 'Action' : 'Madness'} 6`,
  club_id: clubId,
  union_id: null,
  variant: 'nlh',
  template_name: which === 6 ? 'action' : 'madness',
  sb: which === 6 ? 0.01 : 0.02,
  bb: which === 6 ? 0.02 : 0.04,
  handedness: 6,
  must_move: true,
  ruleset_snapshot: templateSnapshot(which === 6 ? 'action' : 'madness'),
  lightning_enabled: false,
  cluster_mode: 'must_move',
});
const config = {
  ok: true,
  worker_mode: 'off',
  shadow_window_ms: 60000,
  integrity_telemetry: true,
  matcher_version: 'm1',
};
const readiness = (id, verdict = 'no_go') => ({
  ok: true,
  cluster_id: id,
  verdict,
  as_of: '2026-10-12T15:00:00Z',
  reasons: verdict === 'go' ? [] : [{ code: 'WORKER_OFF', severity: 'blocking' }],
  evidence: { cluster: { live_eligible: 0, on_threshold: 12 } },
});
const publicFetch = async (url) => ({
  ok: true,
  json: async () =>
    url.includes('/health')
      ? { status: 'ok', version: '0a8f92f4', access_token: 'SECRET', hole_cards: ['As'] }
      : {
          ca_sha: revision,
          github_run_id: '38200000000',
          built_at: '2026-10-12T14:00:00Z',
          access_token: 'SECRET',
        },
});
function fixture({
  nine = false,
  tables = true,
  countError = null,
  memberCount = 1,
  ready = 'no_go',
  configOverride = {},
  creationError = null,
  detailError = null,
  tableError = null,
} = {}) {
  const calls = [];
  const rows = {
    club_creation_requests: { club_id: clubId, access_token: 'SECRET' },
    clubs: {
      id: clubId,
      name: PILOT.name,
      owner_id: PILOT.ownerId,
      is_public: false,
      requires_approval: true,
      union_id: null,
      created_at: '2026-10-12T05:00:00Z',
    },
    club_members: [{ user_id: PILOT.ownerId, status: 'active', chip_balance: 0 }],
    cash_games: nine ? [game(), game(9)] : [game()],
    tables: tables ? [{ id: tableId, is_private: true, max_players: 6, hole_cards: ['As'] }] : [],
    profiles: { id: outsiderId, status: 'active' },
  };
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.options = {};
    }
    select(fields, options = {}) {
      this.fields = fields;
      this.options = options;
      return this;
    }
    eq(...a) {
      this.filters.push(['eq', ...a]);
      return this;
    }
    in(...a) {
      this.filters.push(['in', ...a]);
      return this;
    }
    gte(...a) {
      this.filters.push(['gte', ...a]);
      return this;
    }
    lte(...a) {
      this.filters.push(['lte', ...a]);
      return this;
    }
    not(...a) {
      this.filters.push(['not', ...a]);
      return this;
    }
    is(...a) {
      this.filters.push(['is', ...a]);
      return this;
    }
    result() {
      calls.push({
        table: this.table,
        fields: this.fields,
        options: this.options,
        filters: this.filters,
      });
      if (this.table === 'club_creation_requests' && creationError)
        return { error: creationError, data: null };
      if (this.table === 'tables' && tableError) return { error: tableError, data: null };
      if (this.options.head) return { error: countError, data: null, count: countError ? null : 0 };
      if (this.table === 'club_members' && this.filters.some((f) => f[1] === 'user_id'))
        return { data: null, error: null };
      const data = rows[this.table];
      return {
        data,
        error: null,
        count:
          this.table === 'club_members' ? memberCount : Array.isArray(data) ? data.length : null,
      };
    }
    maybeSingle() {
      return Promise.resolve(this.result());
    }
    then(resolve, reject) {
      return Promise.resolve(this.result()).then(resolve, reject);
    }
  }
  const rpc = async (name, args) => {
    calls.push({ rpc: name, args });
    if (name === 'fn_lightning_config')
      return { data: { ...config, ...configOverride }, error: null };
    if (name === 'fn_lightning_rollout_readiness')
      return { data: readiness(args.p_cluster_id, ready), error: null };
    if (name === 'fn_lightning_operator_cluster')
      return {
        error: detailError,
        data: detailError
          ? null
          : {
              ok: true,
              cluster_id: args.p_cluster_id,
              from: args.p_from,
              to: args.p_to,
              window_clamped: false,
              latency_windows: [],
              shadow_report: { version_pairs: [] },
              hole_cards: ['As'],
            },
      };
    if (name === 'fn_ca_engine_table_connection_access')
      return {
        data: {
          table_id: args.p_table_id,
          user_id: args.p_user_id,
          allowed: args.p_user_id === PILOT.ownerId,
          reason: args.p_user_id === PILOT.ownerId ? 'club_member' : 'membership_required',
          access_token: 'SECRET',
        },
        error: null,
      };
    throw new Error(`Unexpected RPC: ${name}`);
  };
  const admin = { from: (table) => new Query(table), rpc };
  return {
    admin,
    player: { rpc },
    fetchImpl: publicFetch,
    now: () => new Date('2026-10-12T15:30:00Z'),
    calls,
  };
}
test('missing targets remain unknown and seeded/default games are never adopted', () => {
  const selected = selectTargets([{ ...game(), name: 'Classic NLH' }], clubId);
  assert.equal(selected.length, 2);
  assert.ok(selected.every((t) => t.observation.status === 'unknown'));
  assert.equal(selected[0].observation.errorCode, 'TARGET_NOT_PREPARED');
  assert.equal(
    selectTargets([game(), game()], clubId)[0].observation.errorCode,
    'AMBIGUOUS_TARGET'
  );
  assert.throws(() => selectTargets([{ ...game(), club_id: 'other' }], clubId));
  assert.equal(
    selectTargets([{ ...game(), ruleset_snapshot: {} }], clubId)[0].observation.status,
    'unknown'
  );
});
test('reads actual zero counts without confusing them with unavailable evidence or certifying launch', async () => {
  const f = fixture();
  const r = await collectQualification(f);
  assert.equal(r.targets[0].completedRecordedHands.status, 'known');
  assert.equal(r.targets[0].completedRecordedHands.data, 0);
  assert.equal(r.targets[1].observation.status, 'unknown');
  assert.equal(r.roster.data.activeMembers, 1);
  assert.equal(r.publicLaunch, 'NOT_CERTIFIED');
  assert.equal(r.releaseGates.certifiedByThisReport, 0);
  assert.ok(r.blockers.includes('MADNESS_TARGET_NOT_ESTABLISHED'));
  assert.ok(r.blockers.includes('NO_RECORDED_SETTLED_LIGHTNING_HANDS'));
  const handRead = f.calls.find((c) => c.table === 'lightning_hand');
  assert.equal(handRead.options.count, 'exact');
  assert.equal(handRead.options.head, true);
  assert.deepEqual(
    handRead.filters.filter((x) => x[0] === 'not'),
    [
      ['not', 'settled_at', 'is', null],
      ['not', 'hand_history_id', 'is', null],
    ]
  );
  assert.equal(handRead.fields, 'hand_id');
});
test('permission and transport failures are UNKNOWN, never zero, empty success or leaked error messages', async () => {
  const r = await collectQualification(
    fixture({
      countError: { code: '42501', message: 'SECRET' },
      detailError: { code: 'PGRST001', message: 'SECRET' },
      tableError: { code: '42501' },
    })
  );
  assert.equal(r.targets[0].completedRecordedHands.status, 'unknown');
  assert.equal(r.targets[0].completedRecordedHands.errorCode, '42501');
  assert.equal(r.targets[0].telemetry.status, 'unknown');
  assert.equal(r.targets[0].databaseAccess.tables.status, 'unknown');
  assert.equal(r.targets[0].completedRecordedHands.data, undefined);
  assert.ok(r.blockers.includes('RECORDED_HAND_COVERAGE_UNKNOWN'));
  assert.ok(r.blockers.includes('PRIVATE_TABLE_SCOPE_UNKNOWN'));
  assert.ok(r.blockers.includes('TELEMETRY_EVIDENCE_UNKNOWN'));
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.equal(
    (
      await observe('rpc', async () => {
        throw new Error('SECRET');
      })
    ).errorCode,
    'READ_UNAVAILABLE'
  );
});
test('partial roster reads are unavailable instead of counting a truncated population', async () => {
  const r = await collectQualification(fixture({ memberCount: 2 }));
  assert.equal(r.roster.status, 'unknown');
  assert.ok(r.blockers.includes('ROSTER_UNKNOWN'));
});
test('database access is checked only for an explicitly supplied existing nonmember and remains distinct from socket proof', async () => {
  const f = fixture();
  const r = await collectQualification({ ...f, outsiderId });
  assert.equal(r.targets[0].databaseAccess.owner[0].data.allowed, true);
  assert.equal(r.targets[0].databaseAccess.outsider[0].data.allowed, false);
  assert.equal(r.targets[0].databaseAccess.authenticatedBrowserAndSocket, 'NOT_PROVED');
  const absent = fixture();
  const unknown = await collectQualification(absent);
  assert.equal(unknown.targets[0].databaseAccess.outsider.length, 0);
  assert.equal(
    unknown.targets[0].databaseAccess.designatedOutsider.errorCode,
    'NO_DESIGNATED_OUTSIDER'
  );
  assert.equal(
    absent.calls.filter((c) => c.rpc === 'fn_ca_engine_table_connection_access').length,
    1
  );
  await assert.rejects(collectQualification({ ...fixture(), outsiderId: 'guessed' }), {
    code: 'INVALID_DESIGNATED_OUTSIDER',
  });
});
test('configuration and readiness schema mismatches remain UNKNOWN', async () => {
  const r = await collectQualification(fixture({ configOverride: { shadow_window_ms: null } }));
  assert.equal(r.targets[0].config.status, 'unknown');
  const f = fixture();
  f.player = { rpc: async () => ({ data: readiness('wrong'), error: null }) };
  assert.equal((await collectQualification(f)).targets[0].readiness.status, 'unknown');
});
test('readiness go and both sizes do not certify unrelated release gates or public launch', async () => {
  const r = await collectQualification(fixture({ nine: true, ready: 'go' }));
  assert.ok(r.targets.every((t) => t.readiness.data.verdict === 'go'));
  assert.equal(r.publicLaunch, 'NOT_CERTIFIED');
  assert.equal(r.releaseGates.verdict, 'NOT_EVALUATED');
  assert.ok(r.blockers.includes('ALL_54_RELEASE_GATES_NOT_CERTIFIED'));
});
test('only approved metadata reaches the report, with no secrets or hidden-card payloads', async () => {
  const r = await collectQualification({ ...fixture(), outsiderId });
  const encoded = JSON.stringify(r);
  assert.ok(!encoded.includes('SECRET'));
  assert.ok(!encoded.includes('hole_cards'));
  assert.ok(!encoded.includes('access_token'));
  assert.equal(r.servingBefore.engine.data.fullRevisionEstablished, false);
});
test('serving identity changes, mismatch, malformed replies and failures stay visible', async () => {
  const a = await servingIdentities(publicFetch);
  assert.equal(servingStable(a, a), 'passed');
  const b = structuredClone(a);
  b.publicClient.data.revision = 'b'.repeat(40);
  assert.equal(servingStable(a, b), 'failed');
  const c = structuredClone(a);
  c.engine.data.reportedVersion = '12345678';
  assert.equal(servingStable(a, c), 'failed');
  const bad = await servingIdentities(async () => ({ ok: false, status: 503 }));
  assert.equal(servingStable(a, bad), 'unknown');
  const malformed = await servingIdentities(async () => ({
    ok: true,
    json: async () => ({ ca_sha: 'short', version: 'SECRET' }),
  }));
  assert.equal(malformed.origin.status, 'unknown');
});
test('missing club identity is unknown and no downstream scope is guessed', async () => {
  const f = fixture({ creationError: { code: '42501' } });
  const r = await collectQualification(f);
  assert.equal(r.club.status, 'unknown');
  assert.equal(r.targets.length, 0);
  assert.ok(r.blockers.includes('PILOT_CLUB_NOT_ESTABLISHED'));
  assert.equal(f.calls.filter((c) => c.rpc).length, 0);
});
test('service credentials and canonical project are required before SDK or authentication work', async () => {
  await assert.rejects(runQualification({}), { code: 'VERIFIED_SERVICE_CONFIGURATION_REQUIRED' });
  await assert.rejects(
    runQualification({
      SUPABASE_URL: 'https://other.supabase.co',
      SP_EMAIL: PILOT.ownerEmail,
      SP_PASS: 'configured',
      SUPABASE_SERVICE_ROLE_KEY: 'configured',
    }),
    { code: 'VERIFIED_SERVICE_CONFIGURATION_REQUIRED' }
  );
});
test('collection uses only read RPCs and no gameplay, financial, release or schema mutation', async () => {
  const f = fixture({ nine: true });
  await collectQualification({ ...f, outsiderId });
  const allowed = new Set([
    'fn_lightning_config',
    'fn_lightning_rollout_readiness',
    'fn_lightning_operator_cluster',
    'fn_ca_engine_table_connection_access',
  ]);
  assert.ok(f.calls.filter((c) => c.rpc).every((c) => allowed.has(c.rpc)));
  const source = readFileSync(
    new URL('./lightning-pilot-qualification.mjs', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(
    source,
    /\.insert\(|\.update\(|\.delete\(|\.upsert\(|fn_lightning_operator_control|fn_cash_game_create|fn_create_club_atomic/
  );
  assert.match(source, /signOut\(\{ scope: 'local' \}\)/);
});

test('missing physical tables and refused access produce explicit blockers, never empty proof', async () => {
  const r = await collectQualification(fixture({ tables: false }));
  assert.ok(r.blockers.includes('PRIVATE_PILOT_TABLES_NOT_ESTABLISHED'));
  const f = fixture();
  const read = f.admin.rpc;
  f.admin.rpc = async (name, args) =>
    name === 'fn_ca_engine_table_connection_access'
      ? {
          data: {
            table_id: args.p_table_id,
            user_id: args.p_user_id,
            allowed: false,
            reason: 'membership_required',
          },
          error: null,
        }
      : read(name, args);
  assert.ok((await collectQualification(f)).blockers.includes('OWNER_DATABASE_ACCESS_REFUSED'));
});
test('mismatched access receipts remain UNKNOWN and an admitted outsider is an explicit failure', async () => {
  const f = fixture();
  const read = f.admin.rpc;
  f.admin.rpc = async (name, args) =>
    name === 'fn_ca_engine_table_connection_access'
      ? { data: { table_id: 'wrong', user_id: args.p_user_id, allowed: true }, error: null }
      : read(name, args);
  const r = await collectQualification({ ...f, outsiderId });
  assert.ok(r.blockers.includes('OWNER_DATABASE_ACCESS_UNKNOWN'));
  assert.ok(r.blockers.includes('OUTSIDER_DATABASE_ACCESS_UNKNOWN'));
  const g = fixture();
  const original = g.admin.rpc;
  g.admin.rpc = async (name, args) =>
    name === 'fn_ca_engine_table_connection_access'
      ? {
          data: {
            table_id: args.p_table_id,
            user_id: args.p_user_id,
            allowed: true,
            reason: 'club_member',
          },
          error: null,
        }
      : original(name, args);
  assert.ok(
    (await collectQualification({ ...g, outsiderId })).blockers.includes(
      'OUTSIDER_DATABASE_ACCESS_ALLOWED'
    )
  );
});
test('future and overlong evidence windows are refused instead of silently clamped or treated as waiting requirements', async () => {
  await assert.rejects(collectQualification({ ...fixture(), from: '2027-01-01T00:00:00Z' }), {
    code: 'INVALID_REPORT_WINDOW',
  });
  await assert.rejects(collectQualification({ ...fixture(), from: '2020-01-01T00:00:00Z' }), {
    code: 'INVALID_REPORT_WINDOW',
  });
});

test('serving bracket requires a healthy engine at both observations', async () => {
  const healthy = await servingIdentities(publicFetch);
  const unhealthy = structuredClone(healthy);
  unhealthy.engine.data.status = 'not_ok';
  assert.equal(servingStable(unhealthy, healthy), 'failed');
  assert.equal(servingStable(healthy, unhealthy), 'failed');
  assert.equal(servingStable(unhealthy, unhealthy), 'failed');
});

test('pilot identity includes authoritative stakes, Action/Madness template and exact table size', () => {
  const valid = selectTargets([game(), game(9)], clubId);
  assert.ok(valid.every((t) => t.observation.status === 'known'));
  for (const bad of [
    { ...game(), sb: 0.02 },
    { ...game(), bb: 0.04 },
    { ...game(), template_name: 'classic' },
    { ...game(9), sb: 0.01, bb: 0.02 },
    { ...game(9), handedness: 9 },
    { ...game(9), template_name: undefined },
  ]) {
    const selected = selectTargets([bad], clubId);
    assert.equal(selected.find((t) => t.name === bad.name).observation.status, 'unknown');
  }
  // The replaced nine-seat Madness is not a target under any reading.
  const retired = { ...game(9), name: 'Lightning Pilot NLH Madness 9', handedness: 9 };
  assert.ok(selectTargets([retired], clubId).every((t) => t.observation.status === 'unknown'));
});

const populatedId = '5e000000-0000-4000-8000-000000000006';
const populatedTable = '5e000000-0000-4000-8000-0000000000a1';
function populatedFixture({
  seated = 32,
  onThreshold = 18,
  gameOverride = {},
  seatError = null,
} = {}) {
  const calls = [];
  const gameRow = {
    id: populatedId,
    club_id: 'fade0000-0000-0000-0000-000000000001',
    name: 'NLH 1/2 Action',
    variant: 'nlh',
    handedness: 6,
    must_move: true,
    enabled: true,
    closed_at: null,
    lightning_enabled: false,
    cluster_mode: 'must_move',
    ...gameOverride,
  };
  const query = (table) => {
    const q = {
      filters: [],
      opts: {},
      select(_f, o = {}) {
        q.opts = o;
        return q;
      },
      eq(...a) {
        q.filters.push(['eq', ...a]);
        return q;
      },
      in(...a) {
        q.filters.push(['in', ...a]);
        return q;
      },
      is(...a) {
        q.filters.push(['is', ...a]);
        return q;
      },
      result() {
        calls.push({ table, filters: q.filters, opts: q.opts });
        if (table === 'cash_games') return { data: gameRow, error: null };
        if (table === 'tables') return { data: [{ id: populatedTable }], error: null, count: 1 };
        if (table === 'table_seats')
          return seatError
            ? { data: null, error: seatError, count: null }
            : { data: null, error: null, count: seated };
        throw new Error(`Unexpected table ${table}`);
      },
      maybeSingle: () => Promise.resolve(q.result()),
      then: (res, rej) => Promise.resolve(q.result()).then(res, rej),
    };
    return q;
  };
  const rpc = async (name, args) => {
    calls.push({ rpc: name, args });
    if (name === 'fn_lightning_config') return { data: config, error: null };
    if (name === 'fn_lightning_rollout_readiness') {
      const r = readiness(args.p_cluster_id);
      r.evidence.cluster.on_threshold = onThreshold;
      return { data: r, error: null };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  };
  return { admin: { from: query, rpc }, player: { rpc }, calls };
}
test('populated Cluster ids are bounded, deduplicated UUIDs and default to none', () => {
  assert.deepEqual(parsePopulatedClusterIds(undefined), []);
  assert.deepEqual(parsePopulatedClusterIds(' '), []);
  assert.deepEqual(parsePopulatedClusterIds(`${populatedId}, ${populatedId}`), [populatedId]);
  assert.throws(() => parsePopulatedClusterIds('guessed'), {
    code: 'INVALID_POPULATED_CLUSTER_IDS',
  });
  const five = Array.from({ length: 5 }, (_, i) => `5e000000-0000-4000-8000-00000000000${i}`);
  assert.throws(() => parsePopulatedClusterIds(five.join(',')), {
    code: 'INVALID_POPULATED_CLUSTER_IDS',
  });
});
test('a populated Cluster reports its actual seated population against the readiness threshold', async () => {
  const f = populatedFixture();
  const [t] = await collectPopulatedTargets({ ...f, clusterIds: [populatedId] });
  assert.equal(t.game.status, 'known');
  assert.equal(t.game.data.handedness, 6);
  assert.equal(t.seatedParticipants.data, 32);
  assert.equal(t.activationPopulation, 'at_or_above_on_threshold');
  const seatRead = f.calls.find((c) => c.table === 'table_seats');
  assert.ok(seatRead.filters.some((x) => x[0] === 'is' && x[1] === 'left_at' && x[2] === null));
  assert.ok(seatRead.filters.some((x) => x[0] === 'in' && x[2].includes(populatedTable)));
  const low = populatedFixture({ seated: 11 });
  const [b] = await collectPopulatedTargets({ ...low, clusterIds: [populatedId] });
  assert.equal(b.activationPopulation, 'below_on_threshold');
});
test('an unreadable seat count or a non Must-Move game stays UNKNOWN, never zero or adopted', async () => {
  const f = populatedFixture({ seatError: { code: '42501' } });
  const [t] = await collectPopulatedTargets({ ...f, clusterIds: [populatedId] });
  assert.equal(t.seatedParticipants.status, 'unknown');
  assert.equal(t.activationPopulation, 'unknown');
  const g = populatedFixture({ gameOverride: { must_move: false } });
  const [u] = await collectPopulatedTargets({ ...g, clusterIds: [populatedId] });
  assert.equal(u.game.status, 'unknown');
  assert.equal(u.readiness, undefined);
  assert.ok(g.calls.filter((c) => c.rpc).length === 0);
});
test('the populated observation is part of the report and adds no write or control call', async () => {
  const f = fixture();
  const p = populatedFixture();
  const admin = {
    from: (t) => (t === 'cash_games' || t === 'table_seats' ? p.admin.from(t) : f.admin.from(t)),
    rpc: f.admin.rpc,
  };
  const r = await collectQualification({ ...f, admin, populatedClusterIds: [] });
  assert.deepEqual(r.populatedTargets, []);
  const only = await collectPopulatedTargets({ ...p, clusterIds: [populatedId] });
  assert.ok(
    p.calls
      .filter((c) => c.rpc)
      .every((c) => ['fn_lightning_config', 'fn_lightning_rollout_readiness'].includes(c.rpc))
  );
  assert.equal(only.length, 1);
});

test('engine serving identity uses the full releaseSha and refuses inconsistent identities', async () => {
  const full = 'a2ccc04d39bc15852d0047a32893371f3a0a6836';
  const read = (body) =>
    servingIdentities(async (url) => ({
      ok: true,
      json: async () => (url.includes('/health') ? body : { ca_sha: revision }),
    }));
  const actual = await read({ status: 'ok', version: full.slice(0, 8), releaseSha: full });
  assert.equal(actual.engine.data.reportedVersion, full);
  assert.equal(actual.engine.data.fullRevisionEstablished, true);
  const later = await read({
    status: 'ok',
    version: full.slice(0, 8),
    releaseSha: full.slice(0, 39) + '7',
  });
  assert.equal(servingStable(actual, later), 'failed');
  for (const releaseSha of ['short', 'b'.repeat(40), null]) {
    assert.equal(
      (await read({ status: 'ok', version: full.slice(0, 8), releaseSha })).engine.status,
      'unknown'
    );
  }
});

test('qualification rejects Classic and tampered Action/Madness semantics without treating legacy names as targets', () => {
  const legacy = { ...game(), name: 'Lightning Pilot NLH 6', template_name: 'classic' };
  assert.ok(selectTargets([legacy], clubId).every((t) => t.observation.status === 'unknown'));
  for (const candidate of [game(), game(9)]) {
    for (const patch of [
      { template_name: 'classic' },
      { ruleset_snapshot: { ...candidate.ruleset_snapshot, vpip_floor: 0 } },
      { ruleset_snapshot: { ...candidate.ruleset_snapshot, bombs: { enabled: false } } },
    ]) {
      const result = selectTargets([{ ...candidate, ...patch }], clubId).find(
        (t) => t.name === candidate.name
      );
      assert.equal(result.observation.status, 'unknown');
    }
  }
});
