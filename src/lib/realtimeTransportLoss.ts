import { reportError } from '../utils/errorReporter';

/**
 * ONE SOCKET DROP IS ONE EVENT, NOT ONE PER CHANNEL (2026-10-24).
 *
 * Every page channel shares the one Supabase Realtime socket. When that socket
 * closes or errors - a phone backgrounding the tab, Wi-Fi to cellular, a missed
 * heartbeat - realtime-js runs `_triggerChanError()`, which fires the error
 * event on EVERY channel at once with no reason attached. Each channel's
 * subscribe callback then reports `CHANNEL_ERROR` with `err === undefined`.
 * Realtime admission produces the same fan-out from its own socket listeners
 * ("Realtime transport closed before admission", "... admission timed out").
 *
 * Production, the 24 hours to 2026-10-24: 1,091 bare `Realtime CHANNEL_ERROR on
 * <channel>` rows from 48 players, every single one with a sibling from the
 * same player inside two seconds (3 to 10 channels per drop), plus 97 admission
 * transport rows - about 300 actual socket drops filed as roughly 1,200 channel
 * errors. The server refused none of them: a refused join always carries the
 * server's reason (e.g. "Unauthorized: You do not have permissions ...").
 *
 * So a transport-level failure is reported once per drop, here, and the
 * per-channel report is kept for failures that belong to one channel. Each
 * consumer's own status/error callbacks still run exactly as before, so every
 * degraded-state indicator and recovery read is unchanged.
 */

/** Messages realtimeAdmission.ts raises when the shared socket, not a channel, failed. */
const ADMISSION_TRANSPORT_MESSAGES: ReadonlySet<string> = new Set([
  'Realtime transport closed before admission',
  'Realtime transport/auth admission timed out',
]);

/** True when this channel status is the shared socket failing, not this channel. */
export function isRealtimeTransportLoss(status: string, err?: unknown): boolean {
  if (status !== 'CHANNEL_ERROR') return false;
  if (err === undefined || err === null) return true;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return ADMISSION_TRANSPORT_MESSAGES.has(message);
}

/**
 * One report per OUTAGE. The fan-out is synchronous, but an outage is not one
 * instant: while the socket stays down the MasterBus health monitor retries
 * every dead channel each 30s, and each retry fails the same way. So after a
 * report, nothing more is filed until some channel subscribes again (the
 * socket is back) - or, as a ceiling for a socket that never recovers, until
 * this long has passed, so a stuck client is still visible.
 */
export const TRANSPORT_LOSS_REPORT_CEILING_MS = 10 * 60_000;

let outageReportedAt: number | null = null;

/** Report a shared-socket failure at most once per outage (see above). */
export function noteRealtimeTransportLoss(
  channelName: string,
  source: string,
  err?: unknown,
  now: number = Date.now()
): void {
  if (outageReportedAt !== null && now - outageReportedAt < TRANSPORT_LOSS_REPORT_CEILING_MS)
    return;
  outageReportedAt = now;
  const reason = err instanceof Error && err.message ? err.message : 'socket closed';
  reportError(new Error(`Realtime transport lost (${reason})`), 'Realtime.transport_lost', {
    firstChannel: channelName,
    via: source,
  });
}

/** A channel joined: the socket is up, so the next failure is a new outage. */
export function noteRealtimeTransportRecovered(): void {
  outageReportedAt = null;
}

/**
 * The server's answer when RLS on realtime.messages refuses a private topic.
 * Unlike a transport loss this is permanent for the current identity: the
 * same join will be refused every time until the token (or the topic) changes.
 */
export function isRealtimeTopicRefusal(err?: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /^"?Unauthorized: You do not have permissions to read from this Channel topic/i.test(
    message
  );
}

/** Test-only: forget the current outage. */
export function __resetRealtimeTransportLossForTests(): void {
  outageReportedAt = null;
}
