import type { ActionRecord, SeatPlayer } from '../types.js';
import type { HorsePublicActionNode } from './HorsePublicActionNode.js';
import { prepareJointPots, jointPotChipUnits } from './multiway/JointPotDistribution.js';
import { riverPositionIncrements } from './HorseRiverPositionRead.js';

export interface MultiwayRiverReadState {
  entries: Array<[string, number, number, number, number]>;
  overflow: boolean;
}
export function validMultiwayRiverState(value: unknown): value is MultiwayRiverReadState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as MultiwayRiverReadState;
  return (
    Object.keys(v).sort().join(',') === 'entries,overflow' &&
    typeof v.overflow === 'boolean' &&
    Array.isArray(v.entries) &&
    v.entries.length <= 64 &&
    new Set(v.entries.map((e) => e?.[0])).size === v.entries.length &&
    v.entries.every(
      (e) =>
        Array.isArray(e) &&
        e.length === 5 &&
        validMultiwayRiverKey(e[0]) &&
        Number.isSafeInteger(e[1]) &&
        e[1] >= 0 &&
        Number.isSafeInteger(e[2]) &&
        e[2] >= 0 &&
        e[2] <= e[1] &&
        Number.isSafeInteger(e[3]) &&
        e[3] >= 0 &&
        Number.isSafeInteger(e[4]) &&
        e[4] >= 0 &&
        e[4] <= e[3]
    )
  );
}
export function mergeMultiwayRiverStates(
  a: MultiwayRiverReadState | undefined,
  b: MultiwayRiverReadState | undefined,
  maximum = false
): MultiwayRiverReadState | undefined {
  if (!b) return a;
  if (!validMultiwayRiverState(b)) return a && validMultiwayRiverState(a) ? a : undefined;
  if (a && !validMultiwayRiverState(a)) return undefined;
  const out: MultiwayRiverReadState = structuredClone(a ?? { entries: [], overflow: false });
  out.overflow ||= b.overflow;
  for (const [key, n, folds, pressure, bets] of b.entries) {
    const row = out.entries.find((e) => e[0] === key);
    if (row) {
      row[1] = maximum ? Math.max(row[1], n) : row[1] + n;
      row[2] = maximum ? Math.max(row[2], folds) : row[2] + folds;
      row[3] = maximum ? Math.max(row[3], pressure) : row[3] + pressure;
      row[4] = maximum ? Math.max(row[4], bets) : row[4] + bets;
    } else if (out.entries.length < 64) out.entries.push([key, n, folds, pressure, bets]);
    else out.overflow = true;
  }
  return validMultiwayRiverState(out) ? out : undefined;
}
function validMultiwayRiverKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length > 180) return false;
  try {
    const v = JSON.parse(key);
    return (
      Array.isArray(v) &&
      v.length === 9 &&
      v[0] === 'multiway-hu-river-v1' &&
      ['nlh', 'plo4', 'plo5', 'plo6'].includes(v[1]) &&
      v[2] === 'cash' &&
      ['chips', 'diamonds'].includes(v[3]) &&
      v
        .slice(4, 7)
        .every((n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 1e9) &&
      v[5] > 0 &&
      v[4] <= v[5] &&
      ['per_player', 'big_blind'].includes(v[7]) &&
      Number.isInteger(v[8]) &&
      v[8] >= 3 &&
      v[8] <= 10 &&
      JSON.stringify(v) === key
    );
  } catch {
    return false;
  }
}
export function multiwayRiverContext(n: Node, count: number): string {
  const u = (v: number) => jointPotChipUnits(v, n.chipUnit);
  return JSON.stringify([
    'multiway-hu-river-v1',
    n.variant,
    n.mode,
    n.asset,
    u(n.smallBlind),
    u(n.bigBlind),
    u(n.ante),
    n.anteType,
    count,
  ]);
}
type Node = Extract<HorsePublicActionNode, { status: 'captured' }>;
/** Only public structural state. No private cards, origin or mutable model data. */
export const RIVER_NODE_KEYS = [
  'version',
  'status',
  'variant',
  'mode',
  'asset',
  'chipUnit',
  'street',
  'dealerSeat',
  'actorSeat',
  'smallBlind',
  'bigBlind',
  'ante',
  'anteType',
  'allInOrFold',
  'bombPot',
  'boardCount',
  'boards',
  'pot',
  'currentBet',
  'toCall',
  'structure',
  'minRaiseTo',
  'maxRaiseTo',
  'fixedBetSize',
  'wagersCapped',
  'legalActions',
  'seats',
] as const;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
/** Incoming sidecars use a closed schema; controller nodes are explicitly projected. */
export function riverPublicNode(value: unknown, project = false): Node | null {
  if (!object(value)) return null;
  if (
    !project &&
    (Object.keys(value).length !== RIVER_NODE_KEYS.length ||
      Object.keys(value).some((k) => !(RIVER_NODE_KEYS as readonly string[]).includes(k)))
  )
    return null;
  const n = Object.fromEntries(RIVER_NODE_KEYS.map((k) => [k, value[k]])) as unknown as Node;
  if (
    n.version !== 1 ||
    n.status !== 'captured' ||
    n.mode !== 'cash' ||
    !['nlh', 'plo4', 'plo5', 'plo6'].includes(n.variant) ||
    n.street !== 'river' ||
    !['chips', 'diamonds'].includes(n.asset) ||
    n.chipUnit !== (n.asset === 'diamonds' ? 1 : 0.01) ||
    n.structure !== (n.variant === 'nlh' ? 'no_limit' : 'pot_limit') ||
    n.bombPot !== false ||
    n.allInOrFold !== false ||
    n.boardCount !== 1 ||
    n.wagersCapped !== false ||
    n.fixedBetSize !== null ||
    !['per_player', 'big_blind'].includes(n.anteType) ||
    !Number.isInteger(n.dealerSeat) ||
    n.dealerSeat < 1 ||
    n.dealerSeat > 10 ||
    ![n.smallBlind, n.bigBlind, n.ante, n.pot, n.currentBet, n.toCall].every(finite) ||
    n.bigBlind <= 0 ||
    n.smallBlind > n.bigBlind ||
    ![n.minRaiseTo, n.maxRaiseTo].every((v) => v === null || finite(v)) ||
    !Array.isArray(n.boards) ||
    n.boards.length !== 1 ||
    typeof n.boards[0] !== 'string' ||
    !/^(?:[2-9TJQKA][cdhs]){5}$/.test(n.boards[0]) ||
    new Set(n.boards[0].match(/../g)).size !== 5 ||
    !Array.isArray(n.legalActions) ||
    n.legalActions.length < 1 ||
    n.legalActions.length > 6 ||
    new Set(n.legalActions).size !== n.legalActions.length ||
    n.legalActions.some((a) => !['fold', 'check', 'call', 'bet', 'raise', 'all_in'].includes(a)) ||
    !Array.isArray(n.seats) ||
    n.seats.length < 3 ||
    n.seats.length > 10
  )
    return null;
  const seen = new Set<number>();
  try {
    for (const s of n.seats) {
      if (
        !Array.isArray(s) ||
        s.length !== 7 ||
        !Number.isInteger(s[0]) ||
        s[0] < 1 ||
        s[0] > 10 ||
        seen.has(s[0]) ||
        !s.slice(1, 6).every(finite) ||
        !Number.isInteger(s[6]) ||
        s[6] < 0 ||
        s[6] > 7
      )
        return null;
      seen.add(s[0]);
      s.slice(1, 6).forEach((v) => jointPotChipUnits(v, n.chipUnit));
    }
    [n.smallBlind, n.bigBlind, n.ante, n.pot, n.currentBet, n.toCall].forEach((v) =>
      jointPotChipUnits(v, n.chipUnit)
    );
    for (const v of [n.minRaiseTo, n.maxRaiseTo]) if (v !== null) jointPotChipUnits(v, n.chipUnit);
  } catch {
    return null;
  }
  const actor = n.seats.find((s) => s[0] === n.actorSeat);
  if (
    !actor ||
    actor[6] !== 0 ||
    actor[1] <= 0 ||
    Math.abs(n.toCall - Math.max(0, n.currentBet - actor[2])) > n.chipUnit / 1e4
  )
    return null;
  const sized = n.legalActions.includes('bet') || n.legalActions.includes('raise');
  if (
    sized
      ? n.minRaiseTo === null || n.maxRaiseTo === null || n.maxRaiseTo < n.minRaiseTo
      : n.minRaiseTo !== null || n.maxRaiseTo !== null
  )
    return null;
  return structuredClone(n);
}
const voluntary = new Set(['fold', 'check', 'call', 'bet', 'raise', 'all_in']);
function structuralNode(
  n: Node,
  ids: Map<string, number>,
  hero: string,
  villain: string
): SeatPlayer[] | null {
  if (n.seats.length !== ids.size || n.seats.some((s) => ![...ids.values()].includes(s[0])))
    return null;
  const players = n.seats.map(
    (s) =>
      ({
        user_id: [...ids].find(([, seat]) => seat === s[0])![0],
        seat: s[0],
        stack: s[1],
        bet: s[2],
        totalInvested: s[3],
        deadInvested: s[4],
        individualAnteInvested: s[5],
        is_folded: Boolean(s[6] & 1),
        is_all_in: Boolean(s[6] & 2),
        is_sitting_out: Boolean(s[6] & 4),
        cards: [],
      }) as unknown as SeatPlayer
  );
  if (
    players.some((p) =>
      [hero, villain].includes(p.user_id)
        ? p.is_folded || p.is_all_in || p.is_sitting_out || p.stack <= 0
        : !p.is_folded || p.is_all_in || p.bet !== 0
    )
  )
    return null;
  try {
    const unit = (v: number) => jointPotChipUnits(v, n.chipUnit);
    if (players.reduce((sum, p) => sum + unit(p.totalInvested), 0) !== unit(n.pot)) return null;
    const prepared = prepareJointPots(players, n.chipUnit);
    if (
      !prepared.pots.length ||
      prepared.pots.some(
        (p) =>
          p.eligiblePlayers.length !== 2 ||
          !p.eligiblePlayers.includes(hero) ||
          !p.eligiblePlayers.includes(villain)
      )
    )
      return null;
  } catch {
    return null;
  }
  return players;
}
/** Exact pre-action money transition, with no rounded or inferred wager. */
function advances(a: ActionRecord, before: Node, after: Node): boolean {
  const same = RIVER_NODE_KEYS.filter(
    (k) =>
      ![
        'actorSeat',
        'pot',
        'currentBet',
        'toCall',
        'minRaiseTo',
        'maxRaiseTo',
        'legalActions',
        'seats',
      ].includes(k)
  );
  if (same.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) return false;
  const unit = (v: number) => jointPotChipUnits(v, before.chipUnit);
  try {
    if (!finite(a.amount) || !before.legalActions.includes(a.action) || a.seat !== before.actorSeat)
      return false;
    const actor = before.seats.find((s) => s[0] === a.seat)!;
    const total = unit(a.amount);
    const delta = a.action === 'check' ? 0 : total - unit(actor[2]);
    if (
      delta < 0 ||
      delta >= unit(actor[1]) ||
      (a.action === 'check' && (a.amount !== 0 || before.toCall !== 0)) ||
      (a.action !== 'check' &&
        (before.minRaiseTo === null ||
          before.maxRaiseTo === null ||
          total < unit(before.minRaiseTo) ||
          total > unit(before.maxRaiseTo)))
    )
      return false;
    if (
      unit(after.pot) !== unit(before.pot) + delta ||
      unit(after.currentBet) !== (a.action === 'check' ? unit(before.currentBet) : total)
    )
      return false;
    return before.seats.every((s) => {
      const t = after.seats.find((r) => r[0] === s[0]);
      if (!t) return false;
      return (
        s[6] === t[6] &&
        unit(s[4]) === unit(t[4]) &&
        unit(s[5]) === unit(t[5]) &&
        unit(t[1]) === unit(s[1]) - (s[0] === a.seat ? delta : 0) &&
        unit(t[2]) === (s[0] === a.seat && a.action !== 'check' ? total : unit(s[2])) &&
        unit(t[3]) === unit(s[3]) + (s[0] === a.seat ? delta : 0)
      );
    });
  } catch {
    return false;
  }
}
/** Prefix mode validates check/bet plus the authoritative current raise node.
 * Completed mode additionally demands the actual response; pending is unknown. */
export function multiwayRiverLine(
  actions: readonly ActionRecord[] | undefined,
  dealtCount: number,
  current?: unknown
): { hero: string; villain: string; nodes: Node[]; river: ActionRecord[] } | null {
  if (
    !Array.isArray(actions) ||
    actions.length > 4096 ||
    !Number.isInteger(dealtCount) ||
    dealtCount < 3 ||
    dealtCount > 10
  )
    return null;
  const river = actions.filter((a) => a.stage === 'river' && voluntary.has(a.action));
  if (current === undefined ? river.length < 4 : river.length !== 2) return null;
  const [check, bet, raise, response] = river;
  if (
    check.action !== 'check' ||
    bet.action !== 'bet' ||
    check.userId === bet.userId ||
    riverPositionIncrements(actions, dealtCount).get(bet.userId)?.bets !== 1
  )
    return null;
  if (actions.some((a) => a.action === 'straddle' || a.action === 'kill_blind')) return null;
  const ids = new Map<string, number>();
  const folded = new Set<string>();
  for (const a of actions) {
    if (!voluntary.has(a.action)) continue;
    if (
      !Number.isInteger(a.seat) ||
      (ids.has(a.userId) && ids.get(a.userId) !== a.seat) ||
      [...ids].some(([id, seat]) => seat === a.seat && id !== a.userId)
    )
      return null;
    ids.set(a.userId, a.seat);
    if (a.stage !== 'river' && a.action === 'fold') folded.add(a.userId);
  }
  if (
    ids.size !== dealtCount ||
    [...ids.keys()].some((id) => id !== check.userId && id !== bet.userId && !folded.has(id))
  )
    return null;
  const source =
    current === undefined
      ? river.slice(0, 4).map((a) => a.publicNode)
      : [check.publicNode, bet.publicNode, current];
  const nodes = source.map((n) => riverPublicNode(n, true));
  if (nodes.some((n) => !n)) return null;
  const ns = nodes as Node[];
  for (let i = 0; i < ns.length; i++) {
    const a = river[i];
    if (
      ns[i].actorSeat !== (a?.seat ?? check.seat) ||
      !structuralNode(ns[i], ids, check.userId, bet.userId)
    )
      return null;
    if (i && !advances(river[i - 1], ns[i - 1], ns[i])) return null;
  }
  try {
    const u = (v: number) => jointPotChipUnits(v, ns[0].chipUnit);
    if (ns[0].currentBet !== 0 || ns[0].seats.some((s) => s[2] !== 0)) return null;
    const b = u(bet.amount),
      target = b * 3;
    const hero = ns[2].seats.find((s) => s[0] === check.seat)!;
    const villain = ns[2].seats.find((s) => s[0] === bet.seat)!;
    if (b <= 0 || target >= u(hero[1]) || target - b >= u(villain[1])) return null;
    if (
      current === undefined &&
      (raise.action !== 'raise' ||
        raise.userId !== check.userId ||
        response.userId !== bet.userId ||
        u(raise.amount) !== target ||
        !['fold', 'call', 'raise', 'all_in'].includes(response.action) ||
        !ns[3].legalActions.includes(response.action) ||
        !finite(response.amount) ||
        (response.action === 'fold' ? response.amount !== 0 : response.amount <= 0))
    )
      return null;
    if (current === undefined) {
      const n = ns[3],
        seat = n.seats.find((s) => s[0] === response.seat)!;
      const answered = u(response.amount);
      if (response.action === 'call' && answered !== Math.min(u(n.toCall), u(seat[1]))) return null;
      if (response.action === 'all_in' && answered !== u(seat[1]) + u(seat[2])) return null;
      if (
        response.action === 'raise' &&
        (n.minRaiseTo === null ||
          n.maxRaiseTo === null ||
          answered < u(n.minRaiseTo) ||
          answered > u(n.maxRaiseTo) ||
          answered <= u(n.currentBet))
      )
        return null;
    }
  } catch {
    return null;
  }
  return { hero: check.userId, villain: bet.userId, nodes: ns, river };
}
export function multiwayRiverIncrements(
  actions: readonly ActionRecord[] | undefined,
  dealtCount: number
) {
  const line = multiwayRiverLine(actions, dealtCount);
  return line
    ? {
        id: line.villain,
        context: multiwayRiverContext(line.nodes[0], dealtCount),
        opportunities: 1,
        folds: line.river[3].action === 'fold' ? 1 : 0,
      }
    : null;
}

/** Both bets and check-backs belong in the denominator. Never derive betting
 * frequency from the selected checkraise-response sample. */
export function multiwayRiverPressure(
  actions: readonly ActionRecord[] | undefined,
  dealtCount: number
) {
  if (
    !Array.isArray(actions) ||
    actions.length > 4096 ||
    !Number.isInteger(dealtCount) ||
    dealtCount < 3 ||
    dealtCount > 10
  )
    return null;
  const river = actions.filter((a) => a.stage === 'river' && voluntary.has(a.action));
  if (
    river.length < 2 ||
    river[0].action !== 'check' ||
    !['bet', 'check'].includes(river[1].action)
  )
    return null;
  const [check, answer] = river;
  const increment = riverPositionIncrements(actions, dealtCount).get(answer.userId);
  if (
    !increment ||
    increment.opportunities !== 1 ||
    actions.some((a) => a.action === 'straddle' || a.action === 'kill_blind')
  )
    return null;
  const ids = new Map<string, number>(),
    folded = new Set<string>();
  for (const a of actions) {
    if (!voluntary.has(a.action)) continue;
    if (
      !Number.isInteger(a.seat) ||
      (ids.has(a.userId) && ids.get(a.userId) !== a.seat) ||
      [...ids].some(([id, seat]) => seat === a.seat && id !== a.userId)
    )
      return null;
    ids.set(a.userId, a.seat);
    if (a.stage !== 'river' && a.action === 'fold') folded.add(a.userId);
  }
  if (
    ids.size !== dealtCount ||
    [...ids.keys()].some((id) => id !== check.userId && id !== answer.userId && !folded.has(id))
  )
    return null;
  const first = riverPublicNode(check.publicNode, true),
    second = riverPublicNode(answer.publicNode, true);
  if (
    !first ||
    !second ||
    first.actorSeat !== check.seat ||
    second.actorSeat !== answer.seat ||
    first.currentBet !== 0 ||
    first.seats.some((s) => s[2] !== 0) ||
    !structuralNode(first, ids, check.userId, answer.userId) ||
    !structuralNode(second, ids, check.userId, answer.userId) ||
    !advances(check, first, second) ||
    !second.legalActions.includes(answer.action)
  )
    return null;
  try {
    const u = (n: number) => jointPotChipUnits(n, second.chipUnit);
    if (
      answer.action === 'check'
        ? answer.amount !== 0 || second.toCall !== 0
        : !finite(answer.amount) ||
          second.minRaiseTo === null ||
          second.maxRaiseTo === null ||
          u(answer.amount) < u(second.minRaiseTo) ||
          u(answer.amount) > u(second.maxRaiseTo)
    )
      return null;
  } catch {
    return null;
  }
  return {
    id: answer.userId,
    context: multiwayRiverContext(first, dealtCount),
    opportunities: 1,
    bets: increment.bets,
  };
}
