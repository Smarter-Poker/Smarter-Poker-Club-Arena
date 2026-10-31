import assert from 'node:assert/strict';
import {
  validatePlayerUIIngress,
  verifyPreActionUI,
  verifyPaidRebuyReturn,
  verifyFinishReport,
  requireCompletePlayerUICoverage,
} from './tournament-player-ui-evidence.mjs';

// These are the existing isolated gateway's fixed names. They are Docker
// INTERNAL-network aliases, never configurable production destinations.
const BASE = 'https://smarter.poker/hub/club-arena/';
const POST_REBUY = '/rest/v1/rpc/process_tournament_rebuy';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const chipText = (value) => {
  const n = Math.trunc(value * 100) / 100;
  return n.toLocaleString(
    'en-US',
    Number.isInteger(n) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 }
  );
};
async function verifyRenderedStandings(report, standings, deadline) {
  const ids = [];
  for (const row of standings) {
    const name = report.getByText(new RegExp(`^${escaped(row.username)}(?:\\s*\\(You\\))?$`));
    await name.waitFor({ state: 'visible', timeout: Math.min(15000, deadline - Date.now()) });
    const grid = report.locator('div.fadeInUp').filter({ has: name });
    assert.equal(await grid.count(), 1, 'PLAYER_UI_REPORT_ROW_AMBIGUOUS');
    const suffix =
      row.position % 100 >= 11 && row.position % 100 <= 13
        ? 'th'
        : ({ 1: 'st', 2: 'nd', 3: 'rd' }[row.position % 10] ?? 'th');
    assert.equal(
      (await grid.locator(':scope > div').first().locator('span').first().innerText()).trim(),
      `${row.position}${suffix}`
    );
    const cells = grid.locator(':scope > span');
    assert.equal(await cells.count(), 4);
    // This scenario admits ordinary Chip MTT/SPIN/SNG, without satellites or
    // bounty configurations. Verify every rendered money cell independently.
    const values = [row.prize, 0, row.bounty_winnings, row.prize + row.bounty_winnings];
    for (let i = 0; i < values.length; i++)
      assert.equal(
        (await cells.nth(i).innerText()).trim(),
        values[i] > 0 ? chipText(values[i]) : '-',
        'PLAYER_UI_REPORT_RENDER_DISAGREES'
      );
    ids.push(row.user_id);
  }
  return ids;
}

/** Only the page can submit a mutation. This collector reads no headers,
 * cookies, tokens, hole cards, or unrelated request/response bodies.
 */
export function collectPlayerUIRequests(page) {
  const mutations = [];
  const responses = new Map();
  const pending = new Set();
  let failure;
  const onRequest = (request) => {
    try {
      if (request.method() !== 'POST') return;
      const url = new URL(request.url());
      if (!['/preaction', '/action', POST_REBUY].includes(url.pathname)) return;
      const body = request.postDataJSON();
      const item = { at: Date.now(), method: request.method(), pathname: url.pathname, body };
      mutations.push(item);
      responses.set(request, item);
      assert.ok(mutations.length <= 256, 'PLAYER_UI_MUTATION_BOUND');
    } catch {
      failure ??= new Error('PLAYER_UI_REQUEST_REFUSED');
    }
  };
  const onResponse = (response) => {
    const item = responses.get(response.request());
    if (!item) return;
    const task = (async () => {
      const raw = await response.body();
      assert.ok(raw.length <= 65536, 'PLAYER_UI_RESPONSE_BOUND');
      item.response = { status: response.status(), body: JSON.parse(raw.toString()) };
    })()
      .catch((error) => {
        failure ??= error;
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  return {
    mutations,
    async drain() {
      await Promise.all([...pending]);
      if (failure) throw failure;
    },
    close() {
      page.off('request', onRequest);
      page.off('response', onResponse);
    },
  };
}

/** Called by the existing isolated cohort driver at an actual pending player
 * decision. Opponents must continue through their own browser input devices.
 * readArm/readCalls are the trusted wire journal's selected event readers;
 * no event is injected and no direct engine action is submitted here.
 */
export async function provePreActionThroughUI({
  page,
  choice,
  tableId,
  userId,
  handNumber,
  journal,
  readArm,
  readCalls,
  deadline,
  onClicked = () => {},
}) {
  assert.ok(Date.now() < deadline);
  assert.match(tableId, UUID);
  assert.match(userId, UUID);
  const button = page.locator('.pre-action-bar').getByRole('button', {
    name: choice === 'call_any' ? 'Call Any' : /^Call [0-9]/,
    exact: choice === 'call_any',
  });
  await page.bringToFront();
  await button.waitFor({ state: 'visible', timeout: Math.min(15000, deadline - Date.now()) });
  const collector = collectPlayerUIRequests(page),
    clickAt = Date.now();
  try {
    await button.click({ timeout: Math.min(15000, deadline - Date.now()) });
    onClicked();
    let armed,
      calls = [];
    while (Date.now() < deadline) {
      await collector.drain();
      armed = readArm(journal, { tableId, userId, handNumber, since: clickAt });
      calls = readCalls(journal, { tableId, userId, handNumber, since: clickAt });
      if (armed && calls.length) break;
      await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    await collector.drain();
    const requests = collector.mutations.filter(
      (r) =>
        r.pathname === '/preaction' &&
        r.body.action === (choice === 'call_any' ? 'auto_call_any' : 'auto_call')
    );
    assert.equal(requests.length, 1, 'PLAYER_UI_EXPECTED_ONE_ARM_REQUEST');
    const request = requests[0];
    assert.ok(request.response, 'PLAYER_UI_ARM_RESPONSE_UNKNOWN');
    return verifyPreActionUI({
      choice,
      tableId,
      userId,
      handNumber,
      clickAt,
      request,
      response: request.response,
      armed,
      calls,
      directActions: collector.mutations.filter((r) => r.pathname === '/action'),
    });
  } finally {
    collector.close();
  }
}

/** readNative is the existing fixture owner's bounded independent DB witness,
 * never the page, a reported success flag, or an arbitrary SQL callback from a
 * candidate. It must bind this same tournament, actor and purchase token.
 */
export async function provePaidRebuyThroughUI({
  page,
  tournamentId,
  userId,
  readNative,
  deadline,
}) {
  assert.match(tournamentId, UUID);
  assert.match(userId, UUID);
  const dialog = page.getByRole('dialog', { name: 'Rebuy Available', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: Math.min(30000, deadline - Date.now()) });
  const before = await readNative({ tournamentId, userId, token: null });
  const collector = collectPlayerUIRequests(page),
    manualSeats = [];
  const observeSeatRequest = (request) => {
    if (
      request.method() !== 'GET' &&
      /\/(?:fn_take_seat_and_buy_in|atomic_table_buyin|fn_cash_game_join)(?:[/?#]|$)/.test(
        new URL(request.url()).pathname
      )
    )
      manualSeats.push(true);
  };
  page.on('request', observeSeatRequest);
  try {
    await page.bringToFront();
    await dialog
      .getByRole('button', { name: /^Rebuy [0-9]/ })
      .click({ timeout: Math.min(15000, deadline - Date.now()) });
    let request;
    while (Date.now() < deadline) {
      await collector.drain();
      const requests = collector.mutations.filter((r) => r.pathname === POST_REBUY);
      assert.ok(requests.length <= 1, 'PLAYER_UI_REBUY_WAS_RETRIED');
      request = requests[0];
      if (request?.response) break;
      await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    assert.ok(request?.response, 'PLAYER_UI_REBUY_OUTCOME_UNKNOWN');
    const tableId = request.response.body.table_id,
      seatNumber = request.response.body.seat_number;
    await page.waitForURL((url) => url.pathname === `/hub/club-arena/table/${tableId}`, {
      timeout: Math.min(15000, deadline - Date.now()),
    });
    await page
      .locator(`.seat--hero[data-player-id="${userId}"][data-seat-num="${seatNumber}"]`)
      .waitFor({ state: 'visible', timeout: Math.min(15000, deadline - Date.now()) });
    const after = await readNative({ tournamentId, userId, token: request.body.p_client_token });
    return verifyPaidRebuyReturn({
      tournamentId,
      userId,
      request,
      response: request.response,
      before,
      after,
      observedTableId: tableId,
      observedSeatNumber: seatNumber,
      manualSeatRequests: manualSeats,
    });
  } finally {
    collector.close();
    page.off('request', observeSeatRequest);
  }
}

export async function proveFinishReportThroughUI({ page, cohort, readNative, deadline }) {
  const first = await readNative({
    tournamentId: cohort.tournament_id,
    userId: cohort.users[0].id,
    token: null,
  });
  assert.ok(
    ['COMPLETED', 'FINISHED', 'ENDED'].includes(String(first.tournamentStatus).toUpperCase()),
    'PLAYER_UI_TOURNAMENT_NOT_FINISHED'
  );
  await page.goto(`${BASE}tournament-results?id=${cohort.tournament_id}`, {
    waitUntil: 'domcontentloaded',
    timeout: Math.min(30000, deadline - Date.now()),
  });
  const report = page.locator('.tournament-results-page');
  await report.waitFor({ state: 'visible', timeout: Math.min(15000, deadline - Date.now()) });
  await verifyRenderedStandings(report, first.standings, deadline);
  // A fresh document must issue and render a new canonical standings read.
  await page.reload({
    waitUntil: 'domcontentloaded',
    timeout: Math.min(30000, deadline - Date.now()),
  });
  const second = await readNative({
    tournamentId: cohort.tournament_id,
    userId: cohort.users[0].id,
    token: null,
  });
  const visibleUserIds = await verifyRenderedStandings(report, second.standings, deadline);
  assert.equal(new URL(page.url()).searchParams.get('id'), cohort.tournament_id);
  return verifyFinishReport({
    tournamentId: cohort.tournament_id,
    endedAt: second.endedAt,
    status: second.tournamentStatus,
    beforeReload: first.standings,
    afterReload: second.standings,
    visibleUserIds,
    reportTournamentId: cohort.tournament_id,
  });
}

export function playerUIRun(ingress) {
  const owned = validatePlayerUIIngress(ingress);
  const cohorts = owned.cohorts.map((c) => ({
    format: c.format,
    tournamentId: c.tournament_id,
    flows: {},
  }));
  return Object.freeze({
    record(format, flow, observation) {
      const cohort = cohorts.find((c) => c.format === format);
      assert.ok(
        cohort && ['call_any', 'call_amount', 'paid_rebuy_return', 'finish_report'].includes(flow)
      );
      assert.equal(cohort.flows[flow], undefined, 'PLAYER_UI_DUPLICATE_FLOW');
      cohort.flows[flow] = { verified: true, observation: structuredClone(observation) };
    },
    finish() {
      return { ...requireCompletePlayerUICoverage(cohorts), cohorts: structuredClone(cohorts) };
    },
  });
}
