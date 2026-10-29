import { horseJournalJson, journalHash } from '../services/horseDecisionJournal/record.js';
import type { SeatPlayer } from '../types.js';
import type { OppPostflopRead } from './HorseEval.js';
import type {
  FastHorseDecisionRequest,
  DeepHorseDecisionRequest,
} from './horseDecision/protocol.js';

export const HORSE_RANGE_RECEIPT_MAX_BYTES = 4096;
const VARIANTS = ['nlh', 'plo4', 'plo5', 'plo6', 'plo8'] as const;
type Request = FastHorseDecisionRequest | DeepHorseDecisionRequest;
/** Original-player index, band lo/hi, aggrW, checked, bigBet, streets,
 * lastFrac, raised, strictPressureRange, actual tier (null if not reached),
 * flags: 1 opponent reached, 2 band branch, 4 conditioner branch, 8 bigBet read.
 * These are supplied/consumed public inputs, never sampled opponent cards. */
export type HorseRangeConsumptionRow = [
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number,
];
export interface HorseRangeSampleUse {
  readonly board: number;
  readonly inputs: readonly HorseRangeConsumptionRow[];
  reachedMask: number;
  bandMask: number;
  conditionedMask: number;
  bigBetMask: number;
  tierMask: number;
  tiers: number;
  samples: number;
  invalidDeck: boolean;
}
export interface HorseRangeConsumptionReceipt {
  version: 'horse-range-consumption-v1';
  status: 'observed' | 'not_reached' | 'outside_domain' | 'refused';
  inputSha256: string;
  readFrameSha256: string | null;
  variant: string;
  street: string;
  heroIndex: number;
  calls: Array<{
    board: number;
    samples: number;
    status: 'sampled' | 'invalid_deck';
    opponents: HorseRangeConsumptionRow[];
  }>;
}
const supported = (request: Request) =>
  (VARIANTS as readonly string[]).includes(request.gameState.gameVariant) &&
  ['flop', 'turn', 'river'].includes(request.gameState.stage);
const bit = (value: boolean | undefined): number | null =>
  value === undefined ? null : value ? 1 : 0;
const exact = (x: unknown, keys: readonly string[]): x is Record<string, unknown> =>
  !!x &&
  typeof x === 'object' &&
  !Array.isArray(x) &&
  Object.keys(x).length === keys.length &&
  keys.every((k) => Object.hasOwn(x, k));
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const integer = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const nullable = (x: unknown, test: (x: unknown) => boolean) => x === null || test(x);
const bool = (x: unknown) => x === 0 || x === 1;
const opponentIndices = (request: Request) =>
  request.gameState.players
    .map((p, index) => ({ p, index }))
    .filter(
      ({ p }) =>
        p.seat !== request.player.seat && !p.is_folded && (!p.is_sitting_out || p.is_all_in)
    )
    .map(({ index }) => index);

/** One synchronous chooser invocation owns this bounded object. No global sink,
 * extra sampling, callbacks, timers, IPC field or strategy option is introduced. */
export class HorseRangeConsumptionCapture {
  private readonly calls: HorseRangeSampleUse[] = [];
  private refused = false;
  constructor(private readonly request: Request) {}

  begin(
    board: number,
    players: readonly SeatPlayer[],
    opponents: readonly SeatPlayer[],
    count: number,
    bands: Array<[number, number] | null> | undefined,
    reads: Array<OppPostflopRead | null> | undefined
  ): HorseRangeSampleUse | undefined {
    if (!supported(this.request)) return undefined;
    try {
      if (
        !integer(board) ||
        board > 2 ||
        this.calls.length >= 3 ||
        this.calls.some((c) => c.board === board) ||
        !integer(count) ||
        count < 1 ||
        count > 9 ||
        count > opponents.length
      ) {
        this.refused = true;
        return undefined;
      }
      const inputs: HorseRangeConsumptionRow[] = [];
      for (let i = 0; i < count; i++) {
        const band = bands?.[i],
          read = reads?.[i];
        inputs.push([
          players.indexOf(opponents[i]!),
          band?.[0] ?? null,
          band?.[1] ?? null,
          read?.aggrW ?? null,
          read?.checked ?? null,
          bit(read?.bigBet),
          read?.streets ?? null,
          read?.lastFrac ?? null,
          bit(read?.raised),
          bit(read?.strictPressureRange),
          null,
          0,
        ]);
      }
      const call: HorseRangeSampleUse = {
        board,
        inputs,
        reachedMask: 0,
        bandMask: 0,
        conditionedMask: 0,
        bigBetMask: 0,
        tierMask: 0,
        tiers: 0,
        samples: 0,
        invalidDeck: false,
      };
      this.calls.push(call);
      return call;
    } catch {
      this.refused = true;
      return undefined;
    }
  }

  finish(readFrameSha256: string | null): HorseRangeConsumptionReceipt | undefined {
    try {
      const receipt: HorseRangeConsumptionReceipt = {
        version: 'horse-range-consumption-v1',
        status: !supported(this.request)
          ? 'outside_domain'
          : this.refused || !readFrameSha256
            ? 'refused'
            : this.calls.length
              ? 'observed'
              : 'not_reached',
        inputSha256: journalHash(horseJournalJson(this.request)),
        readFrameSha256,
        variant: this.request.gameState.gameVariant,
        street: this.request.gameState.stage,
        heroIndex: this.request.gameState.players.findIndex(
          (p) => p.seat === this.request.player.seat && p.user_id === this.request.player.user_id
        ),
        calls: this.calls.map((c) => ({
          board: c.board,
          samples: c.samples,
          status: c.invalidDeck ? 'invalid_deck' : 'sampled',
          opponents: c.inputs.map((row, i) => {
            const mask = 1 << i;
            return [
              ...row.slice(0, 10),
              c.tierMask & mask ? (c.tiers >>> (2 * i)) & 3 : null,
              Number(!!(c.reachedMask & mask)) |
                (Number(!!(c.bandMask & mask)) << 1) |
                (Number(!!(c.conditionedMask & mask)) << 2) |
                (Number(!!(c.bigBetMask & mask)) << 3),
            ] as HorseRangeConsumptionRow;
          }),
        })),
      };
      if (!rangeReceiptIsValid(receipt, this.request, readFrameSha256, receipt.inputSha256))
        return undefined;
      return receipt;
    } catch {
      // Missing diagnostics never change a computed action or admit a receipt.
      return undefined;
    }
  }
}

/** Original producer evidence only. Absence/invalidity remains unknown; this
 * function never calls a current policy to reconstruct historical behavior. */
export function horseRangeConsumptionIsValid(
  value: unknown,
  request: Request,
  readFrameSha256: string | null
): value is HorseRangeConsumptionReceipt {
  try {
    return rangeReceiptIsValid(
      value,
      request,
      readFrameSha256,
      journalHash(horseJournalJson(request))
    );
  } catch {
    return false;
  }
}

function rangeReceiptIsValid(
  value: unknown,
  request: Request,
  readFrameSha256: string | null,
  originalInputSha256: string
): value is HorseRangeConsumptionReceipt {
  try {
    if (
      !exact(value, [
        'version',
        'status',
        'inputSha256',
        'readFrameSha256',
        'variant',
        'street',
        'heroIndex',
        'calls',
      ]) ||
      value.version !== 'horse-range-consumption-v1' ||
      !['observed', 'not_reached', 'outside_domain', 'refused'].includes(value.status as string) ||
      value.inputSha256 !== originalInputSha256 ||
      value.readFrameSha256 !== readFrameSha256 ||
      (readFrameSha256 !== null && !/^[a-f0-9]{64}$/.test(readFrameSha256)) ||
      value.variant !== request.gameState.gameVariant ||
      value.street !== request.gameState.stage ||
      value.heroIndex !==
        request.gameState.players.findIndex(
          (p) => p.seat === request.player.seat && p.user_id === request.player.user_id
        ) ||
      !integer(value.heroIndex) ||
      value.heroIndex > 9 ||
      !Array.isArray(value.calls) ||
      value.calls.length > 3 ||
      Buffer.byteLength(JSON.stringify(value)) > HORSE_RANGE_RECEIPT_MAX_BYTES
    )
      return false;
    if (value.status === 'outside_domain') return !supported(request) && value.calls.length === 0;
    if (!supported(request)) return false;
    if (value.status === 'not_reached') return readFrameSha256 !== null && value.calls.length === 0;
    if (value.status === 'observed' && (readFrameSha256 === null || value.calls.length === 0))
      return false;
    const order = opponentIndices(request);
    const boards = [
      request.gameState.communityCards,
      request.gameState.communityCards2,
      request.gameState.communityCards3,
    ].filter((b) => Array.isArray(b) && b.length >= 3);
    const seen = new Set<number>();
    for (const call of value.calls) {
      if (
        !exact(call, ['board', 'samples', 'status', 'opponents']) ||
        !integer(call.board) ||
        call.board >= boards.length ||
        seen.has(call.board) ||
        !integer(call.samples) ||
        !['sampled', 'invalid_deck'].includes(call.status as string) ||
        (call.status === 'sampled' ? call.samples === 0 : call.samples !== 0) ||
        !Array.isArray(call.opponents) ||
        !call.opponents.length ||
        call.opponents.length > 9 ||
        call.opponents.length > order.length
      )
        return false;
      seen.add(call.board);
      for (let i = 0; i < call.opponents.length; i++) {
        const row = call.opponents[i];
        if (
          !Array.isArray(row) ||
          row.length !== 12 ||
          row[0] !== order[i] ||
          !nullable(row[1], (x) => finite(x) && x <= 1) ||
          !nullable(row[2], (x) => finite(x) && x <= 1) ||
          (row[1] === null) !== (row[2] === null) ||
          (row[1] !== null && row[1] > row[2]) ||
          !nullable(row[3], finite) ||
          !nullable(row[4], integer) ||
          !nullable(row[5], bool) ||
          !nullable(row[6], integer) ||
          !nullable(row[7], finite) ||
          !nullable(row[8], bool) ||
          !nullable(row[9], bool) ||
          !nullable(row[10], (x) => integer(x) && x <= 3) ||
          !integer(row[11]) ||
          row[11] > 15 ||
          (row[11] & 14 && !(row[11] & 1)) ||
          (row[11] & 2 && row[1] === null) ||
          (row[11] & 12 && row[3] === null) ||
          (row[10] !== null && (!(row[11] & 1) || request.gameState.gameVariant === 'nlh')) ||
          (call.status === 'invalid_deck' && (row[11] !== 0 || row[10] !== null))
        )
          return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
