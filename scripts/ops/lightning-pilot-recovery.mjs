import { selectPoolTab } from './lightning-pilot-selected-pool.mjs';
/** Finite existing-player recovery observations. No joins, wagers, consent or fabricated frames. */
import { recoveryWireObservation, recoveryUiInPage } from './recovery-wire-observation.mjs';
import {
  WITNESS_PLAYERS,
  openPlayerSession,
  validatePlayer,
  renderHand,
} from './lightning-pilot-player.mjs';
import {
  captureRecoveryPhase,
  observeRecoveryPhaseBracket,
} from './recovery-phase-observation.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function recoveryFrame(payload, direction, rooms) {
  try {
    const frame = JSON.parse(String(payload));
    if (!rooms.includes(frame.tableId)) return null;
    if (direction === 'sent') {
      const handId = renderHand(payload, frame.tableId);
      if (handId) return { type: 'RENDER_ACK', room: frame.tableId, handId };
      if (['SUBSCRIBE', 'UNSUBSCRIBE'].includes(frame.type))
        return { type: frame.type, room: frame.tableId };
    } else if (['SUBSCRIBED', 'SNAPSHOT'].includes(frame.type))
      return { type: frame.type, room: frame.tableId };
  } catch {}
  return null;
}
/** Seed only the first same-origin document; a real revocation must stay cleared. */
export function initializeRecoverySession({ session }) {
  if (location.origin !== 'https://smarter.poker') return;
  const marker = 'ca.pilot.recovery.session-initialized';
  if (sessionStorage.getItem(marker)) return;
  localStorage.setItem('smarter-poker-auth', JSON.stringify(session));
  sessionStorage.setItem(marker, 'true');
}

/** Observe the existing consumer, without clearing storage or navigating for it. */
export async function observeRevokedConsumer(page, context, evidence, remaining, room) {
  const transports = evidence.socketsFor(room);
  if (transports.length !== 1) throw new Error('Revoked Consumer Transport Unavailable');
  await context.setOffline(true);
  await evidence.wait(() => transports.every((socket) => socket.closed));
  await context.setOffline(false);
  await page.waitForURL(
    (url) =>
      url.origin === 'https://smarter.poker' &&
      url.pathname === '/auth/login' &&
      url.searchParams.get('authError') === 'no_session',
    { timeout: remaining() }
  );
  const localSessionCleared = await page.evaluate(
    () => localStorage.getItem('smarter-poker-auth') === null
  );
  if (localSessionCleared !== true) throw new Error('Revoked Consumer Session Remains');
  return { redirect: 'observed', localSessionCleared: true };
}

export function recoveryJournal(page, rooms, remaining, playerId) {
  const wire = recoveryWireObservation(rooms, playerId);
  const frames = [],
    sockets = [];
  const waiters = new Set();
  const emit = () => {
    for (const wake of waiters) wake();
  };
  page.on('websocket', (ws) => {
    try {
      const url = new URL(ws.url());
      if (url.hostname !== 'engine.smarter.poker' || !url.pathname.startsWith('/ws')) return;
    } catch {
      return;
    }
    const socket = { closed: false, requested: new Set(), subscribed: new Set() };
    sockets.push(socket);
    ws.on('close', () => {
      socket.closed = true;
      emit();
    });
    for (const [event, direction] of [
      ['framesent', 'sent'],
      ['framereceived', 'received'],
    ]) {
      ws.on(event, ({ payload }) => {
        if (direction === 'received') wire.receive(payload);
        const frame = recoveryFrame(payload, direction, rooms);
        if (frame?.type === 'SUBSCRIBE') socket.requested.add(frame.room);
        if (frame?.type === 'SUBSCRIBED') socket.subscribed.add(frame.room);
        if (frame?.type === 'UNSUBSCRIBE') {
          socket.requested.delete(frame.room);
          socket.subscribed.delete(frame.room);
        }
        if (frame && frames.length < 2000) {
          frames.push({ ...frame, at: Date.now() });
          emit();
        }
      });
    }
  });
  return {
    frames,
    sockets,
    socketsFor(room) {
      return sockets.filter((s) => !s.closed && s.requested.has(room) && s.subscribed.has(room));
    },
    wire,
    async wait(predicate) {
      if (predicate()) return;
      await new Promise((resolve, reject) => {
        const wake = () => {
          if (predicate()) {
            clearTimeout(timer);
            waiters.delete(wake);
            resolve();
          }
        };
        const timer = setTimeout(
          () => {
            waiters.delete(wake);
            reject(new Error('Recovery Observation Deadline'));
          },
          Math.min(15000, remaining())
        );
        waiters.add(wake);
        wake();
      });
    },
    lastHand(room) {
      return (
        frames.filter((f) => f.type === 'RENDER_ACK' && f.room === room).at(-1)?.handId ?? null
      );
    },
  };
}
/** One existing manual SPA route. No join control, scripted navigation or tab eviction. */
async function openOtherPool(page, admin, pin, remaining, progress) {
  progress.step = 'find_existing_pool_tab';
  const existing = page.locator(`[data-tabid="${pin.poolSessionId}"]`);
  const matches = await existing.count();
  if (matches > 1) throw new Error('Manual Pool Tab Ambiguous');
  if (matches === 1) {
    if (!(await existing.isVisible())) {
      progress.step = 'existing_pool_tab_hidden';
      throw new Error('Manual Pool Tab Hidden');
    }
    await selectPoolTab(page, pin, remaining, progress, { input: 'tap' });
    return;
  }
  progress.step = 'open_another_table';
  const add = page.getByRole('button', { name: 'Open Another Table', exact: true });
  if ((await add.count()) !== 1 || !(await add.isVisible())) {
    progress.step = 'open_another_table_unavailable';
    throw new Error('Manual Pool Door Unavailable');
  }
  // The maintained context menu is the desktop equivalent of holding '+'.
  await add.click({ button: 'right', timeout: Math.min(5000, remaining()) });
  progress.step = 'open_lobby';
  await page
    .getByRole('menu', { name: 'Open A New Tab', exact: true })
    .getByRole('button', { name: 'Open Lobby', exact: true })
    .click({ timeout: Math.min(5000, remaining()) });
  progress.step = 'identify_cluster_row';
  const rows = page.locator('tr[data-kind="cash"][data-id]');
  await rows.first().waitFor({ state: 'visible', timeout: Math.min(15000, remaining()) });
  const ids = await rows.evaluateAll((elements) =>
    elements.slice(0, 101).map((e) => e.getAttribute('data-id'))
  );
  if (ids.length === 0 || ids.length > 100 || ids.some((id) => !UUID.test(id)))
    throw new Error('Manual Pool Row Unknown');
  const result = await admin
    .from('tables')
    .select('id,cluster_id,club_id')
    .eq('club_id', pin.clubId)
    .eq('cluster_id', pin.clusterId)
    .in('id', ids)
    .limit(2);
  if (result.error || result.data?.length !== 1) throw new Error('Manual Pool Row Unknown');
  const row = result.data[0];
  if (!ids.includes(row.id) || row.cluster_id !== pin.clusterId || row.club_id !== pin.clubId)
    throw new Error('Manual Pool Row Unknown');
  const lobbyRow = page.locator(`tr[data-kind="cash"][data-id="${row.id}"]`);
  const view = lobbyRow.getByRole('button', { name: /^View Game / });
  if ((await view.count()) === 1 && (await view.isVisible())) {
    progress.step = 'view_existing_game';
    await view.click({ timeout: Math.min(5000, remaining()) });
    return;
  }
  // A lobby without the View Game control (the multi-table Open Lobby) offers a
  // seated player only "Return To <game>", which re-opens the seat the player
  // already holds and buys nothing. Join, Sit Down and Waitlist are never used.
  progress.step = 'return_to_existing_game';
  const back = lobbyRow.getByRole('button', { name: /^Return To / });
  if ((await back.count()) !== 1 || !(await back.isVisible())) {
    // Retain only what kind of controls the row offered: fixed data-act values,
    // disabled and visible flags. No labels, names or other page text.
    progress.rowControls = await lobbyRow
      .locator('button')
      .evaluateAll((els) =>
        els.slice(0, 8).map((e) => ({
          act: ['view', 'join', 'waitlist', 'closed', 'register', 'spinjoin'].includes(
            e.dataset.act
          )
            ? e.dataset.act
            : 'other',
          disabled: e.disabled === true,
          visible: !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length),
        }))
      )
      .catch(() => 'unreadable');
    throw new Error('Manual Pool Door Unavailable');
  }
  await back.click({ timeout: Math.min(5000, remaining()) });
}
export function recoveryDiagnosticBudget(started, timeoutMs, now = Date.now()) {
  return Math.max(1, Math.min(1500, started + timeoutMs - now - 10000));
}
/** Revokes only the synthetic session already opened by this operation. */
export async function observeRevokedSocket(WebSocket, poolSessionId, token, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let ws,
      done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws?.terminate();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish('unknown'), timeoutMs);
    try {
      ws = new WebSocket(
        `wss://engine.smarter.poker/ws/table/${poolSessionId}`,
        ['bearer', token],
        { handshakeTimeout: timeoutMs }
      );
      ws.on('error', () => {});
      ws.on('close', (code) => finish(code === 4401 ? 'auth_refused' : 'unknown'));
      ws.on('message', () => finish('unexpected_message'));
      ws.on('unexpected-response', (_request, response) => {
        response.resume();
        finish('unknown');
      });
    } catch {
      finish('unknown');
    }
  });
}
export async function witnessRecovery({
  admin,
  createClient,
  chromium,
  WebSocket,
  url,
  pins,
  timeoutMs = 240000,
  openSession = openPlayerSession,
  validate = validatePlayer,
  capturePhase = captureRecoveryPhase,
}) {
  const report = {
    scope: 'private_existing_player_recovery_sample',
    status: 'unknown',
    phase: 'preflight',
    touch: [],
    touchProgress: [],
    transportSamples: [],
    navigation: [],
    reconnect: 'unknown',
    phaseBracket: { status: 'unknown', phase: 'unknown' },
    phaseCoverage: { idle: 'unknown', reservation: 'unknown', dealing: 'unknown' },
    sameHand: 'unknown',
    duplicate: 'unknown',
    revoked: 'unknown',
    revokedConsumer: { redirect: 'unknown', localSessionCleared: null },
    recovery: 'unknown',
    cleanup: 'pending',
  };
  const started = Date.now(),
    deadline = started + timeoutMs - 20000;
  let browser, primary, replacement, context, diagnosticPage;
  const journals = [];
  let cleaning = false;
  const clients = new Set(),
    closedClients = new Set();
  const ownedCreateClient = (base, key, options = {}) => {
    remaining();
    const normalFetch = options.global?.fetch ?? fetch;
    const client = createClient(base, key, {
      ...options,
      global: {
        ...options.global,
        fetch: (input, init = {}) =>
          normalFetch(input, {
            ...init,
            signal: AbortSignal.any([
              ...(init.signal ? [init.signal] : []),
              AbortSignal.timeout(
                cleaning ? Math.max(1, started + timeoutMs - Date.now()) : remaining()
              ),
            ]),
          }),
      },
    });
    clients.add(client);
    return client;
  };
  let aborted = false;
  const remaining = () => {
    if (aborted) throw new Error('Deadline');
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error('Deadline');
    return ms;
  };
  const bounded = async (promise, ms) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Deadline')), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 30000 ||
      timeoutMs > 240000 ||
      !Array.isArray(pins) ||
      pins.length !== 2 ||
      !WITNESS_PLAYERS.includes(pins[0].playerId) ||
      pins.some((p) => p.playerId !== pins[0].playerId) ||
      new Set(pins.map((p) => p.poolSessionId)).size !== 2 ||
      new Set(pins.map((p) => p.clusterId)).size !== 2 ||
      pins.some((p) => !UUID.test(p.clusterId) || !UUID.test(p.poolSessionId))
    )
      throw new Error('Scope');
    const work = async () => {
      const targets = [];
      for (const pin of pins) {
        remaining();
        targets.push(await validate(admin, pin));
      }
      if (
        new Set(targets.map((t) => t?.templateName)).size !== 2 ||
        !targets.some((t) => t?.templateName === 'action') ||
        !targets.some((t) => t?.templateName === 'madness')
      )
        throw new Error('Distinct Actual Pilot Targets Required');
      const profile = await admin
        .from('profiles')
        .select('id,club_arena_tos_accepted_at')
        .eq('id', pins[0].playerId)
        .maybeSingle();
      if (
        profile.error ||
        profile.data?.id !== pins[0].playerId ||
        !Number.isFinite(Date.parse(profile.data.club_arena_tos_accepted_at))
      )
        throw new Error('Consent');
      primary = await openSession(admin, ownedCreateClient, url, pins[0], remaining);
      clients.add(primary.client);
      const own = await primary.client.rpc('fn_lightning_my_sessions');
      const rows = Array.isArray(own.data) ? own.data : own.data?.rows;
      if (
        own.error ||
        !Array.isArray(rows) ||
        !pins.every((p) =>
          rows.some((r) => r.pool_session_id === p.poolSessionId && r.cluster_id === p.clusterId)
        )
      )
        throw new Error('Own Sessions');
      remaining();
      browser = await chromium.launch({ headless: true });
      const newPage = async (session) => {
        remaining();
        const c = await browser.newContext({
          viewport: { width: 375, height: 812 },
          hasTouch: true,
        });
        await c.addInitScript(initializeRecoverySession, { session });
        const page = await c.newPage();
        const evidence = recoveryJournal(
          page,
          pins.map((p) => p.poolSessionId),
          remaining,
          pins[0].playerId
        );
        diagnosticPage = page;
        journals.push(evidence);
        return { c, page, evidence };
      };
      const initial = await newPage(primary.session);
      context = initial.c;
      const { page, evidence } = initial;
      report.phase = 'touch';
      for (const [index, pin] of pins.entries()) {
        const progress = { poolSessionId: pin.poolSessionId, step: 'entry_navigation' };
        report.navigation.push(progress);
        if (index === 0) {
          await page.goto(`https://smarter.poker/hub/club-arena/lightning/${pin.clusterId}`, {
            waitUntil: 'domcontentloaded',
            timeout: remaining(),
          });
          await selectPoolTab(page, pin, remaining, progress, { input: 'tap' });
        } else await openOtherPool(page, admin, pin, remaining, progress);
        progress.step = 'first_render';
        await evidence.wait(() => evidence.lastHand(pin.poolSessionId) !== null);
        progress.step = 'rendered';
      }
      for (const device of [
        { name: 'phone', width: 375, height: 812 },
        { name: 'tablet', width: 768, height: 1024 },
      ]) {
        await page.setViewportSize({ width: device.width, height: device.height });
        for (const pin of pins) {
          remaining();
          await validate(admin, pin);
          const progress = {
            device: device.name,
            poolSessionId: pin.poolSessionId,
            step: 'locate_tab',
            matches: 0,
            present: false,
            visible: null,
            selected: null,
          };
          report.touchProgress.push(progress);
          const tab = page.locator(`[data-tabid="${pin.poolSessionId}"]`);
          progress.matches = Math.min(2, await tab.count());
          progress.present = progress.matches === 1;
          if (!progress.present) throw new Error('Manual Tab Missing');
          progress.visible = await tab.isVisible();
          if (!progress.visible) throw new Error('Manual Tab Hidden');
          progress.step = 'tap';
          await tab.tap({ timeout: Math.min(5000, remaining()) });
          progress.step = 'verify_selection';
          progress.selected =
            (await tab.getAttribute('aria-current', { timeout: remaining() })) === 'true';
          if (!progress.selected) throw new Error('Manual Selection');
          progress.step = 'selected';
          report.touch.push({
            device: device.name,
            poolSessionId: pin.poolSessionId,
            manualSelection: 'observed',
          });
        }
      }
      const pin = pins.at(-1),
        beforeHand = evidence.lastHand(pin.poolSessionId),
        oldSockets = evidence.socketsFor(pin.poolSessionId);
      if (!beforeHand || oldSockets.length !== 1) throw new Error('Initial Transport');
      report.phase = 'disconnect';
      let restoredAt;
      // One existing outage, surrounded by actual scoped phase reads.
      // Missing phases remain UNKNOWN; they do not rewrite legacy transport status.
      const observedPhase = await observeRecoveryPhaseBracket({
        capture: () => capturePhase({ admin, player: primary.client, pin, remaining }),
        disconnect: async () => {
          const offlineStartedAt = Date.now();
          await context.setOffline(true);
          await evidence.wait(() => oldSockets.every((s) => s.closed));
          restoredAt = Date.now();
          await context.setOffline(false);
          await evidence.wait(() =>
            ['SUBSCRIBE', 'SUBSCRIBED', 'SNAPSHOT', 'RENDER_ACK'].every((type) =>
              evidence.frames.some(
                (f) => f.type === type && f.room === pin.poolSessionId && f.at >= restoredAt
              )
            )
          );
          return { offlineStartedAt, onlineStartedAt: restoredAt };
        },
      });
      report.phaseBracket = observedPhase.bracket;
      report.phaseCoverage = observedPhase.coverage;
      const subscriptions = evidence.frames.filter(
        (f) => f.type === 'SUBSCRIBED' && f.room === pin.poolSessionId && f.at >= restoredAt
      );
      if (subscriptions.length !== 1 || evidence.socketsFor(pin.poolSessionId).length !== 1)
        throw new Error('Reconnect Ownership');
      report.reconnect = 'observed';
      report.sameHand =
        evidence.lastHand(pin.poolSessionId) === beforeHand ? 'observed' : 'not_observed';
      report.phase = 'duplicate';
      const duplicate = await newPage(primary.session);
      const duplicateProgress = {
        context: 'duplicate',
        poolSessionId: pin.poolSessionId,
        step: 'entry_navigation',
      };
      report.navigation.push(duplicateProgress);
      await duplicate.page.goto(`https://smarter.poker/hub/club-arena/table/${pin.poolSessionId}`, {
        waitUntil: 'domcontentloaded',
        timeout: remaining(),
      });
      await selectPoolTab(duplicate.page, pin, remaining, duplicateProgress, { input: 'tap' });
      duplicateProgress.step = 'first_render';
      await duplicate.evidence.wait(() => duplicate.evidence.lastHand(pin.poolSessionId) !== null);
      duplicateProgress.step = 'rendered';
      await validate(admin, pin);
      report.duplicate = 'second_connection_rendered_same_pool';
      await duplicate.c.close();
      report.phase = 'local_revoke';
      const out = await primary.client.auth.signOut({ scope: 'local' });
      if (out?.error) throw new Error('Revoke Unverified');
      primary.closed = true;
      closedClients.add(primary.client);
      report.revoked = await observeRevokedSocket(
        WebSocket,
        pin.poolSessionId,
        primary.session.access_token,
        Math.min(10000, remaining())
      );
      if (report.revoked !== 'auth_refused') throw new Error('Revoked Refusal Unverified');
      report.phase = 'revoked_consumer';
      report.revokedConsumer = await observeRevokedConsumer(
        page,
        context,
        evidence,
        remaining,
        pin.poolSessionId
      );
      await context.close();
      context = null;
      remaining();
      report.phase = 'session_recovery';
      replacement = await openSession(admin, ownedCreateClient, url, pin, remaining);
      clients.add(replacement.client);
      const recovered = await newPage(replacement.session);
      const recoveredProgress = {
        context: 'replacement',
        poolSessionId: pin.poolSessionId,
        step: 'entry_navigation',
      };
      report.navigation.push(recoveredProgress);
      await recovered.page.goto(`https://smarter.poker/hub/club-arena/table/${pin.poolSessionId}`, {
        waitUntil: 'domcontentloaded',
        timeout: remaining(),
      });
      await selectPoolTab(recovered.page, pin, remaining, recoveredProgress, { input: 'tap' });
      recoveredProgress.step = 'first_render';
      await recovered.evidence.wait(() => recovered.evidence.lastHand(pin.poolSessionId) !== null);
      recoveredProgress.step = 'rendered';
      await validate(admin, pin);
      remaining();
      report.recovery = 'new_local_session_same_pool_rendered';
      report.status = 'observed';
      report.phase = 'complete';
    };
    await bounded(work(), remaining());
  } catch {
    aborted = true;
    report.status = 'unknown';
    report.errorCode = 'RECOVERY_SCOPE_OR_OBSERVATION_UNAVAILABLE';
    if (diagnosticPage) {
      try {
        report.ui = await bounded(
          diagnosticPage.evaluate(recoveryUiInPage),
          recoveryDiagnosticBudget(started, timeoutMs)
        );
      } catch {
        report.ui = { route: 'unavailable' };
      }
    }
  } finally {
    report.transportSamples = journals.map((j) => ({
      sockets: j.sockets.length,
      openSocketsBeforeCleanup: j.sockets.filter((s) => !s.closed).length,
      roomSocketCounts: pins.map((p) => ({
        poolSessionId: p.poolSessionId,
        openOwners: j.socketsFor(p.poolSessionId).length,
      })),
      frames: ['SUBSCRIBE', 'SUBSCRIBED', 'SNAPSHOT', 'RENDER_ACK'].map((type) => ({
        type,
        count: j.frames.filter((f) => f.type === type).length,
      })),
      wire: j.wire.summary(),
    }));
    cleaning = true;
    const cleanupDeadline = started + timeoutMs;
    let clean = true;
    const cleanStep = async (action) => {
      try {
        await bounded(action(), Math.max(1, cleanupDeadline - Date.now()));
      } catch {
        clean = false;
      }
    };
    if (browser) await cleanStep(() => browser.close());
    for (const client of clients)
      if (!closedClients.has(client))
        await cleanStep(async () => {
          const out = await client.auth.signOut({ scope: 'local' });
          if (out?.error) throw new Error('Cleanup');
        });
    report.cleanup = clean ? 'local_sessions_and_browser_closed' : 'unknown';
    if (!clean) report.status = 'unknown';
  }
  return report;
}
