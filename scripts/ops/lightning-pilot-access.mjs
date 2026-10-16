/** Explicit private-pilot access witness. Existing designated identities only.
 * No password changes, approval, funding, buy-in, table action or token artifact. */
import { PILOT } from './prepare-lightning-private-pilot.mjs';
// Owner authorized selecting a replacement on 2026-10-15 after the original
// designation proved to be a funded member. Verified active internal horse,
// no pilot membership, no active cash seat and no club memberships at selection.
export const PILOT_OUTSIDER = '23040e91-e0d0-430d-b18e-f9f67c385d90';
const PUBLIC_KEY = 'sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx';
const fail = (message) => {
  throw new Error(message);
};
// Supabase RPC builders are thenables, not promises with .catch().
const safely = async (operation) => {
  try {
    const answer = await operation();
    return answer && typeof answer === 'object' ? answer : { error: true };
  } catch {
    return { error: true };
  }
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
    const out = await safely(() => client.auth.signOut({ scope: 'local' }));
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

/** Owner-authorized consent, only for the pinned existing synthetic identity. */
export async function acceptDesignatedTerms(page, session, actor, url, authorized = false) {
  if (authorized === false) return { authorized: false, acceptedNow: false };
  if (authorized !== true) fail('Consent Authorization Must Be Explicit');
  if (actor !== 'outsider' || session?.user?.id !== PILOT_OUTSIDER)
    fail('Consent Authorization Does Not Match The Designated Outsider');
  await page.waitForFunction(
    () => {
      const status = document
        .querySelector('[data-tos-gate-status]')
        ?.getAttribute('data-tos-gate-status');
      return status === 'accepted' || status === 'not_accepted' || status === 'unknown';
    },
    null,
    { timeout: 30000 }
  );
  const gate = page.locator('[data-tos-gate-status]');
  const status = await gate.getAttribute('data-tos-gate-status');
  if (status === 'accepted') return { authorized: true, acceptedNow: false, status: 'accepted' };
  if (status !== 'not_accepted') fail('Designated Outsider Consent Status Unavailable');
  const identityMatches = await page.evaluate(
    async ({ base, key, token, id }) => {
      const response = await fetch(`${base}/auth/v1/user`, {
        headers: { apikey: key, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      });
      const user = await response.json();
      return response.ok && user.id === id;
    },
    { base: url, key: PUBLIC_KEY, token: session.access_token, id: PILOT_OUTSIDER }
  );
  if (identityMatches !== true) fail('Designated Outsider Consent Identity Unverified');
  const dialog = page.getByRole('dialog', { name: 'Terms Of Service', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: 30000 });
  await dialog.locator('.tosc__terms').evaluate((terms) => {
    terms.scrollTop = terms.scrollHeight;
    terms.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await dialog
    .getByRole('checkbox', {
      name: 'I Have Read And Agree To The Terms Of Service And Privacy Policy',
      exact: true,
    })
    .check();
  await dialog.getByRole('button', { name: 'Accept & Continue', exact: true }).click();
  // The owning gate changes only after the normal authenticated endpoint confirms its write.
  await page.waitForFunction(
    () =>
      document.querySelector('[data-tos-gate-status]')?.getAttribute('data-tos-gate-status') ===
      'accepted',
    null,
    { timeout: 30000 }
  );
  if ((await gate.getAttribute('data-tos-gate-status')) !== 'accepted')
    fail('Designated Outsider Consent Acceptance Unverified');
  return { authorized: true, acceptedNow: true, status: 'accepted' };
}

export async function browserAccess(chromium, session, actor, games, url, acceptTerms = false) {
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
      const diagnostic = {
        clusterId: game.id,
        subphase: 'navigation',
        cause: 'navigation_failed',
        path: 'unknown',
        entryVisible: null,
        refusalVisible: null,
        identityMatches: null,
        readStatus: null,
        discoveryVisible: null,
        socketOutcome: 'unknown',
        consentAuthorized: acceptTerms === true,
        consentAcceptedNow: false,
        consentStatus: 'unknown',
      };
      const refuse = (message, cause) => {
        diagnostic.cause = cause;
        fail(message);
      };
      try {
        await page.goto(`https://smarter.poker/hub/club-arena/lightning/${game.id}`, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        diagnostic.subphase = 'consent';
        diagnostic.cause = 'consent_unverified';
        const consent = await acceptDesignatedTerms(page, session, actor, url, acceptTerms);
        diagnostic.consentAcceptedNow = consent.acceptedNow;
        diagnostic.consentStatus = consent.status === 'accepted' ? 'accepted' : 'not_requested';
        diagnostic.subphase = 'entry_locator';
        diagnostic.cause = 'entry_locator_failed';
        await page
          .locator('[data-testid="lightning-entry"]')
          .waitFor({ state: 'visible', timeout: 30000 });
        diagnostic.entryVisible = true;
        diagnostic.subphase = 'route';
        diagnostic.cause = 'route_mismatch';
        diagnostic.path = new URL(page.url()).pathname.endsWith(`/lightning/${game.id}`)
          ? 'expected_pilot'
          : 'other';
        if (diagnostic.path !== 'expected_pilot')
          refuse('Browser Did Not Stay On The Authenticated Pilot Route', 'route_mismatch');
        diagnostic.subphase = 'entry_content';
        diagnostic.cause =
          actor === 'outsider' ? 'refusal_not_observed' : 'owner_content_not_observed';
        await page.waitForFunction(
          ({ actor, name }) => {
            const text =
              document.querySelector('[data-testid="lightning-entry"]')?.textContent ?? '';
            return actor === 'owner'
              ? Boolean(name && text.includes(name))
              : /Game Unavailable|Not Available|Not A Member|Members Only|Game Is Closed/i.test(
                  text
                );
          },
          { actor, name: game.name },
          { timeout: 30000 }
        );
        diagnostic.subphase = 'authenticated_observation';
        diagnostic.cause = 'observation_failed';
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
        diagnostic.identityMatches = observed.userId === session.user.id;
        diagnostic.readStatus =
          Number.isInteger(observed.status) && observed.status >= 100 && observed.status <= 599
            ? observed.status
            : null;
        diagnostic.discoveryVisible = Array.isArray(observed.ids)
          ? observed.ids.includes(game.id)
          : null;
        diagnostic.socketOutcome =
          observed.socket?.opened === true
            ? 'opened'
            : observed.socket?.opened === false
              ? 'closed'
              : 'unknown';
        diagnostic.subphase = 'identity_and_discovery';
        if (
          observed.userId !== session.user.id ||
          observed.status !== 200 ||
          !Array.isArray(observed.ids)
        )
          refuse('Authenticated Browser Observation Unavailable', 'identity_or_read_unverified');
        const entryText = (await page.locator('[data-testid="lightning-entry"]').innerText()).slice(
          0,
          1000
        );
        diagnostic.refusalVisible =
          /Game Unavailable|Not Available|Not A Member|Members Only|Game Is Closed/i.test(
            entryText
          );
        if (actor === 'outsider' && observed.ids.includes(game.id))
          refuse('Outsider Can Discover A Private Pilot Game', 'private_discovery_visible');
        if (actor === 'owner' && !observed.ids.includes(game.id))
          refuse('Owner Cannot Discover Their Private Pilot Game', 'owner_discovery_missing');
        if (
          actor === 'outsider' &&
          !/Game Unavailable|Not Available|Not A Member|Members Only|Game Is Closed/i.test(
            entryText
          )
        )
          refuse('Outsider Browser Did Not Refuse The Private Route', 'refusal_not_observed');
        diagnostic.subphase = 'socket_assertion';
        if (actor === 'owner' && observed.socket?.opened !== true)
          refuse('Owner Browser Socket Positive Control Failed', 'owner_socket_not_opened');
        if (
          actor === 'outsider' &&
          (observed.socket?.opened !== false || observed.socket.messages !== 0)
        )
          refuse('Outsider Browser Socket Did Not Remain Closed', 'outsider_socket_not_closed');
        results.push({
          clusterId: game.id,
          actor,
          browserSocket: observed.socket,
          viewport: 375,
          consent,
          authenticated: true,
          discovery: observed.ids.includes(game.id) ? 'visible' : 'hidden',
          entry: actor === 'outsider' ? 'refused' : 'rendered',
        });
      } catch {
        // Retain only enumerated context. Browser errors can contain tokens or URLs.
        try {
          diagnostic.path = new URL(page.url()).pathname.endsWith(`/lightning/${game.id}`)
            ? 'expected_pilot'
            : 'other';
          const visibility = await page.evaluate(() => {
            const entry = document.querySelector('[data-testid="lightning-entry"]');
            return {
              entryVisible: Boolean(entry && entry.getClientRects().length),
              refusalVisible: Boolean(
                entry &&
                /Game Unavailable|Not Available|Not A Member|Members Only|Game Is Closed/i.test(
                  entry.textContent ?? ''
                )
              ),
            };
          });
          if (typeof visibility?.entryVisible === 'boolean')
            diagnostic.entryVisible = visibility.entryVisible;
          if (typeof visibility?.refusalVisible === 'boolean')
            diagnostic.refusalVisible = visibility.refusalVisible;
        } catch {}
        const sanitized = new Error('Private Pilot Browser Observation Failed');
        sanitized.browserDiagnostic = diagnostic;
        throw sanitized;
      }
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
  acceptOutsiderTerms = false,
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
      .select('club_id,user_id,joined_at,status,chip_balance')
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
  const initialMembership = await membership();
  let recoveryOnly = false;
  if (initialMembership) {
    const row = initialMembership;
    let owned = false;
    if (row.status === 'pending' && Number(row.chip_balance) === 0) {
      const receipt = await safely(() =>
        admin
          .from('club_join_idempotency')
          .select('user_id,request_id,club_id,result')
          .eq('user_id', PILOT_OUTSIDER)
          .eq('request_id', requestId)
          .eq('club_id', clubId)
          .maybeSingle()
      );
      const saved = receipt.data,
        result = saved?.result,
        member = result?.membership;
      owned =
        !receipt.error &&
        saved?.user_id === PILOT_OUTSIDER &&
        saved.request_id === requestId &&
        saved.club_id === clubId &&
        result?.success === true &&
        result.status === 'pending' &&
        result.club?.id === clubId &&
        row.club_id === clubId &&
        row.user_id === PILOT_OUTSIDER &&
        member?.club_id === clubId &&
        member.user_id === PILOT_OUTSIDER &&
        member.status === 'pending' &&
        Number(member.chip_balance) === 0 &&
        typeof row.joined_at === 'string' &&
        row.joined_at.length > 0 &&
        member.joined_at === row.joined_at;
    }
    if (!owned) {
      report.phase = 'startup_membership_refused';
      report.verdict = 'failed_or_unknown';
      report.cleanup.pendingRequest = 'unowned_or_changed_no_cancellation';
      report.cleanup.outsiderSession = 'not_created';
      const error = new Error('Existing Membership Does Not Match This Owned Pending Operation');
      error.pilotAccessReport = report;
      throw error;
    }
    recoveryOnly = true;
  }
  const { client, session } = await openDesignatedOutsiderSession(admin, createClient, url);
  let requested = false,
    requestConfirmed = false,
    requestTerminal = false,
    primary;
  try {
    if (recoveryOnly) {
      report.phase = 'startup_owned_pending_recovery';
      report.cleanup.pendingRequest = 'owned_pending_cancel_requested';
      const cancelled = await safely(() =>
        client.rpc('fn_cancel_club_join_request', { p_club_id: clubId })
      );
      const after = await membership().catch(() => undefined);
      report.cleanup.pendingRequest =
        after === null
          ? cancelled.error
            ? 'absent_after_unknown_reply'
            : 'removed_and_absence_verified'
          : 'owned_pending_cleanup_unverified';
      fail('Owned Pending Membership Recovery Only; A Fresh Operation Is Required For Proof');
    }
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
    report.poolStatusOwner = [];
    report.phase = 'owner_pool_status';
    for (const game of games) {
      const observation = { clusterId: game.id, outcome: 'unknown' };
      report.poolStatusOwner.push(observation);
      const reply = await safely(() =>
        player.rpc('fn_lightning_pool_status', { p_cluster_id: game.id })
      );
      const value = reply.data;
      if (
        !reply.error &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Number.isInteger(value.players) &&
        value.players >= 0 &&
        typeof value.joinable === 'boolean' &&
        value.multi_table_limit !== null &&
        typeof value.multi_table_limit === 'object' &&
        !Array.isArray(value.multi_table_limit) &&
        ['HOT', 'ACTIVE', 'THIN', 'BUILDING'].includes(value.status)
      )
        observation.outcome = 'positive';
      if (observation.outcome !== 'positive')
        fail('Owner Pool Status Positive Control Unavailable');
    }
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
      const stateObservation = {
        state,
        browser: null,
        sockets: [],
        joins: [],
        poolStatus: [],
        approved: false,
        funded: false,
      };
      report.states.push(stateObservation);
      report.phase = `${state}_pool_status`;
      for (const game of games) {
        const observation = { clusterId: game.id, outcome: 'unknown' };
        stateObservation.poolStatus.push(observation);
        const reply = await safely(() =>
          client.rpc('fn_lightning_pool_status', { p_cluster_id: game.id })
        );
        if (!reply.error && reply.data === null) observation.outcome = 'refused';
        else if (!reply.error && reply.data !== undefined) observation.outcome = 'exposed';
        if (observation.outcome !== 'refused')
          fail('Outsider Private Pool Status Refusal Unverified');
      }
      report.phase = `${state}_browser`;
      const browser = await observeBrowser(
        chromium,
        session,
        'outsider',
        games,
        url,
        acceptOutsiderTerms
      );
      stateObservation.browser = browser;
      report.phase = `${state}_sockets`;
      const sockets = stateObservation.sockets;
      for (const table of tables.data) {
        const answer = await observeSocket(WebSocket, table.id, session.access_token);
        if (answer.outcome !== 'refused' || answer.status !== 403)
          fail('Outsider Socket Did Not Produce A Confirmed Forbidden Refusal');
        sockets.push({ tableId: table.id, ...answer });
      }
      report.phase = `${state}_joins`;
      const joins = stateObservation.joins;
      for (const game of games) {
        const diagnostic = {
          clusterId: game.id,
          ok: null,
          errorSQLSTATE: 'UNKNOWN',
          reason: 'UNAVAILABLE',
          admittedAction: 'UNKNOWN',
          cleanup: 'not_requested',
          refused: false,
        };
        joins.push(diagnostic);
        const r = await client.rpc('fn_cash_game_join', { p_game_id: game.id });
        diagnostic.ok = typeof r.data?.ok === 'boolean' ? r.data.ok : null;
        diagnostic.errorSQLSTATE =
          typeof r.error?.code === 'string' && /^[A-Z0-9]{5}$/.test(r.error.code)
            ? r.error.code
            : 'UNKNOWN';
        const rawReason = String(r.error?.message ?? r.data?.reason ?? '').split(':')[0];
        const reasons = [
          'PRIVATE_MEMBERSHIP_REQUIRED',
          'INSUFFICIENT_CHIPS',
          'GAME_NOT_FOUND',
          'NOT_MEMBER',
          'MEMBERSHIP_REQUIRED',
          'NOT_AUTHORIZED',
        ];
        diagnostic.reason =
          reasons.find((code) => rawReason.toUpperCase().startsWith(code)) ??
          (/^permission denied/i.test(rawReason) ? 'PERMISSION_DENIED' : 'UNRECOGNIZED');
        const action = r.data?.action ?? r.data?.status;
        diagnostic.admittedAction = ['seated', 'seat', 'waitlisted'].includes(action)
          ? action
          : 'UNKNOWN';
        if (r.data?.ok === true) {
          const cleanup = await safely(() =>
            client.rpc('fn_cash_game_leave_waitlist', { p_game_id: game.id })
          );
          diagnostic.cleanup =
            !cleanup.error && (cleanup.data === true || cleanup.data?.ok === true)
              ? 'reply_ok'
              : 'reply_refused_or_unknown';
          fail('Outsider Join Unexpectedly Admitted A Queue Or Seat');
        }
        const prefix = String(r.error?.message ?? r.data?.reason ?? '').split(':')[0];
        if (
          !r.error ||
          (/^PRIVATE_MEMBERSHIP_REQUIRED/i.test(prefix) &&
            (prefix !== 'PRIVATE_MEMBERSHIP_REQUIRED' || r.error.code !== '42501')) ||
          !/^(PRIVATE_MEMBERSHIP_REQUIRED|INSUFFICIENT_CHIPS|GAME_NOT_FOUND|NOT_MEMBER|MEMBERSHIP_REQUIRED|NOT_AUTHORIZED|permission denied)/i.test(
            prefix
          )
        )
          fail('Outsider Join Refusal Was Not An Access Or Funding Gate');
        diagnostic.refused = true;
      }
    }
  } catch (error) {
    primary = error;
    report.error = 'PRIVATE_ACCESS_PROOF_FAILED_OR_UNKNOWN';
    if (error?.browserDiagnostic) report.browserDiagnostic = error.browserDiagnostic;
  } finally {
    if (requested) {
      const before = await membership().catch(() => undefined);
      if (before?.status === 'pending' && Number(before.chip_balance) === 0) {
        const cancelled = await safely(() =>
          client.rpc('fn_cancel_club_join_request', { p_club_id: clubId })
        );
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
    const out = await safely(() => client.auth.signOut({ scope: 'local' }));
    report.cleanup.outsiderSession = out?.error ? 'unverified' : 'local_signout_confirmed';
    if (out?.error) primary ??= new Error('Outsider Session Cleanup Failed');
  }
  report.verdict = recoveryOnly ? 'cleanup_only' : primary ? 'failed_or_unknown' : 'passed';
  if (primary) {
    const error = new Error(
      `Private Pilot Access Proof Failed At ${report.phase}; Inspect Sanitized Report And Durable Membership State`
    );
    error.pilotAccessReport = report;
    throw error;
  }
  return report;
}
