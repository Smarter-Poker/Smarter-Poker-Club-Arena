/** Explicit finite R08 observation. Horses keep their normal input device.
 * Never submits a wager, joins, funds, forges telemetry or accepts new consent.
 */
import {
  openPlayerSession,
  assertPlayerPin,
  renderHand,
  acceptPlayerTerms,
  validatePlayer,
} from './lightning-pilot-player.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** TableStateHub EVENT envelope; retain no cards, identities, amounts or raw frames. */
export function cycleEvent(payload, room, fromMs = 0) {
  try {
    const f = JSON.parse(String(payload));
    if (f.type !== 'EVENT' || f.tableId !== room || !f.payload) return null;
    const e = f.payload;
    if (fromMs > 0 && (!Number.isFinite(e.timestamp) || e.timestamp < fromMs)) return null;
    if (!Number.isSafeInteger(e.hand_number) || e.hand_number <= 0) return null;
    if (e.type === 'player_action' && ['call', 'bet', 'raise', 'all_in'].includes(e.action))
      return { handNumber: e.hand_number, kind: 'betting' };
    if (['showdown', 'hand_complete'].includes(e.type))
      return { handNumber: e.hand_number, kind: e.type };
    if (e.type === 'hand_history_saved' && UUID.test(e.hand_id))
      return { handNumber: e.hand_number, kind: e.type, historyId: e.hand_id };
  } catch {
    /* malformed transport is no witness */
  }
  return null;
}

/** Only clock identity fields, from the maintained SNAPSHOT/DELTA protocol. */
export function cycleClock(payload, room, previous = {}) {
  try {
    const f = JSON.parse(String(payload));
    if (f.tableId !== room) return previous;
    const fields = [
      'hand_id',
      'hand_number',
      'action_context',
      'turn_deadline_ms',
      'time_bank_active',
    ];
    const next = { ...previous };
    if (f.type === 'SNAPSHOT') {
      if (!Number.isSafeInteger(f.seq)) return {};
      next.seq = f.seq;
      for (const key of fields) next[key] = f.state?.[key];
    } else if (f.type === 'DELTA' && Array.isArray(f.patch)) {
      if (!Number.isSafeInteger(f.seq) || f.prev !== previous.seq || f.seq <= f.prev) return {};
      next.seq = f.seq;
      for (const p of f.patch)
        if (['add', 'replace', 'remove'].includes(p.op) && fields.includes(p.path?.slice(1)))
          next[p.path.slice(1)] = p.op === 'remove' ? undefined : p.value;
    }
    return next;
  } catch {
    return previous;
  }
}

export function ownPreactionExecuted(history, playerId) {
  return (
    Array.isArray(history?.actions) &&
    history.actions.some(
      (a) => a?.userId === playerId && a.origin === 'pre_action' && a.action === 'check'
    )
  );
}

const qualifyingCycle = (h) => h.betting && h.showdown && h.hand_complete && h.historyId;
/** Recent twelve records, retaining the armed hand and one complete witness. */
export function recordCycleEvent(hands, e, armedHandNumber = null) {
  if (!e) return;
  if (!hands.has(e.handNumber) && hands.size >= 12) {
    const complete = [...hands.values()].find(qualifyingCycle)?.handNumber;
    const oldest = [...hands.keys()].find((id) => id !== armedHandNumber && id !== complete);
    if (oldest === undefined) return;
    hands.delete(oldest);
  }
  const row = hands.get(e.handNumber) ?? {
    handNumber: e.handNumber,
    betting: false,
    showdown: false,
    hand_complete: false,
    historyId: null,
  };
  if (e.kind === 'hand_history_saved') row.historyId = e.historyId;
  else row[e.kind] = true;
  hands.set(e.handNumber, row);
}

export async function witnessCycle({
  admin,
  createClient,
  chromium,
  url,
  pin,
  timeoutMs = 120000,
  timebank = false,
  preaction = false,
  openSession = openPlayerSession,
}) {
  assertPlayerPin(pin);
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 30000 ||
    timeoutMs > 240000 ||
    typeof timebank !== 'boolean' ||
    typeof preaction !== 'boolean'
  )
    throw new Error('Finite Cycle Scope Required');
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const remaining = () => {
    const ms = deadline - Date.now() - 20000;
    if (ms <= 0) throw new Error('Cycle Deadline');
    return ms;
  };
  const bound = async (promise, ms = remaining()) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Cycle Deadline')), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  let client, session, browser;
  let cleaning = false;
  // Own the synthetic client as soon as it exists, including partial auth failures.
  const ownedCreateClient = (base, key, options = {}) => {
    remaining();
    const normalFetch = options.global?.fetch ?? fetch;
    client = createClient(base, key, {
      ...options,
      global: {
        ...options.global,
        fetch: (input, init = {}) =>
          normalFetch(input, {
            ...init,
            signal: AbortSignal.any([
              ...(init.signal ? [init.signal] : []),
              AbortSignal.timeout(cleaning ? Math.max(1, deadline - Date.now()) : remaining()),
            ]),
          }),
      },
    });
    return client;
  };
  const report = {
    status: 'unknown',
    scope: 'sample_only',
    subphase: 'browser',
    cause: 'browser_unverified',
    playerId: pin.playerId,
    poolSessionId: pin.poolSessionId,
    clusterId: pin.clusterId,
    timebank: timebank ? 'not_available' : 'not_requested',
    preaction: preaction ? 'not_available' : 'not_requested',
    timebankExecution: 'not_observed',
    preactionExecution: 'not_observed',
    controlsQualified: false,
    cycles: [],
    cleanup: 'pending',
  };
  try {
    report.subphase = 'authentication';
    report.cause = 'authentication_unverified';
    const opened = await bound(openSession(admin, ownedCreateClient, url, pin, remaining));
    client = opened.client;
    session = opened.session;
    remaining();
    browser = await chromium.launch({ headless: true, timeout: remaining() });
    const context = await bound(browser.newContext({ viewport: { width: 1440, height: 900 } }));
    await bound(
      context.addInitScript(
        ({ session }) => localStorage.setItem('smarter-poker-auth', JSON.stringify(session)),
        { session }
      )
    );
    const page = await bound(context.newPage());
    const hands = new Map();
    let rendered = false;
    let clock = {},
      bankBefore = null,
      bankActivated = false,
      deadlineExtended = false;
    let armedHandId = null,
      armedHandNumber = null;
    page.on('websocket', (ws) => {
      ws.on('framesent', ({ payload }) => {
        if (renderHand(payload, pin.poolSessionId)) rendered = true;
      });
      ws.on('framereceived', ({ payload }) => {
        clock = cycleClock(payload, pin.poolSessionId, clock);
        if (
          bankBefore &&
          clock.hand_id === bankBefore.hand_id &&
          clock.action_context === bankBefore.action_context &&
          clock.time_bank_active === true &&
          Number.isFinite(clock.turn_deadline_ms) &&
          clock.turn_deadline_ms > bankBefore.turn_deadline_ms
        )
          deadlineExtended = true;
        try {
          const f = JSON.parse(String(payload));
          if (
            bankBefore &&
            f.type === 'EVENT' &&
            f.tableId === pin.poolSessionId &&
            f.payload?.type === 'TIME_BANK_ACTIVATED' &&
            f.payload.playerId === pin.playerId
          )
            bankActivated = true;
        } catch {
          /* no clock witness */
        }
        const e = cycleEvent(payload, pin.poolSessionId, startedAt);
        recordCycleEvent(hands, e, armedHandNumber);
      });
    });
    report.subphase = 'navigation';
    report.cause = 'navigation_unverified';
    await page.goto(`https://smarter.poker/hub/club-arena/table/${pin.poolSessionId}`, {
      waitUntil: 'domcontentloaded',
      timeout: remaining(),
    });
    report.subphase = 'consent';
    report.cause = 'existing_consent_unverified';
    await bound(acceptPlayerTerms(page, session, pin, url, false, remaining));
    report.subphase = 'first_render';
    report.cause = 'first_render_unobserved';
    while (!rendered) await page.waitForTimeout(Math.min(100, remaining()));
    // Optional single clicks only while the maintained UI already offers them.
    for (const [key, requested, selector, path] of [
      ['timebank', timebank, '.control-strip button[title="Time Bank"]', '/timebank'],
      ['preaction', preaction, '.pre-action-btn.check', '/preaction'],
    ]) {
      if (!requested) continue;
      const control = page.locator(selector);
      // Observe the ordinary UI for one short opportunity; never repeat a click.
      const offeredUntil = Date.now() + Math.min(20000, remaining());
      while (Date.now() < offeredUntil) {
        if ((await bound(control.isVisible())) && (await bound(control.isEnabled()))) break;
        await page.waitForTimeout(Math.min(100, offeredUntil - Date.now(), remaining()));
      }
      if (!(await bound(control.isVisible())) || !(await bound(control.isEnabled()))) continue;
      if (key === 'preaction' && (await bound(control.getAttribute('aria-pressed'))) === 'true') {
        report.preaction = 'already_armed';
        continue;
      }
      await bound(validatePlayer(admin, pin));
      if (key === 'timebank') {
        if (
          !UUID.test(clock.hand_id) ||
          typeof clock.action_context !== 'string' ||
          !Number.isFinite(clock.turn_deadline_ms)
        ) {
          report.timebank = 'clock_identity_unknown';
          continue;
        }
        bankBefore = { ...clock };
      }
      report.subphase = key;
      report.cause = 'optional_action_unverified';
      const responseP = page.waitForResponse(
        (r) => {
          if (r.request().method() !== 'POST' || new URL(r.url()).pathname !== path) return false;
          try {
            const b = r.request().postDataJSON();
            if (
              key === 'preaction' &&
              b.tableId === pin.poolSessionId &&
              b.action === 'auto_check' &&
              UUID.test(b.handId)
            ) {
              armedHandId = b.handId;
              armedHandNumber = clock.hand_id === b.handId ? clock.hand_number : null;
            }
            return (
              b.tableId === pin.poolSessionId &&
              (key !== 'preaction' || (b.action === 'auto_check' && UUID.test(b.handId)))
            );
          } catch {
            return false;
          }
        },
        { timeout: remaining() }
      );
      const [response] = await Promise.all([responseP, control.click({ timeout: remaining() })]);
      const answer = await bound(response.json());
      report[key] = response.ok() && answer.success === true ? 'accepted' : 'refused';
      if (key === 'preaction' && report[key] === 'accepted') report.preaction = 'armed';
      if (report[key] === 'refused') throw new Error('Optional Action Refused');
    }
    report.subphase = 'natural_cycle';
    report.cause = 'natural_showdown_history_unobserved';
    while (
      !rendered ||
      ![...hands.values()].some((h) => h.betting && h.showdown && h.hand_complete && h.historyId) ||
      (report.preaction === 'armed' &&
        Number.isSafeInteger(armedHandNumber) &&
        !hands.get(armedHandNumber)?.historyId)
    )
      await page.waitForTimeout(Math.min(100, remaining()));
    const observed = [...hands.values()].find(
      (h) => h.betting && h.showdown && h.hand_complete && h.historyId
    );
    report.subphase = 'history_readback';
    report.cause = 'settled_history_unverified';
    const r = await bound(
      admin
        .from('lightning_hand')
        .select('hand_id,cluster_id,hand_history_id,settled_at')
        .eq('cluster_id', pin.clusterId)
        .eq('hand_history_id', observed.historyId)
        .maybeSingle()
    );
    if (
      r.error ||
      r.data?.cluster_id !== pin.clusterId ||
      r.data?.hand_history_id !== observed.historyId ||
      !UUID.test(r.data?.hand_id) ||
      !Number.isFinite(Date.parse(r.data?.settled_at)) ||
      Date.parse(r.data.settled_at) < startedAt
    )
      throw new Error('Settled History Unverified');
    report.cycles.push({
      handNumber: observed.handNumber,
      handId: r.data.hand_id,
      historyId: observed.historyId,
      betting: 'observed',
      showdown: 'observed',
      completion: 'observed',
      settledHistory: 'observed',
    });
    report.timebankExecution =
      bankActivated && deadlineExtended ? 'activated_and_deadline_extended' : 'not_observed';
    if (report.preaction === 'armed' && armedHandId) {
      const hand = await bound(
        admin
          .from('lightning_hand')
          .select('hand_id,cluster_id,hand_history_id,settled_at')
          .eq('hand_id', armedHandId)
          .eq('cluster_id', pin.clusterId)
          .maybeSingle()
      );
      if (
        !hand.error &&
        hand.data?.hand_id === armedHandId &&
        hand.data?.cluster_id === pin.clusterId &&
        UUID.test(hand.data?.hand_history_id) &&
        Number.isFinite(Date.parse(hand.data?.settled_at))
      ) {
        const history = await bound(
          admin
            .from('hand_history')
            .select('id,actions')
            .eq('id', hand.data.hand_history_id)
            .maybeSingle()
        );
        if (
          !history.error &&
          history.data?.id === hand.data.hand_history_id &&
          ownPreactionExecuted(history.data, pin.playerId)
        ) {
          report.preactionExecution = 'persisted_own_pre_action_check';
          report.preactionHandId = armedHandId;
          report.preactionHistoryId = hand.data.hand_history_id;
        }
      }
    }
    report.controlsQualified =
      report.timebank === 'accepted' &&
      report.timebankExecution === 'activated_and_deadline_extended' &&
      report.preaction === 'armed' &&
      report.preactionExecution === 'persisted_own_pre_action_check';
    remaining();
    report.status = 'observed';
    report.subphase = 'complete';
    report.cause = null;
  } catch {
    report.status = 'unknown';
  } finally {
    cleaning = true;
    if (browser)
      await bound(browser.close(), Math.max(1, Math.min(10000, deadline - Date.now()))).catch(
        () => {
          report.status = 'unknown';
          report.cause = 'browser_cleanup_unverified';
        }
      );
    if (client) {
      const out = await bound(
        client.auth.signOut({ scope: 'local' }),
        Math.max(1, Math.min(10000, deadline - Date.now()))
      ).catch(() => ({ error: true }));
      report.cleanup = out?.error ? 'unknown' : 'local_session_closed';
      if (out?.error) {
        report.status = 'unknown';
        report.cause = 'local_cleanup_unverified';
      }
    } else report.cleanup = 'no_local_session_created';
  }
  return report;
}
