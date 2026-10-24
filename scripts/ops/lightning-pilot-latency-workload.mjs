import { selectPoolTab, clickSelectedPoolControl } from './lightning-pilot-selected-pool.mjs';
/** One bounded actual-action workload for the already authorized existing player.
 * Reports sample observations, never a latency pass or manufactured percentile. */
import { resolvePilotTarget } from './lightning-pilot-targets.mjs';
import {
  WITNESS_PLAYERS,
  assertPlayerPin,
  openPlayerSession,
  validatePlayer,
  validatePlayablePlayer,
  acceptPlayerTerms,
  renderHand,
} from './lightning-pilot-player.mjs';
const LEGS = [
  'fold_ack',
  'ack_to_idle',
  'idle_to_match',
  'match_to_hand',
  'hand_to_first_render',
  'fast_fold_to_next_hand',
  'normal_fold_to_next_hand',
  'fold_watch_to_next_hand',
];

/**
 * This harness's own refusals are fixed plain-word sentences ("Existing Funded
 * Active Pilot Player Unavailable"). Only that shape is reported; any other
 * message is redacted, because an arbitrary exception can carry a URL or a
 * credential and the witness report is uploaded as an artifact.
 */
export function witnessReason(error) {
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  return /^[A-Z][A-Za-z]*( [A-Za-z]+){1,11}$/.test(message) ? message : 'redacted';
}

export async function validateLatencyPlayer(admin, pin, validate = validatePlayer) {
  return validatePlayablePlayer(admin, pin, validate);
}

export function latencyAttemptPlan(maxAttempts = 120) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 120)
    throw new Error('Bounded Workload Required');
  return Array.from({ length: maxAttempts }, (_, index) =>
    index % 2 === 0 ? 'fast_fold' : 'fold_watch'
  );
}
export async function attemptLatencyFold({
  page,
  pin,
  kind,
  handId,
  seen,
  currentHand,
  remaining,
  record = null,
}) {
  record ??= {
    renderedIntentHandId: handId,
    kind,
    requestedAt: new Date().toISOString(),
    outcome: 'unknown',
    cause: 'action_unverified',
  };
  if (seen.has(handId)) {
    record.cause = 'hand_already_attempted';
    return record;
  }
  // This record is the rendered intent before the click. The maintained
  // transport binds its own action context; this sample is no stale-action certificate.
  seen.add(handId);
  const selector = kind === 'fast_fold' ? 'lightning-fold' : 'lightning-fold-watch';
  try {
    const control = page.getByTestId(selector);
    await control.waitFor({ state: 'visible', timeout: remaining() });
    await control.click({ trial: true, timeout: remaining() });
    if (currentHand() !== handId) {
      record.cause = 'fresh_hand_changed';
      return record;
    }
    const responseP = page.waitForResponse(
      (response) => {
        if (
          response.request().method() !== 'POST' ||
          new URL(response.url()).pathname !== '/action'
        )
          return false;
        try {
          const body = response.request().postDataJSON();
          return body.tableId === pin.poolSessionId && body.action === kind;
        } catch {
          return false;
        }
      },
      { timeout: remaining() }
    );
    const [response] = await Promise.all([
      responseP,
      clickSelectedPoolControl(page, pin, control, remaining),
    ]);
    const answer = await response.json();
    remaining();
    record.outcome = response.ok() && answer.success === true ? 'accepted' : 'refused';
    record.cause =
      record.outcome === 'accepted' ? 'normal_action_acknowledged' : 'ordinary_action_refused';
  } catch {
    record.cause = 'action_unavailable_or_outcome_unknown';
  }
  record.completedAt = new Date().toISOString();
  return record;
}
export async function readWorkloadLatency(admin, clusterId, from, to) {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clusterId))
      return { status: 'unknown', windows: [] };
    await resolvePilotTarget(admin, clusterId, { active: false });
    // The table grants no SELECT to service_role. Use the maintained service-authorized reader.
    const read = await admin.rpc('fn_lightning_operator_cluster', {
      p_cluster_id: clusterId,
      p_from: from,
      p_to: to,
    });
    if (
      read.error ||
      read.data?.ok !== true ||
      read.data.cluster_id !== clusterId ||
      !Array.isArray(read.data.latency_windows) ||
      read.data.latency_windows.length > 60
    )
      return { status: 'unknown', windows: [] };
    const windows = [];
    for (const window of read.data.latency_windows) {
      const a = Date.parse(window.window_from),
        b = Date.parse(window.window_to);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a)
        return { status: 'unknown', windows: [] };
      const legs = {};
      for (const leg of LEGS) {
        const value = window.legs?.[leg];
        if (value === undefined) continue;
        if (
          !Number.isSafeInteger(value.n) ||
          value.n < 1 ||
          !['p50', 'p95', 'p99'].every((key) => Number.isFinite(value[key]) && value[key] >= 0) ||
          value.p50 > value.p95 ||
          value.p95 > value.p99
        )
          return { status: 'unknown', windows: [] };
        legs[leg] = { n: value.n, p50: value.p50, p95: value.p95, p99: value.p99 };
      }
      windows.push({ from: new Date(a).toISOString(), to: new Date(b).toISOString(), legs });
    }
    return {
      status: 'known',
      source: 'fn_lightning_operator_cluster',
      observedAt: new Date().toISOString(),
      windows,
      openWindow: 'not_persisted_yet_or_unobserved',
      qualification: 'not_asserted',
    };
  } catch {
    return { status: 'unknown', windows: [] };
  }
}
export async function witnessLatencyWorkload({
  admin,
  createClient,
  chromium,
  url,
  pin,
  timeoutMs = 240000,
  maxAttempts = 120,
  openSession = openPlayerSession,
  validate = validateLatencyPlayer,
}) {
  const report = {
    status: 'unknown',
    scope: 'sample_only',
    phase: 'preflight',
    attempts: [],
    renderAcks: [],
    counts: { accepted: 0, refused: 0, unknown: 0 },
    cleanup: 'pending',
    qualification: 'not_asserted',
    actionHandBinding: 'not_captured_by_this_sample',
    staleActionCertificate: 'not_asserted',
    startedAt: new Date().toISOString(),
  };
  const started = Date.now(),
    end = started + timeoutMs,
    workEnd = end - 20000;
  let client,
    browser,
    cleaning = false,
    scopeValidated = false;
  const remaining = () => {
    const ms = workEnd - Date.now();
    if (ms <= 0) throw new Error('Workload Deadline');
    return ms;
  };
  const bounded = async (promise, ms) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Workload Deadline')), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const ownedFactory = (base, key, options = {}) => {
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
              AbortSignal.timeout(cleaning ? Math.max(1, end - Date.now()) : remaining()),
            ]),
          }),
      },
    });
    return client;
  };
  try {
    const plan = latencyAttemptPlan(maxAttempts);
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 30000 ||
      timeoutMs > 240000 ||
      !WITNESS_PLAYERS.includes(pin?.playerId)
    )
      throw new Error('Scope');
    assertPlayerPin(pin);
    scopeValidated = true;
    await bounded(validate(admin, pin), remaining());
    const profile = await bounded(
      admin
        .from('profiles')
        .select('id,club_arena_tos_accepted_at')
        .eq('id', pin.playerId)
        .maybeSingle(),
      remaining()
    );
    if (
      profile.error ||
      profile.data?.id !== pin.playerId ||
      !Number.isFinite(Date.parse(profile.data.club_arena_tos_accepted_at))
    )
      throw new Error('Prior Consent');
    report.phase = 'authentication';
    const opened = await bounded(
      openSession(admin, ownedFactory, url, pin, remaining),
      remaining()
    );
    client = opened.client;
    browser = await chromium.launch({ headless: true, timeout: remaining() });
    const context = await bounded(
      browser.newContext({ viewport: { width: 1440, height: 900 } }),
      remaining()
    );
    await bounded(
      context.addInitScript(
        ({ session }) => localStorage.setItem('smarter-poker-auth', JSON.stringify(session)),
        { session: opened.session }
      ),
      remaining()
    );
    const page = await bounded(context.newPage(), remaining());
    let latestHand = null;
    const seen = new Set(),
      wakeups = new Set();
    page.on('websocket', (socket) => {
      try {
        if (new URL(socket.url()).hostname !== 'engine.smarter.poker') return;
      } catch {
        return;
      }
      socket.on('framesent', ({ payload }) => {
        const handId = renderHand(payload, pin.poolSessionId);
        if (!handId) return;
        latestHand = handId;
        if (
          !report.renderAcks.some((row) => row.handId === handId) &&
          report.renderAcks.length < 1000
        )
          report.renderAcks.push({ handId, at: new Date().toISOString() });
        for (const wake of wakeups) wake();
      });
    });
    await page.goto(`https://smarter.poker/hub/club-arena/table/${pin.poolSessionId}`, {
      waitUntil: 'domcontentloaded',
      timeout: remaining(),
    });
    await bounded(acceptPlayerTerms(page, opened.session, pin, url, false, remaining), remaining());
    await selectPoolTab(page, pin, remaining, (report.poolSelection = {}));
    for (const kind of plan) {
      report.phase = 'fresh_hand';
      if (!latestHand || seen.has(latestHand))
        await new Promise((resolve, reject) => {
          const wake = () => {
            if (latestHand && !seen.has(latestHand)) {
              clearTimeout(timer);
              wakeups.delete(wake);
              resolve();
            }
          };
          const timer = setTimeout(() => {
            wakeups.delete(wake);
            reject(new Error('Fresh Hand Deadline'));
          }, remaining());
          wakeups.add(wake);
          wake();
        });
      remaining();
      await bounded(validate(admin, pin), remaining());
      report.phase = 'single_action';
      const attempt = {
        renderedIntentHandId: latestHand,
        kind,
        requestedAt: new Date().toISOString(),
        outcome: 'unknown',
        cause: 'action_unverified',
      };
      report.attempts.push(attempt);
      await bounded(
        attemptLatencyFold({
          page,
          pin,
          kind,
          handId: latestHand,
          seen,
          currentHand: () => latestHand,
          remaining,
          record: attempt,
        }),
        remaining()
      );
    }
    report.phase = 'attempt_bound_reached';
  } catch (error) {
    report.cause =
      error?.message === 'Playable Pilot Anchor Unavailable'
        ? 'player_anchor_not_playable'
        : 'bounded_partial_or_observation_unavailable';
    // Name what actually went wrong (CLAUDE.md 10.86 rule 1). On 2026-10-23
    // two dispatches failed in preflight on a pool session that had closed
    // eleven minutes earlier, and the report said only
    // "bounded_partial_or_observation_unavailable": the reason
    // ("Existing Funded Active Pilot Player Unavailable") was thrown here and
    // dropped. The cause stays one of the known codes; the reason rides beside
    // it, but only when it is one of this harness's own plain-word refusals.
    // Anything else (a URL, a token, a stack) is redacted, as the witness
    // already redacts every exception it reports.
    report.reason = witnessReason(error);
  } finally {
    cleaning = true;
    const cleanupBudget = () => Math.max(1, end - Date.now());
    // Includes only actually persisted engine aggregates. No synthetic sample or inferred percentile.
    if (scopeValidated)
      report.latency = await bounded(
        readWorkloadLatency(admin, pin.clusterId, report.startedAt, new Date().toISOString()),
        Math.min(5000, cleanupBudget())
      ).catch(() => ({ status: 'unknown', windows: [] }));
    let clean = true;
    if (browser)
      await bounded(browser.close(), Math.min(5000, cleanupBudget())).catch(() => {
        clean = false;
      });
    if (client) {
      const out = await bounded(client.auth.signOut({ scope: 'local' }), cleanupBudget()).catch(
        () => ({ error: true })
      );
      if (out?.error) clean = false;
    }
    report.cleanup = clean
      ? client
        ? 'local_session_and_browser_closed'
        : 'no_local_session_created'
      : 'unknown';
    report.counts = { accepted: 0, refused: 0, unknown: 0 };
    report.countsByKind = {
      fast_fold: { accepted: 0, refused: 0, unknown: 0 },
      fold_watch: { accepted: 0, refused: 0, unknown: 0 },
    };
    for (const attempt of report.attempts) {
      report.counts[attempt.outcome]++;
      report.countsByKind[attempt.kind][attempt.outcome]++;
    }
    report.status = clean && report.counts.accepted > 0 ? 'partial_observed' : 'unknown';
    report.completedAt = new Date().toISOString();
  }
  return report;
}
