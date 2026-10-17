import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rosterMain,
  rosterFundingReadback,
  assertIncomingEligibility,
  ROSTER_CLUSTERS,
  ROSTER_OPERATION,
  ROSTER_MANIFEST_SHA256,
  createRosterAdapter,
  prepareRoster,
  executeRoster,
  ROSTER_CLUB,
  ROSTER_PAIRS,
  rosterCents,
  rosterRequestId,
} from './lightning-pilot-roster.mjs';
import { PILOT, PILOT_TARGETS } from './prepare-lightning-private-pilot.mjs';
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
  promo_balance: '0.00',
  diamonds: '0',
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
    games: ROSTER_CLUSTERS.map((id, i) => {
      const t = PILOT_TARGETS[i],
        action = t.templateName === 'action';
      return {
        id,
        club_id: ROSTER_CLUB,
        union_id: null,
        name: t.gameName,
        template_name: t.templateName,
        variant: 'nlh',
        handedness: t.handedness,
        sb: t.sb,
        bb: t.bb,
        enabled: true,
        must_move: true,
        cluster_mode: 'must_move',
        lightning_enabled: false,
        ruleset_snapshot: {
          template: t.templateName,
          variant: 'nlh',
          regular_ante: action ? 'sb' : 'bb',
          vpip_floor: action ? 30 : 50,
          vpip_window: 10,
          bombs: {
            enabled: true,
            trigger: action ? 'timed_20m' : 'timed_10m',
            ante_bb: action ? 2 : 3,
            boards: 2,
          },
          options: { is_private: true },
        },
      };
    }),
    members: [
      row(PILOT.ownerId, { role: 'owner' }),
      ...Array.from({ length: 49 }, (_, i) => row(`retained-${i}`)),
      ...ROSTER_PAIRS.map((p) => row(p.outgoing)),
    ],
  };
  const calls = [],
    journal = [],
    funded = new Set();
  let hazards = { seats: 0, uncashed: 0, escrow: 0, holds: 0, cashouts: 0, pool: 0, events: 0 };
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
        recipient_balance_after: 200,
        bank_before: Number(state.club.chip_treasury) + 200,
        bank_after: Number(state.club.chip_treasury),
      };
    },
    verifyLeave: async (id) => ({ transactionId: `leave-${id}` }),
    verifyFunding: async (id, request, response) => {
      assert.ok(funded.has(id));
      assert.equal(request, rosterRequestId('fund', id));
      return rosterFundingReadback(response);
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
  for (const key of ['seats', 'uncashed', 'escrow', 'holds', 'cashouts', 'pool', 'events']) {
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
  let receiptPatch = {},
    metadataPatch = {},
    balanceAfter = '800.00';
  let openCashSessions = 0;
  let horseEmail = 'existing@horses.smarter.poker';
  let horseIdentity = id;
  let horseProfile = { id, is_horse: true, status: 'active', horse_profile: { lane: 'cash' } };
  const admin = {
    rpc: async (name) => ({
      data: name === 'fn_club_membership_cap' ? 10 : name === 'fn_concurrent_game_load' ? 1 : 2,
    }),
    auth: {
      admin: {
        getUserById: async (user) => ({
          data: { user: { id: horseIdentity, email: horseEmail } },
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
        select(fields) {
          this.fields = fields;
          return this;
        },
        is() {
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
          if (table === 'profiles') value = horseProfile;
          else if (table === 'club_members') value = this.fields === 'user_id' ? null : m;
          else if (table === 'stable_hand_horse_state')
            value = {
              horse_id: id,
              rest_weekday: null,
              daily_cap_minutes: 525,
              minutes_played_today: 0,
              counters_reset_on: null,
            };
          else if (table === 'table_seats' || table === 'cash_player_session') value = [];
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
                reason: 'lightning-action-madness-roster-amended-20261017',
              },
              receipt: {
                success: true,
                transaction_id: 'tx',
                amount: 200,
                destination: 'player_wallet',
                recipient_balance_after: 200,
                bank_before: 1000,
                bank_after: 800,
                ...receiptPatch,
              },
              completed_at: '2026-10-16T21:00:00Z',
            };
          else if (table === 'chip_transactions')
            value = [
              {
                id: 'tx',
                from_user_id: PILOT.ownerId,
                to_user_id: id,
                amount: '200.00',
                metadata: {
                  op_id: op,
                  destination: 'player_wallet',
                  recipient_balance_after: 200,
                  bank_before: 1000,
                  bank_after: 800,
                  ...metadataPatch,
                },
                balance_after: balanceAfter,
              },
            ];
          else throw Error('unexpected table');
          calls.push(['select', table, this.filters]);
          return Promise.resolve({
            data: structuredClone(value),
            ...(table === 'cash_player_session' ? { count: openCashSessions } : {}),
          }).then(resolve, reject);
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
        data: {
          success: true,
          transaction_id: 'tx',
          amount: 200,
          destination: 'player_wallet',
          recipient_balance_after: 200,
          bank_before: 1000,
          bank_after: 800,
        },
      };
    },
  };
  const adapter = createRosterAdapter({
    admin,
    owner,
    createClient: () => horse,
    url: 'https://example.invalid',
    now: () => Date.parse('2026-10-17T02:43:00Z'),
  });
  // These actual domains belong to exact owner-approved existing horse IDs.
  for (const domain of [
    'horse.ai',
    'smarter.poker',
    'horses.smarter.poker',
    'hydra.smarter.poker',
    'bot.smarter.poker',
  ]) {
    horseEmail = `existing@${domain}`;
    assert.equal((await adapter.validateIncoming(id)).id, id);
  }
  for (const patch of [{ is_horse: false }, { status: 'inactive' }, { id: 'foreign' }]) {
    horseProfile = {
      id,
      is_horse: true,
      status: 'active',
      horse_profile: { lane: 'cash' },
      ...patch,
    };
    await assert.rejects(adapter.validateIncoming(id), /HORSE_IDENTITY_CHANGED/);
  }
  horseProfile = { id, is_horse: true, status: 'active', horse_profile: { lane: 'cash' } };
  horseIdentity = 'foreign';
  await assert.rejects(adapter.validateIncoming(id), /HORSE_IDENTITY_CHANGED/);
  horseIdentity = id;
  await assert.rejects(adapter.validateIncoming(PILOT.ownerId), /UNPINNED_HORSE/);
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
  const fundedResponse = await adapter.fund(id, op);
  await adapter.verifyFunding(id, op, fundedResponse);
  for (const patch of [{ recipient_balance_after: 201 }, { bank_before: 1200, bank_after: 1000 }]) {
    metadataPatch = patch;
    await assert.rejects(adapter.verifyFunding(id, op, fundedResponse));
  }
  metadataPatch = {};
  receiptPatch = { bank_before: 1200, bank_after: 1000 };
  await assert.rejects(adapter.verifyFunding(id, op, fundedResponse));
  receiptPatch = {};
  balanceAfter = '799.00';
  await assert.rejects(adapter.verifyFunding(id, op, fundedResponse));
  balanceAfter = '800.00';
  openCashSessions = 1;
  await assert.rejects(adapter.validateIncoming(id), /INCOMING_CASH_EXPOSURE_CHANGED/);
  openCashSessions = 0;
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
        p_reason: 'lightning-action-madness-roster-amended-20261017',
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

// The failed first preparation hid its failing boundary. Only owned static
// codes may reach reports; provider payloads can contain sensitive data.
test('CLI reports its failing boundary and static code without copying provider errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lightning-roster-diagnostic-'));
  const secret = 'PROVIDER_PAYLOAD_MUST_NOT_APPEAR';
  const env = {
    PILOT_ROSTER_PHASE: 'prepare',
    PILOT_ROSTER_OPERATION_ID: operationId,
    SP_EMAIL: PILOT.ownerEmail,
    SP_PASS: secret,
    SUPABASE_URL: 'https://example.invalid',
    SUPABASE_SERVICE_ROLE_KEY: secret,
    PILOT_ROSTER_REPORT_PATH: join(dir, 'report.json'),
  };
  let signedOut = false;
  try {
    const result = await rosterMain(env, () => ({
      auth: {
        signInWithPassword: async () => ({ error: { message: secret } }),
        signOut: async (args) => {
          assert.equal(args.scope, 'local');
          signedOut = true;
          return {};
        },
      },
    }));
    assert.equal(result.phase, 'authentication');
    assert.equal(result.diagnostic, 'OWNER_LOGIN_UNAVAILABLE_UNKNOWN');
    assert.equal(result.cleanup, 'local_session_closed');
    assert.equal(signedOut, true);
    assert.equal(JSON.stringify(result).includes(secret), false);
    const unexpected = await rosterMain(env, () => {
      throw new Error(secret);
    });
    assert.equal(unexpected.diagnostic, 'UNEXPECTED_FAILURE');
    assert.equal(JSON.stringify(unexpected).includes(secret), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('population eligibility follows current Chicago day/rest and integer UTC awake hours without duration floors', () => {
  const id = ROSTER_PAIRS[0].incoming,
    at = Date.parse('2026-10-17T02:43:00Z');
  const base = {
    id,
    profile: { horse_profile: { lane: 'cash' } },
    state: {
      horse_id: id,
      rest_weekday: 6,
      daily_cap_minutes: 525,
      minutes_played_today: 600,
      counters_reset_on: '2026-10-15',
    },
    load: 2,
    activeCashSeats: 0,
    openCashSessions: 0,
  };
  const proof = assertIncomingEligibility(base, at);
  assert.equal(proof.chicagoDay, '2026-10-16');
  assert.equal(proof.clock, 'host_normal_fleet_clock');
  assert.throws(
    () =>
      assertIncomingEligibility(
        { ...base, state: { ...base.state, counters_reset_on: '2026-10-16' } },
        at
      ),
    /INCOMING_DAILY_CAP/
  );
  assert.throws(
    () => assertIncomingEligibility({ ...base, state: { ...base.state, rest_weekday: 5 } }, at),
    /INCOMING_REST_DAY/
  );
  assert.throws(
    () => assertIncomingEligibility({ ...base, load: 3 }, at),
    /INCOMING_GAME_LOAD_CHANGED/
  );
  assert.throws(
    () => assertIncomingEligibility({ ...base, activeCashSeats: 1 }, at),
    /INCOMING_CASH_EXPOSURE_CHANGED/
  );
  assert.throws(
    () =>
      assertIncomingEligibility({ ...base, profile: { horse_profile: { lane: 'events' } } }, at),
    /INCOMING_CASH_LANE_REQUIRED/
  );
  assert.throws(
    () =>
      assertIncomingEligibility(
        { ...base, state: { ...base.state, daily_cap_minutes: 'unknown' } },
        at
      ),
    /INCOMING_DAY_STATE_UNREADABLE/
  );
  // Compare directly with the maintained pure normal fleet producer for every UTC hour.
  const behavior = readFileSync(
    new URL('../../server/src/services/HorseBehavior.ts', import.meta.url),
    'utf8'
  );
  const hashBody = behavior.match(
    /export function horseHash\(id: string\): number \{([\s\S]*?)\n\}/
  )[1];
  const activeBody = behavior.match(
    /export function isActiveNow\(horseId: string, hourUTC: number\): boolean \{([\s\S]*?)\n\}/
  )[1];
  const hash = new Function('id', hashBody),
    normal = new Function('horseHash', 'horseId', 'hourUTC', activeBody);
  const outcomes = [];
  for (let hour = 0; hour < 24; hour++) {
    const instant = Date.parse(`2026-10-17T${String(hour).padStart(2, '0')}:59:59Z`);
    let passes = true;
    try {
      assertIncomingEligibility({ ...base, state: null }, instant);
    } catch (e) {
      assert.match(e.message, /INCOMING_ASLEEP/);
      passes = false;
    }
    assert.equal(passes, normal(hash, id, hour));
    outcomes.push(passes);
  }
  const lastActive = outcomes.findIndex((active, hour) => active && !outcomes[(hour + 1) % 24]);
  assert.ok(lastActive >= 0);
  assert.doesNotThrow(() =>
    assertIncomingEligibility(
      { ...base, state: null },
      Date.parse(`2026-10-17T${String(lastActive).padStart(2, '0')}:59:59Z`)
    )
  );
});

test('new operation refuses changed incoming eligibility before departure and before later admission', async () => {
  const f = fixture(),
    baseline = await prepare(f);
  f.adapter.validateIncoming = async () => {
    throw Error('INCOMING_REST_DAY');
  };
  const stopped = await execute(f, baseline);
  assert.equal(stopped.status, 'stopped');
  assert.equal(f.calls.length, 0);
  const g = fixture(),
    b = await prepare(g);
  let checks = 0;
  g.adapter.validateIncoming = async () => {
    checks++;
    if (checks > 23) throw Error('INCOMING_ASLEEP');
  };
  const later = await execute(g, b);
  assert.equal(later.status, 'stopped');
  assert.equal(g.calls.length, 23);
  assert.ok(g.calls.every((c) => c[0] === 'leave'));
});

test('target binding rejects Classic, wrong snapshot and active replacement targets', async () => {
  for (const kind of ['classic', 'snapshot', 'active']) {
    const f = fixture();
    if (kind === 'classic') f.state.games[0].template_name = 'classic';
    if (kind === 'snapshot') f.state.games[0].ruleset_snapshot.template = 'classic';
    if (kind === 'active') f.state.games[0].lightning_enabled = true;
    await assert.rejects(prepare(f));
    assert.equal(f.calls.length, 0);
  }
  assert.equal(ROSTER_OPERATION, 'lightning-action-madness-roster-amended-20261017');
  assert.equal(new Set(ROSTER_PAIRS.flatMap((p) => [p.incoming, p.outgoing])).size, 46);
  assert.deepEqual(ROSTER_PAIRS[19], {
    outgoing: '0b1a64c2-8970-4f89-a396-9863e3aa2ccc',
    incoming: '2af500e1-1665-4468-84d1-e346e64fcb68',
  });
  assert.deepEqual(ROSTER_PAIRS[22], {
    outgoing: '0f14f372-0c43-47ff-9257-1324a7e94488',
    incoming: '4381b30d-631e-4146-a2de-2f01dd1a36e9',
  });
  assert.equal(
    ROSTER_PAIRS.some((p) =>
      ['60e31431-564b-402e-a574-96db4b774e06', 'e573c327-dc89-4d87-81f0-efd0cb3c8020'].includes(
        p.incoming
      )
    ),
    false
  );
});

test('atomic bank-send readback rejects corrupt recipient or bank debit without retry', async () => {
  for (const patch of [{ recipient_balance_after: 199 }, { bank_after: 10 }, { bank_after: -1 }]) {
    const f = fixture(),
      b = await prepare(f),
      fund = f.adapter.fund;
    f.adapter.fund = async (...args) => ({ ...(await fund(...args)), ...patch });
    const r = await execute(f, b);
    assert.equal(r.status, 'stopped');
    assert.equal(f.calls.filter((c) => c[0] === 'fund').length, 1);
    assert.equal(r.steps.at(-1).status, 'acknowledged');
  }
});
test('atomic funding proof survives subsequent natural wallet spend and retains transaction-time balances', async () => {
  const f = fixture(),
    b = await prepare(f),
    fund = f.adapter.fund;
  f.adapter.fund = async (...args) => {
    const result = await fund(...args);
    f.state.members.find((m) => m.user_id === args[0]).chip_balance = '190.00';
    return result;
  };
  const r = await execute(f, b);
  assert.equal(r.status, 'verified');
  const step = r.steps.find((s) => s.kind === 'fund');
  assert.equal(step.walletAfterAtFunding, 200);
  assert.equal(step.bankBeforeAtFunding - step.bankAfterAtFunding, 200);
  assert.ok(step.transactionId);
  assert.equal(
    f.state.members.find((m) => m.user_id === ROSTER_PAIRS[0].incoming).chip_balance,
    '190.00'
  );
});

test('maintained approved manifest binds every pair and admission identity to the exact source and bytes', () => {
  const raw = readFileSync(
    new URL('../../docs/lightning/POPULATION-ROSTER-MANIFEST-2026-10-17.json', import.meta.url)
  );
  const manifest = JSON.parse(raw);
  assert.deepEqual(manifest.pairs, ROSTER_PAIRS);
  assert.equal(manifest.admissionPlan.length, 23);
  const admitted = manifest.admissionPlan.map((p) => p.playerId);
  assert.equal(new Set(admitted).size, 23);
  assert.deepEqual([...admitted].sort(), ROSTER_PAIRS.map((p) => p.incoming).sort());
  assert.equal(manifest.operation, ROSTER_OPERATION);
  assert.equal(manifest.clubId, ROSTER_CLUB);
  assert.deepEqual([manifest.actionClusterId, manifest.madnessClusterId], ROSTER_CLUSTERS);
  assert.equal(manifest.fundingPerIncoming, 200);
  assert.equal(manifest.grossFunding, 4600);
  assert.equal(manifest.rules.preserve72HorseCount, true);
  assert.equal(createHash('sha256').update(raw).digest('hex'), ROSTER_MANIFEST_SHA256);
});
