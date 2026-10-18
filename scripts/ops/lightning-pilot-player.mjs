/** Finite browser witness for an explicitly pinned, already seated pilot horse.
 * No join, buy-in, funding, identity creation or forged telemetry.
 * Consent requires explicit opt-in for the separately owner-authorized exact identity.
 * Horse input continues; only the ordinary UI and authoritative accepted actions count.
 */
import { resolvePilotTarget } from './lightning-pilot-targets.mjs';
const CLUB = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';

const PUBLIC_KEY = 'sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const must = (r) => {
  if (r?.error || !r?.data) throw new Error('Pilot Player Read Unavailable');
  return r.data;
};
export const PLAYER_DEVICES = Object.freeze([
  { name: 'phone', width: 375, height: 812, foldWatch: false },
  { name: 'tablet', width: 768, height: 1024, foldWatch: false },
  { name: 'desktop', width: 1440, height: 900, foldWatch: true },
]);

export function assertPlayerPin(pin) {
  if (
    !pin ||
    !UUID.test(pin.playerId) ||
    !UUID.test(pin.poolSessionId) ||
    pin.clubId !== CLUB ||
    !UUID.test(pin.clusterId)
  )
    throw new Error('Explicit Existing Pilot Player Pin Required');
}

/** Reads only. Repeat immediately before each UI action to reject changed scope. */
export async function validatePlayer(admin, pin) {
  assertPlayerPin(pin);
  const { target } = await resolvePilotTarget(admin, pin.clusterId);
  const profile = must(
    await admin.from('profiles').select('id,is_horse,status').eq('id', pin.playerId).maybeSingle()
  );
  const member = must(
    await admin
      .from('club_members')
      .select('user_id,status,role,chip_balance')
      .eq('club_id', pin.clubId)
      .eq('user_id', pin.playerId)
      .maybeSingle()
  );
  const pool = must(
    await admin
      .from('lightning_pool_session')
      .select('id,cluster_id,player_id,state,exited_at')
      .eq('id', pin.poolSessionId)
      .maybeSingle()
  );
  if (
    profile.id !== pin.playerId ||
    profile.is_horse !== true ||
    profile.status !== 'active' ||
    member.user_id !== pin.playerId ||
    member.status !== 'active' ||
    member.role !== 'player' ||
    !(Number(member.chip_balance) > 0) ||
    pool.player_id !== pin.playerId ||
    pool.cluster_id !== pin.clusterId ||
    pool.state !== 'active' ||
    pool.exited_at !== null
  )
    throw new Error('Existing Funded Active Pilot Player Unavailable');
  return target;
}

export async function openPlayerSession(admin, createClient, url, pin, checkDeadline = () => {}) {
  checkDeadline();
  await validatePlayer(admin, pin);
  checkDeadline();
  const user = must(await admin.auth.admin.getUserById(pin.playerId)).user;
  if (
    user?.id !== pin.playerId ||
    typeof user.email !== 'string' ||
    !user.email.trim() ||
    (user.banned_until &&
      (!Number.isFinite(Date.parse(user.banned_until)) ||
        Date.parse(user.banned_until) > Date.now()))
  )
    throw new Error('Pilot Player Auth Identity Mismatch');
  checkDeadline();
  const link = must(await admin.auth.admin.generateLink({ type: 'magiclink', email: user.email }));
  if (link.user?.id !== pin.playerId || typeof link.properties?.hashed_token !== 'string')
    throw new Error('Pilot Player Link Identity Mismatch');
  checkDeadline();
  const client = createClient(url, PUBLIC_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    checkDeadline();
    const login = must(
      await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'email' })
    );
    checkDeadline();
    const verified = must(await client.auth.getUser()).user;
    if (
      login.user?.id !== pin.playerId ||
      verified?.id !== pin.playerId ||
      login.session?.user?.id !== pin.playerId ||
      !login.session.access_token
    )
      throw new Error('Pilot Player Session Identity Mismatch');
    const sessions = must(await client.rpc('fn_lightning_my_sessions'));
    const rows = Array.isArray(sessions) ? sessions : sessions.rows;
    if (
      !Array.isArray(rows) ||
      !rows.some((r) => r.pool_session_id === pin.poolSessionId && r.cluster_id === pin.clusterId)
    )
      throw new Error('Pilot Player Own Session Unverified');
    checkDeadline();
    return { client, session: login.session };
  } catch {
    const out = await client.auth.signOut({ scope: 'local' }).catch(() => ({ error: true }));
    if (out?.error) throw new Error('Pilot Player Login Refused And Local Cleanup Unverified');
    throw new Error('Pilot Player Login Refused');
  }
}

/** Strictly retain outgoing render identities, never received cards or tokens. */
export function renderHand(payload, poolSessionId) {
  try {
    const f = JSON.parse(String(payload));
    return f.type === 'RENDER_ACK' && f.tableId === poolSessionId && UUID.test(f.hand_id)
      ? f.hand_id
      : null;
  } catch {
    return null;
  }
}

export const CONSENT_PLAYER = '0097309f-2864-4d09-b02b-56bca012a9c3';
export const CONSENT_PLAYERS = Object.freeze([
  CONSENT_PLAYER,
  'a23ca5c9-b748-482f-9b59-9db35f7aa996',
]);
export async function acceptPlayerTerms(
  page,
  session,
  pin,
  url,
  authorized = false,
  remaining = () => 30000
) {
  if (
    typeof authorized !== 'boolean' ||
    (authorized && (!CONSENT_PLAYERS.includes(pin.playerId) || session?.user?.id !== pin.playerId))
  )
    throw new Error('Player Consent Authorization Mismatch');
  await page.waitForFunction(
    () =>
      ['accepted', 'not_accepted', 'unknown'].includes(
        document.querySelector('[data-tos-gate-status]')?.getAttribute('data-tos-gate-status')
      ),
    null,
    { timeout: remaining() }
  );
  const gate = page.locator('[data-tos-gate-status]');
  const status = await gate.getAttribute('data-tos-gate-status', { timeout: remaining() });
  if (status === 'accepted') return { authorized, acceptedNow: false, status: 'accepted' };
  if (status !== 'not_accepted' || !authorized)
    throw new Error('Player Consent Not Authorized Or Unknown');
  const matches = await page.evaluate(
    async ({ base, key, token, id, timeout }) => {
      const response = await fetch(`${base}/auth/v1/user`, {
        headers: { apikey: key, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeout),
      });
      const user = await response.json();
      return response.ok && user.id === id;
    },
    {
      base: url,
      key: PUBLIC_KEY,
      token: session.access_token,
      id: pin.playerId,
      timeout: Math.min(15000, remaining()),
    }
  );
  if (matches !== true) throw new Error('Player Consent Browser Identity Unverified');
  const dialog = page.getByRole('dialog', { name: 'Terms Of Service', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: remaining() });
  await dialog.locator('.tosc__terms').evaluate((terms) => {
    terms.scrollTop = terms.scrollHeight;
    terms.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await dialog
    .getByRole('checkbox', {
      name: 'I Have Read And Agree To The Terms Of Service And Privacy Policy',
      exact: true,
    })
    .check({ timeout: remaining() });
  await dialog
    .getByRole('button', { name: 'Accept & Continue', exact: true })
    .click({ timeout: remaining() });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-tos-gate-status]')?.getAttribute('data-tos-gate-status') ===
      'accepted',
    null,
    { timeout: remaining() }
  );
  if ((await gate.getAttribute('data-tos-gate-status', { timeout: remaining() })) !== 'accepted')
    throw new Error('Player Consent Write Unverified');
  return { authorized: true, acceptedNow: true, status: 'accepted' };
}

export async function witnessPlayer({
  admin,
  createClient,
  chromium,
  url,
  pin,
  timeoutMs = 120000,
  acceptTerms = false,
}) {
  assertPlayerPin(pin);
  if (typeof acceptTerms !== 'boolean' || (acceptTerms && !CONSENT_PLAYERS.includes(pin.playerId)))
    throw new Error('Player Consent Authorization Mismatch');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 240000)
    throw new Error('Bounded Player Witness Timeout Required');
  const deadline = Date.now() + timeoutMs;
  // Reserve twenty seconds for browser closure and local-only session revocation.
  const remaining = () => {
    const ms = deadline - Date.now() - 20000;
    if (ms <= 0) throw new Error('Player Witness Deadline');
    return ms;
  };
  const bounded = async (promise, ms) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Player Witness Deadline')), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const { client, session } = await bounded(
    openPlayerSession(admin, createClient, url, pin, remaining),
    remaining()
  );
  let browser;
  const report = {
    playerId: pin.playerId,
    poolSessionId: pin.poolSessionId,
    clusterId: pin.clusterId,
    status: 'unknown',
    devices: [],
    cleanup: 'pending',
    scope: 'sample_only',
    subphase: 'browser_start',
    cause: 'browser_unavailable',
  };
  try {
    browser = await chromium.launch({ headless: true, timeout: remaining() });
    // Keep the same authenticated browser and existing pool. Mount each viewport
    // afresh: TablePage reads platform capabilities once, when it mounts.
    const context = await bounded(
      browser.newContext({ viewport: { width: 375, height: 812 } }),
      remaining()
    );
    await bounded(
      context.addInitScript(
        ({ session }) => localStorage.setItem('smarter-poker-auth', JSON.stringify(session)),
        { session }
      ),
      remaining()
    );
    const page = await bounded(context.newPage(), remaining());
    let latestHand = null;
    let navigationGeneration = 0;
    page.on('websocket', (ws) => {
      const generation = navigationGeneration;
      ws.on('framesent', ({ payload }) => {
        if (generation !== navigationGeneration) return;
        const hand = renderHand(payload, pin.poolSessionId);
        if (hand) latestHand = hand;
      });
    });
    report.subphase = 'navigation';
    report.cause = 'navigation_unverified';
    await page.goto(`https://smarter.poker/hub/club-arena/table/${pin.poolSessionId}`, {
      waitUntil: 'domcontentloaded',
      timeout: remaining(),
    });
    report.subphase = 'consent';
    report.cause = 'consent_unverified';
    report.consent = await bounded(
      acceptPlayerTerms(page, session, pin, url, acceptTerms, remaining),
      remaining()
    );
    for (const [deviceIndex, device] of PLAYER_DEVICES.entries()) {
      await bounded(validatePlayer(admin, pin), remaining());
      await bounded(
        page.setViewportSize({ width: device.width, height: device.height }),
        remaining()
      );
      if (deviceIndex > 0) {
        // Ordinary reload reconnects the same room, with no join or buy-in.
        // Only a socket created by this document may prove its rendered hand.
        report.subphase = 'device_navigation';
        report.cause = 'device_navigation_unverified';
        navigationGeneration += 1;
        latestHand = null;
        await page.reload({ waitUntil: 'domcontentloaded', timeout: remaining() });
        await bounded(acceptPlayerTerms(page, session, pin, url, false, remaining), remaining());
      }
      const row = { device: device.name, render: 'unknown', layout: 'unknown', actions: [] };
      report.devices.push(row);
      report.subphase = 'viewport_render';
      report.cause = 'viewport_render_unobserved';
      while (!latestHand && remaining() > 0) await page.waitForTimeout(Math.min(100, remaining()));
      row.render = 'observed';
      const layout = await bounded(
        page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        })),
        remaining()
      );
      row.layout =
        Number.isFinite(layout.clientWidth) &&
        layout.clientWidth > 0 &&
        layout.scrollWidth <= layout.clientWidth
          ? 'fits'
          : 'overflow_or_unknown';
      if (row.layout !== 'fits') {
        report.cause = 'viewport_overflow';
        throw new Error('Viewport Overflow');
      }

      // The maintained capability map offers Fold & Watch on desktop only.
      const actions = [['fast_fold', 'lightning-fold']];
      if (device.foldWatch) actions.push(['fold_watch', 'lightning-fold-watch']);
      for (const [kind, selector] of actions) {
        report.subphase = 'player_preflight';
        report.cause = 'player_scope_unverified';
        await bounded(validatePlayer(admin, pin), remaining());
        report.subphase = 'fold_control';
        report.cause = 'fold_control_unavailable';
        const button = page.getByTestId(selector);
        await button.waitFor({ state: 'visible', timeout: remaining() });
        // Trial waits for actionable UI without sending an action.
        await button.click({ trial: true, timeout: remaining() });
        if (!latestHand) throw new Error('Actual Browser Render Unobserved');
        row.render = 'observed';
        const before = latestHand;
        report.subphase = 'fold_request';
        report.cause = 'fold_ack_unverified';
        const responsePromise = page.waitForResponse(
          (r) => {
            if (r.request().method() !== 'POST' || new URL(r.url()).pathname !== '/action')
              return false;
            try {
              const b = r.request().postDataJSON();
              return b.tableId === pin.poolSessionId && b.action === kind;
            } catch {
              return false;
            }
          },
          { timeout: remaining() }
        );
        const [response] = await Promise.all([
          responsePromise,
          button.click({ timeout: remaining() }),
        ]);
        const answer = await bounded(response.json(), remaining());
        const action = {
          kind,
          accepted: response.ok() && answer.success === true,
          nextHand: 'unknown',
        };
        row.actions.push(action);
        if (!action.accepted) {
          report.cause = 'fold_refused';
          throw new Error('Ordinary Player Action Refused');
        }
        // Observe actual next painted hand in this same room; never synthesize an ACK.
        report.subphase = 'next_hand';
        report.cause = 'next_hand_unobserved';
        while (latestHand === before && remaining() > 0)
          await page.waitForTimeout(Math.min(100, remaining()));
        if (latestHand === before) throw new Error('Next Rendered Hand Unobserved');
        action.nextHand = 'observed';
      }
    }
    report.status = 'observed';
    report.subphase = 'complete';
    report.cause = null;
  } catch {
    // Browser exceptions can contain private frame/token data. Retain bounded outcomes only.
    report.status = 'unknown';
  } finally {
    if (browser)
      await bounded(browser.close(), 10000).catch(() => {
        report.status = 'unknown';
        report.cause = 'browser_cleanup_unverified';
      });
    const out = await bounded(client.auth.signOut({ scope: 'local' }), 10000).catch(() => ({
      error: true,
    }));
    report.cleanup = out?.error ? 'unknown' : 'local_session_closed';
    if (out?.error) {
      report.status = 'unknown';
      report.cause = 'local_cleanup_unverified';
    }
  }
  return report;
}
