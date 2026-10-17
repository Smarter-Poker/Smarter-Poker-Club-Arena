/** One explicit normal UI admission for the owner-authorized existing pilot member.
 * No funding, roster, activity-policy or direct buy-in RPC writes. Unknown writes
 * are reconciled once through their real receipt; a new intent is never sent.
 */
import { acceptPlayerTerms } from './lightning-pilot-player.mjs';
import { resolvePilotTarget } from './lightning-pilot-targets.mjs';
export const ADMISSION_PLAYER = 'a23ca5c9-b748-482f-9b59-9db35f7aa996';
const CLUB = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
const KEY = 'sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const must = (r) => {
  if (r?.error || r?.data == null) throw new Error('Read Unavailable');
  return r.data;
};
const finite = (v) => v !== null && v !== '' && Number.isFinite(Number(v));
const rpcPath = (request, name) => {
  try {
    return (
      request.method() === 'POST' && new URL(request.url()).pathname === `/rest/v1/rpc/${name}`
    );
  } catch {
    return false;
  }
};
export function admissionReceiptMatches(p, reply) {
  const r = reply?.request;
  return (
    reply?.status === 'confirmed' &&
    !!r &&
    r.door === 'atomic_table_buyin' &&
    r.user_id === p.p_user_id &&
    r.table_id === p.p_table_id &&
    r.seat_number === p.p_seat_number &&
    r.amount === p.p_amount &&
    r.auto_rebuy === p.p_auto_rebuy &&
    r.club_id === p.p_club_id
  );
}
async function scope(admin, pin) {
  await resolvePilotTarget(admin, pin.clusterId);
  const profile = must(
    await admin.from('profiles').select('id,is_horse,status').eq('id', pin.playerId).maybeSingle()
  );
  const member = must(
    await admin
      .from('club_members')
      .select('user_id,status,role,chip_balance')
      .eq('club_id', CLUB)
      .eq('user_id', pin.playerId)
      .maybeSingle()
  );
  if (
    profile.id !== pin.playerId ||
    profile.is_horse !== true ||
    profile.status !== 'active' ||
    member.user_id !== pin.playerId ||
    member.status !== 'active' ||
    member.role !== 'player' ||
    !finite(member.chip_balance) ||
    Number(member.chip_balance) <= 0
  )
    throw new Error('Funded Active Member Required');
  return Number(member.chip_balance);
}
export async function readAdmissionPool(admin, pin) {
  const rows = must(
    await admin
      .from('lightning_pool_session')
      .select('id,cluster_id,player_id,state,exited_at,cash_player_session_id,anchor_seat_id')
      .eq('cluster_id', pin.clusterId)
      .eq('player_id', pin.playerId)
      .eq('state', 'active')
      .is('exited_at', null)
  );
  if (!Array.isArray(rows) || rows.length > 1) throw new Error('Ambiguous Pool');
  if (!rows.length) return null;
  const p = rows[0];
  if (
    !UUID.test(p.id) ||
    p.player_id !== pin.playerId ||
    p.cluster_id !== pin.clusterId ||
    p.state !== 'active' ||
    p.exited_at !== null ||
    !UUID.test(p.cash_player_session_id) ||
    !UUID.test(p.anchor_seat_id)
  )
    throw new Error('Pool Identity');
  const seat = must(
    await admin
      .from('table_seats')
      .select('id,user_id,club_id,table_id,left_at')
      .eq('id', p.anchor_seat_id)
      .maybeSingle()
  );
  if (
    seat.id !== p.anchor_seat_id ||
    seat.user_id !== pin.playerId ||
    seat.club_id !== CLUB ||
    seat.left_at !== null ||
    !UUID.test(seat.table_id)
  )
    throw new Error('Anchor Identity');
  const table = must(
    await admin.from('tables').select('id,cluster_id').eq('id', seat.table_id).maybeSingle()
  );
  if (table.id !== seat.table_id || table.cluster_id !== pin.clusterId)
    throw new Error('Anchor Cluster');
  const cash = must(
    await admin
      .from('cash_player_session')
      .select('id,player_id,club_id,scope_type,scope_id,table_id,cluster_id,closed_at')
      .eq('id', p.cash_player_session_id)
      .maybeSingle()
  );
  // The promised cluster-scope cutover never happened: 20260920172736 keeps
  // the existing table scope and adds cluster_id as its durable cluster key.
  if (
    cash.id !== p.cash_player_session_id ||
    cash.player_id !== pin.playerId ||
    cash.club_id !== CLUB ||
    cash.scope_type !== 'table' ||
    cash.scope_id !== cash.table_id ||
    cash.table_id !== seat.table_id ||
    cash.cluster_id !== pin.clusterId ||
    cash.closed_at !== null
  )
    throw new Error('Cash Session Identity');
  return { poolSessionId: p.id, cashPlayerSessionId: p.cash_player_session_id };
}

export async function witnessAdmission({
  admin,
  createClient,
  chromium,
  url,
  pin,
  acceptTerms = false,
  timeoutMs = 240000,
  withAdmittedSession,
  validateScope = scope,
  readOwnPool = readAdmissionPool,
}) {
  const report = {
    status: 'unknown',
    phase: 'scope',
    playerId: ADMISSION_PLAYER,
    clusterId: null,
    join: { outcome: 'not_requested', tableId: null },
    buyIn: { outcome: 'not_requested', requestId: null, receipt: 'not_read' },
    pool: null,
    walletBefore: null,
    walletAfter: null,
    cleanup: 'pending',
    scope: 'normal_ui_admission_sample',
  };
  let client, browser, context;
  let cleaning = false;
  const end = Date.now() + timeoutMs;
  const remaining = () => {
    const ms = end - Date.now() - 20000;
    if (ms <= 0) throw new Error('Deadline');
    return ms;
  };
  const bound = async (p, ms = remaining()) => {
    let timer;
    try {
      return await Promise.race([
        p,
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
      pin?.playerId !== ADMISSION_PLAYER ||
      pin.clubId !== CLUB ||
      !UUID.test(pin.clusterId) ||
      typeof acceptTerms !== 'boolean' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 30000 ||
      timeoutMs > 240000
    )
      throw new Error('Scope');
    report.clusterId = pin.clusterId;
    report.walletBefore = await bound(validateScope(admin, pin));
    const initialPool = await bound(readOwnPool(admin, pin));
    report.phase = 'authentication';
    const user = must(await bound(admin.auth.admin.getUserById(pin.playerId))).user;
    if (
      user?.id !== pin.playerId ||
      !user.email?.endsWith('@bot.smarter.poker') ||
      (user.banned_until &&
        (!Number.isFinite(Date.parse(user.banned_until)) ||
          Date.parse(user.banned_until) > Date.now()))
    )
      throw new Error('Identity');
    const link = must(
      await bound(admin.auth.admin.generateLink({ type: 'magiclink', email: user.email }))
    );
    if (link.user?.id !== pin.playerId || typeof link.properties?.hashed_token !== 'string')
      throw new Error('Identity');
    client = createClient(url, KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init = {}) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.any([
              ...(init.signal ? [init.signal] : []),
              AbortSignal.timeout(cleaning ? Math.max(1, end - Date.now()) : remaining()),
            ]),
          }),
      },
    });
    const login = must(
      await bound(
        client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'email' })
      )
    );
    const userRead = must(await bound(client.auth.getUser())).user;
    if (
      login.user?.id !== pin.playerId ||
      login.session?.user?.id !== pin.playerId ||
      userRead?.id !== pin.playerId ||
      !login.session.access_token
    )
      throw new Error('Identity');
    const session = login.session;
    browser = await bound(chromium.launch({ headless: true }));
    context = await bound(browser.newContext({ viewport: { width: 375, height: 812 } }));
    await bound(
      context.addInitScript(
        ({ session }) => {
          if (location.origin !== 'https://smarter.poker') return;
          if (!sessionStorage.getItem('lightning-admission-session-initialized')) {
            localStorage.setItem('smarter-poker-auth', JSON.stringify(session));
            sessionStorage.setItem('lightning-admission-session-initialized', '1');
          }
        },
        { session }
      )
    );
    const page = await bound(context.newPage());
    report.phase = 'consent';
    await bound(
      page.goto(`https://smarter.poker/hub/club-arena/lightning/${pin.clusterId}`, {
        waitUntil: 'domcontentloaded',
        timeout: remaining(),
      })
    );
    report.consent = await bound(
      acceptPlayerTerms(page, session, pin, url, acceptTerms, remaining)
    );
    if (initialPool) {
      report.pool = initialPool;
      report.status = 'read_only_resume';
    } else {
      // Re-read immediately before the single join, in case ordinary input admitted this member.
      report.pool = await bound(readOwnPool(admin, pin));
      if (report.pool) report.status = 'read_only_resume';
      else {
        report.phase = 'join';
        const entry = page.getByTestId('lightning-entry');
        const joining = page
          .waitForResponse((r) => rpcPath(r.request(), 'fn_cash_game_join'), {
            timeout: Math.min(30000, remaining()),
          })
          .catch(() => null);
        report.join.outcome = 'unknown';
        await bound(
          entry
            .getByRole('button', { name: 'Join Lightning', exact: true })
            .click({ timeout: remaining() })
        ).catch(() => null);
        const response = await bound(joining);
        const joined = response ? await bound(response.json()).catch(() => null) : null;
        if (
          joined?.ok !== true ||
          !['seat', 'seated'].includes(joined.action) ||
          !UUID.test(joined.table_id)
        ) {
          if (joined?.ok === true && joined.action === 'waitlisted')
            report.join.outcome = 'waitlisted';
          report.pool = await bound(readOwnPool(admin, pin));
          throw new Error('Join Unknown Or Waitlisted');
        }
        report.join = { outcome: joined.action, tableId: joined.table_id };
        // Ordinary horse input may have purchased a seat while join was in flight.
        // A seated reply never authorizes a second buy-in.
        report.pool = await bound(readOwnPool(admin, pin));
        if (report.pool) {
          report.status = 'read_only_resume';
        } else {
          if (joined.action === 'seated') throw new Error('Existing Seat Pool Unverified');
          report.phase = 'buy_in';
          await bound(
            page.waitForURL(
              (location) =>
                location.origin === 'https://smarter.poker' &&
                location.pathname === `/hub/club-arena/table/${joined.table_id}`,
              { timeout: remaining() }
            )
          );
          const dialog = page.getByRole('dialog', { name: 'Buy-In', exact: true });
          // Entry routes do not always request TablePage's automatic buy-in.
          // Wait for actual offered UI, then make at most one normal chair tap.
          await bound(
            page.waitForFunction(
              () => {
                const visible = (node) => !!node && node.getClientRects().length > 0;
                return (
                  visible(
                    document.querySelector('[role="dialog"][aria-labelledby="buy-in-modal-title"]')
                  ) ||
                  Array.from(document.querySelectorAll('[role="button"][aria-label]')).some(
                    (node) =>
                      /^Seat [0-9]+: Open - Click To Sit$/.test(
                        node.getAttribute('aria-label') ?? ''
                      ) && visible(node)
                  )
                );
              },
              null,
              { timeout: remaining() }
            )
          );
          if (!(await dialog.isVisible())) {
            const offered =
              Number.isInteger(joined.seat_number) && joined.seat_number > 0
                ? page.getByRole('button', {
                    name: `Seat ${joined.seat_number}: Open - Click To Sit`,
                    exact: true,
                  })
                : null;
            const chair =
              offered && (await offered.isVisible())
                ? offered
                : page
                    .locator('[role="button"][aria-label$=": Open - Click To Sit"]:visible')
                    .first();
            await bound(chair.click({ timeout: remaining() }));
          }
          await bound(dialog.waitFor({ state: 'visible', timeout: remaining() }));
          let payload = null;
          const capture = (r) => {
            if (rpcPath(r, 'atomic_table_buyin')) {
              try {
                payload ??= r.postDataJSON();
                // Retain the actual retry identity before awaiting a possibly lost response.
                if (UUID.test(payload?.p_idempotency_key))
                  report.buyIn.requestId = payload.p_idempotency_key;
              } catch {}
            }
          };
          page.on('request', capture);
          const purchase = page
            .waitForResponse((r) => rpcPath(r.request(), 'atomic_table_buyin'), {
              timeout: Math.min(30000, remaining()),
            })
            .catch(() => null);
          report.buyIn.outcome = 'unknown';
          await bound(
            dialog
              .getByRole('button', { name: 'Buy Chips', exact: true })
              .click({ timeout: remaining() })
          ).catch(() => null);
          const bought = await bound(purchase);
          page.off('request', capture);
          if (
            !payload ||
            payload.p_user_id !== pin.playerId ||
            payload.p_table_id !== joined.table_id ||
            payload.p_club_id !== CLUB ||
            !UUID.test(payload.p_idempotency_key) ||
            !Number.isInteger(payload.p_seat_number) ||
            !finite(payload.p_amount) ||
            Number(payload.p_amount) <= 0 ||
            typeof payload.p_auto_rebuy !== 'boolean'
          )
            throw new Error('Buy In Intent Unverified');
          report.buyIn.requestId = payload.p_idempotency_key;
          report.buyIn.outcome = bought ? 'reply_observed' : 'reply_unknown';
          const receipt = await bound(
            client.rpc('fn_ca_cash_buyin_receipt', {
              p_idempotency_key: payload.p_idempotency_key,
              p_table_id: payload.p_table_id,
            })
          );
          report.buyIn.receipt =
            !receipt.error && admissionReceiptMatches(payload, receipt.data)
              ? 'confirmed_exact_intent'
              : 'unknown';
          report.pool = await bound(readOwnPool(admin, pin));
          report.walletAfter = await bound(validateScope(admin, pin));
          if (report.buyIn.receipt !== 'confirmed_exact_intent' || !report.pool)
            throw new Error('Persisted Admission Unverified');
          report.status = 'admitted';
        }
      }
    }
    const currentPool = await bound(readOwnPool(admin, pin));
    if (!currentPool || currentPool.poolSessionId !== report.pool?.poolSessionId)
      throw new Error('Admitted Pool Changed');
    report.pool = currentPool;
    report.phase = 'admitted_callback';
    report.admissionOutcome = report.status;
    if (withAdmittedSession)
      report.playerWitness = await bound(
        withAdmittedSession({
          client,
          session,
          browser,
          context,
          page,
          pin: { ...pin, poolSessionId: report.pool.poolSessionId },
          remaining,
        })
      );
    report.status = 'observed';
    report.phase = 'complete';
  } catch {
    report.status = 'unknown';
    report.cause = 'ADMISSION_FAILED_OR_UNKNOWN';
  } finally {
    cleaning = true;
    let clean = true;
    for (const operation of [
      () => context?.close(),
      () => browser?.close(),
      () => client?.auth.signOut({ scope: 'local' }),
    ]) {
      try {
        const r = await bound(operation(), Math.max(1, end - Date.now()));
        if (r?.error) clean = false;
      } catch {
        clean = false;
      }
    }
    report.cleanup = clean ? 'local_session_and_browser_closed' : 'unknown';
    if (!clean) report.status = 'unknown';
  }
  return report;
}
