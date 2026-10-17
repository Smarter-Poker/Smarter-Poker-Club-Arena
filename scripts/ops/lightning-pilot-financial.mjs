import { servingIdentities, servingStable } from './lightning-pilot-qualification.mjs';
/** One normal UI intent. No financial RPC writes, consent writes or retries. */
import {
  CONSENT_PLAYERS,
  assertPlayerPin,
  validatePlayer,
  openPlayerSession,
  acceptPlayerTerms,
} from './lightning-pilot-player.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const read = (r) => {
  if (r?.error || r?.data == null) throw Error('read_unknown');
  return r.data;
};
const cents = (x) => {
  if (!['number', 'string'].includes(typeof x) || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(String(x)))
    throw Error('money_unknown');
  const [whole, fraction = ''] = String(x).split('.');
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(n)) throw Error('money_unknown');
  return n;
};
export function financialIntent(action, body, pin, anchor) {
  if (action === 'stop_playing')
    return body?.p_cluster_id === pin.clusterId ? { clusterId: pin.clusterId } : null;
  if (action === 'cash_out')
    return body?.tableId === anchor.table_id &&
      body.occupancyId === anchor.occupancy_id &&
      body.seatNumber === anchor.seat_number
      ? { anchorTableId: body.tableId, occupancyId: body.occupancyId, seatNumber: body.seatNumber }
      : null;
  if (
    !['top_up', 'auto_top_up'].includes(action) ||
    body?.tableId !== anchor.table_id ||
    !UUID.test(body?.opId) ||
    cents(body.amount) <= 0
  )
    return null;
  return { anchorTableId: body.tableId, opId: body.opId, amount: cents(body.amount) / 100 };
}
export function proveCashout({ pin, intent, receipt, credit, ledger, seat, cash, pool }) {
  const key = `cashout:occupancy:${intent.occupancyId}`;
  if (
    receipt?.ok !== true ||
    receipt.reason !== undefined ||
    receipt.user_id !== pin.playerId ||
    receipt.table_id !== intent.anchorTableId ||
    receipt.occupancy_id !== intent.occupancyId ||
    receipt.seat_number !== intent.seatNumber ||
    receipt.idempotency_key !== key ||
    receipt.tournament_table !== false ||
    receipt.credited !== true ||
    cents(receipt.stack) <= 0
  )
    throw Error('cashout_receipt_unverified');
  if (
    credit?.key !== key ||
    credit.user_id !== pin.playerId ||
    cents(credit.amount) !== cents(receipt.stack) ||
    typeof credit.created_at !== 'string' ||
    !Number.isFinite(Date.parse(credit.created_at)) ||
    !Array.isArray(ledger) ||
    ledger.length !== 1 ||
    ledger[0].user_id !== pin.playerId ||
    ledger[0].table_id !== intent.anchorTableId ||
    ledger[0].category !== 'cashout' ||
    ledger[0].type !== 'credit' ||
    ledger[0].created_at !== credit.created_at ||
    cents(ledger[0].amount) !== cents(receipt.stack) ||
    cents(ledger[0].balance_after) < 0
  )
    throw Error('cashout_ledger_unverified');
  if (
    seat?.occupancy_id !== intent.occupancyId ||
    seat.user_id !== pin.playerId ||
    seat.table_id !== intent.anchorTableId ||
    !seat.left_at ||
    cash?.player_id !== pin.playerId ||
    cash.club_id !== pin.clubId ||
    cash.table_id !== intent.anchorTableId ||
    cash.cluster_id !== pin.clusterId ||
    !cash.closed_at ||
    pool?.id !== pin.poolSessionId ||
    pool.player_id !== pin.playerId ||
    pool.cluster_id !== pin.clusterId ||
    !pool.exited_at
  )
    throw Error('cashout_closure_unverified');
  return {
    occupancyId: intent.occupancyId,
    receiptKey: key,
    anchorTableId: intent.anchorTableId,
    paid: receipt.stack,
    ledgerId: ledger[0].id,
    walletAfterAtCredit: Number(ledger[0].balance_after),
    cashPlayerSessionId: cash.id,
    seatClosed: true,
    poolExited: true,
    cashSessionClosed: true,
  };
}
export function proveAddon({ pin, intent, reply, funding, keyRow, ledger, pending, refundCredit }) {
  const key = `addon:${intent.anchorTableId}:${pin.playerId}:${intent.opId}`;
  if (
    reply?.success !== true ||
    cents(reply.applied) <= 0 ||
    cents(reply.applied) > cents(intent.amount) ||
    (reply.queued !== undefined && typeof reply.queued !== 'boolean')
  )
    throw Error('addon_refused_or_unknown');
  const amount = cents(reply.applied);
  if (
    funding?.operation_kind !== 'addon' ||
    funding.operation_key !== key ||
    funding.user_id !== pin.playerId ||
    funding.table_id !== intent.anchorTableId ||
    funding.funding_club_id !== pin.clubId ||
    funding.account_type !== 'player_wallet' ||
    funding.account_entity_id !== pin.playerId ||
    funding.unit_scale !== 2 ||
    !UUID.test(funding.id) ||
    funding.asset !== 'chips' ||
    !UUID.test(funding.occupancy_id) ||
    !UUID.test(funding.source_ledger_id) ||
    !UUID.test(funding.wallet_transaction_id) ||
    cents(funding.amount) !== amount ||
    cents(funding.balance_before) - cents(funding.balance_after) !== amount ||
    keyRow?.key !== key ||
    keyRow.user_id !== pin.playerId ||
    keyRow.table_id !== intent.anchorTableId ||
    cents(keyRow.amount) !== amount ||
    keyRow.applied_to_seat !== !reply.queued
  )
    throw Error('addon_receipt_unverified');
  if (
    !Array.isArray(ledger) ||
    ledger.length !== 1 ||
    ledger[0].id !== funding.wallet_transaction_id ||
    ledger[0].user_id !== pin.playerId ||
    ledger[0].table_id !== intent.anchorTableId ||
    ledger[0].category !== 'addon' ||
    ledger[0].type !== 'debit' ||
    cents(ledger[0].amount) !== amount ||
    cents(ledger[0].balance_after) !== cents(funding.balance_after)
  )
    throw Error('addon_ledger_unverified');
  let applied = amount,
    refunded = 0;
  if (reply.queued) {
    if (
      !Array.isArray(pending) ||
      pending.length !== 1 ||
      pending[0].id !== funding.pending_addon_id ||
      !pending[0].resolved_at ||
      pending[0].user_id !== pin.playerId ||
      pending[0].table_id !== intent.anchorTableId ||
      cents(pending[0].amount) !== amount
    )
      throw Error('queued_not_landed');
    applied = cents(pending[0].applied_to_stack);
    refunded = cents(pending[0].refunded);
    if (applied <= 0 || applied + refunded !== amount) throw Error('queued_effect_unverified');
    if (
      refunded > 0 &&
      (refundCredit?.key !== `addon_refund:${funding.pending_addon_id}` ||
        refundCredit.user_id !== pin.playerId ||
        cents(refundCredit.amount) !== refunded)
    )
      throw Error('queued_effect_unverified');
  } else if (funding.pending_addon_id !== null) throw Error('addon_receipt_unverified');
  return {
    receiptKey: key,
    opId: intent.opId,
    fundingReceiptId: funding.id,
    occupancyId: funding.occupancy_id,
    sourceLedgerId: funding.source_ledger_id,
    anchorTableId: intent.anchorTableId,
    requested: intent.amount,
    debited: amount / 100,
    applied: applied / 100,
    refunded: refunded / 100,
    queued: reply.queued === true,
    ledgerId: ledger[0].id,
    walletBeforeAtDebit: Number(funding.balance_before),
    walletAfterAtDebit: Number(funding.balance_after),
  };
}
async function anchorSeat(admin, pin) {
  const pool = read(
    await admin
      .from('lightning_pool_session')
      .select('id,cluster_id,player_id,anchor_seat_id,cash_player_session_id,state,exited_at')
      .eq('id', pin.poolSessionId)
      .maybeSingle()
  );
  if (
    pool.id !== pin.poolSessionId ||
    pool.player_id !== pin.playerId ||
    pool.cluster_id !== pin.clusterId ||
    pool.state !== 'active' ||
    pool.exited_at !== null ||
    !UUID.test(pool.anchor_seat_id)
  )
    throw Error('anchor_unknown');
  const seat = read(
    await admin
      .from('table_seats')
      .select('id,table_id,user_id,club_id,left_at,occupancy_id,seat_number')
      .eq('id', pool.anchor_seat_id)
      .maybeSingle()
  );
  const table = read(
    await admin.from('tables').select('id,cluster_id,club_id').eq('id', seat.table_id).maybeSingle()
  );
  if (
    seat.id !== pool.anchor_seat_id ||
    seat.user_id !== pin.playerId ||
    seat.club_id !== pin.clubId ||
    seat.left_at !== null ||
    table.id !== seat.table_id ||
    table.cluster_id !== pin.clusterId ||
    table.club_id !== pin.clubId
  )
    throw Error('anchor_unknown');
  if (
    !UUID.test(seat.occupancy_id) ||
    !Number.isInteger(seat.seat_number) ||
    !UUID.test(pool.cash_player_session_id)
  )
    throw Error('anchor_unknown');
  const cash = read(
    await admin
      .from('cash_player_session')
      .select('id,player_id,club_id,scope_type,scope_id,table_id,cluster_id,closed_at')
      .eq('id', pool.cash_player_session_id)
      .maybeSingle()
  );
  if (
    cash.id !== pool.cash_player_session_id ||
    cash.player_id !== pin.playerId ||
    cash.club_id !== pin.clubId ||
    cash.scope_type !== 'table' ||
    cash.scope_id !== seat.table_id ||
    cash.table_id !== seat.table_id ||
    cash.cluster_id !== pin.clusterId ||
    cash.closed_at !== null
  )
    throw Error('anchor_unknown');
  return { ...seat, cash_player_session_id: pool.cash_player_session_id };
}
async function cashoutReadback(admin, pin, intent, anchor) {
  // This maintained read-only definer is service-only; the browser writes via
  // the normal occupancy-bound HTTP door, never via this client.
  const lookup = await admin.rpc('fn_get_seat_cashout_receipt', {
    p_user_id: pin.playerId,
    p_table_id: intent.anchorTableId,
    p_seat_number: intent.seatNumber,
    p_occupancy_id: intent.occupancyId,
  });
  if (lookup.error) throw Error('read_unknown');
  if (!lookup.data) throw Error('cashout_pending');
  const receipt = lookup.data,
    key = `cashout:occupancy:${intent.occupancyId}`;
  const credit = read(
    await admin
      .from('wallet_credit_idempotency')
      .select('key,user_id,amount,created_at')
      .eq('key', key)
      .maybeSingle()
  );
  const ledger = read(
    await admin
      .from('wallet_transactions')
      .select('id,user_id,table_id,category,type,amount,balance_after,created_at')
      .eq('user_id', pin.playerId)
      .eq('table_id', intent.anchorTableId)
      .eq('category', 'cashout')
      .eq('type', 'credit')
      .eq('created_at', credit.created_at)
      .limit(2)
  );
  const seat = read(
    await admin
      .from('table_seats')
      .select('occupancy_id,user_id,table_id,left_at')
      .eq('id', anchor.id)
      .maybeSingle()
  );
  const cash = read(
    await admin
      .from('cash_player_session')
      .select('id,player_id,club_id,table_id,cluster_id,closed_at')
      .eq('id', anchor.cash_player_session_id)
      .maybeSingle()
  );
  const pool = read(
    await admin
      .from('lightning_pool_session')
      .select('id,player_id,cluster_id,exited_at')
      .eq('id', pin.poolSessionId)
      .maybeSingle()
  );
  if (!seat.left_at || !cash.closed_at || !pool.exited_at) throw Error('cashout_pending');
  return proveCashout({ pin, intent, receipt, credit, ledger, seat, cash, pool });
}
async function addonReadback(admin, pin, intent, reply, anchor) {
  const key = `addon:${intent.anchorTableId}:${pin.playerId}:${intent.opId}`;
  const funding = read(
    await admin
      .from('cash_participant_funding_receipts')
      .select(
        'id,operation_kind,operation_key,user_id,table_id,seat_id,occupancy_id,source_ledger_id,wallet_transaction_id,account_type,account_entity_id,funding_club_id,asset,unit_scale,amount,balance_before,balance_after,pending_addon_id'
      )
      .eq('operation_kind', 'addon')
      .eq('operation_key', key)
      .maybeSingle()
  );
  if (funding.occupancy_id !== anchor.occupancy_id || funding.seat_id !== anchor.id)
    throw Error('addon_receipt_unverified');
  const keyRow = read(
    await admin
      .from('table_addon_idempotency')
      .select('key,user_id,table_id,amount,applied_to_seat')
      .eq('key', key)
      .maybeSingle()
  );
  const ledger = read(
    await admin
      .from('wallet_transactions')
      .select('id,user_id,table_id,category,type,amount,balance_after')
      .eq('id', funding.wallet_transaction_id)
  );
  const pending = reply.queued
    ? read(
        await admin
          .from('table_pending_addons')
          .select('id,user_id,table_id,amount,resolved_at,applied_to_stack,refunded')
          .eq('id', funding.pending_addon_id)
      )
    : [];
  const refundCredit =
    reply.queued && pending[0]?.resolved_at && Number(pending[0]?.refunded) > 0
      ? read(
          await admin
            .from('wallet_credit_idempotency')
            .select('key,user_id,amount')
            .eq('key', `addon_refund:${funding.pending_addon_id}`)
            .maybeSingle()
        )
      : null;
  return proveAddon({ pin, intent, reply, funding, keyRow, ledger, pending, refundCredit });
}
export async function witnessFinancial({
  admin,
  createClient,
  chromium,
  url,
  pin,
  action,
  timeoutMs = 240000,
  openSession = openPlayerSession,
  fetchImpl = fetch,
}) {
  assertPlayerPin(pin);
  if (
    !CONSENT_PLAYERS.includes(pin.playerId) ||
    !['top_up', 'cash_out', 'auto_top_up', 'stop_playing'].includes(action) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 30000 ||
    timeoutMs > 240000
  )
    throw Error('Explicit Financial Witness Scope Required');
  const end = Date.now() + timeoutMs;
  const remaining = () => {
    const n = end - Date.now() - 20000;
    if (n <= 0) throw Error('deadline');
    return n;
  };
  const bound = async (p, ms = remaining()) => {
    let timer;
    try {
      return await Promise.race([
        p,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('deadline')), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const report = {
    action,
    playerId: pin.playerId,
    poolSessionId: pin.poolSessionId,
    clusterId: pin.clusterId,
    status: 'unknown',
    cause: 'not_started',
    cleanup: 'pending',
    scope: 'one_normal_ui_intent',
    intent: null,
  };
  let auth,
    opening,
    browser,
    page,
    restoreAuto = false,
    autoRestored = true;
  const restorePreference = async (ms) => {
    await bound(
      page.getByRole('button', { name: 'Table Menu', exact: true }).click({ timeout: ms }),
      ms
    );
    const toggle = page.getByRole('menuitem', { name: /^Auto Top Up(?: ON)?$/ });
    if (!/\bON\b/.test(await bound(toggle.innerText(), ms))) throw Error('restore_unknown');
    await bound(toggle.click({ timeout: ms }), ms);
    await bound(
      page.getByRole('button', { name: 'Table Menu', exact: true }).click({ timeout: ms }),
      ms
    );
    if (
      /\bON\b/.test(
        await bound(page.getByRole('menuitem', { name: /^Auto Top Up(?: ON)?$/ }).innerText(), ms)
      )
    )
      throw Error('restore_unknown');
    autoRestored = true;
  };
  const menu = async () => {
    await page
      .getByRole('button', { name: 'Table Menu', exact: true })
      .click({ timeout: remaining() });
  };
  try {
    await bound(validatePlayer(admin, pin));
    const boundedClient = (...args) => {
      const options = args[2] ?? {};
      args[2] = {
        ...options,
        global: {
          ...options.global,
          fetch: (input, init = {}) =>
            fetch(input, {
              ...init,
              signal: AbortSignal.timeout(Math.max(1, Math.min(15000, end - Date.now() - 20000))),
            }),
        },
      };
      return createClient(...args);
    };
    opening = openSession(admin, boundedClient, url, pin, remaining);
    auth = await bound(opening);
    browser = await chromium.launch({ headless: true, timeout: remaining() });
    const context = await bound(browser.newContext({ viewport: { width: 375, height: 812 } }));
    await bound(
      context.addInitScript(
        ({ session }) => localStorage.setItem('smarter-poker-auth', JSON.stringify(session)),
        { session: auth.session }
      )
    );
    page = await bound(context.newPage());
    page.setDefaultTimeout(Math.min(10000, remaining()));
    const identities = () =>
      bound(
        servingIdentities((input, init = {}) =>
          fetchImpl(input, {
            ...init,
            signal: AbortSignal.timeout(Math.max(1, Math.min(15000, remaining()))),
          })
        )
      );
    report.servingBefore = await identities();
    if (
      servingStable(report.servingBefore, report.servingBefore) !== 'passed' ||
      report.servingBefore.engine.data.fullRevisionEstablished !== true
    )
      throw Error('serving_unknown');
    report.clientSha = report.servingBefore.publicClient.data.revision;
    await page.goto(`https://smarter.poker/hub/club-arena/table/${pin.poolSessionId}`, {
      waitUntil: 'domcontentloaded',
      timeout: remaining(),
    });
    await bound(acceptPlayerTerms(page, auth.session, pin, url, false, remaining));
    await page
      .getByTestId('lightning-room-tools')
      .waitFor({ state: 'visible', timeout: remaining() });
    await bound(validatePlayer(admin, pin));
    const anchor = await bound(anchorSeat(admin, pin));
    if (action === 'cash_out') {
      const prior = await bound(
        admin.rpc('fn_get_seat_cashout_receipt', {
          p_user_id: pin.playerId,
          p_table_id: anchor.table_id,
          p_seat_number: anchor.seat_number,
          p_occupancy_id: anchor.occupancy_id,
        })
      );
      if (prior.error || prior.data !== null) throw Error('anchor_unknown');
    }
    if (['top_up', 'auto_top_up'].includes(action))
      read(
        await bound(
          admin
            .from('cash_participant_funding_receipts')
            .select('id')
            .eq('user_id', pin.playerId)
            .eq('operation_kind', 'addon')
            .limit(1)
        )
      );
    const path =
      action === 'stop_playing'
        ? '/rest/v1/rpc/fn_lightning_stop_playing'
        : action === 'cash_out'
          ? '/leave-occupancy'
          : '/addchips';
    const accepts = (req) => {
      try {
        return (
          req.method() === 'POST' &&
          new URL(req.url()).pathname === path &&
          new URL(req.url()).origin ===
            (action === 'stop_playing' ? new URL(url).origin : 'https://engine.smarter.poker') &&
          !!financialIntent(action, req.postDataJSON(), pin, anchor)
        );
      } catch {
        return false;
      }
    };
    report.matchingRequests = 0;
    page.on('request', (request) => {
      if (accepts(request)) {
        report.matchingRequests++;
        report.intent ??= financialIntent(action, request.postDataJSON(), pin, anchor);
      }
    });
    // Listener is armed before the one visible gesture. No request is replayed.
    const responsePromise = page.waitForResponse((r) => accepts(r.request()), {
      timeout: remaining(),
    });
    responsePromise.catch(() => {});
    if (action === 'stop_playing')
      await page.getByTestId('lightning-stop-playing').click({ timeout: remaining() });
    else if (action === 'cash_out') {
      await menu();
      await page
        .getByRole('menuitem', { name: 'Leave Table', exact: true })
        .click({ timeout: remaining() });
      await page
        .getByRole('alertdialog', { name: 'Leave Table?', exact: true })
        .getByRole('button', { name: 'Leave Table', exact: true })
        .click({ timeout: remaining() });
    } else if (action === 'top_up') {
      await menu();
      await page
        .getByRole('menuitem', { name: 'Top Up', exact: true })
        .click({ timeout: remaining() });
      const dialog = page.getByRole('dialog', { name: 'Add-On Available', exact: true });
      await dialog.waitFor({ state: 'visible', timeout: remaining() });
      await dialog
        .getByRole('button', { name: '25%', exact: true })
        .click({ timeout: remaining() });
      const amount = Number(await dialog.getByLabel('Amount To Add', { exact: true }).inputValue());
      if (cents(amount) <= 0) throw Error('no_topup_headroom');
      await dialog.getByRole('button', { name: /^Add [\d,.]+$/ }).click({ timeout: remaining() });
    } else {
      await menu();
      const toggle = page.getByRole('menuitem', { name: /^Auto Top Up(?: ON)?$/ });
      const initial = await toggle.innerText();
      if (/\bON\b/.test(initial)) throw Error('auto_already_armed');
      // Restore through the same normal control even after unknown observation.
      restoreAuto = true;
      autoRestored = false;
      await toggle.click({ timeout: remaining() });
      report.autoArmed = true;
    }
    report.cause = 'response_unknown';
    const response = await bound(responsePromise);
    const intent = financialIntent(action, response.request().postDataJSON(), pin, anchor);
    report.intent = intent;
    const reply = await bound(response.json());
    if (restoreAuto) await restorePreference(remaining());
    if (action === 'stop_playing') {
      const out = Array.isArray(reply) ? reply[0] : reply;
      if (!response.ok() || out?.ok !== true || out.pool_session_id !== pin.poolSessionId)
        throw Error('stop_refused');
      // Only read-only observation waits; ordinary engine input remains active.
      while (true) {
        const pool = read(
          await bound(
            admin
              .from('lightning_pool_session')
              .select('id,cluster_id,player_id,state,exited_at,stop_requested_at')
              .eq('id', pin.poolSessionId)
              .maybeSingle()
          )
        );
        if (
          pool.id !== pin.poolSessionId ||
          pool.cluster_id !== pin.clusterId ||
          pool.player_id !== pin.playerId
        )
          throw Error('pool_changed');
        if (pool.stop_requested_at && pool.exited_at) {
          report.stop = { requested: true, exited: true, cashout: 'not_asserted' };
          break;
        }
        await page.waitForTimeout(Math.min(750, remaining()));
      }
    } else if (action === 'cash_out') {
      if (
        !response.ok() ||
        reply?.success !== true ||
        reply.protocol !== 'seat-occupancy-v1' ||
        reply.occupancyId !== anchor.occupancy_id ||
        reply.seatNumber !== anchor.seat_number
      )
        throw Error(reply?.code === 'LEAVE_LOCKED' ? 'stay_clock_refused' : 'cashout_refused');
      report.deferred = reply.immediate === false;
      while (true) {
        try {
          report.proof = await bound(cashoutReadback(admin, pin, intent, anchor));
          break;
        } catch (e) {
          if (e.message !== 'cashout_pending') throw e;
        }
        await page.waitForTimeout(Math.min(750, remaining()));
      }
    } else {
      if (!response.ok() || reply?.success !== true) throw Error('addon_refused');
      while (true) {
        try {
          report.proof = await bound(addonReadback(admin, pin, intent, reply, anchor));
          break;
        } catch (e) {
          if (e.message !== 'queued_not_landed') throw e;
        }
        await page.waitForTimeout(Math.min(750, remaining()));
      }
    }
    report.servingAfter = await identities();
    report.servingVerdict = servingStable(report.servingBefore, report.servingAfter);
    if (
      report.servingVerdict !== 'passed' ||
      report.servingAfter.engine.data.fullRevisionEstablished !== true
    )
      throw Error('serving_unknown');
    report.status = 'observed';
    report.cause = 'actual_effect_verified';
  } catch (error) {
    const causes = [
      'deadline',
      'build_changed',
      'serving_unknown',
      'read_unknown',
      'money_unknown',
      'build_unknown',
      'anchor_unknown',
      'no_topup_headroom',
      'auto_already_armed',
      'response_unknown',
      'addon_refused',
      'addon_refused_or_unknown',
      'addon_receipt_unverified',
      'addon_ledger_unverified',
      'queued_not_landed',
      'queued_effect_unverified',
      'stop_refused',
      'pool_changed',
      'cashout_pending',
      'cashout_refused',
      'stay_clock_refused',
      'cashout_receipt_unverified',
      'cashout_ledger_unverified',
      'cashout_closure_unverified',
    ];
    report.cause = causes.includes(error?.message)
      ? error.message
      : 'normal_ui_or_readback_unknown';
  } finally {
    if (restoreAuto && !autoRestored) {
      try {
        await restorePreference(Math.max(1, end - Date.now() - 12000));
      } catch {
        autoRestored = false;
      }
    }
    if (restoreAuto) report.autoPreferenceRestored = autoRestored;
    let closed = true,
      local = true;
    if (!auth && opening)
      try {
        auth = await bound(opening, Math.max(1, end - Date.now() - 10000));
      } catch {
        local = false;
      }
    if (browser)
      try {
        await bound(browser.close(), Math.max(1, end - Date.now() - 7000));
      } catch {
        closed = false;
      }
    if (auth?.client)
      try {
        const out = await bound(
          auth.client.auth.signOut({ scope: 'local' }),
          Math.max(1, end - Date.now())
        );
        if (out?.error) local = false;
      } catch {
        local = false;
      }
    report.cleanup =
      closed && local && autoRestored ? 'local_session_and_browser_closed' : 'unknown';
    if (report.cleanup === 'unknown') report.status = 'unknown';
    if (
      report.matchingRequests > 1 ||
      (report.status === 'observed' && report.matchingRequests !== 1)
    ) {
      report.status = 'unknown';
      report.cause = 'multiple_ui_requests_observed';
    }
  }
  return report;
}
