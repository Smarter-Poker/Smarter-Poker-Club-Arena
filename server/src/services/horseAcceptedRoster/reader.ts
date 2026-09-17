/** PREPARED, UNEXECUTED retained read-side validation; no producer implementation. */
import { horseCompletedHandKey } from '../../engine/HorseDecisionHandBinding.js';
import {
  validateHorseJournalRecord,
  horseJournalJson,
  journalHash,
} from '../horseDecisionJournal/record.js';
import { reconcileHorseJournalHand } from '../horseDecisionJournal/review.js';
import {
  ROSTER_FIELD,
  PAYLOAD_ROSTER_FIELD,
  readRosterCapsule,
  readReturnedRosterTransport,
  digest,
  sha,
  freeze,
} from './schema.js';
import type {
  UnknownObject,
  AcceptedRoster,
  AcceptedRosterReadRequest,
  AcceptedRosterReadResult,
  PrivateRosterHand,
} from './contract.js';
const no = (reason: string): AcceptedRosterReadResult => ({
  status: 'pending',
  reason,
  producerAuthorityVerified: false,
  completePopulation: false,
});
export function readPrivateAcceptedRoster({
  records,
  handKey,
  acceptedHandRecordDigest,
  payloadText,
  payloadDigest,
}: AcceptedRosterReadRequest): AcceptedRosterReadResult {
  try {
    if (
      !sha(handKey) ||
      !sha(acceptedHandRecordDigest) ||
      !sha(payloadDigest) ||
      !Array.isArray(records) ||
      records.length > 256 ||
      typeof payloadText !== 'string' ||
      Buffer.byteLength(payloadText) > 262144 ||
      journalHash(payloadText) !== payloadDigest
    )
      return no('roster_input_invalid');
    const join = reconcileHorseJournalHand(records, handKey);
    if (
      join.status === 'unavailable' ||
      join.gaps.some((g) =>
        [
          'accepted_hand_conflict',
          'accepted_hand_missing',
          'invalid_records',
          'record_conflict',
        ].includes(g)
      )
    )
      return no('roster_retained_join_invalid');
    const accepted = records.filter((r) => r.kind === 'accepted_hand' && r.handKey === handKey);
    if (!accepted.length || !accepted.some((r) => r.sha256 === acceptedHandRecordDigest))
      return no('roster_accepted_pin_missing');
    const payload = JSON.parse(payloadText) as UnknownObject | null;
    if (!Object.hasOwn(payload ?? {}, PAYLOAD_ROSTER_FIELD))
      return no('accepted_roster_legacy_missing');
    const roster = readRosterCapsule((payload as UnknownObject)[PAYLOAD_ROSTER_FIELD]);
    if (!roster) return no('accepted_roster_schema_invalid');
    let pinnedHand: PrivateRosterHand | undefined;
    const rosterDigest = digest(roster);
    for (const record of accepted) {
      validateHorseJournalRecord(record);
      const hand: PrivateRosterHand = JSON.parse(record.body);
      if (!Object.hasOwn(hand, ROSTER_FIELD)) return no('retained_roster_missing');
      const transport = readReturnedRosterTransport(hand[ROSTER_FIELD]);
      if (!transport) return no('retained_roster_schema_invalid');
      const coordinate = horseCompletedHandKey(hand);
      if (
        !coordinate ||
        coordinate.split(':').slice(0, 2).join(':') !== `${roster.tableId}:${roster.handNumber}` ||
        journalHash(coordinate) !== handKey ||
        hand.committedHandId !== roster.handId ||
        transport.payloadDigest !== payloadDigest ||
        transport.rosterDigest !== rosterDigest ||
        horseJournalJson(transport.roster) !== horseJournalJson(roster)
      )
        return no('retained_roster_binding_mismatch');
      if (record.sha256 === acceptedHandRecordDigest) pinnedHand = hand;
    }
    return freeze<AcceptedRosterReadResult>({
      status: 'structurally_bound',
      producerAuthorityVerified: false,
      completePopulation: false,
      acceptedActorClassification: roster.actors.every((a) => a.classification !== 'unknown')
        ? 'all_present_untrusted'
        : 'partial_unknown',
      roster,
      rosterDigest,
      hand: pinnedHand,
      requestLifecycleVerified: join.requestLifecycleVerified === true,
    });
  } catch {
    return no('roster_retained_evidence_invalid');
  }
}
/** Cross-check exact accepted stack-generation membership; written-only is not
 * exhaustive because lawful cash departures and zero-delta omissions exist.
 * Caller must additionally run the preserved R2 receipt-delta reconciliation. */
export function rosterMatchesAcceptedActors(
  roster: AcceptedRoster,
  players: unknown,
  receipt: unknown
): boolean {
  // This is an untrusted field view only; every array/element used below is
  // checked by the exporter before this membership predicate is invoked.
  const raw = receipt as { request?: { stacks?: unknown } } | null;
  const stacks = raw?.request?.stacks;
  if (
    !Array.isArray(players) ||
    players.length !== roster.actors.length ||
    !Array.isArray(stacks) ||
    stacks.length !== roster.actors.length
  )
    return false;
  const p = new Map<unknown, UnknownObject>(),
    s = new Map<unknown, UnknownObject>();
  for (const player of players as UnknownObject[]) {
    if (p.has(player.userId)) return false;
    p.set(player.userId, player);
  }
  for (const stack of stacks as UnknownObject[]) {
    if (s.has(stack.user_id)) return false;
    s.set(stack.user_id, stack);
  }
  return roster.actors.every(
    (a) =>
      p.get(a.userId)?.seat === a.seat &&
      s.get(a.userId)?.seat_id === a.seatId &&
      s.get(a.userId)?.seat_joined_at === a.seatJoinedAt
  );
}
