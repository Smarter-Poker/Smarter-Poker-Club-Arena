import { selectPoolTab, clickSelectedPoolControl } from './lightning-pilot-selected-pool.mjs';
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
    if (e.replayed === true) return null;
    // Showdown's live producer has no payload timestamp. Retained events have
    // a fresh send time too, so only a positive live event sequence permits
    // envelope-time fallback. An explicit stale/invalid payload time never does.
    const timestamp = Object.hasOwn(e, 'timestamp')
      ? e.timestamp
      : Number.isSafeInteger(f.seq) && f.seq > 0
        ? f.ts
        : null;
    if (fromMs > 0 && (!Number.isFinite(timestamp) || timestamp < fromMs)) return null;
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

/** A disappearing optional control cannot consume the remaining natural-cycle witness.
 * One click only. An unknown acknowledgment is retained and never re-clicked.
 */
export async function clickCycleControlOnce(page, control, matches, remaining, why = {}) {
  const timeout = Math.min(5000, remaining());
  const responseP = page.waitForResponse(matches, { timeout });
  const [response, click] = await Promise.allSettled([
    responseP,
    control.click({ timeout: Math.min(2500, remaining()) }),
  ]);
  // Why an acknowledgment is unknown, from fixed categories only (no messages).
  if (click.status === 'rejected') {
    const m = String(click.reason?.message ?? '');
    why.click = /Selected Pool|Pool Tab/.test(m)
      ? 'selected_pool_unverified'
      : click.reason?.name === 'TimeoutError' || /Timeout/i.test(m)
        ? 'control_not_clickable'
        : 'click_failed';
    // Playwright names the element that took the pointer; keep only its tag and
    // class tokens (no text, ids or attributes), and Playwright's fixed reasons.
    const blocker = m.match(
      /<(\w{1,12})(?:[^>]*?class="([\w\s-]{0,80})")?[^>]*>[^\n]*intercepts pointer events/
    );
    if (blocker)
      why.interceptedBy = `${blocker[1]}.${(blocker[2] || '').trim().split(/\s+/).slice(0, 4).join('.')}`;
    if (/not visible/.test(m)) why.reason = 'not_visible';
    else if (/not enabled|disabled/.test(m)) why.reason = 'not_enabled';
    else if (/not stable/.test(m)) why.reason = 'not_stable';
    else if (/intercepts pointer events/.test(m)) why.reason = 'pointer_intercepted';
    else if (/outside of the viewport/.test(m)) why.reason = 'outside_viewport';
  } else why.click = 'clicked';
  if (response.status !== 'fulfilled') {
    why.response = 'no_matching_response';
    return null;
  }
  why.response = 'observed';
  return response.value;
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
  const hands = new Map();
  let bankActivated = false,
    deadlineExtended = false;
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
    requests: { timebank: 0, preaction: 0 },
    appRequests: { timebank: 0 },
    staleRefusals: { timebank: 0, preaction: 0 },
    clickOutcomes: { timebank: [], preaction: [] },
    foldWatch: { accepted: 0, refused: 0, unknown: 0 },
    preactionRequestHandId: null,
    timebankContextHandId: null,
    observedHands: [],
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
    let rendered = false;
    let clock = {},
      bankBefore = null;
    let armedHandId = null,
      armedHandNumber = null;
    // The control this witness is clicking right now. A request outside that
    // click is the app's own (for example its automatic Time Bank) and is
    // retained separately, never counted as the witness's one request.
    let clicking = null;
    page.on('request', (request) => {
      try {
        const endpoint = new URL(request.url());
        if (request.method() !== 'POST' || endpoint.origin !== 'https://engine.smarter.poker')
          return;
        const body = request.postDataJSON();
        if (body.tableId !== pin.poolSessionId) return;
        if (endpoint.pathname === '/timebank') {
          if (clicking !== 'timebank') {
            report.appRequests.timebank++;
            return;
          }
          report.requests.timebank++;
          report.timebankContextHandId = UUID.test(bankBefore?.hand_id) ? bankBefore.hand_id : null;
        } else if (
          endpoint.pathname === '/preaction' &&
          body.action === 'auto_check' &&
          UUID.test(body.handId)
        ) {
          report.requests.preaction++;
          armedHandId = body.handId;
          armedHandNumber = clock.hand_id === body.handId ? clock.hand_number : null;
          report.preactionRequestHandId = body.handId;
        }
      } catch {
        /* malformed requests provide no evidence */
      }
    });
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
    await selectPoolTab(page, pin, remaining, (report.poolSelection = {}));
    report.subphase = 'first_render';
    report.cause = 'first_render_unobserved';
    while (!rendered) await page.waitForTimeout(Math.min(100, remaining()));
    // Optional single clicks only while the maintained UI already offers them.
    const controls = [
      // A pre-action is offered while others act, so it is tried first; the
      // Time Bank needs the player's own turn and comes second.
      ['preaction', preaction, '.pre-action-btn.check', '/preaction'],
      [
        'timebank',
        timebank,
        '.control-strip button[title="Time Bank"], .control-strip button[title="Unlimited Lifetime VIP Time Banks"]',
        '/timebank',
      ],
    ];
    const retried = new Set();
    for (let ci = 0; ci < controls.length; ci++) {
      const [key, requested, selector, path] = controls[ci];
      if (!requested) continue;
      const control = page.locator(selector);
      // Observe the ordinary UI for one short opportunity; never repeat a click.
      // A check pre-action is offered only while the player faces no bet, so it
      // gets a longer window than the Time Bank, which is offered every turn.
      const offeredUntil = Date.now() + Math.min(key === 'preaction' ? 60000 : 20000, remaining());
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
      clicking = key;
      const why = {};
      const response = await clickCycleControlOnce(
        page,
        { click: (options) => clickSelectedPoolControl(page, pin, control, remaining, options) },
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
        remaining,
        why
      );
      clicking = null;
      report.clickOutcomes[key].push(why);
      if (!response) {
        report[key] = 'click_or_response_unknown';
        continue;
      }
      const answer = await bound(response.json());
      report[key] = response.ok() && answer.success === true ? 'accepted' : 'refused';
      if (key === 'preaction' && report[key] === 'accepted') report.preaction = 'armed';
      if (report[key] === 'refused') {
        // A hand that ended between the offer and the click is refused with no
        // effect. That one case is tried once more on the next hand; any other
        // refusal, or a second one, stops the witness as before.
        const stale =
          answer?.code === 'STALE_HAND' ||
          /hand is over|left this hand|no active hand/i.test(String(answer?.error ?? ''));
        if (!stale || retried.has(key)) throw new Error('Optional Action Refused');
        retried.add(key);
        report.staleRefusals[key]++;
        report[key] = 'not_available';
        if (key === 'preaction') {
          armedHandId = null;
          armedHandNumber = null;
        }
        const staleHand = clock.hand_id;
        const nextHandBy = Date.now() + Math.min(20000, remaining());
        while (Date.now() < nextHandBy && clock.hand_id === staleHand)
          await page.waitForTimeout(Math.min(100, remaining()));
        controls.splice(ci + 1, 0, controls[ci]);
      }
    }
    report.subphase = 'natural_cycle';
    report.cause = 'natural_showdown_history_unobserved';
    // The account's own client holds its turns (#7738), so a passive witness
    // times out, leaves every hand and never sees a showdown. On its own turn
    // it takes the normal non-wager Fold & Watch, once per hand, and watches
    // the hand play to showdown. It never bets, calls or raises.
    const foldWatch = page.getByTestId('lightning-fold-watch');
    const foldedHands = new Set();
    const watchOwnTurn = async () => {
      const hand = clock.hand_id;
      if (!UUID.test(hand) || foldedHands.has(hand)) return;
      // An armed Time Bank opens only when the clock runs out on that same turn:
      // that turn waits for the bank to open and extend the deadline first.
      if (
        report.timebank === 'accepted' &&
        !(bankActivated && deadlineExtended) &&
        bankBefore &&
        hand === bankBefore.hand_id &&
        clock.action_context === bankBefore.action_context
      )
        return;
      if (!(await bound(foldWatch.isVisible())) || !(await bound(foldWatch.isEnabled()))) return;
      foldedHands.add(hand);
      const response = await clickCycleControlOnce(
        page,
        { click: (options) => clickSelectedPoolControl(page, pin, foldWatch, remaining, options) },
        (r) => {
          if (r.request().method() !== 'POST') return false;
          try {
            return r.request().postDataJSON()?.tableId === pin.poolSessionId;
          } catch {
            return false;
          }
        },
        remaining
      );
      if (!response) report.foldWatch.unknown++;
      else {
        const answer = await bound(response.json()).catch(() => null);
        if (response.ok() && answer?.success === true) report.foldWatch.accepted++;
        else report.foldWatch.refused++;
      }
    };
    while (
      !rendered ||
      ![...hands.values()].some((h) => h.betting && h.showdown && h.hand_complete && h.historyId) ||
      (report.preaction === 'armed' &&
        Number.isSafeInteger(armedHandNumber) &&
        !hands.get(armedHandNumber)?.historyId)
    ) {
      await watchOwnTurn();
      await page.waitForTimeout(Math.min(100, remaining()));
    }
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
      report.requests.timebank - report.staleRefusals.timebank === 1 &&
      report.requests.preaction - report.staleRefusals.preaction === 1 &&
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
    report.observedHands = [...hands.values()].map((hand) => ({ ...hand }));
    report.timebankExecution =
      bankActivated && deadlineExtended ? 'activated_and_deadline_extended' : 'not_observed';
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
    if (report.status !== 'observed') report.controlsQualified = false;
  }
  return report;
}
