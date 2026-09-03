/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SHELL TELEMETRY — the reader the 2026-08-29 glitch fix never had
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `useShellUpdateGate` emits SHELL_STALENESS_CHECKED (both outcomes, with a
 * source) and SHELL_RELOADED (with page age). Nothing listened. A fix nobody
 * measures is a fix nobody can defend — and this one in particular is
 * INVISIBLE when it works: the whole point is that no reload happens.
 *
 * This service is the listener. It persists to `client_shell_telemetry`,
 * whose two views answer the only questions worth asking:
 *
 *   v_shell_staleness_rate    — stale share per source per day. Near zero on
 *                               shell-updated / controllerchange means the
 *                               service worker's freshness race is winning.
 *   v_shell_reload_lateness   — reloads inside the 15s startup window (the fix
 *                               adopting a stale bundle cleanly) versus long
 *                               after paint (the glitch Dan reported).
 *
 * ── RULES IT LIVES BY ──────────────────────────────────────────────────────
 *
 * 1. IT CAN NEVER BREAK THE APP. Every write is fire-and-forget behind a
 *    try/catch; a failed insert is dropped, not retried, not surfaced. This
 *    is a KPI, not a money path.
 * 2. IT CAN NEVER BE CHATTY. The producers are already throttled (the resume
 *    probe once a minute; a reload at most once per cooldown), and a
 *    same-page dedupe below stops a pathological loop from writing a row a
 *    frame. There is no batching queue because there is nothing to batch.
 * 3. IT WRITES ONLY WHEN SIGNED IN. RLS requires user_id = auth.uid(), so an
 *    anonymous insert would be refused anyway; skipping it avoids the noise.
 * 4. A RELOAD IS WRITTEN BEFORE THE PAGE DIES. `window.location.reload()`
 *    fires immediately after the emit, so the insert is raced against
 *    teardown — `keepalive` is what makes it survive, exactly as an analytics
 *    beacon does.
 */
import { masterBus } from '../core/MasterBus';
import { supabase } from '../lib/supabase';

/** Highest write rate this service will ever produce, per event kind. */
export const MIN_WRITE_INTERVAL_MS = 30 * 1000;

type Row = {
  user_id: string;
  event: 'staleness_checked' | 'reloaded';
  stale?: boolean;
  source?: string;
  running_entry?: string | null;
  deployed_entry?: string | null;
  page_age_ms?: number;
};

let started = false;
const lastWriteAt: Record<string, number> = {};

/**
 * May this event kind be written now? Producer-side throttles already exist;
 * this is the backstop that makes a pathological loop cheap rather than
 * expensive. Exported for the unit test.
 */
export function mayWrite(kind: string, now: number, last: number | undefined): boolean {
  return last === undefined || now - last >= MIN_WRITE_INTERVAL_MS;
}

async function currentUserId(): Promise<string | null> {
  try {
    /* The error is BOUND and acted on, per the discarded-error-read ratchet
       (tests/unit/discardedErrorReadRatchet.test.ts). "Acted on" here means
       logged at debug and treated as signed-out: a KPI row is not worth a
       Sentry event, but an invisible read failure is exactly how this
       service would appear to work while writing nothing. */
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      console.debug('[shell-telemetry] session read failed; skipping write', error.message);
      return null;
    }
    return data.session?.user?.id ?? null;
  } catch {
    return null;
  }
}

async function write(row: Omit<Row, 'user_id'>): Promise<void> {
  try {
    const userId = await currentUserId();
    if (!userId) return; // RLS would refuse it; do not generate the noise
    const { error } = await supabase
      .from('client_shell_telemetry')
      .insert({ ...row, user_id: userId });
    if (error) {
      // Dropped on purpose — never retried, never surfaced to the player.
      console.debug('[shell-telemetry] insert refused', error.message);
    }
  } catch {
    /* Telemetry must never surface to the player, and never retry. */
  }
}

/**
 * Subscribe to the shell events. Idempotent: calling twice does not
 * double-write (the app root may re-run effects in StrictMode).
 */
export function startShellTelemetry(): void {
  if (started) return;
  started = true;

  /* Subscribers receive the bus ENVELOPE ({ type, payload, timestamp }), not
     the bare payload — reading `event.stale` here would be silently undefined
     and every row would land null. */
  masterBus.subscribe('SHELL_STALENESS_CHECKED', (event) => {
    const payload = event.payload;
    const now = Date.now();
    if (!mayWrite('staleness_checked', now, lastWriteAt.staleness_checked)) return;
    lastWriteAt.staleness_checked = now;
    void write({
      event: 'staleness_checked',
      stale: payload.stale,
      source: payload.source,
      running_entry: payload.running,
      deployed_entry: payload.deployed,
    });
  });

  masterBus.subscribe('SHELL_RELOADED', (event) => {
    const payload = event.payload;
    const now = Date.now();
    if (!mayWrite('reloaded', now, lastWriteAt.reloaded)) return;
    lastWriteAt.reloaded = now;
    /* The page is about to be replaced. A normal insert would be cancelled
       mid-flight, so this one goes out as a keepalive beacon — the same
       mechanism analytics uses for unload — and falls back to the ordinary
       client path if the environment has no fetch keepalive. */
    void writeReloadBeacon(payload.pageAgeMs);
  });
}

/**
 * The reload write, sent so it survives the page teardown that follows it.
 * Exported for the unit test, which asserts it never throws.
 */
export async function writeReloadBeacon(pageAgeMs: number): Promise<void> {
  try {
    const userId = await currentUserId();
    if (!userId) return;
    const url = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/client_shell_telemetry`;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
    const { data, error: sessionErr } = await supabase.auth.getSession();
    if (sessionErr) {
      console.debug('[shell-telemetry] session read failed on reload beacon', sessionErr.message);
      return;
    }
    const token = data.session?.access_token;
    if (!url || !key || !token) return;
    await fetch(url, {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${token}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ user_id: userId, event: 'reloaded', page_age_ms: pageAgeMs }),
    });
  } catch {
    /* The page is going away regardless. Losing one KPI row is acceptable;
       throwing on the way out is not. */
  }
}

/** Test seam: forget that we started, and forget the throttle. */
export function __resetShellTelemetryForTests(): void {
  started = false;
  for (const k of Object.keys(lastWriteAt)) delete lastWriteAt[k];
}
