import {
  isReadOnlySpectatorSocketType,
  requestObserverForegroundProbe,
} from './support/spectatorSocketRead';
import { openLobbyGameSection } from './support/lobbyGameSections';
import { readFile } from 'node:fs/promises';
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { formatPopupText } from '../../src/utils/popupStyle';
import {
  CASH_SPECTATOR_ACTION,
  CASH_TABLE_CARD_SELECTOR,
  collectVisibleCashCandidates,
  selectClassicCashCandidate,
} from './support/cashTableCandidates';
import { prepareCashLobbyActions } from './support/cashLobbyOverlays';

const CLUB_ID = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const ENGINE_HOST = 'engine.smarter.poker';
const MAIN_NAME = /\bmain(?:\s*\d+)?\b/i;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
type CashTable = { id: string; name: string; cluster_id?: unknown; cluster?: unknown };
type RefusedWrite = { transport: 'http' | 'websocket'; operation: string; path: string };

/** Refuse participation before a request can reach a real seat or chip pool. */
function forbiddenParticipation(method: string, url: URL, body: string | null): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return false;
  const path = url.pathname.toLowerCase().replace(/\/+$/, '');
  if (url.hostname === ENGINE_HOST) return !path.endsWith('/heartbeat');
  if (
    /\/(?:action|buyin|buy-in|cashout|cash-out|addchips|add-chips|rebuy|leave|seat-move|seat-change|request-cashout|approve-cashout|transfer-chips|mint-chips|distribute-chips|clawback-chips|settle-period|agent-credit)$/.test(
      path
    )
  )
    return true;
  if (
    /\/rest\/v1\/(?:table_seats|tournament_players|wallets|wallet_transactions|chip_ledger|chip_transactions)$/.test(
      path
    )
  )
    return true;
  if (
    path.endsWith('/rest/v1/club_members') &&
    /"(?:chip_balance|promo_balance|held_chips|locked_chips|credit_used)"\s*:/.test(body || '')
  )
    return true;
  const rpc = path.match(/\/rpc\/([^/]+)$/)?.[1];
  // This is the existing read-only price calculation, not a purchase.
  if (
    !rpc ||
    rpc === 'fn_cash_effective_buyin' ||
    /^(?:fn_|ca_)?(?:get|read|list|fetch|can|has|is)_/.test(rpc)
  )
    return false;
  return /take_seat|leave_seat|seat_move|move_seat|seat_change|swap_seat|buy_?in|rebuy|add_?chips|cash_?out|cashout|transfer_chips|mint_chips|clawback|distribute_chips|tournament_payout|register_for_tournament|unregister_from_tournament|join_waitlist|leave_waitlist|(?:^|_)(?:credit|debit|transfer|mint|payout|refund|settle)(?:_|$)|claim_(?:daily|bonus|reward)/.test(
    rpc
  );
}

// The existing post-deploy account and cleanup own authentication. No tokens,
// socket URLs, raw state, trace or video are retained by this controlled proof.
test.use({ viewport: { width: 393, height: 852 }, trace: 'off', video: 'off' });
test('the published table explains controlled seat moves without moving a player', async ({
  page,
  context,
  request,
}, info) => {
  test.setTimeout(150_000);
  const record = process.env.E2E_TEST_ACCOUNT_FILE;
  if (!record) throw new Error('The maintained isolated post-deploy account record is required.');
  const { id: fixtureUserId, email } = JSON.parse(await readFile(record, 'utf8'));
  if (
    !UUID.test(String(fixtureUserId)) ||
    !/^ca-customization-cert-postdeploy-.*@example\.invalid$/.test(String(email))
  )
    throw new Error('Seat-move rendering proof refuses a non-reserved account.');

  const writes: RefusedWrite[] = [];
  const nameReads = new Map<string, number>();
  const clients: WebSocketRoute[] = [];
  let observedViewerId: string | null = null;
  let realIncomingFrames = 0;
  let subjectTableId: string | null = null;
  let snapshotTemplate: Record<string, any> | null = null;
  let latestSequence = 0;
  let syntheticPhase = false;
  const refusedSynthetic = { http: 0, websocket: 0 };
  let forwardedSyntheticUpstream = 0;
  const heroDiagnostics: string[] = [];
  page.on('console', (message) => {
    if (syntheticPhase && message.text().includes('TablePage.EngineHeroSeatNotRendered'))
      heroDiagnostics.push('TablePage.EngineHeroSeatNotRendered');
  });
  const evidence: Record<string, unknown> = {
    source: 'controlled-browser-event',
    naturalMoveObserved: false,
  };
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const nonRead = !['GET', 'HEAD', 'OPTIONS'].includes(req.method());
    // Synthetic input must never create production telemetry or any write.
    if (nonRead && (syntheticPhase || url.pathname.endsWith('/rpc/fn_report_client_errors'))) {
      if (syntheticPhase) refusedSynthetic.http++;
      await route.abort('blockedbyclient');
      return;
    }
    if (forbiddenParticipation(req.method(), url, req.postData())) {
      writes.push({ transport: 'http', operation: req.method(), path: url.pathname });
      await route.abort('blockedbyclient');
      return;
    }
    if (url.pathname.endsWith('/rest/v1/tables') && url.searchParams.get('select') === 'name') {
      const id = url.searchParams.get('id') || '';
      nameReads.set(id, (nameReads.get(id) || 0) + 1);
    }
    await route.continue();
  });
  await context.route('**/rest/v1/table_seats?**', async (route) => {
    const url = new URL(route.request().url());
    if (
      (url.searchParams.get('select') || '').startsWith('table_id') &&
      (url.searchParams.get('user_id') || '').startsWith('eq.')
    )
      observedViewerId = url.searchParams.get('user_id')!.slice(3);
    await route.fallback();
  });
  await context.routeWebSocket(
    () => true,
    (client) => {
      const engine = new URL(client.url()).hostname === ENGINE_HOST;
      if (engine) clients.push(client);
      const server = client.connectToServer();
      const upstream = (message: string | Buffer) => {
        if (syntheticPhase) forwardedSyntheticUpstream++;
        server.send(message);
      };
      // Preserve all genuine server bytes; only the extra test packets below
      // are synthetic, and original-route.send delivers them to this page only.
      server.onMessage((message) => {
        // During the final synthetic phase only this browser's display is
        // held. The real engine, players and upstream connection are untouched.
        if (syntheticPhase) return;
        if (engine) {
          realIncomingFrames += 1;
          try {
            const frame = JSON.parse(String(message));
            if (frame.tableId === subjectTableId) {
              if (typeof frame.seq === 'number')
                latestSequence = Math.max(latestSequence, frame.seq);
              if (frame.type === 'SNAPSHOT' && Array.isArray(frame.state?.players))
                snapshotTemplate = frame;
            }
          } catch {
            /* genuine non-JSON bytes are still forwarded unchanged */
          }
        }
        client.send(message);
      });
      client.onMessage((message) => {
        // Every upstream socket, including Realtime, is read-only during this
        // phase. Never forward synthetic client participation or diagnostics.
        if (syntheticPhase) {
          refusedSynthetic.websocket++;
          return;
        }
        if (!engine) {
          upstream(message);
          return;
        }
        let type = '';
        try {
          type = String(JSON.parse(String(message)).type || '');
        } catch {
          /* refused below */
        }
        if (!isReadOnlySpectatorSocketType(type)) {
          writes.push({
            transport: 'websocket',
            operation: type || 'unreadable-frame',
            path: '/ws/multi',
          });
          return;
        }
        upstream(message);
      });
    }
  );
  const readBuild = async () => {
    const responses = await Promise.all([
      request.get(`https://ca-static.smarter.poker/build-info.json?notice=${Date.now()}`),
      request.get(`https://smarter.poker/hub/club-arena/build-info.json?notice=${Date.now()}`),
    ]);
    for (const response of responses)
      expect(response.ok(), 'the public build identity must be readable').toBe(true);
    const [origin, rewrite] = await Promise.all(responses.map((response) => response.json()));
    expect(origin.ca_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(rewrite.ca_sha).toBe(origin.ca_sha);
    expect(rewrite.run_id).toBe(origin.run_id);
    expect(origin.built_by).toBe('publish-club-arena.yml');
    return { ca_sha: origin.ca_sha as string, run_id: String(origin.run_id) };
  };

  try {
    evidence.before = await readBuild();
    const cashRead = page
      .waitForResponse(
        (response) => {
          const url = new URL(response.url());
          return (
            url.pathname.endsWith('/rest/v1/tables') &&
            (url.searchParams.get('select') || '')
              .replace(/\s+/g, '')
              .startsWith('id,name,game_variant,') &&
            url.searchParams.get('tournament_id') === 'is.null'
          );
        },
        { timeout: 35_000 }
      )
      .then(async (response) => {
        expect(response.ok(), 'the real cash catalogue read failed').toBe(true);
        const rows: unknown = await response.json();
        if (!Array.isArray(rows)) throw new Error('The cash catalogue was not an array.');
        return {
          rows: rows.filter(
            (row): row is CashTable => UUID.test(row?.id) && typeof row?.name === 'string'
          ),
          error: null as string | null,
        };
      })
      .catch((error: unknown) => ({ rows: null, error: String(error) }));
    await page.goto(`clubs/${CLUB_ID}`, { waitUntil: 'domcontentloaded' });
    expect(new URL(page.url()).origin, 'this proof must load the actual public client').toBe(
      'https://smarter.poker'
    );
    expect(new URL(page.url()).pathname).toMatch(/^\/hub\/club-arena\/clubs\//);
    await expect(page.locator('.club-home')).toBeVisible({ timeout: 30_000 });
    await prepareCashLobbyActions(page);
    await openLobbyGameSection(page, 'ALL');
    const allGames = page.getByRole('tab', { name: 'ALL', exact: true });
    await allGames.click();
    await expect(allGames).toHaveAttribute('aria-selected', 'true');
    const allStatuses = page
      .getByLabel('Game Status', { exact: true })
      .getByRole('button', { name: 'All', exact: true });
    await allStatuses.click();
    await expect(allStatuses).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(CASH_TABLE_CARD_SELECTOR).first()).toBeVisible({ timeout: 30_000 });
    const candidates = await page
      .locator(CASH_TABLE_CARD_SELECTOR)
      .evaluateAll(collectVisibleCashCandidates, CASH_SPECTATOR_ACTION.source);
    expect(
      candidates.length,
      'the reserved club needs an occupied cash spectator subject'
    ).toBeGreaterThan(0);
    const catalogueRead = await cashRead;
    if (catalogueRead.error || !catalogueRead.rows)
      throw new Error(`The cash catalogue was unreadable: ${catalogueRead.error}`);
    const catalogue = catalogueRead.rows;
    const source = selectClassicCashCandidate(candidates, catalogue);
    if (!source)
      throw new Error(
        'The classic hero proof needs a visible occupied cash table with an exact must_move cluster catalogue row.'
      );
    subjectTableId = source.id;
    evidence.subjectMode = {
      tableId: source.id,
      clusterId: catalogue.find((table) => table.id === source.id)!.cluster_id,
      clusterMode: 'must_move',
      authority: 'existing tables catalogue cash_games foreign-key join',
    };
    expect(observedViewerId, 'the page must use its reserved fixture identity').toBe(fixtureUserId);
    const main = catalogue.find((table) => table.id !== source.id && MAIN_NAME.test(table.name));
    const other = catalogue.find(
      (table) => table.id !== source.id && !MAIN_NAME.test(table.name) && table.name.trim()
    );
    if (!main || !other)
      throw new Error('The readable catalogue needs distinct main and other-table destinations.');

    const row = page.locator(`[data-testid="lobby-game-row"][data-id="${source.id}"]`);
    if (await row.isVisible()) {
      await row.getByRole('button', { name: /^Details:/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: CASH_SPECTATOR_ACTION }).click();
    } else {
      await page
        .locator(`[data-testid="arena-lobby-game-card"][data-id="${source.id}"]`)
        .getByRole('button', { name: CASH_SPECTATOR_ACTION })
        .click();
    }
    await expect(page).toHaveURL(
      (url) =>
        url.origin === 'https://smarter.poker' && url.pathname.endsWith(`/table/${source.id}`),
      {
        timeout: 30_000,
      }
    );
    await expect(page.locator('.table-surface')).toBeVisible({ timeout: 20_000 });
    // Full cash tables render the waiting-list action instead of a
    // "Spectating" label. This test id belongs only to the unseated branch.
    const spectator = page.getByTestId('spectator-footer-bar');
    await expect(spectator).toBeVisible();
    await expect(spectator).toHaveAttribute('data-state', /^(open-here|no-seats-here)$/);
    await expect(page.locator('.table-page')).toHaveAttribute('data-hero', 'false');
    await expect(page.locator('.seat--hero')).toHaveCount(0);
    const seats = page.locator('.seat[data-player-id]');
    await expect.poll(() => seats.count()).toBeGreaterThanOrEqual(2);
    const actor = seats.filter({ has: page.locator('.seat__name') }).first();
    const actorId = await actor.getAttribute('data-player-id');
    const alias = (await actor.locator('.seat__name').innerText()).trim();
    expect(actorId).not.toBe(fixtureUserId);
    expect(actorId).toMatch(UUID);
    expect(alias).not.toBe('');
    await expect.poll(() => clients.length).toBeGreaterThan(0);
    expect(
      realIncomingFrames,
      'the isolated browser must receive real engine traffic'
    ).toBeGreaterThan(0);
    const openChat = page.getByRole('button', { name: /^Open Table Chat/ });
    if (await openChat.isVisible()) await openChat.click();
    await expect(page.getByRole('dialog', { name: 'Table Chat', exact: true })).toBeVisible();
    const routeBefore = page.url();
    const exactText = (selector: string, text: string) =>
      page
        .locator(selector)
        .filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
    const systemMessage = (text: string) =>
      exactText('.chat-message--system .chat-message__system-text', text);
    const toastMessage = (text: string) => exactText('.toast__message', formatPopupText(text));
    const timestamp = Date.now();
    const inject = (destination: CashTable, at: number, reason: string, replayed = false) => {
      const payload = {
        type: 'seat_moved',
        table_id: source.id,
        user_id: actorId,
        to_table_id: destination.id,
        reason,
        timestamp: at,
        ...(replayed ? { replayed: true } : {}),
      };
      // Absent EVENT seq is the existing legacy contract: it cannot advance or
      // corrupt the real server's monotonic event epoch. Nothing is sent upstream.
      clients
        .at(-1)!
        .send(JSON.stringify({ type: 'EVENT', tableId: source.id, ts: Date.now(), payload }));
    };
    const mainText = `${alias} Was Moved To The Main Game`;
    const otherText = `${alias} Was Moved To ${other.name.trim()}`;
    inject(main, timestamp, 'must_move');
    await expect(systemMessage(mainText)).toHaveCount(1);
    await expect(toastMessage(mainText)).toBeVisible();
    await info.attach('mobile-live-table-seat-move-main', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    const mainReadsAfterFirst = nameReads.get(`eq.${main.id}`) || 0;
    expect(
      mainReadsAfterFirst,
      'the destination-read observer must see the positive control'
    ).toBeGreaterThan(0);
    inject(main, timestamp, 'must_move');
    inject(main, timestamp + 1, 'must_move', true);
    inject(other, timestamp + 2, 'seat_change');
    await expect(systemMessage(otherText)).toHaveCount(1);
    await expect(toastMessage(otherText)).toBeVisible();
    await expect(systemMessage(mainText)).toHaveCount(1);
    expect(
      nameReads.get(`eq.${main.id}`),
      'duplicates and replay must not begin another destination read'
    ).toBe(mainReadsAfterFirst);
    await expect(page).toHaveURL(routeBefore);
    await expect(spectator).toBeVisible();
    await expect(spectator).toHaveAttribute('data-state', /^(open-here|no-seats-here)$/);
    await expect(page.locator('.table-page')).toHaveAttribute('data-hero', 'false');
    await expect(page.locator('.seat--hero')).toHaveCount(0);
    expect(writes).toEqual([]);
    await info.attach('mobile-live-table-seat-move-other', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    evidence.after = await readBuild();
    expect(evidence.after).toEqual(evidence.before);
    Object.assign(evidence, {
      sourceTableId: source.id,
      actorId,
      alias,
      destinations: { main, other },
      rendered: {
        main: await systemMessage(mainText).innerText(),
        other: await systemMessage(otherText).innerText(),
      },
      duplicateAndFreshReplaySuppressed: true,
      routeUnchanged: true,
      spectatorUnchanged: true,
      realIncomingFrames,
      renderedCounts: {
        main: await systemMessage(mainText).count(),
        other: await systemMessage(otherText).count(),
      },
    });
    console.log(
      `SEAT_MOVE_NOTICE_PROOF ${JSON.stringify({ ...evidence, refusedParticipationAttempts: writes })}`
    );

    // A synthetic reserved-account identity tests the deployed diagnostic,
    // not an authoritative seat, natural gameplay or a financial receipt.
    await expect.poll(() => snapshotTemplate !== null).toBe(true);
    const template = snapshotTemplate! as Record<string, any>;
    expect(template.tableId, 'the captured snapshot must belong to the selected subject').toBe(
      source.id
    );
    expect(
      template.state.lightning_observer,
      'a public Lightning observer cannot qualify a classic hero diagnostic'
    ).not.toBe(true);
    const input = structuredClone(template);
    const index = input.state.players.findIndex(
      (player: { user_id?: string }) => player.user_id === actorId
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const seat = input.state.players[index].seat;
    expect(seat).toBeGreaterThanOrEqual(1);
    expect(seat).toBeLessThanOrEqual(9);
    input.state.players[index].user_id = fixtureUserId;
    input.seq = latestSequence + 1;
    // The guard is armed before any synthetic bytes reach the real parser.
    syntheticPhase = true;
    clients.at(-1)!.send(JSON.stringify(input));
    await expect(page.locator(`.seat--hero[data-player-id="${fixtureUserId}"]`)).toHaveCount(1);
    await expect(page.locator('.table-page')).toHaveAttribute('data-hero', 'true');
    // Observe actual committed rendering, not a queued React state update.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    await expect(page.locator(`.seat--hero[data-player-id="${fixtureUserId}"]`)).toHaveAttribute(
      'data-seat-num',
      String(seat)
    );
    expect(heroDiagnostics).toEqual([]);
    await page.evaluate(requestObserverForegroundProbe);
    await page.evaluate(async () => {
      // A nonread against a nonexistent static path proves the HTTP guard
      // without touching any money, seat, telemetry or backend mutation API.
      await fetch('/hub/club-arena/__a14_ui_only_refusal_probe__', {
        method: 'POST',
        body: 'ui-only',
      }).catch(() => undefined);
    });
    await expect.poll(() => refusedSynthetic.websocket).toBeGreaterThan(0);
    expect(refusedSynthetic.http).toBeGreaterThan(0);
    expect(forwardedSyntheticUpstream).toBe(0);
    expect(heroDiagnostics).toEqual([]);
    const afterSynthetic = await readBuild();
    expect(afterSynthetic).toEqual(evidence.before);
    evidence.heroDiagnostic = {
      source: 'synthetic-reserved-row-browser-input',
      actualServedParserMapperAndEffect: true,
      authoritativeSeatReceipt: false,
      naturalSeatedGameplay: false,
      financialReceipt: false,
      originalSeatMoveStageFinishedAsSpectator: true,
      renderedHeroRows: 1,
      diagnosticCount: heroDiagnostics.length,
      refusedUpstreamAttempts: refusedSynthetic,
      forwardedSyntheticUpstream,
      client: afterSynthetic,
    };
  } finally {
    // Keep every write guard armed until the synthetic page is gone. Never
    // resume a real stream or unload handler against its synthetic hero state.
    try {
      if (syntheticPhase) await context.close();
    } finally {
      await info.attach('mobile-live-table-seat-move-rendering', {
        body: Buffer.from(
          JSON.stringify({ ...evidence, refusedParticipationAttempts: writes }, null, 2)
        ),
        contentType: 'application/json',
      });
    }
  }
});
