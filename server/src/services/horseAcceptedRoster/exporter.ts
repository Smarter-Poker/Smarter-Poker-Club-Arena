/** PREPARED UNEXECUTED PRIVATE ROSTER CANDIDATE R1. Derived from frozen R2. No database client, connection, signer or
 * policy writer. A raw-row file is untrusted input even when its hashes match.
 * Typed server-source overlay; execution and compilation are still pending. */
import {
  horseCompletedHandKey,
  horsePriorActionsDigest,
} from '../../engine/HorseDecisionHandBinding.js';
import { horseJournalJson, journalHash } from '../horseDecisionJournal/record.js';
import { reconcileHorseJournalHand } from '../horseDecisionJournal/review.js';
import { chipCents } from '../horseCorrectiveReview/eligibility.js';

import { readPrivateAcceptedRoster, rosterMatchesAcceptedActors } from './reader.js';

import type { ActionRecord } from '../../types.js';
import type {
  UnknownObject,
  PrivateRosterHand,
  AcceptedSourceRequest,
  AcceptedSourceExport,
  UnavailableAcceptedExport,
  UnsignedAcceptedExport,
  SettlementActorCoverage,
  AcceptedExportSource,
  MonetaryActor,
} from './contract.js';
type RawPayload = {
  accepted_hand_facts?: { contributions?: unknown; returned_uncalled?: unknown };
};
interface CapturedStack {
  user_id: string;
  stack: number;
  stack_before: number;
  seat_id?: string;
  seat_joined_at?: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const MAX_INPUT = 1024 * 1024;
const signedCents = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value)
    ? chipCents(Math.abs(value)) === null
      ? null
      : Math.sign(value) * (chipCents(Math.abs(value)) as number)
    : null;
const object = (v: unknown): v is UnknownObject =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => horseJournalJson(a) === horseJournalJson(b);
function fail(reason: string): never {
  throw new Error(reason);
}
function jsonText(value: unknown, limit: number, reason: string): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value) > limit) fail(reason);
  try {
    return JSON.parse(value);
  } catch {
    return fail(reason);
  }
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
function numberText(value: unknown): number | null {
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    return null;
  return Number(value);
}
function date(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

/** Reconcile the actual stack receipt: written contains seat writes only.
 * Cash departures settle a nonzero delta through departed; zero-delta cash
 * departures are omitted from both maps. Only the captured complete request
 * can establish that omission as a zero-delta no-op. This is structural,
 * unsigned evidence; no current seat, wallet or profile is consulted. */
function reconcileReceiptActors(
  receipt: UnknownObject,
  roster: ReadonlyMap<string, number>
): SettlementActorCoverage {
  const written = receipt.written as UnknownObject; // checked by the caller's exact map validation
  const departed = receipt.departed === undefined ? [] : receipt.departed;
  if (!Array.isArray(departed) || departed.length > 10) fail('settlement_actor_coverage_invalid');
  const missing = [...roster.keys()].filter((id) => !Object.hasOwn(written, id));
  // Preserve the original all-written envelope subset, including older captures
  // with no request field. Never pretend these captured rows proved request math.
  if (!missing.length && !departed.length && !Object.hasOwn(receipt, 'request')) {
    return {
      basis: 'all_roster_written',
      requestReconciled: false,
      writtenActors: roster.size,
      departedCashActors: 0,
      unwrittenZeroDeltaActors: 0,
    };
  }
  const requestView = receipt.request as { stacks?: unknown } | null | undefined;
  const stacks = requestView?.stacks;
  if (
    !object(receipt.request) ||
    !Array.isArray(stacks) ||
    stacks.length !== roster.size ||
    receipt.players !== roster.size ||
    receipt.mode !== 'delta' ||
    !object(receipt.rebased) ||
    Object.keys(receipt.rebased).length > 10 ||
    ((missing.length || departed.length) && receipt.tournament_id !== null)
  )
    fail('settlement_request_invalid');
  const requested = new Map<string, CapturedStack>(),
    seatIds = new Set<string>();
  let exact: boolean | undefined;
  for (const rawStack of stacks as unknown[]) {
    const stack = rawStack as UnknownObject;
    if (
      !object(stack) ||
      !uuid(stack.user_id) ||
      !roster.has(stack.user_id) ||
      requested.has(stack.user_id) ||
      chipCents(stack.stack) === null ||
      chipCents(stack.stack_before) === null
    )
      fail('settlement_request_invalid');
    const hasSeat = Object.hasOwn(stack, 'seat_id'),
      hasJoined = Object.hasOwn(stack, 'seat_joined_at');
    if (
      hasSeat !== hasJoined ||
      (exact !== undefined && exact !== hasSeat) ||
      (hasSeat &&
        (!uuid(stack.seat_id) ||
          !date(stack.seat_joined_at) ||
          seatIds.has(stack.seat_id as string)))
    )
      fail('settlement_request_invalid');
    exact = hasSeat;
    if (hasSeat) seatIds.add(stack.seat_id as string);
    requested.set(stack.user_id, stack as unknown as CapturedStack);
  }
  for (const [id, value] of Object.entries(receipt.rebased as UnknownObject)) {
    if (!Object.hasOwn(written, id) || signedCents(value) === null || value === 0)
      fail('settlement_written_mismatch');
  }
  for (const [id, value] of Object.entries(written)) {
    const stack = requested.get(id) as CapturedStack; // roster/request membership already established
    const cents =
      (chipCents(stack.stack) as number) +
      (Object.hasOwn(receipt.rebased as UnknownObject, id)
        ? (signedCents((receipt.rebased as UnknownObject)[id]) as number)
        : 0);
    if (!Number.isSafeInteger(cents) || chipCents(value) !== cents)
      fail('settlement_written_mismatch');
  }
  const departedIds = new Set<string>();
  for (const rawItem of departed as unknown[]) {
    const item = rawItem as UnknownObject;
    if (
      !object(item) ||
      !uuid(item.user_id) ||
      !uuid(item.club_id) ||
      !requested.has(item.user_id) ||
      departedIds.has(item.user_id) ||
      Object.hasOwn(written, item.user_id) ||
      signedCents(item.delta) === null ||
      item.delta === 0
    )
      fail('settlement_departed_mismatch');
    const stack = requested.get(item.user_id) as CapturedStack;
    if (
      signedCents(item.delta) !==
        (chipCents(stack.stack) as number) - (chipCents(stack.stack_before) as number) ||
      Object.hasOwn(item, 'seat_id') !== exact ||
      Object.hasOwn(item, 'seat_joined_at') !== exact ||
      (exact && (item.seat_id !== stack.seat_id || item.seat_joined_at !== stack.seat_joined_at))
    )
      fail('settlement_departed_mismatch');
    departedIds.add(item.user_id);
  }
  let noops = 0;
  for (const id of missing) {
    if (departedIds.has(id)) continue;
    const stack = requested.get(id) as CapturedStack; // roster/request membership already established
    if (chipCents(stack.stack) !== chipCents(stack.stack_before))
      fail('settlement_actor_coverage_invalid');
    noops++;
  }
  return {
    basis: 'captured_delta_request',
    requestReconciled: true,
    writtenActors: Object.keys(written).length,
    departedCashActors: departedIds.size,
    unwrittenZeroDeltaActors: noops,
  };
}

/** Fixed future SELECT contract only; this module never executes it. Use one
 * authorized REPEATABLE READ READ ONLY transaction, statement_timeout 2000ms,
 * lock_timeout 250ms, an explicit hand/table/number and a bounded connection.
 * Exact PostgreSQL text must survive transport. No current-profile join. */
export const ACCEPTED_SOURCE_SELECT = `
SELECT h.id::text AS hand_id, h.table_id::text AS table_id,
       h.hand_number::text AS hand_number,
       c.hand_id::text AS atomic_hand_id, c.table_id::text AS atomic_table_id,
       c.hand_number::text AS atomic_hand_number,
       h.big_blind::text AS big_blind, h.game_variant AS game_variant,
       h.tournament_id::text AS tournament_id,
       h.actions::text AS actions_text, h.players::text AS players_text,
       c.post_commit_payload::text AS payload_text,
       c.post_commit_payload_hash AS payload_digest,
       c.payload_hash AS core_payload_digest,
       c.post_commit_request_hash AS post_commit_request_digest,
       c.stack_result::text AS stack_result_text,
       c.committed_at::text AS committed_at,
       c.post_commit_completed_at::text AS post_commit_completed_at,
       statement_timestamp()::text AS read_at,
       pg_current_snapshot()::text AS snapshot_id
FROM public.hand_history h
JOIN public.hand_atomic_commits c
  ON c.hand_id = h.id AND c.table_id = h.table_id AND c.hand_number = h.hand_number
WHERE h.id = $1::uuid AND h.table_id = $2::uuid AND h.hand_number = $3::bigint
  AND octet_length(c.post_commit_payload::text) <= 262144
  AND octet_length(h.actions::text) <= 262144
  AND octet_length(h.players::text) <= 32768
  AND octet_length(c.stack_result::text) <= 262144
LIMIT 2`;

/** Retained JSON joins are structural evidence only. An unsigned export can
 * be useful input to the corrective core without acquiring trusted authority. */
export function createUnsignedAcceptedCommitmentExport({
  records,
  handKey,
  acceptedHandRecordDigest,
  rows,
}: AcceptedSourceRequest): AcceptedSourceExport {
  const out: UnavailableAcceptedExport = {
    version: 2,
    references: [],
    sourceExport: {
      version: 1,
      status: 'unavailable',
      inputClass: 'untrusted_raw_row_capture',
      sourceReadVerified: false,
      authorityQualified: false,
      completePopulation: false,
      replayVerified: false,
      gtoVerified: false,
      activationAllowed: false,
      historicalHorsePopulation: 'not_established',
      rosterBasis: 'proposed_private_accepted_actor_roster_v1',
      acceptedActorClassification: 'unknown',
      producerImplementation: 'pending',
      reasons: [
        'trusted_roster_producer_authority_missing',
        'producer_implementation_pending',
        'historical_horse_population_not_established',
      ],
      journal: null,
      source: null,
      actors: [],
    },
  };
  const meta = out.sourceExport;
  try {
    if (
      typeof handKey !== 'string' ||
      !SHA.test(handKey) ||
      typeof acceptedHandRecordDigest !== 'string' ||
      !SHA.test(acceptedHandRecordDigest)
    )
      fail('requested_identity_invalid');
    if (!Array.isArray(rows) || rows.length !== 1) fail('source_row_missing_or_ambiguous');
    // Bound and reject non-portable input before inspecting caller objects.
    const serialized = horseJournalJson(rows[0]);
    if (Buffer.byteLength(serialized) > MAX_INPUT) fail('source_row_exceeds_bounds');
    const row = JSON.parse(serialized) as UnknownObject; // raw fields stay unknown until guards below
    const review = reconcileHorseJournalHand(records, handKey);
    meta.journal = review;
    if (
      review.status === 'unavailable' ||
      review.gaps.some((gap) =>
        [
          'accepted_hand_conflict',
          'accepted_hand_missing',
          'invalid_records',
          'record_conflict',
        ].includes(gap)
      )
    )
      fail('retained_journal_invalid');
    const accepted = records.find(
      (r) => r.sha256 === acceptedHandRecordDigest && r.kind === 'accepted_hand'
    );
    if (!accepted) fail('accepted_record_pin_missing');
    const hand = JSON.parse(accepted.body) as PrivateRosterHand; // actual journal reconciliation checked the retained observation
    const coordinate = horseCompletedHandKey(hand);
    if (!coordinate || journalHash(coordinate) !== handKey)
      fail('retained_hand_coordinate_invalid');
    const [table, number] = coordinate.split(':');
    if (
      !uuid(hand.committedHandId) ||
      !uuid(row.hand_id) ||
      row.hand_id !== hand.committedHandId ||
      row.atomic_hand_id !== row.hand_id ||
      row.table_id !== table ||
      row.atomic_table_id !== table ||
      numberText(row.hand_number) !== Number(number) ||
      row.atomic_hand_number !== row.hand_number
    )
      fail('accepted_source_identity_mismatch');
    if (typeof row.big_blind !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(row.big_blind))
      fail('big_blind_invalid');
    const bigBlind = Number(row.big_blind),
      bb = chipCents(bigBlind);
    if (bb === null || bb <= 0 || bigBlind !== hand.bigBlind) fail('big_blind_mismatch');
    if (
      typeof row.game_variant !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,40}$/.test(row.game_variant) ||
      (row.tournament_id !== null && !uuid(row.tournament_id))
    )
      fail('source_context_invalid');
    if (
      !date(row.committed_at) ||
      !date(row.read_at) ||
      Date.parse(row.committed_at) > Date.parse(row.read_at) ||
      (row.post_commit_completed_at !== null &&
        (!date(row.post_commit_completed_at) ||
          Date.parse(row.post_commit_completed_at) < Date.parse(row.committed_at) ||
          Date.parse(row.post_commit_completed_at) > Date.parse(row.read_at))) ||
      typeof row.snapshot_id !== 'string' ||
      !/^[0-9]+:[0-9]+:([0-9]+(,[0-9]+)*)?$/.test(row.snapshot_id)
    )
      fail('source_state_metadata_invalid');
    if (
      ![row.payload_digest, row.core_payload_digest, row.post_commit_request_digest].every(
        (v) => typeof v === 'string' && SHA.test(v)
      )
    )
      fail('source_receipt_hash_missing');
    const payload = jsonText(row.payload_text, 262144, 'payload_invalid') as RawPayload | null;
    if (journalHash(row.payload_text as string) !== row.payload_digest)
      fail('payload_digest_mismatch');
    const rawActions = jsonText(row.actions_text, 262144, 'source_actions_invalid');
    const actionsDigest = horsePriorActionsDigest(rawActions as readonly unknown[]);
    if (!actionsDigest || !same(rawActions, hand.actions)) fail('full_accepted_actions_mismatch');
    const actions = rawActions as ActionRecord[]; // digest validation proved the full action array
    const players = jsonText(row.players_text, 32768, 'source_roster_invalid');
    if (!Array.isArray(players) || players.length < 2 || players.length > 10)
      fail('source_roster_invalid');
    const roster = new Map<string, number>(),
      seats = new Set<number>();
    for (const rawPlayer of players as unknown[]) {
      const player = rawPlayer as UnknownObject;
      if (
        !object(player) ||
        !uuid(player.userId) ||
        typeof player.seat !== 'number' ||
        !Number.isInteger(player.seat) ||
        player.seat < 1 ||
        player.seat > 10 ||
        roster.has(player.userId) ||
        seats.has(player.seat)
      )
        fail('source_roster_invalid');
      roster.set(player.userId, player.seat);
      seats.add(player.seat);
    }
    if (actions.some((a) => roster.get(a.userId) !== a.seat)) fail('source_action_roster_mismatch');
    const receipt = jsonText(row.stack_result_text, 262144, 'stack_receipt_invalid');
    // Its hand_id is the separate settlement identity, not history_id.
    if (
      !object(receipt) ||
      receipt.success !== true ||
      !uuid(receipt.hand_id) ||
      receipt.table_id !== table ||
      receipt.hand_number !== Number(number) ||
      !object(receipt.written) ||
      receipt.tournament_id !== row.tournament_id
    )
      fail('stack_receipt_identity_mismatch');
    const maps = [
      payload?.accepted_hand_facts?.contributions,
      payload?.accepted_hand_facts?.returned_uncalled,
      receipt.written,
    ];
    for (const map of maps) {
      if (
        !object(map) ||
        Object.keys(map).length > 10 ||
        Object.entries(map).some(([id, amount]) => !roster.has(id) || chipCents(amount) === null)
      )
        fail('accepted_fact_map_invalid');
    }
    const [contributions, refunds] = maps as [UnknownObject, UnknownObject, UnknownObject];
    if ([...roster.keys()].some((id) => !Object.hasOwn(contributions, id)))
      fail('accepted_actor_facts_missing');
    const settlementActorCoverage = reconcileReceiptActors(receipt, roster);
    const rosterRead = readPrivateAcceptedRoster({
      records,
      handKey,
      acceptedHandRecordDigest,
      payloadText: row.payload_text,
      payloadDigest: row.payload_digest,
    });
    if (rosterRead.status !== 'structurally_bound') fail(rosterRead.reason);
    if (!rosterMatchesAcceptedActors(rosterRead.roster, players, receipt))
      fail('roster_exact_accepted_actor_mismatch');
    if (Date.parse(rosterRead.roster.capturedAt) > Date.parse(row.read_at))
      fail('roster_capture_after_read');
    const classified = new Map(rosterRead.roster.actors.map((a) => [a.userId, a.classification]));
    // Neither action origins nor today's profiles can upgrade unknown identities.
    if (
      actions.some(
        (a) =>
          (a.origin === 'horse_policy' || a.origin === 'horse_fallback') &&
          classified.get(a.userId) !== 'horse'
      )
    )
      fail('roster_action_classification_conflict');
    const horseActorIds = rosterRead.roster.actors
      .filter((a) => a.classification === 'horse')
      .map((a) => a.userId);
    meta.acceptedActorClassification = rosterRead.acceptedActorClassification;
    const actors: MonetaryActor[] = horseActorIds.map((id) => {
      const net = chipCents(contributions[id]) as number,
        returned = Object.hasOwn(refunds, id) ? (chipCents(refunds[id]) as number) : 0;
      if (!Number.isSafeInteger(net + returned)) fail('gross_commitment_exceeds_bounds');
      const gross = BigInt(net) + BigInt(returned);
      return {
        actorRef: journalHash(id),
        grossCommittedBb: Number(gross) / bb,
        eligibility: gross > 10n * BigInt(bb) ? 'over_10bb' : 'not_over_10bb',
      };
    });
    const commitments: UnsignedAcceptedExport['commitments'] = {
      version: 2,
      source: 'accepted_transaction_roster_v1',
      committedHandId: hand.committedHandId as string,
      rosterDigest: rosterRead.rosterDigest,
      acceptedHandRecordDigest,
      actionsDigest,
      bigBlind,
      horseActorIds,
      payloadText: row.payload_text as string,
      payloadDigest: row.payload_digest as string,
    };
    const source: AcceptedExportSource = {
      rawRowDigest: journalHash(serialized),
      historyId: row.hand_id as string,
      tableId: table,
      handNumber: Number(number),
      settlementId: receipt.hand_id,
      payloadDigest: row.payload_digest as string,
      corePayloadDigest: row.core_payload_digest as string,
      postCommitRequestDigest: row.post_commit_request_digest as string,
      fullActionsDigest: journalHash(horseJournalJson(actions)),
      gameVariant: row.game_variant as string,
      tournamentId: row.tournament_id as string | null,
      committedAt: row.committed_at as string,
      capturedReadAt: row.read_at as string,
      snapshotId: row.snapshot_id as string,
      postCommitCompletedAt: row.post_commit_completed_at as string | null,
      postCommitObligations:
        row.post_commit_completed_at === null ? 'pending' : 'reported_complete',
      wholeCoreHashRecomputed: false,
      settlementActorCoverage,
      acceptedRoster: rosterRead.roster,
      rosterDigest: rosterRead.rosterDigest,
      requestLifecycleVerified: rosterRead.requestLifecycleVerified,
    };
    // Final bounds before exposing any accepted output state.
    const candidate: UnsignedAcceptedExport = {
      ...out,
      commitments,
      sourceExport: { ...meta, status: 'unsigned_export', source, actors },
    };
    if (Buffer.byteLength(horseJournalJson(candidate)) > 524288) fail('export_exceeds_bounds');
    return candidate;
  } catch (error) {
    const allowed =
      /^(requested_identity_invalid|source_row_missing_or_ambiguous|source_row_exceeds_bounds|retained_journal_invalid|accepted_record_pin_missing|retained_hand_coordinate_invalid|accepted_source_identity_mismatch|big_blind_invalid|big_blind_mismatch|source_context_invalid|source_state_metadata_invalid|source_receipt_hash_missing|payload_invalid|payload_digest_mismatch|source_actions_invalid|full_accepted_actions_mismatch|source_roster_invalid|source_action_roster_mismatch|stack_receipt_invalid|stack_receipt_identity_mismatch|accepted_fact_map_invalid|accepted_actor_facts_missing|accepted_horse_origin_subset_missing|gross_commitment_exceeds_bounds|export_exceeds_bounds|settlement_actor_coverage_invalid|settlement_request_invalid|settlement_written_mismatch|settlement_departed_mismatch|roster_input_invalid|roster_retained_join_invalid|roster_accepted_pin_missing|accepted_roster_legacy_missing|accepted_roster_schema_invalid|retained_roster_missing|retained_roster_schema_invalid|retained_roster_binding_mismatch|roster_retained_evidence_invalid|roster_exact_accepted_actor_mismatch|roster_capture_after_read|roster_action_classification_conflict)$/;
    meta.reasons.push(
      error instanceof Error && allowed.test(error.message)
        ? error.message
        : 'source_export_invalid'
    );
    return out;
  }
}
