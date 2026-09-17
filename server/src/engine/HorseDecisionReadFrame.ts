import {
  horsePlanContextIsValid,
  horsePlanContextKey,
  type HorsePlanContext,
} from './HorsePlanHandIdentity.js';
import { createHash } from 'node:crypto';
import {
  HorseMind,
  type HorseMindSandbox,
  type OpponentStats,
  type RaiseResponsePlan,
} from './HorseMind.js';
import type { SeatPlayer } from '../types.js';

/** Private portable read component, not a complete runtime checkpoint. Only
 * valid with observation disabled and speculative effects captured. Never
 * include this frame in public state, health, telemetry or worker replies. */
export interface HorseDecisionReadFrame {
  readonly version: 'horse-decision-reads-v1' | 'horse-decision-reads-v2';
  readonly bytes: number;
  readonly sha256: string;
  readonly json: string;
}
export const HORSE_DECISION_READ_FRAME_MAX_BYTES = 256 * 1024;
const VERSION = 'horse-decision-reads-v1';
const ALLOCATED_VERSION = 'horse-decision-reads-v2';
const FIELDS = [
  'hands',
  'vpip',
  'pfr',
  'threeBet',
  'aggr',
  'passive',
  'folds',
  'facedAggr',
  'cbetOpps',
  'cbetFolds',
  'f3bOpps',
  'f3bFolds',
  'bigBetSD',
  'bigBetSDStrong',
  'riverBetOpps',
  'riverBetFolds',
  'rHands',
  'rFolds',
  'rFacedAggr',
  'rAggr',
  'rPassive',
  'checks',
  'postAggr',
  'postPassive',
  'rChecks',
  'snapBetSD',
  'snapBetSDStrong',
  'tankBetSD',
  'tankBetSDStrong',
] as const satisfies readonly (keyof OpponentStats)[];
// A new consumed statistic must be considered explicitly in this codec.
const completeFields: Exclude<keyof OpponentStats, (typeof FIELDS)[number]> extends never
  ? true
  : false = true;
void completeFields;
const PAIR_FIELDS = ['n3', 'opp3', 'nR', 'oppR'] as const;
type Rows<T> = Array<[string, T]>;
type Body = {
  version: typeof VERSION | typeof ALLOCATED_VERSION;
  planContext?: HorsePlanContext;
  actors: string[];
  handKey: string | null;
  stats: Rows<number[]>;
  scoped: Rows<number[]>;
  pairs: Rows<number[]>;
  plans: Rows<boolean>;
  raisePlans: Rows<RaiseResponsePlan>;
  outlooks: Rows<{ good: string[]; scare: string[] }>;
};
const fail = (): never => {
  throw new Error('Horse decision read frame is invalid');
};
const hash = (json: string) => createHash('sha256').update(json).digest('hex');
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const numbers = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every(finite);
const cards = (v: unknown) =>
  Array.isArray(v) &&
  v.length <= 52 &&
  new Set(v).size === v.length &&
  v.every((c) => typeof c === 'string' && /^[2-9TJQKA][cdhs]$/.test(c));

function boundary(players: readonly Pick<SeatPlayer, 'user_id'>[], handKey: string | null) {
  if (!Array.isArray(players) || players.length < 1 || players.length > 10) return fail();
  const actors = players.map((p) => p?.user_id);
  if (
    new Set(actors).size !== actors.length ||
    actors.some((id) => typeof id !== 'string' || !id.length || id.length > 256) ||
    (handKey !== null && (typeof handKey !== 'string' || handKey.length > 512))
  )
    return fail();
  const scoped = new Set<string>(),
    pairs = new Set<string>(),
    plans = new Set<string>(),
    streets = new Set<string>();
  for (const id of actors) {
    for (const family of ['holdem', 'omaha', 'sixplus'])
      for (const size of ['hu', 'short', 'full']) scoped.add(`${family}:${size}|${id}`);
    for (const other of actors) pairs.add(`${id}|${other}`);
    if (handKey !== null) {
      const key = `${handKey}|${id}`;
      plans.add(key);
      for (const street of ['preflop', 'flop', 'turn', 'river']) streets.add(`${key}|${street}`);
    }
  }
  return { actors, stats: new Set(actors), scoped, pairs, plans, streets };
}

function validRows(
  value: unknown,
  allowed: ReadonlySet<string>,
  valid: (v: unknown) => boolean
): boolean {
  if (!Array.isArray(value) || value.length > allowed.size) return false;
  const seen = new Set<string>();
  for (const row of value) {
    if (
      !Array.isArray(row) ||
      row.length !== 2 ||
      typeof row[0] !== 'string' ||
      !allowed.has(row[0]) ||
      seen.has(row[0]) ||
      !valid(row[1])
    )
      return false;
    seen.add(row[0]);
  }
  return true;
}
function validateBody(
  value: unknown,
  b: ReturnType<typeof boundary>,
  handKey: string | null,
  planContext?: HorsePlanContext
): asserts value is Body {
  if (
    planContext !== undefined &&
    (!horsePlanContextIsValid(planContext) ||
      (handKey !== null && handKey !== horsePlanContextKey(planContext)))
  )
    return fail();
  if (
    !object(value) ||
    !exact(value, [
      'version',
      ...(planContext === undefined ? [] : ['planContext']),
      'actors',
      'handKey',
      'stats',
      'scoped',
      'pairs',
      'plans',
      'raisePlans',
      'outlooks',
    ]) ||
    value.version !== (planContext === undefined ? VERSION : ALLOCATED_VERSION) ||
    (planContext !== undefined &&
      (!horsePlanContextIsValid(value.planContext) ||
        horsePlanContextKey(value.planContext) !== horsePlanContextKey(planContext))) ||
    value.handKey !== handKey ||
    !Array.isArray(value.actors) ||
    value.actors.length !== b.actors.length ||
    value.actors.some((id, i) => id !== b.actors[i]) ||
    !validRows(value.stats, b.stats, (v) => numbers(v, FIELDS.length)) ||
    !validRows(value.scoped, b.scoped, (v) => numbers(v, FIELDS.length)) ||
    !validRows(value.pairs, b.pairs, (v) => numbers(v, PAIR_FIELDS.length)) ||
    !validRows(value.plans, b.plans, (v) => typeof v === 'boolean') ||
    !validRows(
      value.raisePlans,
      b.streets,
      (v) => v === 'commit' || v === 'callOnce' || v === 'foldToRaise'
    ) ||
    !validRows(
      value.outlooks,
      b.streets,
      (v) => object(v) && exact(v, ['good', 'scare']) && cards(v.good) && cards(v.scare)
    )
  )
    return fail();
}

export function encodeHorseDecisionReads(
  view: HorseMindSandbox,
  players: readonly Pick<SeatPlayer, 'user_id'>[],
  handKey: string | null,
  planContext?: HorsePlanContext
): HorseDecisionReadFrame {
  const b = boundary(players, handKey);
  // Refuse truncation and pending observations/writes rather than serializing
  // a partial runtime checkpoint as though it were a replayable read view.
  for (const key of ['seenActions', 'handFlags', 'dirty', 'dirtyPairs', 'dirtyScoped'] as const) {
    if (!(view[key] instanceof Set) || view[key].size !== 0) return fail();
  }
  const bounded = <T>(map: Map<string, T>, max: number): Rows<T> => {
    if (!(map instanceof Map) || map.size > max) return fail();
    return [...map];
  };
  const stats = (map: Map<string, OpponentStats>, max: number) =>
    bounded(map, max).map(([id, row]): [string, number[]] => {
      if (!object(row) || !exact(row, FIELDS)) return fail();
      return [id, FIELDS.map((f) => row[f])];
    });
  const body: Body = {
    version: planContext === undefined ? VERSION : ALLOCATED_VERSION,
    ...(planContext === undefined ? {} : { planContext }),
    actors: b.actors,
    handKey,
    stats: stats(view.stats, b.stats.size),
    scoped: stats(view.scoped, b.scoped.size),
    pairs: bounded(view.pairs, b.pairs.size).map(([id, row]) => {
      if (!object(row) || !exact(row, PAIR_FIELDS)) return fail();
      return [id, PAIR_FIELDS.map((f) => row[f])];
    }),
    plans: bounded(view.plans, b.plans.size),
    raisePlans: bounded(view.raisePlans, b.streets.size),
    outlooks: bounded(view.outlooks, b.streets.size).map(([id, row]) => {
      if (
        !object(row) ||
        !exact(row, ['good', 'scare']) ||
        !(row.good instanceof Set) ||
        !(row.scare instanceof Set) ||
        row.good.size > 52 ||
        row.scare.size > 52
      )
        return fail();
      return [id, { good: [...row.good], scare: [...row.scare] }];
    }),
  };
  validateBody(body, b, handKey, planContext);
  const json = JSON.stringify(body),
    bytes = Buffer.byteLength(json);
  if (bytes > HORSE_DECISION_READ_FRAME_MAX_BYTES) return fail();
  return Object.freeze({ version: body.version, bytes, sha256: hash(json), json });
}

export function decodeHorseDecisionReads(
  frame: HorseDecisionReadFrame,
  players: readonly Pick<SeatPlayer, 'user_id'>[],
  handKey: string | null,
  planContext?: HorsePlanContext
): HorseMindSandbox {
  const b = boundary(players, handKey);
  if (
    !object(frame) ||
    !exact(frame, ['version', 'bytes', 'sha256', 'json']) ||
    frame.version !== (planContext === undefined ? VERSION : ALLOCATED_VERSION) ||
    typeof frame.json !== 'string' ||
    frame.json.length > HORSE_DECISION_READ_FRAME_MAX_BYTES ||
    !Number.isSafeInteger(frame.bytes) ||
    frame.bytes < 0 ||
    frame.bytes > HORSE_DECISION_READ_FRAME_MAX_BYTES ||
    Buffer.byteLength(frame.json) !== frame.bytes ||
    typeof frame.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(frame.sha256) ||
    hash(frame.json) !== frame.sha256
  )
    return fail();
  let body: unknown;
  try {
    body = JSON.parse(frame.json);
  } catch {
    return fail();
  }
  validateBody(body, b, handKey, planContext);
  const view = HorseMind.createSandbox();
  const stats = (rows: Rows<number[]>) =>
    new Map(
      rows.map(([id, values]) => [
        id,
        Object.fromEntries(FIELDS.map((f, i) => [f, values[i]])) as unknown as OpponentStats,
      ])
    );
  view.stats = stats(body.stats);
  view.scoped = stats(body.scoped);
  view.pairs = new Map(
    body.pairs.map(([id, v]) => [id, { n3: v[0], opp3: v[1], nR: v[2], oppR: v[3] }])
  );
  view.plans = new Map(body.plans);
  view.raisePlans = new Map(body.raisePlans);
  view.outlooks = new Map(
    body.outlooks.map(([id, v]) => [id, { good: new Set(v.good), scare: new Set(v.scare) }])
  );
  return view;
}
