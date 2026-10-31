import { createRequire } from 'node:module';
import { isMainThread } from 'node:worker_threads';
import { boardRelativeFeaturesV2 } from './GtoBoardRelativeFeaturesV2.js';
import descriptor from './GtoPublicHist215FeatureDescriptor.json' with { type: 'json' };
import { PUBLIC_HIST215_PRIOR } from './GtoPublicHist215FeatureSchema.js';
import {
  decodePublic215F64,
  public215Digest,
  strictObject,
  validPublic215Digest,
} from './GtoPublicHist215Model.js';

export const PUBLIC_HIST215_FEATURE_SCHEMA_SHA256 =
  '0ca054f9bb0463bf6a298a80a29cb4b6d9e6bffcc193e4af9d497e2936ec849f';
export const PUBLIC_HIST215_PREDECESSOR_GRAPH_SCHEMA_SHA256 =
  'af443eb7d8150131a6097b9fb2e41dfdfa388c54bc2867dcb4ce53b97ec3afb0';
if (public215Digest(descriptor) !== PUBLIC_HIST215_FEATURE_SCHEMA_SHA256)
  throw Error('PUBLIC_HIST215_FEATURE_DESCRIPTOR_CHANGED');
export const PUBLIC_HIST215_BASE_SCHEMA_SHA256 =
  '4d8a4918635544c467778a75f77bdb962cf183d99f6a7b2f64a4e418eaf3aaf1';
const CONTEXT_KEYS = [
  'depth_bucket',
  'facing_kind',
  'facing_size_bucket',
  'game_family',
  'hero_position',
  'node_role',
  'objective',
  'opponent_position',
  'pot_type',
  'street',
  'table_size',
  'texture_class',
  'utility_context',
] as const;
export interface Public215Context {
  depth_bucket: number;
  table_size: number;
  facing_kind: string;
  facing_size_bucket: string;
  game_family: string;
  hero_position: string;
  node_role: string;
  objective: string;
  opponent_position: string;
  pot_type: string;
  street: string;
  texture_class: string;
  utility_context: string;
}
export interface Public215Template {
  format: 'public_hist215_template_v1';
  context: Public215Context;
  root_actor: 'IP' | 'OOP';
  scenario: {
    pot_chips_f64: string;
    effective_stack_chips_f64: string;
    chips_per_bb_f64: string;
    rake_f64: [string, string];
    ip_range_checksum: string;
    oop_range_checksum: string;
  };
  opponent_weights: string[];
}
export interface CompiledPublic215Template {
  readonly context: Readonly<Public215Context>;
  readonly rootActor: 'IP' | 'OOP';
  readonly templateSha256: string;
  readonly ipRangeChecksum: string;
  readonly oopRangeChecksum: string;
  readonly potBb: number;
  readonly stackBb: number;
  readonly rake: readonly [number, number];
  readonly normalizedWeights: readonly bigint[];
}
const RANKS = '23456789TJQKA',
  SUITS = 'cdhs';
const INT64_MAX = (1n << 63n) - 1n;
const fail = (why: string): never => {
  throw Error('PUBLIC_HIST215_' + why);
};
const rank = (c: string) => RANKS.indexOf(c[0]) + 2;
const gcd = (x: bigint, y: bigint): bigint => {
  while (y) {
    const r = x % y;
    x = y;
    y = r;
  }
  return x;
};
const count = (a: readonly (number | string)[]) => {
  const out = new Map<number | string, number>();
  for (const x of a) out.set(x, (out.get(x) ?? 0) + 1);
  return out;
};
function cards(own: readonly string[], board: readonly string[]) {
  if (
    !Array.isArray(own) ||
    own.length !== 2 ||
    !Array.isArray(board) ||
    ![3, 4, 5].includes(board.length) ||
    ![...own, ...board].every((c) => typeof c === 'string' && /^[2-9TJQKA][cdhs]$/.test(c)) ||
    new Set([...own, ...board]).size !== own.length + board.length
  )
    return fail('STANDARD_DECK');
  const id = (c: string) => RANKS.indexOf(c[0]) * 4 + SUITS.indexOf(c[1]);
  const ownIds = own.map(id).sort((a, b) => a - b),
    boardIds = board.map(id);
  return {
    own: ownIds.map((i) => RANKS[Math.floor(i / 4)] + SUITS[i % 4]),
    board: [...board],
    ownIds,
    boardIds,
  };
}
export function compilePublic215Template(
  input: unknown,
  expectedSha256: string
): CompiledPublic215Template {
  if (!validPublic215Digest(expectedSha256)) return fail('TEMPLATE_DIGEST');
  const t = strictObject(input, [
    'format',
    'context',
    'root_actor',
    'scenario',
    'opponent_weights',
  ]);
  if (
    t.format !== 'public_hist215_template_v1' ||
    (t.root_actor !== 'IP' && t.root_actor !== 'OOP') ||
    public215Digest(t) !== expectedSha256
  )
    return fail('TEMPLATE_IDENTITY');
  const c = strictObject(t.context, CONTEXT_KEYS);
  if (
    !Number.isSafeInteger(c.depth_bucket) ||
    (c.depth_bucket as number) <= 0 ||
    !Number.isSafeInteger(c.table_size) ||
    (c.table_size as number) < 2 ||
    (c.table_size as number) > 10
  )
    return fail('CONTEXT_NUMERIC');
  for (const k of CONTEXT_KEYS)
    if (
      !['depth_bucket', 'table_size'].includes(k) &&
      (typeof c[k] !== 'string' || (c[k] as string).length > 96)
    )
      return fail('CONTEXT_STRING');
  if (
    !['flop', 'turn', 'river'].includes(c.street as string) ||
    !(c.texture_class as string).length
  )
    return fail('CONTEXT_STREET');
  for (const [k, v] of Object.entries(c))
    if (
      !['texture_class', 'depth_bucket', 'table_size'].includes(k) &&
      !(PUBLIC_HIST215_PRIOR as readonly string[]).includes(k + '=' + v)
    )
      return fail('UNKNOWN_PUBLIC_CATEGORY');
  const s = strictObject(t.scenario, [
    'pot_chips_f64',
    'effective_stack_chips_f64',
    'chips_per_bb_f64',
    'rake_f64',
    'ip_range_checksum',
    'oop_range_checksum',
  ]);
  for (const k of ['ip_range_checksum', 'oop_range_checksum'])
    if (
      !validPublic215Digest(s[k]) ||
      !(PUBLIC_HIST215_PRIOR as readonly string[]).includes(
        (k === 'ip_range_checksum' ? 'iprange=' : 'ooprange=') + s[k]
      )
    )
      return fail('RANGE_CATEGORY');
  const pot = decodePublic215F64(s.pot_chips_f64),
    stack = decodePublic215F64(s.effective_stack_chips_f64),
    bb = decodePublic215F64(s.chips_per_bb_f64);
  if (
    !(pot > 0) ||
    !(stack > 0) ||
    !(bb > 0) ||
    !Number.isFinite(pot / bb) ||
    !Number.isFinite(stack / bb)
  )
    return fail('ROOT_GEOMETRY');
  if (!Array.isArray(s.rake_f64) || s.rake_f64.length !== 2) return fail('RAKE');
  const rake = s.rake_f64.map(decodePublic215F64);
  if (rake.some((n) => n < 0)) return fail('RAKE');
  if (!Array.isArray(t.opponent_weights) || t.opponent_weights.length !== 1326)
    return fail('WEIGHT_SHAPE');
  let total = 0n,
    divisor = 0n;
  const weights = t.opponent_weights.map((w) => {
    if (typeof w !== 'string' || w.length > 19 || !/^(0|[1-9][0-9]*)$/.test(w))
      return fail('WEIGHT_WORD');
    const n = BigInt(w);
    if (n > 1000000000000n) return fail('APPROVED_RANGE_UNIT_BOUND');
    total += n;
    if (total > INT64_MAX) return fail('WEIGHT_INT64');
    if (n) divisor = gcd(divisor, n);
    return n;
  });
  if (!total) return fail('ZERO_ROOT_RANGE');
  return Object.freeze({
    context: Object.freeze({ ...c }) as unknown as Readonly<Public215Context>,
    rootActor: t.root_actor,
    templateSha256: expectedSha256,
    ipRangeChecksum: s.ip_range_checksum as string,
    oopRangeChecksum: s.oop_range_checksum as string,
    potBb: pot / bb,
    stackBb: stack / bb,
    rake: Object.freeze(rake) as unknown as readonly [number, number],
    normalizedWeights: Object.freeze(weights.map((w) => w / divisor)),
  });
}
/** The caller must compare the cell's exact authored context before admission.
 * Runtime pot, ranges, rake or other players' private cards are never inputs. */
export function public215TemplateMatchesContext(
  template: CompiledPublic215Template,
  context: Public215Context
): boolean {
  return CONTEXT_KEYS.every((k) => Object.is(template.context[k], context[k]));
}

function numeric(h: string[], b: string[]): Record<string, number> {
  const hr = h.map(rank).sort((a, b) => b - a),
    br = b.map(rank).sort((a, b) => b - a),
    all = [...h, ...b],
    rc = count(all.map(rank)),
    sc = count(all.map((c) => c[1])),
    bc = count(b.map(rank)),
    get = (m: Map<number | string, number>, k: number | string) => m.get(k) ?? 0;
  const f: Record<string, number> = {
    hhigh: hr[0],
    hlow: hr[1],
    hgap: hr[0] - hr[1],
    hpocket: +(hr[0] === hr[1]),
    hsuited: +(h[0][1] === h[1][1]),
    nover: hr.filter((r) => r > Math.max(...br)).length,
    nunder: hr.filter((r) => r < Math.min(...br)).length,
    matches: hr.reduce((s, r) => s + get(bc, r), 0),
    maxsuit: Math.max(...sc.values()),
    boardmaxsuit: Math.max(...count(b.map((c) => c[1])).values()),
    span: Math.max(...br) - Math.min(...br),
    npairs: [...rc.values()].filter((v) => v === 2).length,
    ntrips: [...rc.values()].filter((v) => v === 3).length,
    nquads: [...rc.values()].filter((v) => v === 4).length,
  };
  br.forEach((r, i) => (f['boardrank' + i] = r));
  h.forEach((c, i) => (f['holesuitboard' + i] = b.filter((z) => z[1] === c[1]).length));
  for (let r = 2; r <= 14; r++) {
    f['boardcount' + r] = get(bc, r);
    f['allcount' + r] = get(rc, r);
  }
  const rr = new Set(rc.keys());
  if (rr.has(14)) rr.add(1);
  const windows = Array.from({ length: 10 }, (_, i) =>
    Array.from({ length: 5 }, (_, j) => i + 1 + j)
  );
  f.straightwindow = Math.max(...windows.map((w) => w.filter((r) => rr.has(r)).length));
  f.straighttop = Math.max(0, ...windows.filter((w) => w.every((r) => rr.has(r))).map((w) => w[4]));
  f.flushrank = Math.max(0, ...all.filter((c) => get(sc, c[1]) >= 5).map(rank));
  return f;
}
export function encodePublic215Base181(
  own: readonly string[],
  board: readonly string[],
  template: CompiledPublic215Template
): number[] {
  const legal = cards(own, board);
  let h = legal.own;
  const b = legal.board,
    c = template.context;
  if (({ flop: 3, turn: 4, river: 5 } as Record<string, number>)[c.street] !== b.length)
    return fail('STREET_CARD_COUNT');
  h = [...h].sort(
    (a, b) =>
      rank(b) - rank(a) ||
      legal.board.filter((c) => c[1] === b[1]).length -
        legal.board.filter((c) => c[1] === a[1]).length
  );
  const v = boardRelativeFeaturesV2(h, b),
    f = numeric(h, b);
  Object.assign(f, {
    depth: c.depth_bucket,
    tablesize: c.table_size,
    potbb: template.potBb,
    stackbb: template.stackBb,
    rakepct: template.rake[0],
    rakecap: template.rake[1],
  });
  for (const [k, value] of Object.entries(c))
    if (!['texture_class', 'depth_bucket', 'table_size'].includes(k)) f[k + '=' + value] = 1;
  f['iprange=' + template.ipRangeChecksum] = 1;
  f['ooprange=' + template.oopRangeChecksum] = 1;
  const prior = PUBLIC_HIST215_PRIOR.map((k) => f[k] ?? 0),
    pad = (a: readonly number[], n: number) => Array.from({ length: n }, (_, i) => a[i] ?? -1),
    flat = (a: readonly (readonly number[])[], rows: number, cols: number) =>
      Array.from({ length: rows }, (_, i) => pad(a[i] ?? [], cols)).flat();
  const extra = [
    v.street,
    v.madeCategory,
    ...Array.from({ length: 9 }, (_, i) => +(i === v.madeCategory)),
    ...pad(v.boardMultiplicity, 5),
    v.boardMultiplicity.length,
    ...flat(v.holeRelations, 2, 3),
    +v.pocketPair,
    v.straightCompletionRanks,
    v.straightCompletionCards,
    ...flat(v.suitRelations, 4, 4),
    ...v.suitRelations.map((a) => a.length),
    v.flushCompletionCards,
    ...flat(v.madeTiebreakRoles, 5, 3),
    v.madeTiebreakRoles.length,
    ...v.bestHoleContribution,
    ...v.boardConnectivity,
  ];
  const out = [...prior, ...extra];
  if (
    prior.length !== 113 ||
    extra.length !== 68 ||
    out.length !== 181 ||
    !out.every(Number.isFinite)
  )
    return fail('BASE_FEATURES');
  return out;
}
const permutations = (a: string[]): string[][] =>
  a.length < 2
    ? [a]
    : a.flatMap((v, i) => permutations(a.filter((_, j) => i !== j)).map((p) => [v, ...p]));
const compare = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};
/** Frozen public-state graph: ranks7 and suit incidence21; equal-rank ties minimize the whole vector. */
export function encodePublic215State28(own: readonly string[], board: readonly string[]): number[] {
  const c = cards(own, board),
    orders = (a: string[]) =>
      permutations(a).filter((a) => a.every((c, i) => i === 0 || rank(a[i - 1]) >= rank(c)));
  let best: number[] | undefined;
  for (const h of orders(c.own))
    for (const f of orders(c.board.slice(0, 3))) {
      const slots: (string | null)[] = [...h, ...f, c.board[3] ?? null, c.board[4] ?? null],
        v = slots.map((c) => (c === null ? 0 : rank(c)));
      for (let i = 0; i < 7; i++)
        for (let j = i + 1; j < 7; j++)
          v.push(+(slots[i] !== null && slots[j] !== null && slots[i]![1] === slots[j]![1]));
      if (!best || compare(v, best) < 0) best = v;
    }
  return best!;
}
/** Exact rational rounding, frozen 3da algorithm. Domain has no subnormal ratios. */
export function public215ExactRatio(n: bigint, d: bigint): number {
  if (typeof n !== 'bigint' || typeof d !== 'bigint') return fail('BIGINT_RATIO_REQUIRED');
  if (d <= 0n || d > INT64_MAX * 990n || n < 0n || n > d) return fail('RATIO_DOMAIN');
  if (n === 0n) return 0;
  if (n === d) return 1;
  let e = BigInt(n.toString(2).length - d.toString(2).length);
  if (e >= 0n) {
    if (n < d << e) e--;
  } else if (n << -e < d) e--;
  const shifted = n << (52n - e);
  let q = shifted / d;
  const twice = 2n * (shifted % d);
  if (twice > d || (twice === d && (q & 1n) === 1n)) q++;
  if (q < 1n << 52n || q > 1n << 53n || e < -73n || e > 0n) return fail('RATIO_BOUND');
  return Number(q) * 2 ** (Number(e) - 52);
}
interface NativeRootWTL {
  exactRootWTL(
    own: number[],
    board: number[],
    weights: readonly bigint[]
  ): {
    current: string[];
    terminal: string[];
    terminalRunouts: number;
    opponentCompatibleCombos: number;
  };
}
let native: NativeRootWTL | undefined;
/** Fixed maintained native artifact, loaded only inside the actual table FIFO worker. */
function workerNative(): NativeRootWTL {
  if (isMainThread) return fail('TABLE_FIFO_WORKER_REQUIRED');
  if (!native) {
    const require = createRequire(import.meta.url);
    native = require('../../native/build/public_hist215_wtl.node') as NativeRootWTL;
    if (typeof native?.exactRootWTL !== 'function') return fail('NATIVE_API');
  }
  return native;
}
export function encodePublic215Features(
  own: readonly string[],
  board: readonly string[],
  template: CompiledPublic215Template
): number[] {
  if (isMainThread) return fail('TABLE_FIFO_WORKER_REQUIRED');
  const c = cards(own, board),
    base = encodePublic215Base181(c.own, c.board, template),
    state = encodePublic215State28(c.own, c.board),
    blocked = new Set([...c.ownIds, ...c.boardIds]);
  let index = 0,
    legalMass = 0n,
    compatible = 0;
  for (let hi = 1; hi < 52; hi++)
    for (let lo = 0; lo < hi; lo++, index++)
      if (!blocked.has(hi) && !blocked.has(lo) && template.normalizedWeights[index] > 0n) {
        legalMass += template.normalizedWeights[index];
        compatible++;
      }
  if (!legalMass) return fail('ZERO_COMPATIBLE_OPPONENT_MASS');
  const exact = workerNative().exactRootWTL(c.ownIds, c.boardIds, template.normalizedWeights);
  const mass = (values: string[]) => {
    if (
      !Array.isArray(values) ||
      values.length !== 4 ||
      values.some((v) => typeof v !== 'string' || v.length > 40 || !/^(0|[1-9][0-9]*)$/.test(v))
    )
      return fail('NATIVE_MASS');
    const m = values.map(BigInt);
    if (m[3] <= 0n || m[0] + m[1] + m[2] !== m[3]) return fail('NATIVE_CONSERVATION');
    return m;
  };
  const current = mass(exact.current),
    terminal = mass(exact.terminal),
    factor = ({ 3: 990n, 4: 44n, 5: 1n } as Record<number, bigint>)[c.board.length],
    runouts = ({ 3: 1081, 4: 46, 5: 1 } as Record<number, number>)[c.board.length];
  if (
    current[3] !== legalMass ||
    terminal[3] !== legalMass * factor ||
    exact.terminalRunouts !== runouts ||
    exact.opponentCompatibleCombos !== compatible
  )
    return fail('NATIVE_CENSUS');
  const out = [
    ...base,
    ...current.slice(0, 3).map((n) => public215ExactRatio(n, current[3])),
    ...terminal.slice(0, 3).map((n) => public215ExactRatio(n, terminal[3])),
    ...state,
  ];
  if (out.length !== 215 || !out.every(Number.isFinite)) return fail('FEATURE215');
  return out;
}
