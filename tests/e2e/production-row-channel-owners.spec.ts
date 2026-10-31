import { isClubMemberOwnerJoin } from './support/rowChannelOwner';
import { isReadOnlySpectatorSocketType } from './support/spectatorSocketRead';
import { test, expect, type Page } from '@playwright/test';
import { openLobbyGameSection } from './support/lobbyGameSections';
import { CASH_SPECTATOR_ACTION, CASH_TABLE_CARD_SELECTOR } from './support/cashTableCandidates';
import { prepareCashLobbyActions } from './support/cashLobbyOverlays';
import { diamondEntryRead, settleDiamondSpinsOffer } from './support/diamondInvitationOffer';

const CLUB_ID = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
test.use({ viewport: { width: 393, height: 852 }, trace: 'off', video: 'off', screenshot: 'off' });
async function openLobby(page: Page) {
  const offer = diamondEntryRead(page);
  await page.goto(`clubs/${CLUB_ID}`, { waitUntil: 'domcontentloaded' });
  await prepareCashLobbyActions(page);
  await expect(page.getByRole('button', { name: 'Cash Games', exact: true })).toBeVisible();
  await settleDiamondSpinsOffer(page, offer);
  await openLobbyGameSection(page, 'ALL');
}

// This case observes natural row traffic in two mounted views. No raw socket
// frames, tokens or member rows are retained in its evidence.
test('both club views keep receiving rows and one survives the other unmounting', async ({
  page,
  request,
  context,
}, info) => {
  test.setTimeout(120_000);
  expect(
    /^ca-customization-cert-postdeploy-.*@example\.invalid$/.test(process.env.SP_EMAIL || '')
  ).toBe(true);
  const readPublishedClient = async () => {
    const origin = await request.get('https://ca-static.smarter.poker/build-info.json');
    const rewrite = await request.get('https://smarter.poker/hub/club-arena/build-info.json');
    expect(origin.ok() && rewrite.ok()).toBe(true);
    const stamp = await origin.json();
    expect(stamp.ca_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await rewrite.json()).toEqual(stamp);
    return stamp;
  };
  const publishedClient = await readPublishedClient();
  const owners = new Map<string, { ref: string; joined: boolean; updates: number }>();
  const frame = (raw: string | Buffer) => {
    try {
      const value = JSON.parse(String(raw));
      return Array.isArray(value)
        ? { ref: value[1], topic: value[2], event: value[3], payload: value[4] }
        : value;
    } catch {
      return null;
    }
  };
  page.on('websocket', (socket) => {
    if (!new URL(socket.url()).hostname.endsWith('.supabase.co')) return;
    socket.on('framesent', ({ payload }) => {
      const item = frame(payload);
      if (!item) return;
      if (isClubMemberOwnerJoin(item.topic, item.event, item.payload, CLUB_ID))
        owners.set(item.topic, { ref: String(item.ref), joined: false, updates: 0 });
      if (item.event === 'phx_leave' && owners.has(item.topic)) owners.delete(item.topic);
    });
    socket.on('framereceived', ({ payload }) => {
      const item = frame(payload);
      const owner = owners.get(item?.topic);
      if (!owner) return;
      if (
        item.event === 'phx_reply' &&
        String(item.ref) === owner.ref &&
        item.payload?.status === 'ok'
      )
        owner.joined = true;
      if (item.event === 'postgres_changes') owner.updates++;
    });
  });
  const participation: string[] = [];
  await context.routeWebSocket(
    (url) =>
      url.hostname === 'engine.smarter.poker' &&
      (url.pathname === '/ws/multi' || url.pathname.startsWith('/ws/table/')),
    (client) => {
      const server = client.connectToServer();
      server.onMessage((message) => client.send(message));
      client.onMessage((message) => {
        let type = '';
        try {
          type = String(JSON.parse(String(message)).type || '');
        } catch {
          /* refused below */
        }
        if (!isReadOnlySpectatorSocketType(type)) {
          participation.push(`websocket:${type || 'unreadable'}`);
          return;
        }
        server.send(message);
      });
    }
  );

  await page.route(
    /\/(?:action|leave|post-bb|rabbit-hunt|buyin|addchips|rebuy|cashout|sitout|seat-move|seat-change|rest\/v1\/(?:table_seats|tournament_players|wallet_transactions|rpc\/(?:fn_cash_game_join|atomic_table_buyin|fn_lightning_join|fn_lightning_buy_in|fn_take_seat_and_buy_in|fn_register_for_tournament|fn_unregister_from_tournament|fn_leave_seat_and_refund|atomic_table_rebuy|process_tournament_rebuy|fn_join_waitlist)))(?:[/?#]|$)/,
    async (route) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.continue();
      participation.push(new URL(route.request().url()).pathname);
      await route.abort('blockedbyclient');
    }
  );
  await openLobby(page);
  await page.getByRole('tab', { name: 'ALL', exact: true }).click();
  const cards = page.locator(`${CASH_TABLE_CARD_SELECTOR}:visible`);
  await expect(cards.first()).toBeVisible();
  const ids = (
    await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-id')))
  )
    .filter((id): id is string => /^[0-9a-f-]{36}$/i.test(id || ''))
    .slice(0, 32);
  const response = await request.get(
    `https://engine.smarter.poker/health?liveness_table_ids=${ids.join(',')}`
  );
  expect(response.ok()).toBe(true);
  const health = await response.json();
  expect(Array.isArray(health.tableLiveness)).toBe(true);
  const subject = health.tableLiveness.find(
    (row: {
      tableId: string;
      running: boolean;
      paused: boolean;
      seated: number;
      dealable: number;
    }) =>
      ids.includes(row.tableId) &&
      row.running &&
      !row.paused &&
      row.seated >= 2 &&
      row.dealable >= 2
  );
  expect(subject, 'The reserved observer needs an actually served cash table').toBeTruthy();
  // The data-id is on the card/row itself, not a descendant.
  const selected = page.locator(
    `${CASH_TABLE_CARD_SELECTOR}[data-id="${subject.tableId}"]:visible`
  );
  await selected.getByRole('button', { name: /^Details:/ }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('game')).toBe(subject.tableId);
  const returnToLobby = page.url();
  await page
    .getByRole('dialog')
    .filter({ has: page.locator('.arena-game-card') })
    .getByRole('button', { name: CASH_SPECTATOR_ACTION })
    .click();
  // View awaits token preparation (up to 15s), then the mux initial-state
  // gate (up to 15s). The roster's 5s read starts concurrently; it is not
  // another sequential allowance. A refusal still leaves this assertion red.
  await expect(page).toHaveURL(new RegExp(`/table/${subject.tableId}(?:[?#]|$)`), {
    timeout: 30_000,
  });
  await expect(page.getByTestId('spectator-footer-bar')).toBeVisible();
  const bar = page.locator('.table-tab-bar:visible').first();
  await bar.getByRole('button', { name: 'Open Another Table', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Quick Join', exact: true })
    .getByRole('button', { name: 'Browse Full Lobby', exact: true })
    .click();
  await expect(page.locator('.multi-table-page__lobby-tab .club-home:visible')).toBeVisible();
  await expect.poll(() => [...owners.values()].filter((owner) => owner.joined).length).toBe(1);
  const retainedTopic = [...owners.keys()][0];
  await page.goBack();
  await expect(page).toHaveURL(returnToLobby);
  await expect.poll(() => [...owners.values()].filter((owner) => owner.joined).length).toBe(2);
  await expect
    .poll(() => [...owners.values()].every((owner) => owner.updates > 0), { timeout: 30_000 })
    .toBe(true);
  const both = [...owners.values()].map((owner) => ({
    joined: owner.joined,
    updates: owner.updates,
  }));
  await info.attach('two-mounted-club-views.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/table/${subject.tableId}(?:[?#]|$)`));
  await expect.poll(() => owners.size).toBe(1);
  expect(owners.has(retainedTopic)).toBe(true);
  const afterUnmount = owners.get(retainedTopic)!.updates;
  await expect
    .poll(() => owners.get(retainedTopic)!.updates, { timeout: 30_000 })
    .toBeGreaterThan(afterUnmount);
  expect(participation).toEqual([]);
  expect(await readPublishedClient()).toEqual(publishedClient);
  await info.attach('row-owner-natural-delivery.json', {
    body: Buffer.from(
      JSON.stringify({
        both,
        remainingOwnerReceivedAnotherRow: true,
        zeroParticipation: true,
        naturalTrafficOnly: true,
        publishedClient,
        tableId: subject.tableId,
        engineSha: health.releaseSha,
      })
    ),
    contentType: 'application/json',
  });
});
