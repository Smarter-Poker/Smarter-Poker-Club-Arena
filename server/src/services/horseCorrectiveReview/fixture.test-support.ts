import { generateKeyPairSync, sign } from 'node:crypto';
import { jointPolicyFixture } from '../../engine/multiway/JointRangeFixture.test-support.js';
import {
  captureHorseHandJournalContext,
  horsePriorActionsDigest,
} from '../../engine/HorseDecisionHandBinding.js';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
} from '../../engine/HorseExecutionWitness.js';
import { encodeHorseDecisionReads } from '../../engine/HorseDecisionReadFrame.js';
import { HorseMind } from '../../engine/HorseMind.js';
import { calculatePots, calculateContestablePot } from '../../engine/PokerEngine.js';
import {
  buildHorseDecisionKey,
  type FastHorseDecisionRequest,
  type CompletedHandObservation,
} from '../../engine/horseDecision/protocol.js';
import {
  horseJournalJson,
  journalHash,
  makeHorseJournalRecord,
  type HorseJournalRecord,
} from '../horseDecisionJournal/record.js';
import { authoritySigningBytes, evidenceDigest, verifyCorrectiveAuthority } from './authority.js';
import { correctiveReferenceBinding, correctiveUtilityContextDigest } from './review.js';
import type {
  AcceptedCommitmentEvidence,
  AlternativeActionReference,
  CorrectiveReviewAuthority,
} from './contract.js';

export const TABLE = '10000000-0000-4000-8000-000000000001';
export const HAND = '30000000-0000-4000-8000-000000000001';
export const HAND_KEY = journalHash(`${TABLE}:12:9`);
const keyPair = generateKeyPairSync('ed25519');
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
export const TRUSTED_KEY_DIGEST = journalHash(
  keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
);

export function authorize(commitments: unknown, references: readonly unknown[]) {
  const authority: CorrectiveReviewAuthority = {
    version: 1,
    role: 'accepted_source_and_counterfactual_reference',
    handKey: HAND_KEY,
    qualificationId: 'synthetic-counterfactual-fixture',
    evidenceClass: 'synthetic_fixture',
    commitmentDigest: evidenceDigest(commitments),
    referenceDigests: references.map(evidenceDigest),
  };
  const envelope = {
    authority,
    publicKeyPem,
    signature: sign(null, authoritySigningBytes(authority), keyPair.privateKey).toString('base64'),
  };
  return { envelope, authority: verifyCorrectiveAuthority(envelope, TRUSTED_KEY_DIGEST)! };
}

export function correctiveFixture(
  variant: Parameters<typeof jointPolicyFixture>[0] = 'nlh',
  format: 'cash' | 'mtt' | 'sng' | 'spin' | 'hu_sng' = 'cash'
) {
  const raw = jointPolicyFixture(variant, 1, format === 'cash' ? 'cash' : 'tournament', 'flop');
  const { hero, state } = JSON.parse(JSON.stringify(raw), (key, value) =>
    typeof value === 'string' && /^p[0-9]$/.test(value)
      ? `20000000-0000-4000-8000-00000000000${Number(value.slice(1)) + 1}`
      : value
  ) as typeof raw;
  const opponent = state.players.find((p) => p.seat !== hero.seat)!;
  state.players[state.players.findIndex((p) => p.seat === hero.seat)] = hero;
  state.players = [hero, opponent];
  state.dealtSeatIds = [hero.seat, opponent.seat];
  state.dealerSeat = opponent.seat;
  state.format = format;
  hero.bet = 0;
  hero.totalInvested = 20;
  opponent.bet = 1;
  opponent.totalInvested = 21;
  opponent.stack = 0;
  opponent.is_all_in = true;
  state.bigBlind = 1;
  state.pot = 41;
  state.pots = calculatePots(state.players);
  state.contestablePot = calculateContestablePot(state.players, hero.user_id, 1);
  state.toCall = 1;
  state.currentBet = 1;
  state.legalActions = ['fold', 'call'];
  state.minRaiseTo = null;
  state.maxRaiseTo = null;
  state.actionHistory = [
    {
      seat: opponent.seat,
      userId: opponent.user_id,
      action: 'raise',
      amount: 20,
      timestamp: 1,
      stage: 'preflop',
    },
    {
      seat: hero.seat,
      userId: hero.user_id,
      action: 'call',
      amount: 20,
      timestamp: 2,
      stage: 'preflop',
    },
    {
      seat: opponent.seat,
      userId: opponent.user_id,
      action: 'all_in',
      amount: 1,
      timestamp: 3,
      stage: 'flop',
    },
  ];
  const snapshot: FastHorseDecisionRequest = {
    type: 'DECIDE_FAST',
    requestId: 1,
    generation: 7,
    fence: `${TABLE}:12:${hero.seat}:9:7`,
    decisionTimeMs: 1000,
    decisionKey: '',
    player: hero,
    gameState: state,
    handJournalContext: captureHorseHandJournalContext(state.actionHistory),
  };
  snapshot.decisionKey = buildHorseDecisionKey(snapshot);
  const decision = { action: 'call' as const, thinkTime: 10 };
  const capture = {
    snapshot,
    readFrame: encodeHorseDecisionReads(
      HorseMind.createSandbox(),
      state.players,
      HorseMind.handKeyOf(state.actionHistory)
    ),
    decision,
    effects: [],
    rngBefore: 1,
    rngAfter: 2,
    computeMs: 1,
    governorScale: 1,
    runtimePins: 'incomplete',
  };
  const witness = createHorseExecutionWitness(snapshot, decision, {
    requestId: 1,
    lane: 'fast',
    computeMs: 1,
    governorScale: 1,
  });
  const accepted = {
    seat: hero.seat,
    userId: hero.user_id,
    action: 'call' as const,
    amount: 1,
    timestamp: 1001,
    stage: 'flop' as const,
  };
  settleHorseExecutionWitness(witness, {
    applied: true,
    acceptedActions: [{ record: accepted, intended: true }],
  });
  const ordinal = state.actionHistory.length;
  const hand: CompletedHandObservation = {
    generation: 12,
    fence: `${TABLE}:12:9:observe`,
    handKey: `${TABLE}:12`,
    committedHandId: HAND,
    bigBlind: 1,
    actions: [
      ...state.actionHistory.map((a) => ({ ...a, origin: 'player' as const })),
      {
        ...accepted,
        origin: 'horse_policy',
        publicNode: { version: 1, status: 'captured', actorSeat: hero.seat, street: 'flop' } as any,
        observationIdentity: {
          version: 1,
          status: 'bound',
          handId: HAND,
          actionOrdinal: ordinal,
          observationId: `${HAND}:${ordinal}`,
          sessionKey: 'a'.repeat(64),
        },
      },
    ],
  };
  const turn = journalHash(
    JSON.stringify([
      snapshot.generation,
      snapshot.fence,
      snapshot.requestId,
      snapshot.decisionKey,
      snapshot.decisionTimeMs,
    ])
  );
  const make = (kind: HorseJournalRecord['kind'], sequence: number, payload: unknown) =>
    makeHorseJournalRecord(
      {
        producerId: '40000000-0000-4000-8000-000000000001',
        sequence,
        atMs: 2000,
        sourceRelease: 'a'.repeat(40),
        kind,
        handKey: HAND_KEY,
        turnKey: kind === 'accepted_hand' ? HAND_KEY : turn,
      },
      payload
    );
  const records = [
    make('decision', 1, capture),
    make('execution', 2, witness),
    make('accepted_hand', 3, hand),
  ];
  const payloadText = JSON.stringify({
    accepted_hand_facts: {
      contributions: { [hero.user_id]: 21, [opponent.user_id]: 21 },
      returned_uncalled: {},
    },
  });
  const commitments: AcceptedCommitmentEvidence = {
    version: 1,
    source: 'accepted_transaction',
    committedHandId: HAND,
    acceptedHandRecordDigest: records[2]!.sha256,
    actionsDigest: horsePriorActionsDigest(hand.actions!)!,
    bigBlind: 1,
    horseActorIds: [hero.user_id],
    payloadText,
    payloadDigest: journalHash(payloadText),
  };
  const reference: AlternativeActionReference = {
    version: 1,
    sourceId: 'synthetic-only',
    qualificationId: 'synthetic-counterfactual-fixture',
    basis: 'counterfactual',
    method: 'exact_enumeration',
    causal: true,
    complete: true,
    informationSet: 'original_decision_only',
    utility: {
      unit: format === 'cash' ? 'net_chip_bb' : 'net_tournament_utility',
      costsIncluded: true,
      contextDigest: correctiveUtilityContextDigest(snapshot),
    },
    binding: correctiveReferenceBinding(records[0]!, records[1]!, records[2]!),
    uncertainty: { familyWiseConfidence: 1, independentSamples: 1, simultaneous: true },
    alternatives: [
      { choice: { action: 'fold', amount: 0 }, mean: 0, lower: 0, upper: 0 },
      { choice: { action: 'call', amount: 1 }, mean: -1, lower: -1, upper: -1 },
    ],
  };
  return { records, commitments, reference, snapshot, hand, hero, make, capture, witness };
}
