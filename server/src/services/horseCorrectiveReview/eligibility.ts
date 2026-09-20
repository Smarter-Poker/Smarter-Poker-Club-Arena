import { horsePriorActionsDigest } from '../../engine/HorseDecisionHandBinding.js';
import type { CompletedHandObservation } from '../../engine/horseDecision/protocol.js';
import { journalHash } from '../horseDecisionJournal/record.js';
import { evidenceDigest, isVerifiedCorrectiveAuthority, sha256 } from './authority.js';
import type { AcceptedCommitmentEvidence, CorrectiveReviewAuthority } from './contract.js';

export const actorIdValid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function chipCents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) && Math.abs(value * 100 - cents) <= 0.000001 ? cents : null;
}
export type CommitmentEligibility =
  | { status: 'available'; actors: Array<{ id: string; grossBb: number; over: boolean }> }
  | { status: 'unavailable'; reason: string };

/** The signed source export binds the accepted hand and exact transaction
 * bytes independently of the reviewer. Winner/loss and game type do not filter
 * eligibility. A missing refund map is unknown; an absent actor key in a
 * present refund map is zero, matching the accepted transaction contract. */
export function acceptedCommitmentEligibility(
  raw: unknown,
  authority: CorrectiveReviewAuthority | undefined,
  hand: CompletedHandObservation,
  acceptedHandDigest: string
): CommitmentEligibility {
  const no = (reason: string): CommitmentEligibility => ({ status: 'unavailable', reason });
  if (!raw) return no('accepted_commitment_facts_missing');
  if (!isVerifiedCorrectiveAuthority(authority)) return no('trusted_source_authority_missing');
  try {
    if (evidenceDigest(raw) !== authority.commitmentDigest)
      return no('accepted_source_pin_mismatch');
    const e = raw as AcceptedCommitmentEvidence;
    const bb = chipCents(e.bigBlind);
    if (
      e.version !== 1 ||
      e.source !== 'accepted_transaction' ||
      e.committedHandId !== hand.committedHandId ||
      e.acceptedHandRecordDigest !== acceptedHandDigest ||
      e.actionsDigest !== horsePriorActionsDigest(hand.actions ?? []) ||
      e.bigBlind !== hand.bigBlind ||
      bb === null ||
      bb <= 0 ||
      !sha256(e.payloadDigest) ||
      typeof e.payloadText !== 'string' ||
      Buffer.byteLength(e.payloadText) > 262144 ||
      journalHash(e.payloadText) !== e.payloadDigest ||
      !Array.isArray(e.horseActorIds) ||
      e.horseActorIds.length > 10 ||
      e.horseActorIds.some((id) => !actorIdValid(id)) ||
      new Set(e.horseActorIds.map((id) => id.toLowerCase())).size !== e.horseActorIds.length
    )
      return no('accepted_commitment_source_mismatch');
    const facts = JSON.parse(e.payloadText)?.accepted_hand_facts;
    const contributions = facts?.contributions,
      refunds = facts?.returned_uncalled;
    if (
      !contributions ||
      typeof contributions !== 'object' ||
      Array.isArray(contributions) ||
      !refunds ||
      typeof refunds !== 'object' ||
      Array.isArray(refunds)
    )
      return no('accepted_commitment_facts_invalid');
    const actors = [];
    for (const id of e.horseActorIds) {
      const net = chipCents(contributions[id]),
        returned = Object.hasOwn(refunds, id) ? chipCents(refunds[id]) : 0;
      if (
        net === null ||
        returned === null ||
        !Number.isSafeInteger(net + returned) ||
        !hand.actions?.some((a) => a.userId?.toLowerCase() === id.toLowerCase())
      )
        return no('accepted_commitment_actor_unknown');
      const gross = BigInt(net) + BigInt(returned);
      actors.push({
        id: id.toLowerCase(),
        grossBb: Number(gross) / bb,
        over: gross > 10n * BigInt(bb),
      });
    }
    return { status: 'available', actors };
  } catch {
    return no('accepted_commitment_facts_invalid');
  }
}
