/** Explicit offline accepted-hand oracle reader. Hidden accepted holdings are
 * used only by the independent terminal oracle, never by the decision model.
 * Missing accepted holdings stay unavailable; callers may not drop those hands
 * and call the remaining selection a complete independent holdout. */
import pg from 'pg';
import tls from 'node:tls';
import type { Card } from '../../types.js';
import type { HorseJournalRecord } from '../horseDecisionJournal/record.js';
import { horseJournalJson } from '../horseDecisionJournal/record.js';
import { ACCEPTED_SOURCE_SELECT } from '../horseAcceptedRoster/exporter.js';
import { SUPABASE_ROOT_2021_CA } from '../supabase/enginePgSession.js';
import { rebuildCorrectiveSourceCustody } from './kernelReviewInput.js';
import { resolveKernelOriginalInput } from './kernelOriginalInput.js';
import { evidenceDigest } from './authority.js';
import type { RiverReferenceInput } from './riverReference.js';
import { produceRiverCallFoldReference } from './riverReference.js';
import { isTournamentKernelReferenceInput } from './kernelModel.js';
import { priceClosedHeadsUpTournamentRiver } from './tournamentRiverReference.js';
import { priceClosedHeadsUpTournamentLadderRiver } from './closedHeadsUpTournamentRiverReference.js';
import {
  TOURNAMENT_KERNEL_OBJECTIVE,
  type TournamentKernelObjective,
} from './kernelTournamentDefinition.js';
import { independentlyPriceAcceptedTournamentRiver } from './tournamentAcceptedUtility.js';
import { tournamentOriginalFundingMatchesAccepted } from './tournamentAcceptedFunding.js';
import {
  settleJointBoardReference,
  type JointReferenceVariant,
} from '../../benchmark/JointBoardReference.js';

const QUERY = ACCEPTED_SOURCE_SELECT.replace(
  'SELECT h.id::text AS hand_id,',
  'SELECT h.hole_cards::text AS oracle_hole_cards_text, h.board::text AS oracle_board_text, h.ended_at::text AS oracle_ended_at_text, h.id::text AS hand_id,'
);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export interface RiverAcceptedOracleRequest {
  records: readonly HorseJournalRecord[];
  handKey: string;
  input: RiverReferenceInput;
}
interface OracleFlags {
  readonly version: 1;
  readonly qualified: false;
  readonly completePopulation: false;
  readonly activationAllowed: false;
}
export type RiverAcceptedOracleResult = OracleFlags &
  (
    | {
        readonly status: 'accepted_source_oracle';
        readonly playedAt: string;
        readonly committedAt: string;
        readonly oracle: Readonly<
          | {
              foldBb: 0;
              callBb: number;
              fold?: never;
              call?: never;
              objective?: never;
              utilityUnit?: never;
            }
          | {
              objective: TournamentKernelObjective;
              utilityUnit: 'prize_share';
              fold: number;
              call: number;
              foldBb?: never;
              callBb?: never;
            }
        >;
        readonly custodyDigest: string;
        readonly oracleDigest: string;
      }
    | {
        readonly status: 'unavailable';
        readonly reason:
          | 'oracle_configuration_unavailable'
          | 'oracle_source_unavailable'
          | 'oracle_binding_refused'
          | 'oracle_holdings_unavailable'
          | 'oracle_numerics_unavailable';
      }
  );
const flags = {
  version: 1 as const,
  qualified: false as const,
  completePopulation: false as const,
  activationAllowed: false as const,
};
const no = (
  reason: Extract<RiverAcceptedOracleResult, { status: 'unavailable' }>['reason']
): RiverAcceptedOracleResult => Object.freeze({ ...flags, status: 'unavailable', reason });
function cards(value: unknown): Card[] | null {
  if (!Array.isArray(value) || value.length > 6 || !value.length) return null;
  const parsed: Card[] = [];
  for (const raw of value) {
    if (
      !object(raw) ||
      Object.keys(raw).sort().join(',') !== 'rank,suit' ||
      typeof raw.rank !== 'string' ||
      !/^[2-9TJQKA]$/.test(raw.rank) ||
      !['clubs', 'diamonds', 'hearts', 'spades'].includes(String(raw.suit))
    )
      return null;
    parsed.push({
      rank: raw.rank as Card['rank'],
      suit: raw.suit as Card['suit'],
    });
  }
  return parsed;
}
function board(value: unknown): Card[] | null {
  if (!Array.isArray(value) || value.length !== 5) return null;
  const suits: Record<string, Card['suit']> = {
    c: 'clubs',
    d: 'diamonds',
    h: 'hearts',
    s: 'spades',
  };
  const result: Card[] = [];
  for (const c of value) {
    if (typeof c !== 'string') return null;
    const parsed = /^([2-9TJQKA])(clubs|diamonds|hearts|spades|[cdhs])$/.exec(c);
    if (!parsed) return null;
    result.push({
      rank: parsed[1] as Card['rank'],
      suit: parsed[2].length === 1 ? suits[parsed[2]] : (parsed[2] as Card['suit']),
    });
  }
  return result;
}
/** Reads only the already authenticated immutable atomic payload. Absence refuses authenticated terminal time; malformed or conflicting facts refuse. */
function acceptedHoldings(
  raw: Record<string, unknown>,
  input: RiverReferenceInput,
  endedAt: unknown
): Record<string, Card[]> | null {
  const payload: unknown = JSON.parse(String(raw.payload_text));
  if (!object(payload) || !object(payload.accepted_hand_facts)) return null;
  const stats = payload.accepted_hand_facts.stats_facts;
  if (stats === undefined) return null;
  if (
    !object(stats) ||
    ![1, 2].includes(Number(stats.version)) ||
    typeof stats.version !== 'number' ||
    !Array.isArray(stats.facts) ||
    stats.facts.length < 1 ||
    stats.facts.length > 10
  )
    return null;
  const ended = typeof endedAt === 'string' ? Date.parse(endedAt) : NaN;
  if (!Number.isFinite(ended)) return null;
  const seen = new Set<string>(),
    result: Record<string, Card[]> = {};
  for (const fact of stats.facts) {
    if (!object(fact) || typeof fact.user_id !== 'string' || seen.has(fact.user_id)) return null;
    seen.add(fact.user_id);
    const actor = input.original.snapshot.gameState.players.find((p) => p.user_id === fact.user_id);
    if (
      !actor ||
      fact.hand_id !== raw.hand_id ||
      fact.table_id !== raw.table_id ||
      fact.seat !== actor.seat ||
      fact.game_variant !== input.domain.variant ||
      fact.big_blind !== input.bigBlind ||
      fact.tournament_id !==
        (isTournamentKernelReferenceInput(input)
          ? input.original.snapshot.gameState.tournament?.tournamentId
          : null) ||
      typeof fact.played_at !== 'string' ||
      Date.parse(fact.played_at) !== ended ||
      typeof fact.invested !== 'number' ||
      !Number.isFinite(fact.invested) ||
      fact.invested < 0
    )
      return null;
    if (fact.hole_cards === null) continue;
    const holding = cards(fact.hole_cards);
    if (fact.invested <= 0 || !holding || holding.length !== input.hero.length) return null;
    result[fact.user_id] = holding;
  }
  return result;
}
/** Independent benchmark pot/card owner plus independent integer fee scaling. */
function independentCall(input: RiverReferenceInput, opponentCards: Card[]): number | null {
  const gs = input.original.snapshot.gameState,
    hero = input.original.snapshot.player;
  if (
    gs.players.length !== 2 ||
    gs.dealtSeatIds?.length !== 2 ||
    gs.players.some(
      (p) => p.is_folded || (p.deadInvested ?? 0) !== 0 || (p.individualAnteInvested ?? 0) !== 0
    )
  )
    return null;
  const settled = settleJointBoardReference({
    variant: input.domain.variant as JointReferenceVariant,
    players: gs.players.map((p) => ({
      id: p.user_id,
      seat: p.seat,
      cards: p.user_id === hero.user_id ? input.hero : opponentCards,
      contributed: p.totalInvested + (p.user_id === hero.user_id ? input.toCall : 0),
    })),
    boards: [input.board],
    chipUnit: 0.01,
    dealerSeat: gs.dealerSeat!,
  });
  const ids = [...new Set(settled.awards.map((a) => a.playerId))],
    entitlements = ids.map((id) => Math.round(settled.totals[id] * 100));
  const gross = entitlements.reduce((a, b) => a + b, 0),
    r = gs.rakeConfig!;
  if (gross <= 0 || !r) return null;
  const tier = r.playerCountCaps
    ?.slice()
    .sort((a, b) => b.players - a.players)
    .find((c) => 2 >= c.players);
  const rake = Math.min(
    gross,
    Math.round((tier?.cap ?? r.cap) * 100),
    Math.round((gross * Math.min(r.percent, 5)) / 100)
  );
  const b = gs.bbjConfig,
    bbj =
      b?.enabled && 2 >= b.minPlayersDealt
        ? Math.min(gross - rake, Math.round(input.bigBlind * b.feeBB * 100))
        : 0;
  if (rake + bbj !== Math.round(input.finalRake * 100)) return null;
  const target = gross - rake - bbj,
    net = entitlements.map((n) =>
      Number((2n * BigInt(n) * BigInt(target) + BigInt(gross)) / (2n * BigInt(gross)))
    );
  let residual = target - net.reduce((a, b) => a + b, 0);
  if (Math.abs(residual) > net.length) return null;
  for (let j = 0; j < net.length && residual !== 0; j++) {
    if (residual > 0 && net[j] < entitlements[j]) {
      net[j]++;
      residual--;
    } else if (residual < 0 && net[j] > 0) {
      net[j]--;
      residual++;
    }
  }
  if (residual !== 0) return null;
  const index = ids.indexOf(hero.user_id),
    returned = (index < 0 ? 0 : net[index]) / 100 + (settled.refunds[hero.user_id] ?? 0);
  const value = (returned - input.toCall) / input.bigBlind;
  return Number.isFinite(value) ? value : null;
}
/** Captures configured credentials once, never logs or exposes them. The only
 * path to an oracle runs its exact-coordinate query itself; there is no exported
 * JSON-to-trusted-row converter or caller-supplied qualified flag. */
export function createRiverAcceptedOracleReader(
  environment: Readonly<Record<string, string | undefined>>
): (request: RiverAcceptedOracleRequest) => Promise<RiverAcceptedOracleResult> {
  let connectionString: string | null = null;
  try {
    const raw = environment.DATABASE_URL;
    if (!raw || raw.length > 8192 || raw !== raw.trim() || /[\r\n\0]/.test(raw)) throw Error();
    const url = new URL(raw);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.password ||
      !url.pathname ||
      url.hash
    )
      throw Error();
    // libpq URL TLS query options must not override explicit verified TLS.
    for (const key of [...url.searchParams.keys()])
      if (/^ssl/i.test(key)) url.searchParams.delete(key);
    connectionString = url.href;
  } catch {
    /* Explicit configuration refusal below. */
  }
  let busy = false;
  return async (request) => {
    if (!connectionString) return no('oracle_configuration_unavailable');
    if (busy) return no('oracle_source_unavailable');
    const input = request?.input,
      binding = input?.binding;
    if (
      !binding ||
      !Array.isArray(request.records) ||
      request.records.length < 3 ||
      request.records.length > 256
    )
      return no('oracle_binding_refused');
    let accepted, decision, execution;
    try {
      accepted = request.records.find(
        (r) => r.kind === 'accepted_hand' && r.sha256 === binding.acceptedHandDigest
      );
      decision = request.records.find(
        (r) => r.kind === 'decision' && r.sha256 === binding.decisionDigest
      );
      execution = request.records.find(
        (r) => r.kind === 'execution' && r.sha256 === binding.executionDigest
      );
      if (!accepted || !decision || !execution) return no('oracle_binding_refused');
      const resolved = resolveKernelOriginalInput(request.records, decision, execution, accepted);
      if (
        resolved.status !== 'resolved' ||
        evidenceDigest(resolved.binding) !== evidenceDigest(binding) ||
        horseJournalJson(resolved.original.snapshot) !==
          horseJournalJson(input.original.snapshot) ||
        horseJournalJson(resolved.original.readFrame) !== horseJournalJson(input.original.readFrame)
      )
        return no('oracle_binding_refused');
      const referenceValid = isTournamentKernelReferenceInput(input)
        ? (input.objective === TOURNAMENT_KERNEL_OBJECTIVE
            ? priceClosedHeadsUpTournamentRiver({
                version: 'horse-wta-spin-river-reference-v1',
                original: input.original,
                range: input.range,
                rangeReadFrameDigest: input.rangeReadFrameDigest,
              })
            : priceClosedHeadsUpTournamentLadderRiver({
                version: 'horse-closed-hu-ladder-river-reference-v1',
                original: input.original,
                range: input.range,
                rangeReadFrameDigest: input.rangeReadFrameDigest,
              })
          ).status === 'priced'
        : produceRiverCallFoldReference(input).status === 'produced';
      if (!referenceValid) return no('oracle_binding_refused');
    } catch {
      return no('oracle_binding_refused');
    }
    let hand: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(accepted.body);
      if (!object(parsed)) return no('oracle_binding_refused');
      hand = parsed;
    } catch {
      return no('oracle_binding_refused');
    }
    const snapshot = input.original.snapshot,
      gs = snapshot.gameState;
    const [tableId, handNumber] = String(hand.handKey).split(':');
    if (
      !UUID.test(String(hand.committedHandId)) ||
      !UUID.test(tableId) ||
      !/^[1-9][0-9]*$/.test(handNumber) ||
      !Number.isSafeInteger(Number(handNumber))
    )
      return no('oracle_binding_refused');
    const client = new pg.Client({
      connectionString,
      ssl: {
        ca: [...tls.rootCertificates, SUPABASE_ROOT_2021_CA],
        rejectUnauthorized: true,
      },
      connectionTimeoutMillis: 5000,
      statement_timeout: 2000,
      lock_timeout: 250,
      query_timeout: 3000,
      application_name: 'horse-phase14-accepted-oracle',
    });
    busy = true;
    let begun = false;
    try {
      await client.connect();
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      begun = true;
      const reply = await client.query(QUERY, [hand.committedHandId, tableId, Number(handNumber)]);
      if (reply.rows.length !== 1 || Buffer.byteLength(horseJournalJson(reply.rows)) > 1024 * 1024)
        return no('oracle_source_unavailable');
      const captured = reply.rows[0],
        { oracle_hole_cards_text, oracle_board_text, oracle_ended_at_text, ...raw } = captured;
      const custody = rebuildCorrectiveSourceCustody(
        request.records,
        request.handKey,
        binding.acceptedHandDigest,
        [raw]
      );
      if (
        custody.status !== 'reconstructed_unsigned' ||
        raw.game_variant !== input.domain.variant ||
        raw.tournament_id !==
          (isTournamentKernelReferenceInput(input) ? gs.tournament?.tournamentId : null)
      )
        return no('oracle_binding_refused');
      if (
        isTournamentKernelReferenceInput(input) &&
        !tournamentOriginalFundingMatchesAccepted(
          input.original.snapshot,
          JSON.parse(String(raw.stack_result_text))
        )
      )
        return no('oracle_binding_refused');
      if (
        typeof oracle_hole_cards_text !== 'string' ||
        Buffer.byteLength(oracle_hole_cards_text) > 8192 ||
        typeof oracle_board_text !== 'string' ||
        Buffer.byteLength(oracle_board_text) > 512
      )
        return no('oracle_holdings_unavailable');
      let holes: unknown, publicBoard: Card[] | null;
      try {
        holes = JSON.parse(oracle_hole_cards_text);
        publicBoard = board(JSON.parse(oracle_board_text));
      } catch {
        return no('oracle_holdings_unavailable');
      }
      if (
        !object(holes) ||
        !publicBoard ||
        horseJournalJson(publicBoard) !== horseJournalJson(input.board) ||
        Object.keys(holes).some((id) => !gs.players.some((p) => p.user_id === id))
      )
        return no('oracle_binding_refused');
      const hero = snapshot.player,
        opponent = gs.players.find((p) => p.user_id !== hero.user_id)!;
      const endedMs =
        typeof oracle_ended_at_text === 'string' ? Date.parse(oracle_ended_at_text) : NaN;
      if (!Number.isFinite(endedMs)) return no('oracle_binding_refused');
      const committedMs = typeof raw.committed_at === 'string' ? Date.parse(raw.committed_at) : NaN;
      if (!Number.isFinite(committedMs)) return no('oracle_binding_refused');
      const committedAt = new Date(committedMs).toISOString();
      const playedAt = new Date(endedMs).toISOString();
      const privateHoles = acceptedHoldings(raw, input, oracle_ended_at_text);
      if (!privateHoles) return no('oracle_binding_refused');
      for (const actor of gs.players) {
        const revealed = holes[actor.user_id],
          retained = privateHoles[actor.user_id];
        if (revealed !== undefined) {
          const parsed = cards(revealed);
          if (
            !parsed ||
            parsed.length !== input.hero.length ||
            (retained && horseJournalJson(parsed) !== horseJournalJson(retained))
          )
            return no('oracle_binding_refused');
        }
      }
      const opponentCards = privateHoles[opponent.user_id] ?? cards(holes[opponent.user_id]),
        heroCards = privateHoles[hero.user_id] ?? cards(holes[hero.user_id]);
      if (!opponentCards || opponentCards.length !== input.hero.length)
        return no('oracle_holdings_unavailable');
      if (heroCards && horseJournalJson(heroCards) !== horseJournalJson(input.hero))
        return no('oracle_binding_refused');
      let oracle: Extract<
        RiverAcceptedOracleResult,
        { status: 'accepted_source_oracle' }
      >['oracle'];
      if (isTournamentKernelReferenceInput(input)) {
        const priced = independentlyPriceAcceptedTournamentRiver({
          original: input.original,
          opponentCards,
        });
        if (priced.status !== 'priced') return no('oracle_numerics_unavailable');
        oracle = Object.freeze({
          objective: priced.objective,
          utilityUnit: priced.utilityUnit,
          fold: priced.fold.expectedPrizeShare,
          call: priced.call.expectedPrizeShare,
        });
      } else {
        const callBb = independentCall(input, opponentCards);
        if (callBb === null) return no('oracle_numerics_unavailable');
        oracle = Object.freeze({ foldBb: 0 as const, callBb });
      }
      await client.query('COMMIT');
      begun = false;
      return Object.freeze({
        ...flags,
        status: 'accepted_source_oracle',
        playedAt,
        committedAt,
        oracle,
        custodyDigest: custody.custodyDigest,
        oracleDigest: evidenceDigest({
          version: isTournamentKernelReferenceInput(input)
            ? 'horse-tournament-prize-share-accepted-oracle-v1'
            : 'horse-river-accepted-oracle-v2',
          binding,
          custodyDigest: custody.custodyDigest,
          playedAt,
          committedAt,
          inputDigest: binding.inputDigest,
          readFrameDigest: binding.readFrameDigest,
          oracleHoleCardsText: oracle_hole_cards_text,
          oracleBoardText: oracle_board_text,
          oracle,
        }),
      });
    } catch {
      return no('oracle_source_unavailable');
    } finally {
      if (begun)
        try {
          await client.query('ROLLBACK');
        } catch {
          /* No writes were requested. */
        }
      try {
        await client.end();
      } catch {
        /* Never expose driver configuration/query errors. */
      }
      busy = false;
    }
  };
}
