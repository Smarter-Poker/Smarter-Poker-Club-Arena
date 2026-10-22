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
    autoOffBeforeRestore = false,
    menuInitiallyOpen = false,
    replyError,
    httpStatus = 200,
    sitoutFlow = false,
    pausePersistDelay = 0,
    pendingRounds = 0,
    newHandWhilePaused = false,
    returnError = false,
    returnReadError = false,
    baselineDrift = 0,
    selectionLostAfter,
  } = {}
) {
  const actions = [],
    events = {},
    a = addon(queued),
    c = cashout();
  let issued = false,
    auto = false,
    menuOpen = menuInitiallyOpen,
    resolveResponse,
    paused = false,
    pauseReads = 0,
    handReads = 0,
    returned = false,
    selected = false,
    selectionReads = 0;
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
                ? {
                    ...anchor,
                    is_sitting_out: paused && pauseReads++ >= pausePersistDelay,
                    leave_pending: false,
                    ...(issued && action === 'cash_out' ? { left_at: stamp } : {}),
                  }
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
                            : table === 'lightning_pool_slot'
                              ? [
                                  {
                                    id: id(44),
                                    pool_session_id: pin.poolSessionId,
                                    player_id: pin.playerId,
                                    cluster_id: pin.clusterId,
                                  },
                                ]
                              : table === 'lightning_hand_player'
                                ? handReads < pendingRounds
                                  ? [{ hand_id: id(45), hand: { settled_at: null } }]
                                  : []
                                : table === 'cash_player_session'
                                  ? {
                                      ...c.cash,
                                      scope_type: 'table',
                                      scope_id: anchor.table_id,
                                      opened_at: stamp,
                                      baseline:
                                        3.9 +
                                        (issued && !refused && action === 'top_up' ? 1 : 0) +
                                        (returned ? baselineDrift : 0),
                                      closed_at: issued && action === 'cash_out' ? stamp : null,
                                    }
                                  : null;
  const admin = {
    rpc: async (name) => {
      if (name === 'fn_lightning_player_live_hand') {
        handReads++;
        return { data: handReads <= pendingRounds ? id(45) : null };
      }
      assert.equal(name, 'fn_get_seat_cashout_receipt');
      return { data: issued ? c.receipt : null };
    },
    from(table) {
      let head = false;
      const q = {
        select(_columns, options) {
          head = options?.head === true;
          return q;
        },
        eq() {
          return q;
        },
        gte() {
          return q;
        },
        in() {
          return q;
        },
        is() {
          return q;
        },
        limit() {
          return q;
        },
        maybeSingle() {
          return q;
        },
        then(resolve, reject) {
          const out =
            returnReadError && returned && table === 'table_seats'
              ? { error: { message: 'SECRET_READ_ERROR' } }
              : head
                ? { data: null, count: 100 + (newHandWhilePaused && handReads > 0 ? 1 : 0) }
                : { data: rows(table) };
          return Promise.resolve(out).then(resolve, reject);
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
          : { ...a.reply, success: !refused, error: replyError };
    resolveResponse({
      request: () => req,
      status: () => httpStatus,
      ok: () => httpStatus < 400,
      json: async () => reply,
    });
  };
  const triggerPause = (wanted) => {
    const req = {
      method: () => 'POST',
      url: () => 'https://engine.smarter.poker/sitout',
      postDataJSON: () => ({ tableId: pin.poolSessionId, sitOut: wanted }),
    };
    events.request?.(req);
    if (!wanted) returned = true;
    if (wanted || !returnError) paused = wanted;
    resolveResponse({
      request: () => req,
      status: () => (returnError && !wanted ? 400 : 200),
      ok: () => !(returnError && !wanted),
      json: async () => ({ success: !(returnError && !wanted) }),
    });
  };
  const loc = (role, name, nested = false) => ({
    waitFor: async () => {},
    getAttribute: async () => (name === 'Table Menu' ? String(menuOpen) : gate),
    inputValue: async () => '1',
    innerText: async () => `Auto Top Up${auto ? ' ON' : ''}`,
    getByRole: (r, o) => loc(r, o.name, true),
    getByLabel: () => loc('input', 'amount'),
    click: async () => {
      actions.push([role, String(name)]);
      if (name === 'Table Menu') {
        menuOpen = !menuOpen;
        return;
      }
      if (role === 'menuitem') assert.equal(menuOpen, true, 'normal menu must be open');
      if (name === 'Sit Out') {
        triggerPause(true);
        return;
      }
      if (name === "I'm Back") {
        triggerPause(false);
        return;
      }
      if (name === 'Top Up') {
        assert.equal(role, 'menuitem');
        return;
      }
      if (name instanceof RegExp && String(name).includes('Auto Top Up')) {
        assert.equal(role, 'menuitem');
        if (auto && restoreError) throw Error('SECRET_RESTORE');
        auto = !auto;
        if (auto) trigger();
        menuOpen = false;
        if (autoOffBeforeRestore) auto = false;
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
    on: (n, fn) => {
      const prior = events[n];
      events[n] = (...a) => {
        prior?.(...a);
        fn(...a);
      };
    },
    goto: async () => {},
    waitForFunction: async () => {},
    locator: (selector) =>
      selector.includes('data-tabid')
        ? {
            waitFor: async () => {},
            count: async () => (selector.includes(pin.poolSessionId) ? 1 : 0),
            isVisible: async () => true,
            tap: async () => {
              actions.push('select_pool');
              selected = true;
            },
            click: async () => {
              actions.push('select_pool');
              selected = true;
            },
            getAttribute: async () => {
              if (selectionLostAfter !== undefined && ++selectionReads > selectionLostAfter)
                selected = false;
              return String(selected);
            },
          }
        : loc('gate', 'gate'),
    getByTestId: (n) => loc('testid', n),
    getByRole: (r, o) => loc(r, o.name),
    waitForResponse: () => new Promise((r) => (resolveResponse = r)),
    waitForTimeout: async () => {
      if (sitoutFlow) {
        actions.push('read_only_wait');
        return;
      }
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
      pauseForTopUp: sitoutFlow,
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
  assert.equal(r.cleanupStages.autoPreference, 'unknown');
  assert.equal(r.cleanupStages.browser, 'closed');
  assert.equal(r.cleanupStages.localSession, 'closed');
  assert.equal(r.cleanupStages.autoOffGestures, 1);
  assert.equal(r.cleanupStages.autoStep, 'read_preference');
  assert.ok(f.actions.includes('local_signout'));
  await assert.rejects(witnessFinancial({ ...f.args, pin: { ...pin, playerId: id(99) } }), /Scope/);
});
test('already-open normal menu is not toggled closed before the single intent', async () => {
  const f = fixture('auto_top_up', { menuInitiallyOpen: true });
  const r = await witnessFinancial(f.args);
  assert.equal(r.status, 'observed');
  assert.equal(r.matchingRequests, 1);
  assert.equal(r.cleanupStages.autoOffGestures, 1);
});
test('already OFF preference is verified without a second toggle', async () => {
  const f = fixture('auto_top_up', { autoOffBeforeRestore: true });
  const r = await witnessFinancial(f.args);
  assert.equal(r.autoPreferenceRestored, true);
  assert.equal(r.cleanupStages.autoPreference, 'off_verified');
  assert.equal(r.cleanupStages.autoOffGestures, 0);
  assert.equal(
    f.actions.filter((x) => Array.isArray(x) && String(x[1]).includes('Auto Top Up')).length,
    1
  );
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
  assert.match(
    src,
    /AbortSignal\.timeout\(Math\.max\(1, Math\.min\(15000, end - Date\.now\(\)\)\)\)/
  );
  assert.doesNotMatch(src, /Math\.min\(15000, end - Date\.now\(\) - 20000\)/);
});

test('addon refusal preserves only bounded HTTP facts and exact public classifications without replay', async () => {
  for (const [message, code] of [
    [
      'Your Chips Are In A Lightning Hand. Add Chips When It Finishes.',
      'LIGHTNING_HAND_IN_PROGRESS',
    ],
    ['Scheduled maintenance is in progress', 'MAINTENANCE'],
    ['Already at the maximum buy-in for this table', 'MAX_BUY_IN'],
    ['Player not seated', 'NOT_SEATED'],
    ['Insufficient wallet balance', 'INSUFFICIENT_BALANCE'],
    [
      'Your Chips Are In A Lightning Hand. Add Chips When It Finishes. SECRET_TOKEN',
      'UNCLASSIFIED',
    ],
    [{ message: 'SECRET_TOKEN' }, 'UNCLASSIFIED'],
  ]) {
    const f = fixture('top_up', { refused: true, replyError: message, httpStatus: 400 });
    const r = await witnessFinancial(f.args);
    assert.deepEqual(r.addonResponse, { httpStatus: 400, success: false, code });
    assert.ok(Number.isFinite(Date.parse(r.requestAt)));
    assert.ok(Number.isFinite(Date.parse(r.responseAt)));
    assert.ok(Date.parse(r.requestAt) <= Date.parse(r.responseAt));
    assert.equal(r.intent.opId, intent.opId);
    assert.equal(r.matchingRequests, 1);
    assert.equal(r.cause, 'addon_refused');
    assert.equal(r.cleanup, 'local_session_and_browser_closed');
    assert.ok(!JSON.stringify(r).includes('SECRET'));
  }
});

test('refusal classification is pinned to maintained add-on producers', () => {
  const seating = readFileSync(
    new URL('../../server/src/engine/ServerTableEngineSeating.ts', import.meta.url),
    'utf8'
  );
  const errors = readFileSync(
    new URL('../../server/src/lightning/rpcErrors.ts', import.meta.url),
    'utf8'
  );
  assert.ok(errors.includes("'Your Chips Are In A Lightning Hand. Add Chips When It Finishes.'"));
  assert.ok(seating.includes('error: LIGHTNING_ADD_ON_REFUSED_MESSAGE'));
  for (const message of [
    'Scheduled maintenance is in progress',
    'Already at the maximum buy-in for this table',
    'Player not seated',
    'Insufficient wallet balance',
  ])
    assert.ok(seating.includes(`'${message}'`));
});

test('explicit paused manual top-up waits for persisted pause and every old hand, then returns once with funded baseline', async () => {
  const f = fixture('top_up', { sitoutFlow: true, pausePersistDelay: 1, pendingRounds: 2 });
  const r = await witnessFinancial(f.args);
  assert.equal(r.status, 'observed', JSON.stringify(r));
  assert.equal(r.cleanup, 'local_session_and_browser_closed');
  assert.equal(r.sitout.persistedPause, true);
  assert.equal(r.sitout.allOldHandsSettled, true);
  assert.equal(r.sitout.noNewFormation, true);
  assert.equal(r.sitout.returnVerified, true);
  assert.equal(r.sitout.baselineBefore, 3.9);
  assert.equal(r.sitout.baselineAfter, 4.9);
  assert.equal(r.sitout.expectedBaselineAfter, 4.9);
  assert.deepEqual(r.sitout.requests, { pause: 1, return: 1 });
  assert.equal(r.matchingRequests, 1);
  const firstWait = f.actions.indexOf('read_only_wait');
  const topup = f.actions.findIndex((x) => Array.isArray(x) && x[1] === 'Top Up');
  assert.ok(firstWait >= 0 && topup > firstWait);
  assert.ok(!JSON.stringify(r).includes('SECRET'));
});
test('a new formation during persisted pause prevents the financial gesture and still returns once', async () => {
  const f = fixture('top_up', { sitoutFlow: true, pendingRounds: 2, newHandWhilePaused: true });
  const r = await witnessFinancial(f.args);
  assert.equal(r.status, 'unknown');
  assert.equal(r.cause, 'sitout_formed_new_hand');
  assert.equal(r.intent, null);
  assert.deepEqual(r.sitout.requests, { pause: 1, return: 1 });
  assert.equal(r.sitout.returnVerified, true);
  assert.ok(!f.actions.some((x) => Array.isArray(x) && x[1] === 'Top Up'));
});
test('known add-on refusal returns once without baseline fiction or a second monetary request', async () => {
  const f = fixture('top_up', {
    sitoutFlow: true,
    refused: true,
    httpStatus: 400,
    replyError: 'Your Chips Are In A Lightning Hand. Add Chips When It Finishes.',
  });
  const r = await witnessFinancial(f.args);
  assert.equal(r.status, 'unknown');
  assert.equal(r.cause, 'addon_refused');
  assert.equal(r.matchingRequests, 1);
  assert.deepEqual(r.sitout.requests, { pause: 1, return: 1 });
  assert.equal(r.sitout.returnVerified, true);
  assert.equal(r.sitout.baselineAfter, 3.9);
});
test('return refusal or unreadable persistence stays unknown and never retries the return', async () => {
  for (const options of [{ returnError: true }, { returnReadError: true }]) {
    const f = fixture('top_up', { sitoutFlow: true, ...options });
    const r = await witnessFinancial(f.args);
    assert.equal(r.status, 'unknown');
    assert.equal(r.cleanup, 'unknown');
    assert.equal(r.sitout.returnVerified, false);
    assert.deepEqual(r.sitout.requests, { pause: 1, return: 1 });
    assert.equal(r.matchingRequests, 1);
    assert.ok(f.actions.includes('local_signout'));
    assert.ok(f.actions.includes('browser_close'));
    assert.ok(!JSON.stringify(r).includes('SECRET'));
  }
});

test('pause proof uses the actual hand relationship and additive cash baseline owner', () => {
  const source = readFileSync(new URL('./lightning-pilot-financial.mjs', import.meta.url), 'utf8');
  const custody = readFileSync(
    new URL(
      '../../supabase/migrations/20260917230925_cash_funding_retains_original_participant_custody.sql',
      import.meta.url
    ),
    'utf8'
  );
  assert.match(source, /pauseInitial\.baselineCents \+ cents\(report\.proof\.applied\)/);
  assert.match(custody, /fn_cash_session_add_baseline\(p_user_id, p_table_id, p_amount\)/);
});

test('unknown add-on acknowledgment or unexpected baseline remains unknown after one return', async () => {
  for (const options of [{ unknown: true }, { baselineDrift: 1 }]) {
    const f = fixture('top_up', { sitoutFlow: true, ...options });
    const r = await witnessFinancial(f.args);
    assert.equal(r.status, 'unknown');
    assert.equal(r.cleanup, 'unknown');
    assert.equal(r.sitout.returnObserved, true);
    assert.equal(r.sitout.returnVerified, false);
    assert.deepEqual(r.sitout.requests, { pause: 1, return: 1 });
    assert.equal(r.matchingRequests, 1);
    assert.equal(r.intent.opId, intent.opId);
    assert.ok(!JSON.stringify(r).includes('SECRET'));
  }
});

test('Sit Out diagnostics keep only maintained status and classification', async () => {
  const { sitoutResponse } = await import('./lightning-pilot-financial.mjs');
  assert.deepEqual(
    sitoutResponse(400, {
      success: false,
      error: 'You Must Play At Least One Hand Before You Can Sit Out',
      secret: 'never retain',
    }),
    { httpStatus: 400, success: false, code: 'SITOUT_HAND_REQUIRED' }
  );
  assert.deepEqual(sitoutResponse(500, { error: 'sensitive arbitrary body' }), {
    httpStatus: 500,
    success: null,
    code: 'UNCLASSIFIED',
  });
});

test('a pool selection lost before the money gesture refuses it without switching back', async () => {
  const f = fixture('top_up', { selectionLostAfter: 2 }),
    r = await witnessFinancial(f.args);
  assert.equal(r.status, 'unknown');
  assert.equal(r.intent, null);
  assert.equal(f.actions.filter((a) => a === 'select_pool').length, 1);
  assert.ok(!f.actions.some((a) => Array.isArray(a) && String(a[1]).startsWith('/^Add')));
  assert.ok(f.actions.includes('local_signout'));
  assert.ok(f.actions.includes('browser_close'));
});
