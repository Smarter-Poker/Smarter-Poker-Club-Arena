/** Explicit private-pilot access witness. Existing designated identities only.
 * No password changes, approval, funding, buy-in, table action or token artifact. */
import { PILOT } from './prepare-lightning-private-pilot.mjs';
export const PILOT_OUTSIDER = '00bc0957-1913-4beb-a4d1-acab94950690';
const PUBLIC_KEY = 'sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx';
const fail = (message) => {
  throw new Error(message);
};
const data = (r, label) => {
  if (r?.error || !r?.data) fail(label);
  return r.data;
};

export async function openDesignatedOutsiderSession(admin, createClient, url) {
  const user = data(
    await admin.auth.admin.getUserById(PILOT_OUTSIDER),
    'Designated Outsider Unavailable'
  ).user;
  if (
    user?.id !== PILOT_OUTSIDER ||
    typeof user.email !== 'string' ||
    !user.email.endsWith('@bot.smarter.poker')
  )
    fail('Designated Outsider Identity Mismatch');
  const link = data(
    await admin.auth.admin.generateLink({ type: 'magiclink', email: user.email }),
    'Synthetic Session Link Unavailable'
  );
  if (link.user?.id !== PILOT_OUTSIDER || typeof link.properties?.hashed_token !== 'string')
    fail('Synthetic Session Link Identity Mismatch');
  const client = createClient(url, PUBLIC_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    const login = data(
      await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'email' }),
      'Synthetic Session Verification Failed'
    );
    const verified = data(
      await client.auth.getUser(),
      'Synthetic Session Identity Unverified'
    ).user;
    if (
      login.user?.id !== PILOT_OUTSIDER ||
      verified?.id !== PILOT_OUTSIDER ||
      login.session?.user?.id !== PILOT_OUTSIDER ||
      !login.session?.access_token
    )
      fail('Synthetic Session Identity Mismatch');
    return { client, session: login.session };
  } catch (error) {
    const out = await client.auth.signOut({ scope: 'local' }).catch(() => ({ error: true }));
    if (out?.error) fail('Synthetic Session Verification And Cleanup Failed');
    throw error;
  }
}

export async function socketAccess(WebSocket, tableId, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://engine.smarter.poker/ws/table/${tableId}`, ['bearer', token], {
      handshakeTimeout: 15000,
    });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      try {
        ws.close();
      } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {}
      finish({ outcome: 'unknown', status: null });
    }, 18000);
    ws.on('open', () => finish({ outcome: 'opened', status: 101 }));
    ws.on('unexpected-response', (_req, response) => {
      const status = response.statusCode;
      response.resume();
      finish({ outcome: 'refused', status });
    });
    ws.on('error', () => finish({ outcome: 'unknown', status: null }));
  });
}

export async function browserAccess(chromium, session, actor, games, url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    await context.addInitScript(
      ({ session }) => {
        localStorage.setItem('smarter-poker-auth', JSON.stringify(session));
      },
      { session }
    );
    const page = await context.newPage();
    const results = [];
    for (const game of games) {
      await page.goto(`https://smarter.poker/hub/club-arena/lightning/${game.id}`, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await page
        .locator('[data-testid="lightning-entry"]')
        .waitFor({ state: 'visible', timeout: 30000 });
      if (!new URL(page.url()).pathname.endsWith(`/lightning/${game.id}`))
        fail('Browser Did Not Stay On The Authenticated Pilot Route');
      await page.waitForFunction(
        ({ actor, name }) => {
          const text = document.querySelector('[data-testid="lightning-entry"]')?.textContent ?? '';
          return actor === 'owner'
            ? Boolean(name && text.includes(name))
            : /Game Unavailable|Not Available|Not A Member|Members Only|Game Is Closed/i.test(text);
        },
        { actor, name: game.name },
        { timeout: 30000 }
      );
      const observed = await page.evaluate(
        async ({ base, key, token, gameId, tableId }) => {
          const headers = { apikey: key, Authorization: `Bearer ${token}` };
          const identity = await fetch(`${base}/auth/v1/user`, {
            headers,
            signal: AbortSignal.timeout(15000),
          });
          const user = await identity.json();
          const read = await fetch(`${base}/rest/v1/cash_games?id=eq.${gameId}&select=id`, {
            headers,
            signal: AbortSignal.timeout(15000),
          });
          const rows = await read.json();
          const socket = await new Promise((resolve) => {
            let finished = false,
              failed = false,
              messages = 0;
            const ws = new WebSocket(`wss://engine.smarter.poker/ws/table/${tableId}`, [
              'bearer',
              token,
            ]);
            const finish = (value) => {
              if (finished) return;
              finished = true;
              clearTimeout(timer);
              try {
                ws.close();
              } catch {}
              resolve({ ...value, messages });
            };
            const timer = setTimeout(
              () => finish({ opened: null, closedCode: null, observedError: failed }),
              18000
            );
            ws.onmessage = () => {
              messages++;
            };
            ws.onerror = () => {
              failed = true;
            };
            ws.onopen = () => finish({ opened: true, closedCode: null, observedError: false });
            ws.onclose = (event) =>
              finish({ opened: false, closedCode: event.code, observedError: failed });
          });
          return {
            socket,
            userId: identity.ok ? user.id : null,
            status: read.status,
            ids: Array.isArray(rows) ? rows.map((x) => x.id) : null,
          };
        },
        {
          base: url,
          key: PUBLIC_KEY,
          token: session.access_token,
          gameId: game.id,
          tableId: game.accessTableIds?.[0],
        }
      );
      if (
        observed.userId !== session.user.id ||
        observed.status !== 200 ||
        !Array.isArray(observed.ids)
      )
        fail('Authenticated Browser Observation Unavailable');
      const entryText = (await page.locator('[data-testid="lightning-entry"]').innerText()).slice(
        0,
        1000
      );
      if (actor === 'outsider' && observed.ids.includes(game.id))
        fail('Outsider Can Discover A Private Pilot Game');
      if (actor === 'owner' && !observed.ids.includes(game.id))
        fail('Owner Cannot Discover Their Private Pilot Game');
      if (
        actor === 'outsider' &&
        !/Game Unavailable|Not Available|Not A Member|Members Only|Game Is Closed/i.test(entryText)
      )
        fail('Outsider Browser Did Not Refuse The Private Route');
      if (actor === 'owner' && observed.socket?.opened !== true)
        fail('Owner Browser Socket Positive Control Failed');
      if (
        actor === 'outsider' &&
        (observed.socket?.opened !== false || observed.socket.messages !== 0)
      )
        fail('Outsider Browser Socket Did Not Remain Closed');
      results.push({
        clusterId: game.id,
        actor,
        browserSocket: observed.socket,
        viewport: 375,
        authenticated: true,
        discovery: observed.ids.includes(game.id) ? 'visible' : 'hidden',
        entry: actor === 'outsider' ? 'refused' : 'rendered',
      });
    }
    await context.close();
    return results;
  } finally {
    await browser.close();
  }
}

export async function runPilotAccess({
  admin,
  player,
  createClient,
  url,
  games,
  operationId,
  requestId,
  chromium,
  WebSocket,
  observeBrowser = browserAccess,
  observeSocket = socketAccess,
}) {
  const report = {
    scope: 'designated_private_pilot_only',
    outsiderId: PILOT_OUTSIDER,
    operationId,
    states: [],
    phase: 'preflight',
    cleanup: { pendingRequest: 'not_created', outsiderSession: 'pending' },
  };
  const clubId = games[0]?.club_id;
  if (
    !clubId ||
    games.some((g) => g.club_id !== clubId || g.ruleset_snapshot?.options?.is_private !== true)
  )
    fail('Private Access Target Scope Invalid');
  const club = data(
    await admin
      .from('clubs')
      .select('id,owner_id,is_public,requires_approval')
      .eq('id', clubId)
      .maybeSingle(),
    'Pilot Access Club Unavailable'
  );
  if (
    club.owner_id !== PILOT.ownerId ||
    club.is_public !== false ||
    club.requires_approval !== true
  )
    fail('Pilot Access Club Identity Invalid');
  const membership = async () => {
    const r = await admin
      .from('club_members')
      .select('status,chip_balance')
      .eq('club_id', clubId)
      .eq('user_id', PILOT_OUTSIDER)
      .maybeSingle();
    if (
      r.error ||
      (r.data !== null &&
        (!r.data ||
          typeof r.data.status !== 'string' ||
          !Number.isFinite(Number(r.data.chip_balance))))
    )
      fail('Outsider Membership Read Unavailable');
    return r.data;
  };
  if (await membership()) fail('Designated Outsider Is Already A Pilot Member');
  const { client, session } = await openDesignatedOutsiderSession(admin, createClient, url);
  let requested = false,
    requestConfirmed = false,
    requestTerminal = false,
    primary;
  try {
    const ownerSession = data(await player.auth.getSession(), 'Owner Session Unavailable').session;
    if (ownerSession?.user?.id !== PILOT.ownerId) fail('Owner Session Identity Invalid');
    const tables = await admin
      .from('tables')
      .select('id,cluster_id')
      .in(
        'cluster_id',
        games.map((g) => g.id)
      )
      .eq('is_deleted', false)
      .eq('lifecycle', 'live');
    if (tables.error || !Array.isArray(tables.data)) fail('Pilot Table Scope Unavailable');
    games = games.map((g) => ({
      ...g,
      accessTableIds: tables.data.filter((t) => t.cluster_id === g.id).map((t) => t.id),
    }));
    report.phase = 'owner_sockets';
    for (const game of games) {
      const own = tables.data.filter((t) => t.cluster_id === game.id);
      if (!own.length) fail('Pilot Has No Live Anchor Table');
      for (const table of own) {
        const owner = await observeSocket(WebSocket, table.id, ownerSession.access_token);
        if (owner.outcome !== 'opened') fail('Owner Socket Positive Control Failed');
        report.states.push({ state: 'owner', tableId: table.id, socket: owner });
      }
    }
    report.phase = 'owner_browser';
    report.browserOwner = await observeBrowser(chromium, ownerSession, 'owner', games, url);
    for (const state of ['nonmember', 'pending']) {
      if (state === 'pending') {
        report.phase = 'pending_membership_request';
        requested = true;
        report.cleanup.pendingRequest = 'pending_or_unknown';
        const joined = data(
          await client.rpc('fn_join_club_atomic', {
            p_identifier: clubId,
            p_request_id: requestId,
            p_referral_code: null,
          }),
          'Pending Membership Request Unavailable'
        );
        requestTerminal = true;
        requestConfirmed = joined.success === true;
        const row = await membership();
        if (joined.success !== true || row?.status !== 'pending' || Number(row.chip_balance) !== 0)
          fail('Pending Membership Did Not Remain Unapproved And Unfunded');
      }
      const row = await membership();
      if (state === 'nonmember' ? row !== null : row?.status !== 'pending')
        fail('Outsider Membership State Changed');
      report.phase = `${state}_browser`;
      const browser = await observeBrowser(chromium, session, 'outsider', games, url);
      report.phase = `${state}_sockets`;
      const sockets = [];
      for (const table of tables.data) {
        const answer = await observeSocket(WebSocket, table.id, session.access_token);
        if (answer.outcome !== 'refused' || answer.status !== 403)
          fail('Outsider Socket Did Not Produce A Confirmed Forbidden Refusal');
        sockets.push({ tableId: table.id, ...answer });
      }
      report.phase = `${state}_joins`;
      const joins = [];
      for (const game of games) {
        const r = await client.rpc('fn_cash_game_join', { p_game_id: game.id });
        if (r.data?.ok === true) {
          await client.rpc('fn_cash_game_leave_waitlist', { p_game_id: game.id });
          fail('Outsider Join Unexpectedly Admitted A Queue Or Seat');
        }
        const prefix = String(r.error?.message ?? r.data?.reason ?? '').split(':')[0];
        if (
          !r.error ||
          !/^(INSUFFICIENT_CHIPS|GAME_NOT_FOUND|NOT_MEMBER|MEMBERSHIP_REQUIRED|NOT_AUTHORIZED|permission denied)/i.test(
            prefix
          )
        )
          fail('Outsider Join Refusal Was Not An Access Or Funding Gate');
        joins.push({
          clusterId: game.id,
          refused: true,
          code: String(r.error.code ?? 'UNKNOWN').slice(0, 20),
          reason: prefix.slice(0, 60),
        });
      }
      report.states.push({ state, browser, sockets, joins, approved: false, funded: false });
    }
  } catch (error) {
    primary = error;
    report.error = 'PRIVATE_ACCESS_PROOF_FAILED_OR_UNKNOWN';
  } finally {
    if (requested) {
      const before = await membership().catch(() => undefined);
      if (before?.status === 'pending' && Number(before.chip_balance) === 0) {
        const cancelled = await client
          .rpc('fn_cancel_club_join_request', { p_club_id: clubId })
          .catch(() => ({ error: true }));
        if (!cancelled.error && (await membership().catch(() => undefined)) === null)
          report.cleanup.pendingRequest = 'removed_and_absence_verified';
        else primary ??= new Error('Pending Membership Cleanup Unverified');
      } else if (before === null && requestTerminal)
        report.cleanup.pendingRequest = requestConfirmed ? 'absent' : 'not_created_refused';
      else if (before === null) {
        report.cleanup.pendingRequest = 'unknown_request_outcome';
        primary ??= new Error('Pending Request Outcome Unknown');
      } else {
        report.cleanup.pendingRequest = 'changed_or_unreadable_no_destructive_cleanup';
        primary ??= new Error('Pending Membership Changed; No Destructive Cleanup Attempted');
      }
    }
    const out = await client.auth.signOut({ scope: 'local' }).catch(() => ({ error: true }));
    report.cleanup.outsiderSession = out?.error ? 'unverified' : 'local_signout_confirmed';
    if (out?.error) primary ??= new Error('Outsider Session Cleanup Failed');
  }
  report.verdict = primary ? 'failed_or_unknown' : 'passed';
  if (primary) {
    const error = new Error(
      `Private Pilot Access Proof Failed At ${report.phase}; Inspect Sanitized Report And Durable Membership State`
    );
    error.pilotAccessReport = report;
    throw error;
  }
  return report;
}
