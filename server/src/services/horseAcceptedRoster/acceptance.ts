/** P14.2: read the accepted roster the settlement door returns on its private
 * success receipt and copy it into the private completed-hand transport.
 *
 * The door (fn_ca_commit_hand_settlement, first acceptance only) builds the
 * capsule inside the settlement transaction from the dealt seat generations
 * and profiles read in that transaction and records it ONLY in the separately
 * protected discriminator row (smarter_private.accepted_hand_rosters), bound to
 * the unchanged post_commit_payload_hash; the payload itself never carries it.
 * A replay returns that stored row unchanged. This module
 * never looks up a profile, never generates a roster and never labels it
 * trusted: it only checks the returned shape and its binding to the hand the
 * engine just committed. It never throws. */
import { digest, freeze, readReturnedRosterTransport, readRosterCapsule, sha } from './schema.js';
import type { ReturnedRosterTransport, UnknownObject } from './contract.js';

export const ACCEPTED_ROSTER_PRODUCER_VERSION = 'accepted_hand_roster_v1';
export const ACCEPTED_ROSTER_RESULT_FIELD = 'accepted_roster';
const STATUS = ['captured', 'unavailable', 'legacy_missing'] as const;
const KEYS = ['version', 'status', 'reasons', 'payloadDigest', 'producerVersion', 'roster'];
const REASON = /^[A-Za-z0-9_:.-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AcceptedRosterBinding {
  tableId: string;
  handNumber: number;
  /** hand_history.id returned by the accepted transaction. */
  historyId: string;
  /** post_commit_payload_hash on the same receipt, when the receipt carries one. */
  payloadDigest?: unknown;
}
export type AcceptedRosterReturn =
  | { status: 'captured'; transport: ReturnedRosterTransport }
  | { status: 'unavailable' | 'legacy_missing'; reasons: string[] }
  | { status: 'malformed'; reason: string };

const object = (v: unknown): v is UnknownObject =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const malformed = (reason: string): AcceptedRosterReturn => ({ status: 'malformed', reason });

export function readAcceptedRosterReturn(
  raw: unknown,
  binding: AcceptedRosterBinding
): AcceptedRosterReturn {
  try {
    if (!object(raw) || Object.keys(raw).sort().join('|') !== [...KEYS].sort().join('|'))
      return malformed('accepted_roster_shape_invalid');
    if (raw.version !== 1) return malformed('accepted_roster_version_invalid');
    if (raw.producerVersion !== ACCEPTED_ROSTER_PRODUCER_VERSION)
      return malformed('accepted_roster_producer_invalid');
    if (!(STATUS as readonly unknown[]).includes(raw.status))
      return malformed('accepted_roster_status_invalid');
    const reasons = raw.reasons;
    if (
      !Array.isArray(reasons) ||
      reasons.length > 16 ||
      !reasons.every((r) => typeof r === 'string' && REASON.test(r))
    )
      return malformed('accepted_roster_reasons_invalid');
    if (
      raw.payloadDigest !== null &&
      (!sha(raw.payloadDigest) ||
        (binding.payloadDigest !== undefined && binding.payloadDigest !== raw.payloadDigest))
    )
      return malformed('accepted_roster_payload_digest_mismatch');
    if (raw.status !== 'captured') {
      if (raw.roster !== null) return malformed('accepted_roster_unexpected_roster');
      return freeze({
        status: raw.status as 'unavailable' | 'legacy_missing',
        reasons: [...(reasons as string[])],
      });
    }
    if (raw.payloadDigest === null) return malformed('accepted_roster_payload_digest_mismatch');
    const roster = readRosterCapsule(raw.roster);
    if (!roster) return malformed('accepted_roster_capsule_invalid');
    if (
      !UUID.test(binding.tableId) ||
      !UUID.test(binding.historyId) ||
      roster.tableId !== binding.tableId.toLowerCase() ||
      roster.handNumber !== binding.handNumber ||
      roster.handId !== binding.historyId.toLowerCase()
    )
      return malformed('accepted_roster_binding_mismatch');
    // rosterDigest is the canonical Horse JSON digest readReturnedRosterTransport
    // verifies; payloadDigest stays the PostgreSQL raw-text digest of the stored
    // post-commit payload. The two are never compared with each other.
    const transport = readReturnedRosterTransport({
      version: 1,
      payloadDigest: raw.payloadDigest,
      rosterDigest: digest(roster),
      roster,
    });
    if (!transport) return malformed('accepted_roster_transport_invalid');
    return freeze({ status: 'captured', transport });
  } catch {
    return malformed('accepted_roster_unreadable');
  }
}
