import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignmentMain,
  assignmentScope,
  assertAssignmentStatus,
  assignmentControlRequestId,
  ASSIGNMENT_MANIFEST_SHA256,
} from './lightning-pilot-assignment.mjs';
import { PILOT, PILOT_TARGETS } from './prepare-lightning-private-pilot.mjs';
const operationId = '98765432-1234-4123-a123-123456789abc';
const scope = assignmentScope();
const ids = ['56d5d6f0-23e9-41b0-b407-852aa1026c2a', '0cdc133d-ad23-4ace-bb85-312d0f221edd'];
const status = (active) => ({
  active,
  club_id: scope.clubId,
  player_ids: scope.participants,
  manifest_sha256: ASSIGNMENT_MANIFEST_SHA256,
});
const envFor = (phase) => ({
  PILOT_ASSIGNMENT_PHASE: phase,
  PILOT_ASSIGNMENT_OPERATION_ID: operationId,
  PILOT_ASSIGNMENT_REASON: 'Authorized finite pilot qualification',
  SP_EMAIL: PILOT.ownerEmail,
  SP_PASS: 'fixture-secret',
  SUPABASE_URL: 'https://fixture.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'fixture-service',
});
function fixture({
  wrongOwner = false,
  unknownControl = false,
  cleanupError = false,
  drift = false,
  departed = [],
} = {}) {
  let active = false,
    last_request_id = null;
  const calls = [],
    saved = [];
  const owner = {
    auth: {
      signInWithPassword: async () => ({
        data: {
          user: { id: wrongOwner ? 'other' : PILOT.ownerId },
          session: { user: { id: PILOT.ownerId } },
        },
      }),
      getUser: async () => ({ data: { user: { id: PILOT.ownerId } } }),
      signOut: async (x) => {
        calls.push(['signOut', x]);
        return { error: cleanupError ? { message: 'fixture-secret' } : null };
      },
    },
    rpc: async (name, args) => {
      calls.push([name, args]);
      if (name === 'fn_lightning_pilot_assignment_set') {
        if (unknownControl) throw Error('fixture-secret');
        active = args.p_active;
        last_request_id = args.p_request_id;
        return { data: { ...status(active), last_request_id, ok: true } };
      }
      return { data: { ...status(active), last_request_id } };
    },
  };
  const admin = {
    from(table) {
      let columns,
        filters = {};
      const q = {
        select(s) {
          columns = s;
          return q;
        },
        eq(k, v) {
          filters[k] = v;
          return q;
        },
        in() {
          return q;
        },
        order() {
          return q;
        },
        limit: async () => ({
          count: table === 'tournament_players' ? 0 : undefined,
          data:
            table === 'tournament_players'
              ? []
              : table === 'club_members'
                ? [
                    { user_id: PILOT.ownerId, role: 'owner', status: 'active' },
                    ...scope.participants.map((user_id) => ({
                      user_id,
                      status: drift ? 'pending' : 'active',
                      role: 'player',
                      membership_lifecycle_status: 'active',
                      is_active: true,
                    })),
                    ...departed,
                  ]
                : scope.participants.map((id) => ({ id, is_horse: true, status: 'active' })),
        }),
        maybeSingle: async () => {
          if (table === 'clubs')
            return {
              data: {
                id: scope.clubId,
                owner_id: PILOT.ownerId,
                name: PILOT.name,
                is_public: false,
                requires_approval: true,
              },
            };
          const index = filters.id
              ? ids.indexOf(filters.id)
              : PILOT_TARGETS.findIndex((t) => t.gameName === filters.name),
            t = PILOT_TARGETS[index],
            a = index === 0;
          return {
            data:
              columns === 'id'
                ? { id: ids[index] }
                : {
                    id: ids[index],
                    club_id: scope.clubId,
                    name: t.gameName,
                    template_name: t.templateName,
                    handedness: t.handedness,
                    sb: t.sb,
                    bb: t.bb,
                    variant: 'nlh',
                    must_move: true,
                    ruleset_snapshot: {
                      template: t.templateName,
                      variant: 'nlh',
                      regular_ante: a ? 'sb' : 'bb',
                      vpip_floor: a ? 30 : 50,
                      vpip_window: 10,
                      bombs: {
                        enabled: true,
                        trigger: a ? 'timed_20m' : 'timed_10m',
                        ante_bb: a ? 2 : 3,
                        boards: 2,
                      },
                      options: { is_private: true },
                    },
                  },
          };
        },
      };
      return q;
    },
  };
  let count = 0;
  return {
    calls,
    saved,
    deps: {
      createClient: () => (++count === 1 ? admin : owner),
      persist: async (r) => saved.push(structuredClone(r)),
    },
  };
}
test('manifest/status binds all exact funded participants and refuses drift', () => {
  assert.equal(scope.participants.length, 144);
  assertAssignmentStatus(status(false), false);
  for (const patch of [
    { active: null },
    { club_id: ids[0] },
    { manifest_sha256: 'wrong' },
    { player_ids: scope.participants.slice(1) },
  ])
    assert.throws(() => assertAssignmentStatus({ ...status(false), ...patch }));
  assert.throws(() => assertAssignmentStatus(status(false), true));
  assert.notEqual(
    assignmentControlRequestId(operationId, true),
    assignmentControlRequestId(operationId, false)
  );
});
test('normal owner control records exact scoped request and local cleanup', async () => {
  const f = fixture(),
    r = await assignmentMain(envFor('assign'), f.deps);
  assert.equal(r.status, 'verified');
  assert.equal(r.assignment.active, true);
  const args = f.calls.find((c) => c[0] === 'fn_lightning_pilot_assignment_set')[1];
  assert.deepEqual(args.p_player_ids, scope.participants);
  assert.equal(args.p_manifest_sha256, ASSIGNMENT_MANIFEST_SHA256);
  assert.equal(args.p_request_id, assignmentControlRequestId(operationId, true));
  assert.deepEqual(f.calls.at(-1), ['signOut', { scope: 'local' }]);
});
test('unknown control acknowledgment retains original operation and request, with no retry', async () => {
  const f = fixture({ unknownControl: true }),
    r = await assignmentMain(envFor('release'), f.deps);
  assert.equal(r.status, 'stopped');
  assert.equal(r.operationId, operationId);
  assert.equal(r.requestId, assignmentControlRequestId(operationId, false));
  assert.equal(f.calls.filter((c) => c[0] === 'fn_lightning_pilot_assignment_set').length, 1);
  assert.ok(!JSON.stringify(f.saved).includes('fixture-secret'));
});
test('owner identity, roster drift and unknown cleanup cannot certify controls', async () => {
  for (const options of [{ wrongOwner: true }, { drift: true }, { cleanupError: true }]) {
    const f = fixture(options),
      r = await assignmentMain(envFor('assign'), f.deps);
    assert.equal(r.status, 'stopped');
    if (!options.cleanupError)
      assert.equal(f.calls.filter((c) => c[0] === 'fn_lightning_pilot_assignment_set').length, 0);
    assert.deepEqual(f.calls.at(-1), ['signOut', { scope: 'local' }]);
  }
});
test('release remains callable after roster drift; withdrawal refuses foreign baseline before action', async () => {
  const f = fixture({ drift: true });
  assert.equal((await assignmentMain(envFor('release'), f.deps)).status, 'verified');
  const g = fixture();
  let withdrawals = 0;
  const r = await assignmentMain(envFor('withdraw'), {
    ...g.deps,
    readBaseline: () => ({ operationId: ids[0] }),
    utility: {
      createAssignmentWithdrawalAdapter: () => ({}),
      withdrawAssignment: async () => {
        withdrawals++;
      },
    },
  });
  assert.equal(r.status, 'stopped');
  assert.equal(withdrawals, 0);
});
test('actual preparation helper accepts caller budget and retains exact empty-scope baseline without writes', async () => {
  const f = fixture();
  let baseline;
  const r = await assignmentMain(envFor('prepare'), {
    ...f.deps,
    writeBaseline: (b) => {
      baseline = b;
    },
  });
  assert.equal(r.status, 'prepared');
  assert.equal(baseline.operationId, operationId);
  assert.deepEqual(baseline.participants, scope.participants);
  assert.deepEqual(baseline.entries, []);
  assert.deepEqual(baseline.deferred, []);
  assert.equal(r.baselineDigest, baseline.digest);
  assert.equal(r.noRegistrationOrMoneyWrites, true);
  assert.deepEqual(f.calls, [['signOut', { scope: 'local' }]]);
});

const departedRow = (user_id, patch = {}) => ({
  user_id,
  status: 'suspended',
  role: 'player',
  membership_lifecycle_status: 'departed',
  is_active: false,
  ...patch,
});
test('departed historical-rakeback memberships are not roster drift; anything else still is', async () => {
  // 2026-10-22 00:05 UTC: 47 departed rows retained for historical rakeback
  // receipts landed in the pilot club and the exact-73 roster check refused
  // every assign/prepare/withdraw.
  const outsiders = Array.from({ length: 47 }, (_, i) =>
    departedRow(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
  );
  const ok = fixture({ departed: outsiders });
  assert.equal((await assignmentMain(envFor('assign'), ok.deps)).status, 'verified');
  for (const bad of [
    [departedRow(scope.participants[0])],
    [departedRow(PILOT.ownerId)],
    [departedRow('00000000-0000-4000-8000-0000000000aa', { is_active: true })],
    [departedRow('00000000-0000-4000-8000-0000000000ab', { status: 'active' })],
    [
      departedRow('00000000-0000-4000-8000-0000000000ac', {
        membership_lifecycle_status: 'active',
      }),
    ],
  ]) {
    const f = fixture({ departed: bad }),
      r = await assignmentMain(envFor('assign'), f.deps);
    assert.equal(r.status, 'stopped');
    assert.equal(f.calls.filter((c) => c[0] === 'fn_lightning_pilot_assignment_set').length, 0);
  }
});
