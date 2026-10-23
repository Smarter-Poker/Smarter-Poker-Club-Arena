import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ASSIGNMENT_MEMBERS,
  ASSIGNMENT_MANIFEST_SHA256,
  assignmentWithdrawalRequestId,
  withdrawalPreflight,
  proveAssignmentWithdrawal,
  prepareAssignmentWithdrawals,
  withdrawAssignment,
  createAssignmentWithdrawalAdapter,
} from './lightning-pilot-assignment-withdraw.mjs';
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-10-17T04:40:00Z'),
  operationId = id(99),
  SECRET = 'DO_NOT_RETAIN_TOKEN_OR_ERROR';
const scopes = [0, 1].map((i) => ({
  playerId: ASSIGNMENT_MEMBERS[i],
  eventId: id(i + 1),
  bookingId: id(i + 3),
}));
function snapshot(e, asset = 'chips') {
  return {
    registration: {
      id: e.bookingId,
      user_id: e.playerId,
      tournament_id: e.eventId,
      status: 'registered',
      registered_at: '2026-10-17T04:00:00.000001+00:00',
      table_id: null,
      seat_number: null,
    },
    event: {
      id: e.eventId,
      club_id: id(50),
      status: 'REGISTERING',
      start_time: '2026-10-17T06:00:00+00:00',
      started_at: null,
      buy_in_amount: 0,
      buy_in_fee: '0.00',
      bounty_amount: 0,
    },
    asset,
    entitlements: [],
    custodies:
      asset === 'diamonds'
        ? [
            {
              id: id(20),
              user_id: e.playerId,
              target_id: e.eventId,
              purpose: 'tournament_entry',
              entry_key: `entry:${e.bookingId}`,
              state: 'active',
              balance: 0,
              seat_id: null,
            },
          ]
        : [],
    counts: {
      activeSeats: 0,
      activeHands: 0,
      seatContracts: 0,
      positiveChipFunding: 0,
      positiveDiamondFunding: 0,
      diamondLedger: 0,
    },
  };
}
function chipReceipt(e) {
  return {
    ok: true,
    registration_id: e.bookingId,
    request_id: e.requestId,
    refunded_chips: 0,
    returned_ticket_value: 0,
    fees_reversed: 0,
    entitlement_ids: [],
    credit_ledger_ids: [],
    wallet_transaction_ids: [],
    ticket_ids: [],
    fee_reversal_ids: [],
    scheduled_start_at: '2026-10-17T06:00:00+00:00',
    settled_at: '2026-10-17T04:41:00+00:00',
  };
}
function outcome(e) {
  if (e.identity.asset === 'chips')
    return { registrationAbsent: true, chipReceipt: chipReceipt(e), movement: null };
  const custody = {
    ...snapshot(e, 'diamonds').custodies[0],
    state: 'released',
    released_at: '2026-10-17T04:41:00Z',
  };
  return {
    registrationAbsent: true,
    chipReceipt: null,
    custody,
    diamondLedgerCount: 0,
    movement: {
      request_id: e.requestId,
      custody_id: custody.id,
      user_id: e.playerId,
      action: 'release',
      amount: 0,
      wallet_journal_id: null,
      request: { action: 'release', custody_id: custody.id, user_id: e.playerId },
      receipt: {
        success: true,
        custody_id: custody.id,
        request_id: e.requestId,
        amount: 0,
        custody_balance: 0,
        debt_settled: 0,
        journal_id: null,
      },
    },
  };
}
function fixture() {
  const snapshots = scopes.map((e, i) => snapshot(e, i ? 'diamonds' : 'chips')),
    calls = [],
    closed = [],
    done = new Set();
  let lost = false,
    committedLost = false,
    prior = false,
    partialAuth = false,
    cleanupError = false;
  const adapter = {
    listRegistrations: async (ids) => {
      assert.deepEqual(ids, ASSIGNMENT_MEMBERS);
      return scopes;
    },
    readRegistration: async (e) =>
      structuredClone(snapshots[scopes.findIndex((s) => s.bookingId === e.bookingId)]),
    readOutcome: async (e) =>
      done.has(e.bookingId) || prior
        ? outcome(e)
        : { registrationAbsent: false, chipReceipt: null, movement: null },
    assertAssignmentActive: async () => ({
      active: true,
      manifest_sha256: ASSIGNMENT_MANIFEST_SHA256,
      player_ids: ASSIGNMENT_MEMBERS,
    }),
    openPlayer: async (player, { onClient }) => {
      const client = {
        auth: {
          getUser: async () => ({ data: { user: { id: player } } }),
          signOut: async (opts) => {
            assert.deepEqual(opts, { scope: 'local' });
            closed.push(player);
            return cleanupError ? { error: SECRET } : {};
          },
        },
        rpc: async (name, args) => {
          assert.equal(name, 'fn_lightning_pilot_withdraw_zero');
          const e = scopes.find((s) => s.eventId === args.p_tournament_id);
          assert.deepEqual(args, {
            p_tournament_id: e.eventId,
            p_registration_id: e.bookingId,
            p_request_id: assignmentWithdrawalRequestId(operationId, e),
          });
          assert.equal(e.playerId, player);
          calls.push(args);
          if (lost) throw Error(SECRET);
          done.add(e.bookingId);
          if (committedLost) throw Error(SECRET);
          return { data: { ok: true } };
        },
      };
      onClient(client);
      if (partialAuth) throw Error(SECRET);
      return { client };
    },
  };
  return {
    adapter,
    snapshots,
    calls,
    closed,
    setLost: (x) => (lost = x),
    setCommittedLost: (x) => (committedLost = x),
    setPrior: (x) => (prior = x),
    setPartial: (x) => (partialAuth = x),
    setCleanup: (x) => (cleanupError = x),
  };
}
const prepare = (f) =>
  prepareAssignmentWithdrawals({ adapter: f.adapter, operationId, now: () => NOW });
const execute = (f, baseline, extra = {}) =>
  withdrawAssignment({
    adapter: f.adapter,
    baseline,
    persist: async () => {},
    now: () => NOW,
    ...extra,
  });
test('exact approved72 and deterministic registration-bound request identities', async () => {
  assert.equal(ASSIGNMENT_MEMBERS.length, 144);
  assert.equal(new Set(ASSIGNMENT_MEMBERS).size, 144);
  assert.notEqual(
    assignmentWithdrawalRequestId(operationId, scopes[0]),
    assignmentWithdrawalRequestId(operationId, { ...scopes[0], bookingId: id(70) })
  );
  assert.throws(() =>
    assignmentWithdrawalRequestId(operationId, { ...scopes[0], playerId: id(71) })
  );
  const f = fixture(),
    b = await prepare(f);
  assert.equal(b.entries.length, 2);
  assert.equal(f.calls.length, 0);
  assert.equal(b.manifestSha256, ASSIGNMENT_MANIFEST_SHA256);
});
test('paid, running, existing hand/seat or ineligible custody is preserved before authentication', () => {
  for (const mutate of [
    (s) => (s.event.buy_in_amount = 1),
    (s) => (s.event.status = 'RUNNING'),
    (s) => (s.event.started_at = '2026-10-17T04:00:00Z'),
    (s) => (s.event.start_time = '2026-10-17T04:30:00Z'),
    (s) => (s.registration.table_id = id(77)),
    (s) => (s.counts.activeSeats = 1),
    (s) => (s.counts.activeHands = 1),
    (s) => (s.counts.positiveChipFunding = 1),
    (s) => (s.counts.positiveDiamondFunding = 1),
    (s) => (s.custodies[0].balance = 1),
    (s) => (s.counts.diamondLedger = 1),
  ]) {
    const s = snapshot(scopes[0], 'diamonds');
    mutate(s);
    assert.equal(withdrawalPreflight(s, scopes[0], NOW).allowed, false);
  }
  const s = snapshot(scopes[0]);
  delete s.counts.activeHands;
  assert.throws(() => withdrawalPreflight(s, scopes[0], NOW), /READ_UNAVAILABLE/);
});
test('both normal single attempts establish exact zero chip receipt or zero Diamond released custody', async () => {
  const f = fixture(),
    b = await prepare(f),
    saved = [];
  const r = await execute(f, b, { persist: async (x) => saved.push(x) });
  assert.equal(r.status, 'verified');
  assert.equal(r.cleanup, 'local_sessions_closed');
  assert.equal(r.counts.verified, 2);
  assert.equal(f.calls.length, 2);
  assert.equal(f.closed.length, 2);
  assert.equal(saved.filter((x) => x.steps.at(-1)?.status === 'intent').length, 2);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
});
test('changed paid/started booking is preserved and a replacement lifecycle is never adopted', async () => {
  const f = fixture(),
    b = await prepare(f);
  f.snapshots[0].event.status = 'RUNNING';
  f.snapshots[1].event.buy_in_fee = 1;
  const r = await execute(f, b);
  assert.equal(r.status, 'verified_with_preserved');
  assert.equal(f.calls.length, 0);
  assert.equal(r.counts.preserved, 2);
  const g = fixture(),
    c = await prepare(g);
  g.snapshots[0].registration.registered_at = '2026-10-17T04:00:00.000002+00:00';
  const stopped = await execute(g, c);
  assert.equal(stopped.status, 'stopped');
  assert.equal(g.calls.length, 0);
});
test('prior outcomes and replayed baseline refuse without repeating any normal write', async () => {
  const f = fixture(),
    b = await prepare(f);
  f.setPrior(true);
  const r = await execute(f, b);
  assert.equal(r.status, 'stopped');
  assert.equal(r.cause, 'PRIOR_OR_UNKNOWN_OUTCOME_NO_REPLAY');
  assert.equal(f.calls.length, 0);
  await assert.rejects(prepare(f), /NO_REPLAY/);
  const g = fixture(),
    c = await prepare(g);
  await execute(g, c);
  const again = await execute(g, c);
  assert.equal(again.status, 'stopped');
  assert.equal(g.calls.length, 2);
});
test('lost acknowledgement is read back once; missing durable proof stops and local cleanup survives partial auth', async () => {
  const f = fixture(),
    b = await prepare(f);
  f.setLost(true);
  const r = await execute(f, b);
  assert.equal(r.status, 'stopped');
  assert.equal(f.calls.length, 1);
  assert.equal(f.closed.length, 1);
  assert.equal(r.steps[0].reply, 'unknown');
  assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
  const g = fixture(),
    c = await prepare(g);
  g.setCommittedLost(true);
  assert.equal((await execute(g, c)).status, 'verified');
  assert.equal(g.calls.length, 2);
  const h = fixture(),
    d = await prepare(h);
  h.setPartial(true);
  assert.equal((await execute(h, d)).cleanup, 'local_sessions_closed');
  assert.equal(h.closed.length, 1);
  assert.equal(h.calls.length, 0);
});
test('inactive assignment, deadline, tampered/expired baseline and cleanup failure cannot succeed', async () => {
  const f = fixture(),
    b = await prepare(f);
  f.adapter.assertAssignmentActive = async () => ({ active: false });
  assert.equal((await execute(f, b)).status, 'stopped');
  assert.equal(f.calls.length, 0);
  await assert.rejects(execute(f, { ...b, operationId: id(98) }), /BASELINE/);
  await assert.rejects(execute(f, b, { now: () => NOW + 1800001 }), /BASELINE/);
  const g = fixture(),
    c = await prepare(g);
  g.setCleanup(true);
  const r = await execute(g, c);
  assert.equal(r.cleanup, 'unknown');
  assert.equal(r.status, 'stopped');
  const h = fixture(),
    d = await prepare(h);
  let clock = NOW;
  const open = h.adapter.openPlayer;
  h.adapter.openPlayer = async (...args) => {
    const value = await open(...args);
    clock = NOW + 10001;
    return value;
  };
  const expired = await execute(h, d, { now: () => clock, timeoutMs: 30000 });
  assert.equal(expired.cause, 'DEADLINE');
  assert.equal(expired.cleanup, 'local_sessions_closed');
  assert.equal(h.closed.length, 1);
  assert.equal(h.calls.length, 0);
});
test('durable evidence binds exact request/registration and no positive or unrecorded release can qualify', async () => {
  const f = fixture(),
    b = await prepare(f);
  for (const mutate of [
    (o) => (o.chipReceipt.request_id = id(50)),
    (o) => (o.chipReceipt.refunded_chips = 1),
    (o) => (o.chipReceipt.wallet_transaction_ids = [id(60)]),
    (o) => (o.registrationAbsent = false),
  ]) {
    const o = outcome(b.entries[0]);
    mutate(o);
    assert.throws(() => proveAssignmentWithdrawal(b.entries[0], o));
  }
  for (const mutate of [
    (o) => (o.movement.request_id = id(50)),
    (o) => (o.custody.balance = 1),
    (o) => (o.movement.receipt.amount = 1),
    (o) => (o.diamondLedgerCount = 1),
    (o) => (o.movement.wallet_journal_id = id(60)),
  ]) {
    const o = outcome(b.entries[1]);
    mutate(o);
    assert.throws(() => proveAssignmentWithdrawal(b.entries[1], o));
  }
});
test('SDK adapter uses actual finite scoped queries and supported chip receipt RPC, not its protected raw table', async () => {
  const e = scopes[0],
    s = snapshot(e),
    queries = [];
  let absent = false,
    cap = false;
  const admin = {
    rpc: async (name, args) => {
      assert.equal(name, 'fn_lightning_pilot_withdrawal_receipt');
      assert.deepEqual(args, {
        p_player_id: e.playerId,
        p_tournament_id: e.eventId,
        p_registration_id: e.bookingId,
        p_request_id: assignmentWithdrawalRequestId(operationId, e),
      });
      return { data: absent ? chipReceipt({ ...e, requestId: args.p_request_id }) : null };
    },
    from(table) {
      assert.notEqual(table, 'tournament_unregistration_receipts');
      const filters = [],
        q = {};
      let fields,
        head = false;
      for (const method of ['eq', 'in', 'neq', 'gt', 'is', 'order', 'limit'])
        q[method] = (...args) => {
          filters.push([method, ...args]);
          return q;
        };
      q.select = (value, options) => {
        fields = value;
        head = options?.head === true;
        return q;
      };
      q.maybeSingle = () => q;
      q.then = (resolve, reject) => {
        queries.push({ table, fields, filters, head });
        let data = head
          ? null
          : table === 'tournament_players'
            ? fields === 'id'
              ? absent
                ? null
                : { id: e.bookingId }
              : fields === 'id,user_id,tournament_id'
                ? cap
                  ? Array(1000).fill({
                      id: e.bookingId,
                      user_id: e.playerId,
                      tournament_id: e.eventId,
                    })
                  : [{ id: e.bookingId, user_id: e.playerId, tournament_id: e.eventId }]
                : s.registration
            : table === 'tournaments'
              ? s.event
              : table === 'clubs'
                ? { id: s.event.club_id, asset: 'chips' }
                : table === 'tables'
                  ? [{ id: id(80), hands_dealt: 0 }]
                  : [];
        return Promise.resolve({
          data,
          count: head ? 0 : Array.isArray(data) ? data.length : undefined,
        }).then(resolve, reject);
      };
      return q;
    },
  };
  const adapter = createAssignmentWithdrawalAdapter({
    admin,
    openPlayer() {},
    assertAssignmentActive() {},
    now: () => NOW,
  });
  assert.equal((await adapter.listRegistrations(ASSIGNMENT_MEMBERS)).length, 1);
  assert.equal(withdrawalPreflight(await adapter.readRegistration(e), e, NOW).allowed, true);
  const entry = {
    ...e,
    requestId: assignmentWithdrawalRequestId(operationId, e),
    identity: withdrawalPreflight(s, e, NOW).identity,
  };
  assert.equal((await adapter.readOutcome(entry)).registrationAbsent, false);
  absent = true;
  assert.equal((await adapter.readOutcome(entry)).chipReceipt.registration_id, e.bookingId);
  assert.ok(
    queries.some(
      (q) =>
        q.table === 'table_seats' &&
        q.head &&
        q.filters.some((f) => f[0] === 'in' && f[1] === 'table_id')
    )
  );
  assert.ok(
    queries.some(
      (q) =>
        q.table === 'chip_ledger' &&
        q.head &&
        q.filters.some((f) => f[1] === 'from_entity_id' && f[2] === e.playerId)
    )
  );
  const outcomeQuery = queries.find((q) => q.table === 'tournament_players' && q.fields === 'id');
  assert.ok(!outcomeQuery.filters.some((f) => f[1] === 'id'));
  const beforePreserve = queries.length;
  s.event.status = 'RUNNING';
  assert.equal(withdrawalPreflight(await adapter.readRegistration(e), e, NOW).allowed, false);
  assert.deepEqual(
    queries.slice(beforePreserve).map((q) => q.table),
    ['tournament_players', 'tournaments']
  );
  cap = true;
  await assert.rejects(adapter.listRegistrations(ASSIGNMENT_MEMBERS), /INCOMPLETE/);
  const source = readFileSync(
    new URL('./lightning-pilot-assignment-withdraw.mjs', import.meta.url),
    'utf8'
  );
  assert.ok(!source.includes("from('tournament_unregistration_receipts')"));
  assert.ok(!source.includes("rpc('fn_poker_diamond_release'"));
});

test('bounded batch retains exact deferred identities and never authenticates or withdraws them', async () => {
  const f = fixture();
  const b = await prepareAssignmentWithdrawals({
    adapter: f.adapter,
    operationId,
    now: () => NOW,
    maxWithdrawals: 1,
    timeoutMs: 600000,
  });
  assert.equal(b.entries.length, 1);
  assert.equal(b.deferred.length, 1);
  assert.equal(b.deferred[0].bookingId, scopes[1].bookingId);
  const r = await execute(f, b, { timeoutMs: 600000 });
  assert.equal(r.status, 'verified_batch_with_deferred');
  assert.deepEqual(r.deferred, b.deferred);
  assert.equal(r.counts.deferred, 1);
  assert.equal(r.counts.verified, 1);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.closed, [scopes[0].playerId]);
  for (const timeoutMs of [29999, 600001, Infinity])
    await assert.rejects(
      prepareAssignmentWithdrawals({ adapter: f.adapter, operationId, now: () => NOW, timeoutMs }),
      /TIMEOUT/
    );
  for (const maxWithdrawals of [0, 73, 1.5])
    await assert.rejects(
      prepareAssignmentWithdrawals({
        adapter: f.adapter,
        operationId,
        now: () => NOW,
        maxWithdrawals,
      }),
      /BOUNDED_BATCH/
    );
});
test('read-only preparation is bounded to six simultaneous registrations and retains deterministic order', async () => {
  const rows = Array.from({ length: 13 }, (_, i) => ({
    playerId: ASSIGNMENT_MEMBERS[i],
    eventId: id(100 + i),
    bookingId: id(200 + i),
  }));
  let active = 0,
    peak = 0;
  const adapter = {
    listRegistrations: async () => [...rows].reverse(),
    readRegistration: async (e) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return snapshot(e);
    },
    readOutcome: async () => ({ registrationAbsent: false, chipReceipt: null, movement: null }),
  };
  const b = await prepareAssignmentWithdrawals({ adapter, operationId, now: () => NOW });
  assert.equal(peak, 6);
  assert.equal(active, 0);
  assert.deepEqual(
    b.entries.map((e) => e.playerId),
    rows.map((e) => e.playerId)
  );
});
test('Diamond adapter reads exact zero custody, request movement and custody-scoped ledger count', async () => {
  const e = scopes[1],
    s = snapshot(e, 'diamonds');
  const entry = {
    ...e,
    requestId: assignmentWithdrawalRequestId(operationId, e),
    identity: withdrawalPreflight(s, e, NOW).identity,
  };
  const expected = outcome(entry),
    queries = [];
  const admin = {
    from(table) {
      let fields,
        head = false;
      const filters = [],
        q = {};
      for (const method of ['eq', 'in', 'neq', 'gt', 'is', 'order', 'limit'])
        q[method] = (...args) => {
          filters.push([method, ...args]);
          return q;
        };
      q.select = (value, opts) => {
        fields = value;
        head = opts?.head === true;
        return q;
      };
      q.maybeSingle = () => q;
      q.then = (resolve, reject) => {
        queries.push({ table, fields, head, filters });
        const data = head
          ? null
          : table === 'tournament_players'
            ? null
            : table === 'poker_diamond_custody'
              ? expected.custody
              : table === 'poker_diamond_movements'
                ? expected.movement
                : null;
        return Promise.resolve({ data, count: head ? 0 : undefined }).then(resolve, reject);
      };
      return q;
    },
    rpc() {
      assert.fail('Diamond proof must not invoke chip receipt or mutation RPC');
    },
  };
  const adapter = createAssignmentWithdrawalAdapter({
    admin,
    openPlayer() {},
    assertAssignmentActive() {},
    now: () => NOW,
  });
  assert.deepEqual(await adapter.readOutcome(entry), expected);
  assert.ok(
    queries.some(
      (q) =>
        q.table === 'poker_diamond_custody' &&
        q.filters.some((f) => f[1] === 'id' && f[2] === entry.identity.custodyId)
    )
  );
  assert.ok(
    queries.some(
      (q) =>
        q.table === 'poker_diamond_movements' &&
        q.filters.some((f) => f[1] === 'request_id' && f[2] === entry.requestId)
    )
  );
  assert.ok(
    queries.some(
      (q) =>
        q.table === 'poker_diamond_tournament_ledger' &&
        q.head &&
        q.filters.some((f) => f[1] === 'custody_id' && f[2] === entry.identity.custodyId)
    )
  );
});
