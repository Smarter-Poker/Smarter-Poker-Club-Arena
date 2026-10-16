/** Finite browser witness for an explicitly pinned, already seated pilot horse.
 * No join, buy-in, funding, identity creation, consent acceptance or forged telemetry.
 * Horse input continues; only the ordinary UI and authoritative accepted actions count.
 */
import { assertPilotClub, PILOT_TARGETS } from './prepare-lightning-private-pilot.mjs';
const CLUB = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
const CLUSTERS = ['babb43f1-368e-406f-a97a-a0d5013648b2', '3330ff9f-76ec-4487-b0c9-fc8ad8c2fdbb'];

const PUBLIC_KEY = 'sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const must = (r) => {
  if (r?.error || !r?.data) throw new Error('Pilot Player Read Unavailable');
  return r.data;
};
export const PLAYER_DEVICES = Object.freeze([
  { name: 'phone', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
]);

export function assertPlayerPin(pin) {
  if (
    !pin ||
    !UUID.test(pin.playerId) ||
    !UUID.test(pin.poolSessionId) ||
    pin.clubId !== CLUB ||
    !CLUSTERS.includes(pin.clusterId)
  )
    throw new Error('Explicit Existing Pilot Player Pin Required');
}

/** Reads only. Repeat immediately before each UI action to reject changed scope. */
export async function validatePlayer(admin, pin) {
  assertPlayerPin(pin);
  const club = must(await admin.from('clubs').select('*').eq('id', pin.clubId).maybeSingle());
  assertPilotClub(club);
  const game = must(
    await admin.from('cash_games').select('*').eq('id', pin.clusterId).maybeSingle()
  );
  const target = PILOT_TARGETS[CLUSTERS.indexOf(pin.clusterId)];
  if (
    game.id !== pin.clusterId ||
    game.club_id !== pin.clubId ||
    game.union_id ||
    game.name !== target.gameName ||
    game.handedness !== target.handedness ||
    Number(game.sb) !== target.sb ||
    Number(game.bb) !== target.bb ||
    game.variant !== 'nlh' ||
    game.enabled !== true ||
    game.must_move !== true ||
    game.ruleset_snapshot?.options?.is_private !== true ||
    game.cluster_mode !== 'lightning' ||
    game.lightning_enabled !== true
  )
    throw new Error('Active Private Pilot Game Unverified');
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
}

export async function openPlayerSession(admin, createClient, url, pin, checkDeadline = () => {}) {
  checkDeadline();
  await validatePlayer(admin, pin);
  checkDeadline();
  const user = must(await admin.auth.admin.getUserById(pin.playerId)).user;
  if (
    user?.id !== pin.playerId ||
    !user.email?.endsWith('@bot.smarter.poker') ||
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

export async function witnessPlayer({
  admin,
  createClient,
  chromium,
  url,
  pin,
  timeoutMs = 120000,
}) {
  assertPlayerPin(pin);
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
    // One document/socket throughout: viewport changes never leave or rejoin the pool.
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
    page.on('websocket', (ws) =>
      ws.on('framesent', ({ payload }) => {
        const hand = renderHand(payload, pin.poolSessionId);
        if (hand) latestHand = hand;
      })
    );
    report.subphase = 'navigation';
    report.cause = 'navigation_unverified';
    await page.goto(`https://smarter.poker/hub/club-arena/table/${pin.poolSessionId}`, {
      waitUntil: 'domcontentloaded',
      timeout: remaining(),
    });
    for (const device of PLAYER_DEVICES) {
      const baseline = latestHand;
      await bounded(
        page.setViewportSize({ width: device.width, height: device.height }),
        remaining()
      );
      const row = { device: device.name, render: 'unknown', layout: 'unknown', actions: [] };
      report.devices.push(row);
      report.subphase = 'viewport_render';
      report.cause = 'viewport_render_unobserved';
      while ((!latestHand || latestHand === baseline) && remaining() > 0)
        await page.waitForTimeout(Math.min(100, remaining()));
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

      for (const [kind, selector] of [
        ['fast_fold', 'lightning-fold'],
        ['fold_watch', 'lightning-fold-watch'],
      ]) {
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
