/** PREPARED, UNEXECUTED private schema. No current producer emits this contract.
 * A matching schema/hash is structural evidence only, never producer authority. */
import { horseJournalJson, journalHash } from '../horseDecisionJournal/record.js';
import type { UnknownObject, AcceptedRoster, ReturnedRosterTransport } from './contract.js';
export const ROSTER_BYTES = 16384;
export const ROSTER_FIELD = 'acceptedActorRoster';
export const PAYLOAD_ROSTER_FIELD = 'accepted_actor_roster';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA = /^[0-9a-f]{64}$/;
const object = (v: unknown): v is UnknownObject =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: unknown, expected: readonly string[]): v is UnknownObject =>
  object(v) && Object.keys(v).sort().join('|') === [...expected].sort().join('|');
export const sha = (v: unknown): v is string => typeof v === 'string' && SHA.test(v);
export const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
export const date = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v));
export const digest = (v: unknown): string => journalHash(horseJournalJson(v));
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}
export function readRosterCapsule(raw: unknown): AcceptedRoster | null {
  try {
    const text = horseJournalJson(raw);
    if (Buffer.byteLength(text) > ROSTER_BYTES) return null;
    const r: unknown = JSON.parse(text);
    if (
      !keys(r, ['version', 'basis', 'tableId', 'handId', 'handNumber', 'capturedAt', 'actors']) ||
      r.version !== 1 ||
      r.basis !== 'profiles_read_in_acceptance_transaction' ||
      !uuid(r.tableId) ||
      !uuid(r.handId) ||
      typeof r.handNumber !== 'number' ||
      !Number.isSafeInteger(r.handNumber) ||
      r.handNumber < 1 ||
      !date(r.capturedAt) ||
      !Array.isArray(r.actors) ||
      r.actors.length < 2 ||
      r.actors.length > 10
    )
      return null;
    const seats = new Set<number>(),
      seatIds = new Set<string>();
    let previous = '';
    for (const a of r.actors as unknown[]) {
      if (
        !keys(a, ['userId', 'seat', 'seatId', 'seatJoinedAt', 'classification', 'status']) ||
        !uuid(a.userId) ||
        a.userId <= previous ||
        typeof a.seat !== 'number' ||
        !Number.isInteger(a.seat) ||
        a.seat < 1 ||
        a.seat > 10 ||
        seats.has(a.seat) ||
        !uuid(a.seatId) ||
        seatIds.has(a.seatId) ||
        !date(a.seatJoinedAt) ||
        Date.parse(a.seatJoinedAt) > Date.parse(r.capturedAt) ||
        !(
          ((a.classification === 'horse' || a.classification === 'human') &&
            a.status === 'canonical_boolean') ||
          (a.classification === 'unknown' &&
            (a.status === 'profile_missing' || a.status === 'classification_null'))
        )
      )
        return null;
      previous = a.userId;
      seats.add(a.seat);
      seatIds.add(a.seatId);
    }
    // All fields and actor relationships were checked above; own the parsed JSON.
    return freeze(r as unknown as AcceptedRoster);
  } catch {
    return null;
  }
}
/** Only copies a proposed private accepted-response capsule. It does not look
 * up profiles, generate a roster, or label the response trusted. No public wire. */
export function readReturnedRosterTransport(raw: unknown): ReturnedRosterTransport | null {
  try {
    if (
      !keys(raw, ['version', 'payloadDigest', 'rosterDigest', 'roster']) ||
      raw.version !== 1 ||
      !sha(raw.payloadDigest) ||
      !sha(raw.rosterDigest)
    )
      return null;
    const roster = readRosterCapsule(raw.roster);
    if (!roster || digest(roster) !== raw.rosterDigest) return null;
    return freeze({
      version: 1,
      payloadDigest: raw.payloadDigest,
      rosterDigest: raw.rosterDigest,
      roster,
    });
  } catch {
    return null;
  }
}
