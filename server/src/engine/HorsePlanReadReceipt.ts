import { horseJournalJson, journalHash } from '../services/horseDecisionJournal/record.js';
import { decodeHorseDecisionReads, type HorseDecisionReadFrame } from './HorseDecisionReadFrame.js';
import { horseObserverReadContextFromRequest } from './HorseObserverReadContext.js';
import { horsePlanContextFromDecision, horsePlanContextKey } from './HorsePlanHandIdentity.js';
import {
  buildHorseDecisionKey,
  type FastHorseDecisionRequest,
  type DeepHorseDecisionRequest,
} from './horseDecision/protocol.js';

type Request = FastHorseDecisionRequest | DeepHorseDecisionRequest;
type Kind = 'barrel' | 'outlook' | 'raise';
const KINDS = ['barrel', 'outlook', 'raise'] as const;
// -1 is not consulted; 0 is an actual undefined return. FALSE is not absent.
const VALUES: readonly (readonly unknown[])[] = [
  [undefined, false, true],
  [undefined, 'good', 'scare', 'blank'],
  [undefined, 'commit', 'callOnce', 'foldToRaise'],
];
export const HORSE_PLAN_READ_RECEIPT_MAX_BYTES = 1024;
export interface HorsePlanReadReceipt {
  version: 'horse-plan-read-v1';
  status: 'observed' | 'not_reached' | 'outside_domain' | 'refused';
  inputSha256: string;
  readFrameSha256: string | null;
  lookups: [number, number, number];
}
const supported = (r: Request) =>
  ['nlh', 'plo4', 'plo5', 'plo6', 'plo8'].includes(r.gameState.gameVariant) &&
  ['flop', 'turn', 'river'].includes(r.gameState.stage) &&
  (r.gameState.boardCount ?? 1) === 1 &&
  !(r.gameState.communityCards2?.length || r.gameState.communityCards3?.length);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));

/** One chooser invocation; no global sink, extra getter, sampling or policy option. */
export class HorsePlanReadCapture {
  private readonly lookups: [number, number, number] = [-1, -1, -1];
  private refused = false;
  constructor(private readonly request: Request) {}

  note(kind: Kind, handKey: string | null, actor: string, street: string, value: unknown): void {
    try {
      if (!supported(this.request)) return;
      const index = KINDS.indexOf(kind);
      const expectedStreet =
        kind === 'outlook'
          ? this.request.gameState.stage === 'turn'
            ? 'flop'
            : this.request.gameState.stage === 'river'
              ? 'turn'
              : null
          : this.request.gameState.stage;
      const code = VALUES[index]?.indexOf(value) ?? -1;
      if (
        index < 0 ||
        code < 0 ||
        this.lookups[index] !== -1 ||
        handKey !== horsePlanContextKey(horsePlanContextFromDecision(this.request)) ||
        handKey === null ||
        actor !== this.request.player.user_id ||
        street !== expectedStreet
      ) {
        this.refused = true;
        return;
      }
      this.lookups[index] = code;
    } catch {
      this.refused = true;
    }
  }

  refuse(): void {
    this.refused = true;
  }

  finish(readFrameSha256: string | null): HorsePlanReadReceipt | undefined {
    try {
      const status = !supported(this.request)
        ? 'outside_domain'
        : this.refused || !readFrameSha256
          ? 'refused'
          : this.lookups.some((n) => n !== -1)
            ? 'observed'
            : 'not_reached';
      const receipt: HorsePlanReadReceipt = {
        version: 'horse-plan-read-v1',
        status,
        inputSha256: journalHash(horseJournalJson(this.request)),
        readFrameSha256,
        lookups: status === 'observed' ? [...this.lookups] : [-1, -1, -1],
      };
      return Buffer.byteLength(JSON.stringify(receipt)) <= HORSE_PLAN_READ_RECEIPT_MAX_BYTES
        ? receipt
        : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Validate original getter returns against its original bounded read frame.
 * Never executes HorseLogic, getters, effects, RNG or a historical policy. */
export function horsePlanReadsAreValid(
  value: unknown,
  request: Request,
  frame: HorseDecisionReadFrame | null
): value is HorsePlanReadReceipt {
  try {
    if (
      !exact(value, ['version', 'status', 'inputSha256', 'readFrameSha256', 'lookups']) ||
      value.version !== 'horse-plan-read-v1' ||
      !['observed', 'not_reached', 'outside_domain', 'refused'].includes(value.status as string) ||
      value.inputSha256 !== journalHash(horseJournalJson(request)) ||
      value.readFrameSha256 !== (frame?.sha256 ?? null) ||
      !Array.isArray(value.lookups) ||
      value.lookups.length !== 3 ||
      value.lookups.some((n, i) => !Number.isInteger(n) || n < -1 || n >= VALUES[i]!.length) ||
      Buffer.byteLength(JSON.stringify(value)) > HORSE_PLAN_READ_RECEIPT_MAX_BYTES
    )
      return false;
    if (!supported(request))
      return value.status === 'outside_domain' && value.lookups.every((n) => n === -1);
    if (value.status === 'outside_domain') return false;
    if (value.status === 'refused') return value.lookups.every((n) => n === -1);
    const context = horsePlanContextFromDecision(request),
      handKey = horsePlanContextKey(context);
    if (
      !frame ||
      !handKey ||
      !horseObserverReadContextFromRequest(request) ||
      request.decisionKey !== buildHorseDecisionKey(request)
    )
      return false;
    const view = decodeHorseDecisionReads(frame, request.gameState.players, handKey, context);
    if ((value.status === 'not_reached') !== value.lookups.every((n) => n === -1)) return false;
    const actorKey = `${handKey}|${request.player.user_id}`,
      stage = request.gameState.stage;
    const prev = stage === 'turn' ? 'flop' : stage === 'river' ? 'turn' : null;
    const card = request.gameState.communityCards.at(-1);
    const outlook = prev ? view.outlooks.get(`${actorKey}|${prev}`) : undefined;
    const cardKey = card ? `${card.rank}${card.suit[0]}` : null;
    const returned = [
      view.plans.get(actorKey),
      outlook && cardKey
        ? outlook.good.has(cardKey)
          ? 'good'
          : outlook.scare.has(cardKey)
            ? 'scare'
            : 'blank'
        : undefined,
      view.raisePlans.get(`${actorKey}|${stage}`),
    ];
    return value.lookups.every(
      (code, i) =>
        code === -1 ||
        ((i !== 1 || (prev !== null && request.gameState.communityCards.length >= 4)) &&
          code === VALUES[i]!.indexOf(returned[i]))
    );
  } catch {
    return false;
  }
}
