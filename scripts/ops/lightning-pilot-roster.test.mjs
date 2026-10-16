import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createRosterAdapter,
  prepareRoster,
  executeRoster,
  ROSTER_CLUB,
  ROSTER_PAIRS,
  rosterCents,
  rosterRequestId,
} from './lightning-pilot-roster.mjs';
import { PILOT } from './prepare-lightning-private-pilot.mjs';
const operationId = '2d8fbcc8-b059-44f4-a4c3-ac441472bb84';
const row = (id, extra = {}) => ({
  user_id: id,
  role: 'player',
  status: 'active',
  joined_at: '2026-10-14T00:00:00Z',
  created_at: '2026-10-14T00:00:00Z',
  chip_balance: '100.00',
  credit_used: '0.00',
  locked_chips: '0.00',
  held_chips: '0.00',
  ...extra,
});
function fixture() {
  const state = {
    club: {
      id: ROSTER_CLUB,
      owner_id: PILOT.ownerId,
      name: PILOT.name,
      is_public: false,
      requires_approval: true,
      union_id: null,
      chip_treasury: '10000.00',
      settlement_locked: false,
    },
    games: ['babb43f1-368e-406f-a97a-a0d5013648b2', '3330ff9f-76ec-4487-b0c9-fc8ad8c2fdbb'].map(
      (id) => ({ id, club_id: ROSTER_CLUB, lightning_enabled: false })
    ),
    members: [
      row(PILOT.ownerId, { role: 'owner' }),
      ...Array.from({ length: 49 }, (_, i) => row(`retained-${i}`)),
      ...ROSTER_PAIRS.map((p) => row(p.outgoing)),
    ],
  };
  const calls = [],
    journal = [],
    funded = new Set();
  let hazards = { seats: 0, uncashed: 0, escrow: 0, holds: 0, cashouts: 0, pool: 0 };
  const adapter = {
    snapshot: async (id) =>
      structuredClone({
        ...state,
        frozen: false,
        admission: { allowed: true },
        profiles: state.members.map((m) => ({ id: m.user_id, is_horse: true, status: 'active' })),
        ...(id ? { hazards } : {}),
      }),
    validateIncoming: async (id) => assert.ok(ROSTER_PAIRS.some((p) => p.incoming === id)),
    leave: async (id) => {
      calls.push(['leave', id]);
      const r = state.members.find((m) => m.user_id === id);
      state.members = state.members.filter((m) => m.user_id !== id);
      state.club.chip_treasury = (
        Number(state.club.chip_treasury) + Number(r.chip_balance)
      ).toFixed(2);
      return { success: true, chips_returned: r.chip_balance };
    },
    join: async (id, request) => {
      calls.push(['join', id, request]);
      const m = row(id, { status: 'pending', chip_balance: '0.00' });
      state.members.push(m);
      return { success: true, status: 'pending', membership: structuredClone(m) };
    },
    approve: async (id) => {
      calls.push(['approve', id]);
      state.members.find((m) => m.user_id === id).status = 'active';
      return { success: true };
    },
    fund: async (id, request) => {
      calls.push(['fund', id, request]);
      assert.ok(!funded.has(id));
      funded.add(id);
      state.members.find((m) => m.user_id === id).chip_balance = '200.00';
      state.club.chip_treasury = (Number(state.club.chip_treasury) - 200).toFixed(2);
      return {
        success: true,
        amount: 200,
        destination: 'player_wallet',
        transaction_id: `tx-${id}`,
        replayed: false,
      };
    },
    verifyLeave: async (id) => ({ transactionId: `leave-${id}` }),
    verifyFunding: async (id, request) => {
      assert.ok(funded.has(id));
      assert.equal(request, rosterRequestId('fund', id));
    },
  };
  return {
    state,
    calls,
    journal,
    adapter,
    setHazards: (x) => (hazards = x),
    persist: async (r) => journal.push(r),
  };
}
const prepare = (f) =>
  prepareRoster({ adapter: f.adapter, sourceRunId: '123', operationId, now: () => 1000 });
const execute = (f, baseline, extra = {}) =>
  executeRoster({
    adapter: f.adapter,
    baseline,
    persist: f.persist,
    now: () => 1001,
    admission: { firstInvocation: true, prepareRunId: '123', executeRunId: '124' },
    ...extra,
  });
test('pinned prepare has no mutation; all23 normal door cycles conserve targeted gross and return', async () => {
  const f = fixture(),
    baseline = await prepare(f);
  assert.equal(f.calls.length, 0);
  const r = await execute(f, baseline);
  assert.equal(r.status, 'verified');
  assert.equal(r.grossFundingCents, 460000);
  assert.equal(r.returnedCents, 230000);
  assert.equal(f.state.members.length, 73);
  assert.equal(f.calls.length, 92);
  assert.equal(r.steps.filter((x) => x.status === 'verified').length, 92);
  assert.equal(Number(f.state.club.chip_treasury), 7700);
  assert.equal(r.capacityQualification, 'not_asserted');
  for (const p of ROSTER_PAIRS) {
    assert.ok(!f.state.members.some((m) => m.user_id === p.outgoing));
    assert.equal(f.state.members.find((m) => m.user_id === p.incoming).chip_balance, '200.00');
  }
  assert.equal(f.journal[1].steps[0].status, 'intent');
});
test('all financial obligations refuse before departure, and malformed money fails closed', async () => {
  for (const key of ['seats', 'uncashed', 'escrow', 'holds', 'cashouts', 'pool']) {
    const f = fixture();
    f.setHazards({ seats: 0, uncashed: 0, escrow: 0, holds: 0, cashouts: 0, pool: 0, [key]: 1 });
    await assert.rejects(prepare(f), /OUTGOING_NOT_SETTLED/);
    assert.equal(f.calls.length, 0);
  }
  assert.throws(() => rosterCents('NaN'));
  assert.throws(() => rosterCents('1.001'));
  assert.equal(rosterCents('0.10'), 10);
});
test('outgoing original membership and wallet drift refuse without leave', async () => {
  for (const field of ['joined_at', 'chip_balance']) {
    const f = fixture(),
      b = await prepare(f);
    f.state.members.find((m) => m.user_id === ROSTER_PAIRS[0].outgoing)[field] =
      field === 'joined_at' ? '2026-10-16T21:00:00Z' : '101.00';
    assert.equal((await execute(f, b)).status, 'stopped');
    assert.equal(f.calls.length, 0);
  }
});
test('retained natural wallet and treasury changes do not masquerade as roster drift', async () => {
  const f = fixture(),
    b = await prepare(f);
  f.state.members.find((m) => m.user_id === 'retained-0').chip_balance = '90.00';
  f.state.club.chip_treasury = '9999.00';
  const r = await execute(f, b);
  assert.equal(r.status, 'verified');
  assert.equal(f.state.members.find((m) => m.user_id === 'retained-0').chip_balance, '90.00');
});
test('timeout after actual committed leave stops without a second door or retry', async () => {
  const f = fixture(),
    b = await prepare(f),
    normal = f.adapter.leave;
  f.adapter.leave = async (id) => {
    await normal(id);
    throw Error('transport secret');
  };
  const r = await execute(f, b);
  assert.equal(r.status, 'stopped');
  assert.equal(r.cause, 'DOOR_OUTCOME_UNKNOWN');
  assert.equal(f.calls.length, 1);
  assert.equal(r.steps[0].status, 'unknown');
  assert.ok(!JSON.stringify(r).includes('transport secret'));
});
test('funding refusal/ambiguous response stops at exact target without fallback or new key', async () => {
  for (const response of [
    { success: false },
    { success: true, amount: 200, destination: 'agent_wallet', transaction_id: 'wrong' },
  ]) {
    const f = fixture(),
      b = await prepare(f);
    f.adapter.fund = async (id, key) => {
      f.calls.push(['fund', id, key]);
      return response;
    };
    const r = await execute(f, b);
    assert.equal(r.status, 'stopped');
    assert.equal(f.calls.filter((c) => c[0] === 'fund').length, 1);
    assert.equal(r.grossFundingCents, 0);
  }
});
test('tampered baseline, missing durable sink, rerun and wrong provenance are rejected before actions', async () => {
  const f = fixture(),
    b = await prepare(f);
  await assert.rejects(execute(f, { ...b, clubId: 'wrong' }), /INVALID_BASELINE/);
  await assert.rejects(execute(f, b, { persist: null }), /DURABLE_RESULT/);
  for (const a of [
    { firstInvocation: 'true', prepareRunId: '123', executeRunId: '124' },
    { firstInvocation: true, prepareRunId: 'wrong', executeRunId: '124' },
  ])
    await assert.rejects(execute(f, b, { admission: a }), /FIRST_EXECUTION/);
  assert.equal(f.calls.length, 0);
});
test('persistence failure before intent prevents any financial call; deadline is finite', async () => {
  const f = fixture(),
    b = await prepare(f);
  await assert.rejects(
    execute(f, b, {
      persist: async () => {
        throw Error('disk');
      },
    })
  );
  assert.equal(f.calls.length, 0);
  let clock = 1001;
  const r = await execute(f, b, { now: () => clock++, timeoutMs: 1 });
  assert.equal(r.status, 'stopped');
  assert.equal(f.calls.length, 0);
});
test('real adapter binds maintained installed contracts and never calls retired or broad seed doors', () => {
  const source = readFileSync(new URL('./lightning-pilot-roster.mjs', import.meta.url), 'utf8');
  for (const text of [
    "owner.rpc('fn_member_leave_to_treasury'",
    "client.rpc('fn_join_club_atomic'",
    "owner.rpc('fn_review_join_request'",
    'p_approve:true',
    "owner.rpc('fn_club_bank_send'",
    "p_destination:'player_wallet'",
    'cashier_rpc_operation_intents',
    'metadata->>op_id',
    "signOut({scope:'local'})",
  ])
    assert.ok(source.replace(/\s/g, '').includes(text.replace(/\s/g, '')), text);
  assert.ok(!source.includes("rpc('fn_leave_club_atomic'"));
  assert.ok(!source.includes('fn_seed_horses_to_floor'));
  const adapterSource = source.slice(source.indexOf('export function createRosterAdapter'));
  assert.ok(!adapterSource.includes('.update('));
  assert.ok(!adapterSource.includes('.delete('));
});

test('real adapters exercise installed row shapes, exact RPC arguments and durable funding proof', async () => {
  const id = ROSTER_PAIRS[0].incoming,
    op = rosterRequestId('fund', id),
    calls = [];
  const m = row(id, { club_id: ROSTER_CLUB, status: 'pending', chip_balance: '0.00' });
  let wrongClub = false;
  const admin = {
    rpc: async (name) => ({ data: name === 'fn_club_membership_cap' ? 10 : 2 }),
    auth: {
      admin: {
        getUserById: async (user) => ({
          data: { user: { id: user, email: 'existing@horses.smarter.poker' } },
        }),
        generateLink: async () => ({
          data: { user: { id }, properties: { hashed_token: 'memory-only' } },
        }),
      },
    },
    from(table) {
      const q = {
        filters: [],
        eq(k, v) {
          this.filters.push([k, v]);
          return this;
        },
        select() {
          return this;
        },
        maybeSingle() {
          return this;
        },
        limit() {
          return this;
        },
        gte() {
          return this;
        },
        then(resolve, reject) {
          let value;
          if (table === 'profiles') value = { id, is_horse: true, status: 'active' };
          else if (table === 'club_members') value = m;
          else if (table === 'cashier_rpc_operation_intents')
            value = {
              actor_user_id: PILOT.ownerId,
              action: 'club_bank_send',
              club_id: ROSTER_CLUB,
              operation_intent: {
                actor: PILOT.ownerId,
                club: ROSTER_CLUB,
                action: 'club_bank_send',
                target: id,
                amount: 200,
                effective_wallet: 'player_wallet',
                reason: 'lightning-approved-roster-20261016',
              },
              receipt: { success: true, transaction_id: 'tx' },
              completed_at: '2026-10-16T21:00:00Z',
            };
          else if (table === 'chip_transactions')
            value = [
              {
                id: 'tx',
                from_user_id: PILOT.ownerId,
                to_user_id: id,
                amount: '200.00',
                metadata: { op_id: op, destination: 'player_wallet' },
              },
            ];
          else throw Error('unexpected table');
          calls.push(['select', table, this.filters]);
          return Promise.resolve({ data: structuredClone(value) }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  const horse = {
    auth: {
      verifyOtp: async () => ({ data: { user: { id }, session: { user: { id } } } }),
      getUser: async () => ({ data: { user: { id } } }),
      signOut: async (args) => {
        calls.push(['cleanup', args]);
        return {};
      },
    },
    rpc: async (name, args) => {
      calls.push(['horse', name, args]);
      return {
        data: {
          success: true,
          club: { id: wrongClub ? 'wrong' : ROSTER_CLUB },
          status: 'pending',
          membership: m,
        },
      };
    },
  };
  const owner = {
    auth: { getUser: async () => ({ data: { user: { id: PILOT.ownerId } } }) },
    rpc: async (name, args) => {
      calls.push(['owner', name, args]);
      return {
        data: { success: true, transaction_id: 'tx', amount: 200, destination: 'player_wallet' },
      };
    },
  };
  const adapter = createRosterAdapter({
    admin,
    owner,
    createClient: () => horse,
    url: 'https://example.invalid',
  });
  const joined = await adapter.join(id, rosterRequestId('join', id));
  assert.deepEqual(joined.membership, m);
  assert.deepEqual(
    calls.find((c) => c[0] === 'horse'),
    [
      'horse',
      'fn_join_club_atomic',
      {
        p_identifier: ROSTER_CLUB,
        p_request_id: rosterRequestId('join', id),
        p_referral_code: null,
      },
    ]
  );
  assert.deepEqual(
    calls.find((c) => c[0] === 'cleanup'),
    ['cleanup', { scope: 'local' }]
  );
  await adapter.approve(id);
  await adapter.fund(id, op);
  await adapter.verifyFunding(id, op);
  assert.deepEqual(
    calls.find((c) => c[1] === 'fn_review_join_request'),
    ['owner', 'fn_review_join_request', { p_club_id: ROSTER_CLUB, p_user_id: id, p_approve: true }]
  );
  assert.deepEqual(
    calls.find((c) => c[1] === 'fn_club_bank_send'),
    [
      'owner',
      'fn_club_bank_send',
      {
        p_club_id: ROSTER_CLUB,
        p_to_user_id: id,
        p_amount: 200,
        p_destination: 'player_wallet',
        p_reason: 'lightning-approved-roster-20261016',
        p_op_id: op,
      },
    ]
  );
  wrongClub = true;
  await assert.rejects(adapter.join(id, rosterRequestId('join', id)), /JOIN_RECEIPT_SCOPE/);
  assert.equal(calls.filter((c) => c[0] === 'cleanup').length, 2);
});

test('freeze, commerce refusal and a human roster fail before any normal door', async () => {
  for (const mode of ['freeze', 'commerce', 'human']) {
    const f = fixture(),
      snapshot = f.adapter.snapshot;
    f.adapter.snapshot = async (id) => {
      const s = await snapshot(id);
      if (mode === 'freeze') s.frozen = true;
      if (mode === 'commerce') s.admission.allowed = false;
      if (mode === 'human')
        s.profiles.find((p) => p.id === ROSTER_PAIRS[0].outgoing).is_horse = false;
      return s;
    };
    await assert.rejects(prepare(f));
    assert.equal(f.calls.length, 0);
  }
});
test('prepared request manifest is pinned; stale baseline and durable funding proof failure refuse', async () => {
  const f = fixture(),
    b = await prepare(f);
  assert.equal(b.requests.length, 23);
  assert.equal(b.requests[0].fundRequestId, rosterRequestId('fund', ROSTER_PAIRS[0].incoming));
  await assert.rejects(execute(f, b, { now: () => 1801001 }), /BASELINE_EXPIRED/);
  f.adapter.verifyFunding = async () => {
    throw Error('unverified ledger');
  };
  const r = await execute(f, b);
  assert.equal(r.status, 'stopped');
  assert.equal(f.calls.filter((c) => c[0] === 'fund').length, 1);
  assert.equal(r.steps.at(-1).status, 'acknowledged');
});
