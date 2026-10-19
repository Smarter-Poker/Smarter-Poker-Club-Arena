import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  financialIntent,
  proveAddon,
  proveCashout,
  witnessFinancial,
} from './lightning-pilot-financial.mjs';
import { PILOT, PILOT_TARGETS } from './prepare-lightning-private-pilot.mjs';
import { CONSENT_PLAYER } from './lightning-pilot-player.mjs';
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pin = {
  clubId: PILOT.clubId ?? 'e14bc9f7-736d-425f-8f2c-e78305ebac1d',
  playerId: CONSENT_PLAYER,
  clusterId: id(1),
  poolSessionId: id(2),
};
const anchor = {
  id: id(3),
  table_id: id(4),
  occupancy_id: id(5),
  seat_number: 1,
  user_id: pin.playerId,
  club_id: pin.clubId,
  left_at: null,
  cash_player_session_id: id(6),
};
const intent = { anchorTableId: anchor.table_id, opId: id(7), amount: 1 };
const key = `addon:${anchor.table_id}:${pin.playerId}:${intent.opId}`;
const stamp = '2026-10-17T04:00:00.000Z';
function addon(queued = false) {
  return {
    pin,
    intent,
    reply: { success: true, applied: 1, ...(queued ? { queued: true } : {}) },
    funding: {
      id: id(10),
      operation_kind: 'addon',
      operation_key: key,
      user_id: pin.playerId,
      table_id: anchor.table_id,
      seat_id: anchor.id,
      occupancy_id: anchor.occupancy_id,
      source_ledger_id: id(11),
      wallet_transaction_id: id(8),
      account_type: 'player_wallet',
      account_entity_id: pin.playerId,
      funding_club_id: pin.clubId,
      asset: 'chips',
      unit_scale: 2,
      amount: 1,
      balance_before: 200,
      balance_after: 199,
      pending_addon_id: queued ? id(12) : null,
    },
    keyRow: {
      key,
      user_id: pin.playerId,
      table_id: anchor.table_id,
      amount: 1,
      applied_to_seat: !queued,
    },
    ledger: [
      {
        id: id(8),
        user_id: pin.playerId,
        table_id: anchor.table_id,
        category: 'addon',
        type: 'debit',
        amount: 1,
        balance_after: 199,
      },
    ],
    pending: queued
      ? [
          {
            id: id(12),
            user_id: pin.playerId,
            table_id: anchor.table_id,
            amount: 1,
            resolved_at: stamp,
            applied_to_stack: 1,
            refunded: 0,
          },
        ]
      : [],
  };
}
function cashout() {
  const cashkey = `cashout:occupancy:${anchor.occupancy_id}`;
  return {
    pin,
    intent: { anchorTableId: anchor.table_id, occupancyId: anchor.occupancy_id, seatNumber: 1 },
    receipt: {
      ok: true,
      user_id: pin.playerId,
      table_id: anchor.table_id,
      occupancy_id: anchor.occupancy_id,
      seat_number: 1,
      idempotency_key: cashkey,
      tournament_table: false,
      credited: true,
      stack: 2,
    },
    credit: { key: cashkey, user_id: pin.playerId, amount: 2, created_at: stamp },
    ledger: [
      {
        id: id(9),
        user_id: pin.playerId,
        table_id: anchor.table_id,
        category: 'cashout',
        type: 'credit',
        amount: 2,
        balance_after: 201,
        created_at: stamp,
      },
    ],
    seat: { ...anchor, left_at: stamp },
    cash: {
      id: id(6),
      player_id: pin.playerId,
      club_id: pin.clubId,
      table_id: anchor.table_id,
      cluster_id: pin.clusterId,
      closed_at: stamp,
    },
    pool: {
      id: pin.poolSessionId,
      player_id: pin.playerId,
      cluster_id: pin.clusterId,
      exited_at: stamp,
    },
  };
}
test('intent binds the actual normal anchor/op or original occupancy, never arbitrary room', () => {
  assert.equal(
    financialIntent('top_up', { tableId: pin.poolSessionId, opId: id(7), amount: 1 }, pin, anchor),
    null
  );
  assert.deepEqual(
    financialIntent('top_up', { tableId: anchor.table_id, opId: id(7), amount: 1 }, pin, anchor),
    intent
  );
  assert.equal(
    financialIntent(
      'cash_out',
      { tableId: anchor.table_id, occupancyId: id(20), seatNumber: 1 },
      pin,
      anchor
    ),
    null
  );
  assert.equal(financialIntent('stop_playing', { p_cluster_id: id(20) }, pin, anchor), null);
});
test('addon requires actual debit, exact atomic receipt and real queued landing', () => {
  assert.equal(proveAddon(addon()).applied, 1);
  assert.equal(proveAddon(addon(true)).queued, true);
  for (const mutate of [
    (x) => (x.reply.applied = 0),
    (x) => (x.funding.user_id = id(20)),
    (x) => (x.keyRow.amount = 2),
    (x) => (x.ledger[0].balance_after = 198),
    (x) => x.ledger.push(x.ledger[0]),
    (x) => (x.pending[0].resolved_at = null),
    (x) => (x.pending[0].applied_to_stack = 0),
  ]) {
    const x = addon(true);
    mutate(x);
    assert.throws(() => proveAddon(x));
  }
});
test('cashout requires paid exact occupancy and all actual closure facts', () => {
  assert.equal(proveCashout(cashout()).paid, 2);
  for (const mutate of [
    (x) => (x.receipt.occupancy_id = id(20)),
    (x) => (x.receipt.stack = 0),
    (x) => (x.credit.key = 'other'),
    (x) => (x.ledger[0].amount = 1),
    (x) => (x.ledger[0].created_at = '2026-10-17T04:00:00.001Z'),
    (x) => (x.credit.created_at = 'unreadable'),
    (x) => (x.seat.left_at = null),
    (x) => (x.cash.closed_at = null),
    (x) => (x.pool.exited_at = null),
  ]) {
    const x = cashout();
    mutate(x);
    assert.throws(() => proveCashout(x));
  }
});
test('atomic money proof refuses coerced or unsafe cent values', () => {
  for (const value of [
    '',
    ' ',
    false,
    true,
    '0x1',
    'Infinity',
    NaN,
    -1,
    0.001,
    '1e2',
    '9007199254740992',
  ]) {
    const x = addon();
    x.funding.balance_before = value;
    x.funding.balance_after = 0;
    x.ledger[0].balance_after = 0;
    assert.throws(() => proveAddon(x), /money_unknown/);
  }
  const x = addon();
  x.funding.amount = '1.00';
  assert.equal(proveAddon(x).debited, 1);
});
function fixture(
  action,
  {
    unknown = false,
    refused = false,
    queued = false,
    gate = 'accepted',
    cleanupError = false,
    restoreError = false,
  } = {}
) {
  const actions = [],
    events = {},
    a = addon(queued),
    c = cashout();
  let issued = false,
    auto = false,
    resolveResponse;
  const target = PILOT_TARGETS[0];
  const game = {
    id: pin.clusterId,
    club_id: pin.clubId,
    name: target.gameName,
    template_name: target.templateName,
    handedness: target.handedness,
    sb: target.sb,
    bb: target.bb,
    variant: 'nlh',
    enabled: true,
    must_move: true,
    cluster_mode: 'lightning',
    lightning_enabled: true,
    ruleset_snapshot: {
      template: target.templateName,
      variant: 'nlh',
      regular_ante: 'sb',
      vpip_floor: 30,
      vpip_window: 10,
      bombs: { enabled: true, trigger: 'timed_20m', ante_bb: 2, boards: 2 },
      options: { is_private: true },
    },
  };
  const pool = {
    id: pin.poolSessionId,
    player_id: pin.playerId,
    cluster_id: pin.clusterId,
    state: 'active',
    exited_at: null,
    anchor_seat_id: anchor.id,
    cash_player_session_id: id(6),
  };
  const rows = (table) =>
    table === 'clubs'
      ? {
          id: pin.clubId,
          owner_id: PILOT.ownerId,
          name: PILOT.name,
          is_public: false,
          requires_approval: true,
        }
      : table === 'cash_games'
        ? game
        : table === 'profiles'
          ? { id: pin.playerId, is_horse: true, status: 'active' }
          : table === 'club_members'
            ? { user_id: pin.playerId, status: 'active', role: 'player', chip_balance: 199 }
            : table === 'lightning_pool_session'
              ? {
                  ...pool,
                  ...(issued && ['stop_playing', 'cash_out'].includes(action)
                    ? { exited_at: stamp, stop_requested_at: stamp }
                    : {}),
                }
              : table === 'table_seats'
                ? { ...anchor, ...(issued && action === 'cash_out' ? { left_at: stamp } : {}) }
                : table === 'tables'
                  ? { id: anchor.table_id, cluster_id: pin.clusterId, club_id: pin.clubId }
                  : table === 'cash_participant_funding_receipts'
                    ? a.funding
                    : table === 'table_addon_idempotency'
                      ? a.keyRow
                      : table === 'wallet_transactions'
                        ? action === 'cash_out'
                          ? c.ledger
                          : a.ledger
                        : table === 'table_pending_addons'
                          ? a.pending
                          : table === 'wallet_credit_idempotency'
                            ? c.credit
                            : table === 'cash_player_session'
                              ? {
                                  ...c.cash,
                                  scope_type: 'table',
                                  scope_id: anchor.table_id,
                                  closed_at: issued ? stamp : null,
                                }
                              : null;
  const admin = {
    rpc: async (name) => {
      assert.equal(name, 'fn_get_seat_cashout_receipt');
      return { data: issued ? c.receipt : null };
    },
    from(table) {
      const q = {
        select() {
          return q;
        },
        eq() {
          return q;
        },
        gte() {
          return q;
        },
        limit() {
          return q;
        },
        maybeSingle() {
          return q;
        },
        then(resolve, reject) {
          return Promise.resolve({ data: rows(table) }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  const trigger = () => {
    issued = true;
    const path =
      action === 'cash_out'
        ? '/leave-occupancy'
        : action === 'stop_playing'
          ? '/rest/v1/rpc/fn_lightning_stop_playing'
          : '/addchips';
    const body =
      action === 'cash_out'
        ? { tableId: anchor.table_id, occupancyId: anchor.occupancy_id, seatNumber: 1 }
        : action === 'stop_playing'
          ? { p_cluster_id: pin.clusterId }
          : { tableId: anchor.table_id, opId: intent.opId, amount: 1 };
    const req = {
      method: () => 'POST',
      url: () =>
        `${action === 'stop_playing' ? 'https://example.invalid' : 'https://engine.smarter.poker'}${path}`,
      postDataJSON: () => body,
    };
    events.request?.(req);
    if (unknown) throw Error('SECRET_TOKEN_RAW_ERROR');
    const reply =
      action === 'cash_out'
        ? {
            success: !refused,
            protocol: 'seat-occupancy-v1',
            occupancyId: anchor.occupancy_id,
            seatNumber: 1,
            immediate: !queued,
            code: refused ? 'LEAVE_LOCKED' : undefined,
            cashout: null,
          }
        : action === 'stop_playing'
          ? { ok: !refused, pool_session_id: pin.poolSessionId }
          : { ...a.reply, success: !refused };
    resolveResponse({ request: () => req, ok: () => true, json: async () => reply });
  };
  const loc = (role, name, nested = false) => ({
    waitFor: async () => {},
    getAttribute: async () => gate,
    inputValue: async () => '1',
    innerText: async () => `Auto Top Up${auto ? ' ON' : ''}`,
    getByRole: (r, o) => loc(r, o.name, true),
    getByLabel: () => loc('input', 'amount'),
    click: async () => {
      actions.push([role, String(name)]);
      if (name === 'Table Menu') return;
      if (name === 'Top Up') {
        assert.equal(role, 'menuitem');
        return;
      }
      if (name instanceof RegExp && String(name).includes('Auto Top Up')) {
        assert.equal(role, 'menuitem');
        if (auto && restoreError) throw Error('SECRET_RESTORE');
        auto = !auto;
        if (auto) trigger();
        return;
      }
      if (
        (name === 'Leave Table' && nested) ||
        name === 'lightning-stop-playing' ||
        (name instanceof RegExp && String(name).includes('Add '))
      )
        trigger();
    },
  });
  const page = {
    setDefaultTimeout() {},
    on: (n, fn) => (events[n] = fn),
    goto: async () => {},
    waitForFunction: async () => {},
    locator: () => loc('gate', 'gate'),
    getByTestId: (n) => loc('testid', n),
    getByRole: (r, o) => loc(r, o.name),
    waitForResponse: () => new Promise((r) => (resolveResponse = r)),
    waitForTimeout: async () => {
      throw Error('Unexpected repeated observation');
    },
  };
  const context = {
    addInitScript: async () => {},
    newPage: async () => page,
    request: {
      get: async () => ({ ok: () => true, json: async () => ({ ca_sha: 'a'.repeat(40) }) }),
    },
  };
  const chromium = {
    launch: async () => ({
      newContext: async () => context,
      close: async () => {
        actions.push('browser_close');
        if (cleanupError) throw Error('SECRET_CLEANUP');
      },
    }),
  };
  const openSession = async () => ({
    session: { user: { id: pin.playerId }, access_token: 'SECRET_TOKEN' },
    client: {
      auth: {
        signOut: async (opts) => {
          assert.deepEqual(opts, { scope: 'local' });
          actions.push('local_signout');
          return {};
        },
      },
    },
  });
  return {
    args: {
      admin,
      chromium,
      createClient() {},
      url: 'https://example.invalid',
      pin,
      action,
      openSession,
      timeoutMs: 30000,
      fetchImpl: async (input) => ({
        ok: true,
        json: async () =>
          String(input).includes('/health')
            ? { version: 'b'.repeat(40), status: 'ok' }
            : { ca_sha: 'a'.repeat(40) },
      }),
    },
    actions,
  };
}
test('one real UI path per supported action, exact proof and cleanup', async () => {
  for (const action of ['top_up', 'cash_out', 'auto_top_up', 'stop_playing']) {
    const f = fixture(action, { queued: action === 'cash_out' }),
      r = await witnessFinancial(f.args);
    assert.equal(r.status, 'observed', JSON.stringify(r));
    assert.equal(r.cleanup, 'local_session_and_browser_closed');
    assert.equal(r.matchingRequests, 1);
    assert.ok(f.actions.includes('local_signout'));
    assert.ok(f.actions.includes('browser_close'));
    if (action === 'auto_top_up') assert.equal(r.autoPreferenceRestored, true);
    if (action === 'cash_out') assert.equal(r.proof.paid, 2);
    assert.ok(!JSON.stringify(r).includes('SECRET'));
  }
});
test('unknown/refused action retains sanitized intent and always cleans up without retry', async () => {
  for (const options of [
    { unknown: true },
    { refused: true },
    { gate: 'not_accepted' },
    { cleanupError: true },
  ]) {
    const f = fixture('top_up', options),
      r = await witnessFinancial(f.args);
    assert.equal(r.status, 'unknown');
    assert.ok(f.actions.includes('local_signout'));
    assert.ok(f.actions.includes('browser_close'));
    assert.ok(!JSON.stringify(r).includes('SECRET'));
    if (options.unknown) {
      assert.equal(r.intent.opId, intent.opId);
      assert.equal(r.matchingRequests, 1);
    }
  }
  const f = fixture('cash_out', { refused: true }),
    r = await witnessFinancial(f.args);
  assert.equal(r.cause, 'stay_clock_refused');
  assert.equal(r.status, 'unknown');
});
test('queued top-up binds its exact pending row and identity changes retain effect without qualifying', async () => {
  const queued = fixture('top_up', { queued: true });
  const landed = await witnessFinancial(queued.args);
  assert.equal(landed.status, 'observed');
  assert.equal(landed.proof.queued, true);
  const f = fixture('top_up');
  let reads = 0;
  f.args.fetchImpl = async (input) => {
    const closing = ++reads > 3;
    return {
      ok: true,
      json: async () =>
        String(input).includes('/health')
          ? { version: (closing ? 'c' : 'b').repeat(40), status: 'ok' }
          : { ca_sha: 'a'.repeat(40) },
    };
  };
  const changed = await witnessFinancial(f.args);
  assert.equal(changed.status, 'unknown');
  assert.equal(changed.cause, 'serving_unknown');
  assert.equal(changed.proof.debited, 1);
  assert.equal(changed.cleanup, 'local_session_and_browser_closed');
  assert.equal(changed.matchingRequests, 1);
});
test('auto preference restoration failure is not success, and scope refuses before auth', async () => {
  const f = fixture('auto_top_up', { restoreError: true }),
    r = await witnessFinancial(f.args);
  assert.equal(r.cleanup, 'unknown');
  assert.equal(r.status, 'unknown');
  assert.ok(f.actions.includes('local_signout'));
  await assert.rejects(witnessFinancial({ ...f.args, pin: { ...pin, playerId: id(99) } }), /Scope/);
});
test('selectors and receipts are pinned to maintained product producers', () => {
  const menu = readFileSync(
      new URL('../../src/components/table/TableMenu.tsx', import.meta.url),
      'utf8'
    ),
    cashier = readFileSync(
      new URL('../../src/components/table/CashierModal.tsx', import.meta.url),
      'utf8'
    ),
    leave = readFileSync(
      new URL('../../server/src/handlers/leaveOccupancy.ts', import.meta.url),
      'utf8'
    ),
    helper = readFileSync(new URL('./lightning-pilot-financial.mjs', import.meta.url), 'utf8');
  assert.ok(menu.includes('aria-label="Table Menu"'));
  assert.ok(menu.includes(": 'menuitem'"));
  assert.ok(cashier.includes('aria-label="Amount To Add"'));
  assert.ok(cashier.includes('title="Add-On Available"'));
  assert.ok(leave.includes("protocol: 'seat-occupancy-v1'"));
  assert.match(helper, /signOut\(\{\s*scope:\s*'local'/);
  assert.ok(!helper.includes("rpc('atomic_table"));
});
test('a normal step that never appears names that step and still cleans up', async () => {
  const f = fixture('top_up');
  const launch = f.args.chromium.launch;
  f.args.chromium = {
    launch: async (...a) => {
      const browser = await launch(...a);
      const newContext = browser.newContext;
      browser.newContext = async () => {
        const context = await newContext();
        const newPage = context.newPage;
        context.newPage = async () => {
          const page = await newPage();
          const getByRole = page.getByRole;
          page.getByRole = (role, options) => {
            const found = getByRole(role, options);
            if (options?.name !== 'Top Up') return found;
            return {
              ...found,
              click: async () => {
                const e = Error('locator.click: Timeout exceeded SECRET_SELECTOR');
                e.name = 'TimeoutError';
                throw e;
              },
            };
          };
          return page;
        };
        return context;
      };
      return browser;
    },
  };
  const r = await witnessFinancial(f.args);
  assert.equal(r.status, 'unknown');
  assert.equal(r.cause, 'normal_ui_or_readback_unknown');
  assert.equal(r.failedStep, 'top_up_item');
  assert.equal(r.failure, 'TimeoutError');
  assert.equal(r.intent, null);
  assert.ok(f.actions.includes('local_signout'));
  assert.ok(f.actions.includes('browser_close'));
  assert.ok(!JSON.stringify(r).includes('SECRET'));
});
test('the session fetch ceiling does not spend the cleanup reserve', async () => {
  const src = readFileSync(new URL('./lightning-pilot-financial.mjs', import.meta.url), 'utf8');
  assert.match(src, /AbortSignal\.timeout\(Math\.max\(1, Math\.min\(15000, end - Date\.now\(\)\)\)\)/);
  assert.doesNotMatch(src, /Math\.min\(15000, end - Date\.now\(\) - 20000\)/);
});
