import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EXPANSION_CLUB,
  EXPANSION_OPERATION,
  EXPANSION_SIZE,
  EXPANSION_TITLE,
  EXPANSION_WORKFLOW,
  FUND_CENTS,
  checkedRoster,
  executeExpansion,
  expansionRequestId,
  expansionScope,
  prepareExpansion,
} from './lightning-pilot-roster-expand.mjs';
import { assertRosterRun } from './lightning-pilot-roster-run.mjs';
import { PILOT } from './prepare-lightning-private-pilot.mjs';
import { assignmentScope } from './lightning-pilot-assignment.mjs';

const operationId = '6c2f61a4-6f0e-4c55-9f43-1a2b3c4d5e6f';
const scope = expansionScope();
const T = '2026-10-23T16:00:00.000000+00:00';
const member = (user_id, extra = {}) => ({
  user_id,
  role: 'player',
  status: 'active',
  joined_at: T,
  created_at: T,
  membership_lifecycle_status: 'active',
  is_active: true,
  ...extra,
});
function fixture() {
  const state = {
    club: {
      id: EXPANSION_CLUB,
      owner_id: PILOT.ownerId,
      name: PILOT.name,
      is_public: false,
      requires_approval: true,
      union_id: null,
      chip_treasury: '88448.02',
      settlement_locked: false,
    },
    members: [
      member(PILOT.ownerId, { role: 'owner' }),
      ...scope.original.map((id) => member(id)),
      member('11111111-1111-4111-a111-111111111111', {
        status: 'suspended',
        membership_lifecycle_status: 'departed',
        is_active: false,
      }),
    ],
    wallets: {},
    calls: [],
  };
  const horse = (id) => ({ id, is_horse: true, status: 'active' });
  const adapter = {
    async snapshot() {
      return {
        club: structuredClone(state.club),
        members: structuredClone(state.members),
        profiles: state.members.map((m) => horse(m.user_id)),
        frozen: false,
        admission: { allowed: true },
      };
    },
    async validateIncoming(id, { strict }) {
      state.calls.push(['validate', id, strict]);
      if (state.members.some((m) => m.user_id === id))
        throw new Error('INCOMING_ALREADY_PILOT_MEMBER');
      if (state.refuse === id) throw new Error('HORSE_IDENTITY_CHANGED');
      return { seats: 0, openCashSessions: 0, liveBookings: 0, playing: 0 };
    },
    async join(id, requestId) {
      state.calls.push(['join', id, requestId]);
      if (state.unknownAt === id) throw new Error('network');
      const m = member(id, { status: 'pending', chip_balance: '0.00' });
      state.members.push(m);
      return { success: true, status: 'pending', membership: m };
    },
    async approve(id) {
      state.calls.push(['approve', id]);
      state.members.find((m) => m.user_id === id).status = 'active';
      return { success: true };
    },
    async fund(id, op) {
      state.calls.push(['fund', id, op]);
      const before = Math.round(Number(state.club.chip_treasury) * 100);
      state.club.chip_treasury = ((before - FUND_CENTS) / 100).toFixed(2);
      state.wallets[id] = FUND_CENTS;
      return {
        success: true,
        amount: '200.00',
        destination: 'player_wallet',
        transaction_id: `tx-${id}`,
        recipient_balance_after: '200.00',
        bank_before: (before / 100).toFixed(2),
        bank_after: state.club.chip_treasury,
      };
    },
    async provenFunding(id, op) {
      state.calls.push(['proven', id, op]);
      if (state.wallets[id] !== FUND_CENTS) throw new Error('EARLIER_FUNDING_UNPROVED');
      return { transactionId: `tx-${id}` };
    },
    async verifyFunding(id, op, r) {
      state.calls.push(['verify', id, op]);
      return {
        transactionId: r.transaction_id,
        walletAfterAtFunding: 200,
        bankBeforeAtFunding: Number(r.bank_before),
        bankAfterAtFunding: Number(r.bank_after),
      };
    },
  };
  return { state, adapter };
}
const admission = (b) => ({
  firstInvocation: true,
  prepareRunId: b.sourceRunId,
  executeRunId: '902',
});

test('exact pinned 72 beside the exact original 72, and the 144 assignment is their union', () => {
  assert.equal(scope.incoming.length, EXPANSION_SIZE);
  assert.equal(scope.original.length, 72);
  assert.equal(new Set([...scope.incoming, ...scope.original]).size, 144);
  assert.deepEqual(assignmentScope().participants, [...scope.incoming, ...scope.original].sort());
  const doc = JSON.parse(
    readFileSync(
      new URL('../../docs/lightning/PILOT-ROSTER-EXPANSION-2026-10-23.json', import.meta.url)
    )
  );
  assert.equal(doc.perHorseFunding, '200.00');
  assert.equal(FUND_CENTS, 20000);
  assert.match(
    expansionRequestId('fund', scope.incoming[0]),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/
  );
  assert.notEqual(
    expansionRequestId('fund', scope.incoming[0]),
    expansionRequestId('join', scope.incoming[0])
  );
});

test('prepare writes nothing and execute adds, approves and funds each pinned horse once', async () => {
  const { state, adapter } = fixture();
  const b = await prepareExpansion({ adapter, sourceRunId: 901, operationId, now: () => 1000 });
  assert.equal(state.calls.filter((c) => c[0] !== 'validate').length, 0);
  assert.equal(b.initial.rows.length, 73);
  const saved = [];
  const r = await executeExpansion({
    adapter,
    baseline: b,
    admission: admission(b),
    persist: (x) => saved.push(x),
    now: () => 2000,
  });
  assert.equal(r.status, 'verified', r.diagnostic);
  assert.equal(r.added, 72);
  assert.equal(r.grossFundingCents, 72 * FUND_CENTS);
  assert.equal(r.rosterAfter, 145);
  assert.equal(state.calls.filter((c) => c[0] === 'fund').length, 72);
  assert.equal(new Set(state.calls.filter((c) => c[0] === 'fund').map((c) => c[2])).size, 72);
  assert.equal(state.club.chip_treasury, (88448.02 - 14400).toFixed(2));
  assert.ok(saved.length > 72 * 3);
});

test('any pre-write refusal stops before the first door; an unknown door is never retried', async () => {
  let { state, adapter } = fixture();
  let b = await prepareExpansion({ adapter, sourceRunId: 901, operationId, now: () => 1000 });
  state.refuse = scope.incoming[40];
  let r = await executeExpansion({
    adapter,
    baseline: b,
    admission: admission(b),
    persist: () => {},
    now: () => 2000,
  });
  assert.equal(r.status, 'stopped');
  assert.equal(state.calls.filter((c) => c[0] === 'join').length, 0);
  ({ state, adapter } = fixture());
  b = await prepareExpansion({ adapter, sourceRunId: 901, operationId, now: () => 1000 });
  state.unknownAt = scope.incoming[3];
  r = await executeExpansion({
    adapter,
    baseline: b,
    admission: admission(b),
    persist: () => {},
    now: () => 2000,
  });
  assert.equal(r.status, 'stopped');
  assert.equal(r.cause, 'DOOR_OUTCOME_UNKNOWN');
  assert.equal(r.added, 3);
  assert.equal(state.calls.filter((c) => c[0] === 'join' && c[1] === scope.incoming[3]).length, 1);
});

test('a later operation completes a stopped one without touching finished horses', async () => {
  const { state, adapter } = fixture();
  let b = await prepareExpansion({ adapter, sourceRunId: 901, operationId, now: () => 1000 });
  state.unknownAt = scope.incoming[57];
  let r = await executeExpansion({
    adapter,
    baseline: b,
    admission: admission(b),
    persist: () => {},
    now: () => 2000,
  });
  assert.equal(r.status, 'stopped');
  assert.equal(r.added, 57);
  assert.equal(r.steps.at(-1).error, 'THROWN_BEFORE_RECEIPT');
  delete state.unknownAt;
  state.calls.length = 0;
  b = await prepareExpansion({
    adapter,
    sourceRunId: 903,
    operationId: '7d3e7b5a-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
    now: () => 3000,
  });
  assert.equal(b.completed.length, 57);
  assert.deepEqual(b.remaining, scope.incoming.slice(57));
  r = await executeExpansion({
    adapter,
    baseline: b,
    admission: { firstInvocation: true, prepareRunId: '903', executeRunId: '904' },
    persist: () => {},
    now: () => 4000,
  });
  assert.equal(r.status, 'verified', r.diagnostic);
  assert.equal(r.added, 15);
  assert.equal(r.grossFundingCents, 15 * FUND_CENTS);
  assert.equal(r.rosterAfter, 145);
  for (const id of scope.incoming.slice(0, 57))
    assert.ok(!state.calls.some((c) => ['join', 'approve', 'fund'].includes(c[0]) && c[1] === id));
  assert.equal(state.calls.filter((c) => c[0] === 'fund').length, 15);
  // A joined horse with no proved funding is never adopted.
  state.wallets[scope.incoming[0]] = 0;
  await assert.rejects(
    prepareExpansion({ adapter, sourceRunId: 905, operationId, now: () => 5000 }),
    /EARLIER_FUNDING_UNPROVED/
  );
});

test('tampered, expired or re-admitted baselines and roster drift refuse', async () => {
  const { state, adapter } = fixture();
  const b = await prepareExpansion({ adapter, sourceRunId: 901, operationId, now: () => 1000 });
  await assert.rejects(
    executeExpansion({
      adapter,
      baseline: { ...b, incoming: [] },
      admission: admission(b),
      persist: () => {},
    }),
    /INVALID_BASELINE/
  );
  await assert.rejects(
    executeExpansion({
      adapter,
      baseline: b,
      admission: { ...admission(b), firstInvocation: false },
      persist: () => {},
    }),
    /FIRST_EXECUTION/
  );
  await assert.rejects(
    executeExpansion({
      adapter,
      baseline: b,
      admission: admission(b),
      persist: () => {},
      now: () => 1000 + 1800001,
    }),
    /BASELINE_EXPIRED/
  );
  state.members.push(member('22222222-2222-4222-a222-222222222222'));
  assert.throws(
    () =>
      checkedRoster(
        {
          ...structuredClone(state),
          profiles: state.members.map((m) => ({ id: m.user_id, is_horse: true, status: 'active' })),
          frozen: false,
          admission: { allowed: true },
        },
        scope
      ),
    /UNEXPECTED_MEMBER/
  );
  const r = await executeExpansion({
    adapter,
    baseline: b,
    admission: admission(b),
    persist: () => {},
    now: () => 2000,
  });
  assert.equal(r.status, 'stopped');
  assert.equal(state.calls.filter((c) => c[0] === 'join').length, 0);
});

test('provider ownership uses the expansion workflow and its own run names', () => {
  const current = {
    id: 2,
    event: 'workflow_dispatch',
    head_branch: 'main',
    path: EXPANSION_WORKFLOW,
    run_attempt: 1,
    created_at: '2026-10-23T17:00:00Z',
    display_title: `${EXPANSION_TITLE} execute ${operationId}`,
  };
  const baseline = {
    ...current,
    id: 1,
    conclusion: 'success',
    created_at: '2026-10-23T16:59:00Z',
    display_title: `${EXPANSION_TITLE} prepare ${operationId}`,
  };
  const opts = { workflow: EXPANSION_WORKFLOW, title: EXPANSION_TITLE };
  assertRosterRun({
    phase: 'execute',
    operationId,
    current,
    baseline,
    runs: [current, baseline],
    ...opts,
  });
  assert.throws(() =>
    assertRosterRun({
      phase: 'execute',
      operationId,
      current,
      baseline,
      runs: [current, baseline, { id: 3, display_title: current.display_title }],
      ...opts,
    })
  );
  assert.throws(() =>
    assertRosterRun({ phase: 'execute', operationId, current, baseline, runs: [current, baseline] })
  );
  const wf = readFileSync(
    new URL('../../.github/workflows/lightning-pilot-roster-expand.yml', import.meta.url),
    'utf8'
  );
  assert.match(
    wf,
    /run-name: Lightning Roster Expansion \$\{\{ inputs.phase \}\} \$\{\{ inputs.operation_id \}\}/
  );
  assert.match(wf, /group: lightning-private-pilot-setup/);
  assert.ok(wf.indexOf('--guard') < wf.indexOf('SUPABASE_SERVICE_ROLE_KEY'));
  assert.equal(EXPANSION_OPERATION, 'lightning-pilot-roster-expansion-20261023');
});
