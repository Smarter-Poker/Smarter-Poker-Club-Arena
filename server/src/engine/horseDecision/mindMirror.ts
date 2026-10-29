import { mergeMultiwayRiverStates } from '../HorseMultiwayRiverRead.js';
/**
 * ONE FLOOR, ONE READ (2026-10-16).
 *
 * The decision lane is sharded by table (lane.ts), and each worker's HorseMind
 * used to learn only from its own tables. Two horses facing the same player
 * on two shards therefore priced that player from two different histories.
 * Every completed hand now reaches every shard (LiveHorseDecisionWorkerPool.
 * observeCompletedHand); the owner observes it exactly as before, and this is
 * how every other shard learns it.
 *
 * WHY NOT JUST CALL observe() ON THE OTHER SHARDS. HorseMind dedupes a hand in
 * flight by two bounded caches, evicted oldest first: the per-action keys
 * (60,000) and the per-hand participation flags (20,000, about twelve a hand).
 * Feeding a shard the whole floor's hands would multiply what it inserts into
 * them by the shard count, and its OWN hands in flight would lose their flags
 * after about a minute instead of about three: a player whose preflop flag was
 * evicted is counted into `hands` (and VPIP) a second time on the flop. That
 * would corrupt the read this change exists to share. HorseMind.ts is inside
 * the Phase 10-13 policy digests and is not changed here.
 *
 * So another table's hand is learned in an isolated HorseMind sandbox (its own
 * caches, empty), which yields exactly that hand's contribution to every
 * counter, and the contribution is added to the live memory. Lifetime, scoped
 * and pair counters are plain sums. The recency window is reproduced exactly:
 * observe() increments rHands at the player's first action of a hand and, at
 * 24, halves the window BEFORE that hand's own recency counts are added, which
 * is what addHandContribution does. The source window merges as observe()
 * merges it.
 *
 * A player, scope row or pair this memory has never seen enters through the
 * import paths boot hydration uses. One it already holds is updated in place
 * on the row HorseMind's own read accessor returns, because the import path
 * keeps the larger of live and incoming for the recency counters (a hydrate
 * must never lose live information) and so cannot express the halving: a
 * mirror that went through it would hold a recency window that never decays.
 * The update writes exactly the values observe() would have written.
 *
 * Nothing learned here is marked for the persistence flush: the owner flushes
 * its players, and its counters already include what every other shard
 * learned and mirrored back to it, so the GREATEST-merged row is the floor's.
 * A hand is learned at most once per shard (bounded dedupe below), because
 * unlike observe() an addition is not idempotent.
 */
import {
  HorseMind,
  type HorseMindSandbox,
  type OpponentStats,
  type ReadScope,
} from '../HorseMind.js';
import type { ObserveCompletedHandRequest } from './protocol.js';
import {
  mergeHorseObservationWindows,
  normalizeHorseObservationWindow,
} from '../HorseObservationWindow.js';

/** Hands remembered for dedupe; ~17 minutes of the whole floor at 19.4 hands a second. */
export const HORSE_MIND_MIRROR_DEDUPE = 20_000;

/** The recency counters observe() halves with rHands. */
const RECENCY_FIELDS = ['rFolds', 'rFacedAggr', 'rAggr', 'rPassive', 'rChecks'] as const;
/** observe(): `if (s.rHands >= 24)` halves the window. */
const RECENCY_HALVING_HANDS = 24;

export type HorseMindMirrorOutcome = 'learned' | 'duplicate' | 'nothing_to_learn';

type Counters = Record<string, number>;

function counters(row: OpponentStats | undefined): Counters {
  const out: Counters = {};
  if (!row) return out;
  for (const [key, value] of Object.entries(row))
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  return out;
}

/** live + one hand's contribution, with observe()'s recency halving. */
export function addHandContribution(
  live: OpponentStats | undefined,
  hand: OpponentStats
): Partial<OpponentStats> {
  const base = counters(live);
  const delta = counters(hand);
  const merged: Counters = { ...base };
  for (const [key, value] of Object.entries(delta)) merged[key] = (base[key] ?? 0) + value;
  const handsSeen = delta.rHands ?? 0;
  if (handsSeen > 0 && live && merged.rHands! >= RECENCY_HALVING_HANDS) {
    // One hand adds exactly one rHands (a fresh sandbox row starts at zero).
    merged.rHands = ((base.rHands ?? 0) + handsSeen) / 2;
    for (const field of RECENCY_FIELDS)
      merged[field] = (base[field] ?? 0) / 2 + (delta[field] ?? 0);
  }
  const hu = mergeMultiwayRiverStates(live?.riverHu, hand.riverHu);
  return {
    ...(merged as Partial<OpponentStats>),
    ...(hu ? { riverHu: hu } : {}),
    sourceWindow: hand.sourceWindow,
  };
}

function splitKey(key: string): [string, string] | null {
  const bar = key.indexOf('|');
  return bar > 0 && bar < key.length - 1 ? [key.slice(0, bar), key.slice(bar + 1)] : null;
}

/** Write one hand's contribution onto a row the live memory already holds. */
function updateLiveRow(live: OpponentStats, hand: OpponentStats): void {
  const hadContributions = Object.entries(live).some(
    ([key, value]) => key !== 'sourceWindow' && typeof value === 'number' && value > 0
  );
  const merged = addHandContribution(live, hand);
  const row = live as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(merged))
    if (key !== 'sourceWindow' && typeof value === 'number') row[key] = value;
  if (merged.riverHu) live.riverHu = merged.riverHu;
  live.sourceWindow = hadContributions
    ? mergeHorseObservationWindows(live.sourceWindow, hand.sourceWindow)
    : normalizeHorseObservationWindow(hand.sourceWindow);
}

/** Add a sandbox's whole contribution to the live HorseMind. */
export function mergeSandboxIntoLiveMind(sandbox: HorseMindSandbox): void {
  const stats: Array<{ user_id: string } & Partial<OpponentStats>> = [];
  for (const [userId, hand] of sandbox.stats) {
    const live = HorseMind.getStats(userId);
    if (live) updateLiveRow(live, hand);
    else stats.push({ user_id: userId, ...addHandContribution(undefined, hand) });
  }
  if (stats.length) HorseMind.importStats(stats);

  const scoped: Array<{ user_id: string; scope: string } & Partial<OpponentStats>> = [];
  for (const [key, hand] of sandbox.scoped) {
    const parts = splitKey(key);
    if (!parts) continue;
    const [scope, userId] = parts;
    const live = HorseMind.getScopedStats(userId, scope as ReadScope);
    if (live) updateLiveRow(live, hand);
    else scoped.push({ user_id: userId, scope, ...addHandContribution(undefined, hand) });
  }
  if (scoped.length) HorseMind.importScoped(scoped);

  const pairs: Array<{
    attacker_id: string;
    victim_id: string;
    n3: number;
    opp3: number;
    nR: number;
    oppR: number;
  }> = [];
  for (const [key, hand] of sandbox.pairs) {
    const parts = splitKey(key);
    if (!parts) continue;
    const [attacker, victim] = parts;
    const live = HorseMind.getPair(attacker, victim);
    if (live) {
      live.n3 += hand.n3;
      live.opp3 += hand.opp3;
      live.nR += hand.nR;
      live.oppR += hand.oppR;
    } else pairs.push({ attacker_id: attacker, victim_id: victim, ...hand });
  }
  if (pairs.length) HorseMind.importPairs(pairs);

  // The opponent-exploit read (decayed per-opponent counters) travels too, so
  // a player read on one shard is read the same way on every other shard.
  HorseMind.mergeSandboxExploit(sandbox);
}

export class HorseMindMirror {
  private readonly learnedHands = new Set<string>();

  constructor(private readonly dedupeLimit = HORSE_MIND_MIRROR_DEDUPE) {}

  /**
   * Learn one completed hand another shard owns. `observe` is the worker's
   * own completed-hand learner (the one the owner runs), executed here inside
   * a fresh sandbox. Throws only what HorseMind.runInSandbox throws.
   */
  learn(
    request: ObserveCompletedHandRequest,
    observe: (request: ObserveCompletedHandRequest) => void
  ): HorseMindMirrorOutcome {
    const key = JSON.stringify([request.handKey, request.committedHandId ?? null]);
    if (this.learnedHands.has(key)) return 'duplicate';
    const sandbox = HorseMind.createSandbox();
    HorseMind.runInSandbox(sandbox, () => observe(request));
    this.learnedHands.add(key);
    while (this.learnedHands.size > this.dedupeLimit)
      this.learnedHands.delete(this.learnedHands.values().next().value!);
    if (
      sandbox.stats.size === 0 &&
      sandbox.scoped.size === 0 &&
      sandbox.pairs.size === 0 &&
      HorseMind.sandboxExploitRows(sandbox).size === 0
    )
      return 'nothing_to_learn';
    mergeSandboxIntoLiveMind(sandbox);
    return 'learned';
  }

  get rememberedHands(): number {
    return this.learnedHands.size;
  }
}
