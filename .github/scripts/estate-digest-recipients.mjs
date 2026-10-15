/**
 * Who the Estate Digest is delivered to in-app (2026-10-15).
 *
 * The digest is a report, not an alert: it names no fault and nothing closes
 * it. The owner account's operational notices are routed to the Production
 * Alerts store and never to his personal inbox
 * (fn_is_owner_operational_notification, migration 20260916111614), so every
 * daily digest addressed to him became a FIRING warning on the alert board:
 * 46 open rows from 2026-09-01 to 2026-10-14, one a day, each a task for the
 * alert fleet with nothing to fix. The digest's archive is the single
 * 'estate-digest' GitHub issue, which this script still updates every day, and
 * every other active platform recipient still receives it in-app.
 *
 * So the owner account is never an in-app recipient of the digest. The
 * exclusion is that one account only; it is never broadened.
 */
export const OWNER_OPERATIONAL_ID = '47965354-0e56-43ef-931c-ddaab82af765';

/** Distinct in-app recipients for the digest: every given user but the owner account. */
export function digestRecipients(userIds) {
  return [...new Set((userIds || []).filter((id) => typeof id === 'string' && id))].filter(
    (id) => id.toLowerCase() !== OWNER_OPERATIONAL_ID
  );
}
