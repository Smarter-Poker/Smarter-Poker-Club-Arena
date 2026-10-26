/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE MATCHER, AS A PURE FUNCTION, BY VERSION (Lightning Phase 11, 2026-10-08)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The LIVE matcher is SQL: `fn_lightning_match_plan` decides every hand that
 * is formed, inside `fn_lightning_match_and_form`, and nothing here changes
 * that. This module is the matcher's MODEL in TypeScript, for the two jobs
 * that must not touch the database or the live pool:
 *
 *   - the SHADOW MATCHER (LightningShadowRunner): on the population snapshot
 *     each live pass saw, a candidate version decides what IT would have
 *     dealt, and the decisions are compared - never executed;
 *   - the OFFLINE SIMULATOR (LightningMatcherSim, src/scripts/
 *     lightningMatcherSim.ts): a synthetic population, thousands of hands.
 *
 * PLUGGABLE BY VERSION. `LIGHTNING_MATCHER_MODELS` maps a matcher_version to
 * a pure `plan(snapshot, params)`. Two plans exist (and `m1-port`, below,
 * is m1 under a second name):
 *
 *   - `m1`, a line-for-line port of the live SQL plan (P1 group sizes from
 *     the legal count, P2 big blinds by the barrier's blind order, the
 *     first-entry rule (always on: a newcomer is dealt in only as a big
 *     blind, 20261024195059; a seat the epoch's conversion made is not a
 *     newcomer, and a newcomer leads P2, 20261024213844), P4 queue order for
 *     the other seats, P2 again for the
 *     small blinds, P5's diversity assignment with the SQL's weights and
 *     bands, and P3's advisory position order from the button backward);
 *   - `m2`, THE CANDIDATE: m1 with P5's diversity also weighing in the
 *     thin band (`candidate.thinWeight`, half the medium weight by default),
 *     every band's weight scaled by `candidate.diversityScale`, and P3's tie
 *     going to the longest-waiting player instead of the newest. The knobs
 *     are the candidate's own (LightningMatcherParams.candidate), so a sweep
 *     can turn them in the simulator; the DB's `quality_weights` are the
 *     comparison's scoring weights, computed by the database, not a matcher
 *     input.
 *
 * A future candidate is one more entry in the map (and, when it wins, the
 * same change in the SQL plan under a new matcher_version). A version this
 * map does not know makes the shadow side quietly unavailable.
 *
 * `m1-port` IS `m1` UNDER ITS OWN NAME (Phase 11 remediation, 2026-10-09):
 * the same pure plan, registered so the shadow can run it beside the live
 * SQL `m1` and record an A/A calibration (live m1 against shadow m1-port).
 * The database refuses a comparison of a version with itself; it accepts
 * these two names, and any gap between their scores is the measurement's
 * own bias, not a matcher difference. scripts/dev/test-lightning-matcher-
 * parity.sh proves the port against the real fn_lightning_match_plan on
 * PostgreSQL 17: identical groups, blinds and positions on the same
 * snapshot.
 *
 * TIME IS IN MILLISECONDS WITH MICROSECOND FRACTIONS. PostgreSQL stamps in
 * microseconds and the barrier stamps each group of a pass its own
 * microsecond (`v_now + (ordinal - 1) * 1 microsecond`), so a snapshot taken
 * from the database carries `epoch_us / 1000`: a double holds every
 * microsecond of this century distinctly and in order, which is all the
 * plan's comparisons need.
 *
 * NOTHING HERE READS A RISK SCORE. The snapshot carries the queue keys the
 * SQL plan reads and nothing else: the integrity telemetry
 * (LightningTelemetry) is never an input, so a risk signal can never move a
 * seat (spec: matchmaking is not manipulated by risk score). Horses are
 * players like any other here (CLAUDE.md 10.5): there is no horse field.
 */

/** One open-pool player as a matcher pass sees them. */
export interface LightningPoolPlayer {
  playerId: string;
  /** Legal to seat this pass (connected, idle, not blocked). */
  legal: boolean;
  /** Why not, when not legal (e.g. DISCONNECTED). */
  reasonCode: string | null;
  /** P4's first key: when the player last became free to be matched (sl.idle_since). */
  idleSinceMs: number;
  /** P4's second key: when the player's pool session entered (ps.entered_at). */
  enteredAtMs: number;
  /**
   * P4's third key: when the player joined the Cluster (the cash session's
   * opened_at, cps.opened_at). Absent or null sorts last, as the SQL's
   * NULLS LAST does; absent everywhere, the next key (player_id) decides.
   */
  joinedAtMs?: number | null;
  /**
   * P2's fourth key, and the debt age's fallback: when the player's pool
   * SLOT opened (sl.opened_at), which is not the pool session's entry. Absent
   * = enteredAtMs (a model that never saw the two apart).
   */
  slotOpenedAtMs?: number;
  /** P2: when the player last paid a big blind; null = never (outranks everyone). */
  lastBbAtMs: number | null;
  /** P2: an unresolved BB obligation (missed BB debt or BB owed). */
  bbUnresolved: boolean;
  /** P2: the age of the player's blind debt, coalesce(bl.debt_since, sl.opened_at). */
  debtSinceMs: number;
  /** Hands the player has been dealt since their last big blind (null = none yet). */
  handsSinceBb: number | null;
  /**
   * The first-entry rule's key, as the database reports it: this pool slot
   * has never been the big blind (sl.last_bb_at IS NULL, 20261024195059) AND
   * it was not seated by the conversion that began the Cluster's epoch
   * (20261024213844: a player who was already at the tables when the game
   * turned Lightning is not a new player). The plan reads it through
   * `isLightningNewcomer`, which also requires `lastBbAtMs === null`, so the
   * flag can only EXEMPT a conversion seat; it can never make a newcomer of a
   * slot that has been the big blind.
   */
  newcomer: boolean;
  /** P3: how often the player has held each labelled position. */
  positions: { btn: number; co: number; hj: number; utg: number };
}

/** One recent hand of the Cluster (P5's memory). */
export interface LightningRecentHand {
  players: string[];
  formedAtMs: number;
  /** The hand's id: the SQL window's tie-break among hands formed at one instant. */
  handId?: string;
  /** The Cluster epoch the hand was formed in; P5 reads only the current one. */
  epoch?: number;
}

export interface LightningPoolSnapshot {
  nowMs: number;
  players: LightningPoolPlayer[];
  /** Most recent first is not required; the model orders them. */
  recentHands: LightningRecentHand[];
  /**
   * The Cluster's current epoch, when known: P5's window holds only the
   * hands of this epoch (h.cluster_epoch = v_epoch). Absent = no filter.
   */
  epoch?: number;
  /**
   * Whether the SQL plan that read this snapshot posted entry big blinds
   * (its `entry_big_blind`, 20261025050528), when the snapshot is the
   * database's own: it overrides `params.entryBigBlind`, so an A/A
   * comparison against a database whose gate is still closed compares like
   * with like. Absent = the params decide.
   */
  entryBigBlind?: boolean;
  /**
   * The database's legal count for this pass (fn_lightning_player_legality's
   * answer, as the live pass reported it), when the snapshot's own legality
   * is only an estimate: P5's band is read from it, as the SQL reads its band
   * from the legal count. Absent = the snapshot's own legal players.
   */
  legalCount?: number | null;
}

/** The fn_lightning_config keys the plan reads, with the SQL's defaults. */
export interface LightningMatcherParams {
  instanceMin: number;
  instanceTarget: number;
  instanceMax: number;
  /**
   * ALWAYS 'big_blind' from the live config (Dan 2026-10-24: "NEW PLAYERS
   * SHOULD ALWAYS BE BB FIRST"): `lightningMatcherParams` never returns
   * anything else, as fn_lightning_config never does. 'any_seat' survives only
   * as an OFFLINE what-if for the simulator (LightningMatcherSim), to measure
   * what the rule costs; no live path can reach it.
   */
  firstEntryRule: 'any_seat' | 'big_blind';
  /**
   * ENTRY BIG BLIND (20261025050528): a newcomer the pass seats outside its
   * big blinds (only when holding them would leave the pass no hand) posts a
   * live entry big blind. True for this engine, which posts it
   * (LightningHandHost); false reproduces the SQL plan while its gate
   * (the header and constraint gate of 20261025050528) is closed.
   */
  entryBigBlind: boolean;
  positionFairness: boolean;
  recentWindowHands: number;
  recentWindowSeconds: number;
  diversityThinMin: number;
  diversityMediumMin: number;
  diversityLargeMin: number;
  diversityWeightMedium: number;
  diversityWeightLarge: number;
  /** p_max_groups: the pass's admission batch. */
  maxGroups: number;
  /** The candidate's own knobs (m2); m1 ignores them. */
  candidate: Readonly<LightningCandidateKnobs>;
}

export const LIGHTNING_MATCHER_PARAM_DEFAULTS: Readonly<LightningMatcherParams> = Object.freeze({
  instanceMin: 5,
  instanceTarget: 6,
  instanceMax: 6,
  firstEntryRule: 'big_blind',
  entryBigBlind: true,
  positionFairness: true,
  recentWindowHands: 60,
  recentWindowSeconds: 900,
  diversityThinMin: 18,
  diversityMediumMin: 27,
  diversityLargeMin: 54,
  diversityWeightMedium: 0.5,
  diversityWeightLarge: 1,
  maxGroups: 32,
  candidate: Object.freeze({ thinWeight: null, diversityScale: 1 }),
});

export interface LightningCandidateKnobs {
  /** P5 weight in the thin band; null = half the medium weight. */
  thinWeight: number | null;
  /** Every band's P5 weight is multiplied by this. */
  diversityScale: number;
}

export interface LightningPlannedGroup {
  /** big blind, small blind, then seat 3 onward with the button last. */
  players: string[];
  bb: string;
  sb: string;
  btn: string;
  /**
   * The newcomers in this group who post a live entry big blind (the SQL
   * group's `entry_bb`), in `players` order. Never the big blind; the small
   * blind only when nobody else can hold it (its small blind is then dead).
   */
  entryBb: string[];
}

export interface LightningMatchPlan {
  matcherVersion: string;
  groups: LightningPlannedGroup[];
  legalCount: number;
  /** 1 - repeat pairs / pairs over the groups (1 when there are no pairs). */
  poolDiversityScore: number;
}

export interface LightningMatcherModel {
  readonly version: string;
  readonly note: string;
  plan(snapshot: LightningPoolSnapshot, params: LightningMatcherParams): LightningMatchPlan;
}

// ─── P1: GROUP SIZES (fn_lightning_group_sizes, ported) ───────────────────

export function lightningGroupSizes(
  legal: number,
  min: number,
  target: number,
  max: number
): number[] {
  const vMax = Math.min(Math.max(max || 2, 2), 9);
  const vMin = Math.min(Math.max(min || 2, 2), vMax);
  const vTarget = Math.min(Math.max(target || vMax, vMin), vMax);
  const n = Math.max(legal || 0, 0);
  if (n < vMin) return [];
  const lo = Math.ceil(n / vMax);
  const hi = Math.floor(n / vMin);
  let k: number;
  let seat: number;
  if (lo <= hi) {
    k = lo;
    let best = Math.abs(n / lo - vTarget);
    for (let i = lo + 1; i <= hi; i++) {
      const d = Math.abs(n / i - vTarget);
      if (d < best) {
        best = d;
        k = i;
      }
    }
    seat = n;
  } else {
    k = hi;
    seat = hi * vMax;
  }
  if (k <= 0) return [];
  const q = Math.floor(seat / k);
  const r = seat % k;
  const out: number[] = [];
  for (let i = 1; i <= k; i++) out.push(q + (i <= r ? 1 : 0));
  return out;
}

/** Owner choice, 2026-10-23: six ready players form immediately; five wait
 * from the fifth arrival for a sixth. Never form fewer than five. The wait was
 * three seconds; Dan, 2026-10-26: "Approved: five-player Lightning hands wait
 * 1 second" (the database's own rule moves with it in
 * 20261026131624_lightning_five_ready_players_wait_one_second_for_a_sixth). */
export const LIGHTNING_FORMATION_MAX_WAIT_MS = 1_000;

export function lightningFormationSizes(
  players: readonly LightningPoolPlayer[],
  nowMs: number,
  _params: LightningMatcherParams
): number[] {
  const sizes = Array.from({ length: Math.floor(players.length / 6) }, () => 6);
  // The fifth arrival starts the wait. An old first arrival must never
  // release four new arrivals before they have waited for the sixth.
  const fifthReadyAt = players.reduce((t, p) => Math.max(t, p.idleSinceMs), -Infinity);
  if (players.length % 6 === 5 && nowMs - fifthReadyAt >= LIGHTNING_FORMATION_MAX_WAIT_MS)
    sizes.push(5);
  return sizes;
}

// ─── ORDERS ───────────────────────────────────────────────────────────────

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * THE FIRST-ENTRY KEY (20261024195059, narrowed by 20261024213844): a pool
 * slot that has never been the big blind and that the conversion beginning
 * the Cluster's epoch did not seat. The SQL reads `sl.last_bb_at IS NULL AND
 * NOT <conversion seat>` (the same expression in fn_lightning_blind_order,
 * fn_lightning_match_plan and fn_lightning_matcher_snapshot), and the snapshot
 * carries the database's answer as `newcomer`. This reads `lastBbAtMs` as
 * well, never the Cluster's blind ledger, so a flag can only exempt.
 */
export const isLightningNewcomer = (p: LightningPoolPlayer): boolean =>
  p.lastBbAtMs === null && p.newcomer;

/** The pool slot's opening (P2's fourth key), or the pool entry when the model never saw it apart. */
const slotOpened = (p: LightningPoolPlayer): number => p.slotOpenedAtMs ?? p.enteredAtMs;

/**
 * P2, the barrier's blind order (fn_lightning_blind_order): an unresolved
 * obligation first, then a NEWCOMER (20261024213844: a player who has just
 * bought in is the next big blind, ahead of conversion seats that have not
 * been the big blind yet), then last_bb_at NULLS FIRST, then the debt age,
 * then the SLOT's opening (sl.opened_at), then player_id.
 */
export function compareBlindOrder(a: LightningPoolPlayer, b: LightningPoolPlayer): number {
  if (a.bbUnresolved !== b.bbUnresolved) return a.bbUnresolved ? -1 : 1;
  const na = isLightningNewcomer(a);
  const nb = isLightningNewcomer(b);
  if (na !== nb) return na ? -1 : 1;
  if (a.lastBbAtMs !== b.lastBbAtMs) {
    if (a.lastBbAtMs === null) return -1;
    if (b.lastBbAtMs === null) return 1;
    return a.lastBbAtMs - b.lastBbAtMs;
  }
  if (a.debtSinceMs !== b.debtSinceMs) return a.debtSinceMs - b.debtSinceMs;
  const sa = slotOpened(a);
  const sb = slotOpened(b);
  if (sa !== sb) return sa - sb;
  return cmp(a.playerId, b.playerId);
}

/**
 * P4, the queue (fn_lightning_match_plan's row_number): ORDER BY
 * sl.idle_since, ps.entered_at, cps.opened_at, player_id - the Cluster join
 * with NULLS LAST, as PostgreSQL sorts an absent one ascending.
 */
export function compareQueueOrder(a: LightningPoolPlayer, b: LightningPoolPlayer): number {
  if (a.idleSinceMs !== b.idleSinceMs) return a.idleSinceMs - b.idleSinceMs;
  if (a.enteredAtMs !== b.enteredAtMs) return a.enteredAtMs - b.enteredAtMs;
  const ja = a.joinedAtMs ?? null;
  const jb = b.joinedAtMs ?? null;
  if (ja !== jb) {
    if (ja === null) return 1;
    if (jb === null) return -1;
    return ja - jb;
  }
  return cmp(a.playerId, b.playerId);
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}/${b}` : `${b}/${a}`);
const setKey = (ids: readonly string[]): string => [...ids].sort(cmp).join(',');

/**
 * P5's memory: the window of recent hands, most recent first - the SQL's
 * `WHERE h.cluster_epoch = v_epoch AND h.formed_at <= v_now AND h.formed_at
 * > v_now - window ORDER BY h.formed_at DESC, h.hand_id LIMIT hands`. A hand
 * of another epoch is outside it (when both epochs are known), and hands
 * formed at one instant are taken in hand_id order.
 */
export function recentWindow(
  snapshot: LightningPoolSnapshot,
  params: LightningMatcherParams
): LightningRecentHand[] {
  const since = snapshot.nowMs - params.recentWindowSeconds * 1000;
  const epoch = snapshot.epoch;
  return snapshot.recentHands
    .filter(
      (h) =>
        h.formedAtMs <= snapshot.nowMs &&
        h.formedAtMs > since &&
        (epoch === undefined || h.epoch === undefined || h.epoch === epoch)
    )
    .sort((a, b) =>
      b.formedAtMs !== a.formedAtMs
        ? b.formedAtMs - a.formedAtMs
        : a.handId !== undefined && b.handId !== undefined
          ? cmp(a.handId, b.handId)
          : 0
    )
    .slice(0, Math.max(0, params.recentWindowHands));
}

/** Pair encounters among `among` in the window, and the window's full-table sets. */
export function encounterMemory(
  window: readonly LightningRecentHand[],
  among: ReadonlySet<string>
): { encounters: Map<string, number>; recentSets: Set<string> } {
  const encounters = new Map<string, number>();
  const recentSets = new Set<string>();
  for (const h of window) {
    recentSets.add(setKey(h.players));
    const inside = h.players.filter((p) => among.has(p));
    for (let i = 0; i < inside.length; i++)
      for (let j = i + 1; j < inside.length; j++) {
        const k = pairKey(inside[i], inside[j]);
        encounters.set(k, (encounters.get(k) ?? 0) + 1);
      }
  }
  return { encounters, recentSets };
}

/** fn_lightning_diversity_assign, ported: each rest player to the first group with room, unless P5 saves weight x penalty >= 1 elsewhere. */
export function diversityAssign(
  groups: string[][],
  rest: readonly string[],
  capacity: number[],
  encounters: ReadonlyMap<string, number>,
  recentSets: ReadonlySet<string>,
  weight: number
): string[][] {
  const grp = groups.map((g) => [...g]);
  const cap = [...capacity];
  const active = weight > 0 && (encounters.size > 0 || recentSets.size > 0);
  for (const p of rest) {
    const def = cap.findIndex((c) => c > 0);
    if (def < 0) throw new Error(`diversityAssign: ${rest.length} players for fewer seats`);
    let best = def;
    if (active) {
      let defPen: number | null = null;
      let bestPen: number | null = null;
      for (let j = 0; j < grp.length; j++) {
        if (cap[j] <= 0) continue;
        let pen = 0;
        for (const m of grp[j]) pen += encounters.get(pairKey(p, m)) ?? 0;
        if (cap[j] === 1 && recentSets.size > 0 && recentSets.has(setKey([...grp[j], p]))) {
          const size = grp[j].length;
          pen += Math.floor(((size + 1) * size) / 2);
        }
        if (j === def) defPen = pen;
        if (bestPen === null || pen < bestPen) {
          bestPen = pen;
          best = j;
        }
      }
      if (!(weight * ((defPen ?? 0) - (bestPen ?? 0)) >= 1)) best = def;
    }
    grp[best].push(p);
    cap[best]--;
  }
  return grp;
}

type Band = 'tiny' | 'thin' | 'medium' | 'large';

function bandOf(n: number, params: LightningMatcherParams): Band {
  if (n >= params.diversityLargeMin) return 'large';
  if (n >= params.diversityMediumMin) return 'medium';
  if (n >= params.diversityThinMin) return 'thin';
  return 'tiny';
}

interface PlanKnobs {
  /** P5 weight for the pass's band. */
  weight(band: Band, params: LightningMatcherParams): number;
  /** P3: among equally-fair candidates, take the newest in queue order (SQL) or the oldest. */
  p3TieTakesNewest: boolean;
}

/** The SQL plan, parameterised by the knobs a candidate may turn. */
function planWith(
  version: string,
  knobs: PlanKnobs,
  snapshot: LightningPoolSnapshot,
  params: LightningMatcherParams
): LightningMatchPlan {
  const byId = new Map(snapshot.players.map((p) => [p.playerId, p]));
  const legal = snapshot.players.filter((p) => p.legal).sort(compareBlindOrder);
  const n = legal.length;
  // P5's band by the legal count: the database's, when the snapshot only
  // estimates legality (the shadow runner's engine-side pool).
  const bandCount =
    typeof snapshot.legalCount === 'number' && Number.isFinite(snapshot.legalCount)
      ? snapshot.legalCount
      : n;
  const weight = knobs.weight(bandOf(bandCount, params), params);
  const cap = Math.max(0, Math.floor(params.maxGroups));

  let seatable = legal;
  let sizes = lightningFormationSizes(
    seatable,
    snapshot.nowMs + LIGHTNING_FORMATION_MAX_WAIT_MS,
    params
  );
  let g = Math.min(sizes.length, cap);

  // NEW PLAYERS ARE ALWAYS THE BIG BLIND FIRST (20261024195059, the SQL's
  // LOOP, line for line). A newcomer who is not one of this pass's big blinds
  // is held even when that costs the pass a hand; holding shrinks the pass,
  // so its big blinds are taken again and a newcomer pushed out of them is
  // held too, until nothing changes. The one exception: a hold that would
  // leave the pass no hand at all is not taken (a pool of only newcomers
  // still deals).
  if (params.firstEntryRule === 'big_blind') {
    for (;;) {
      if (g === 0) break;
      const firstBbs = new Set(seatable.slice(0, g).map((p) => p.playerId));
      const next = seatable.filter((p) => !isLightningNewcomer(p) || firstBbs.has(p.playerId));
      if (next.length === seatable.length) break;
      const sizes2 = lightningFormationSizes(
        next,
        snapshot.nowMs + LIGHTNING_FORMATION_MAX_WAIT_MS,
        params
      );
      const g2 = Math.min(sizes2.length, cap);
      if (g2 === 0) break;
      seatable = next;
      sizes = sizes2;
      g = g2;
    }
  }

  const bbs = seatable.slice(0, g);
  const bbSet = new Set(bbs.map((p) => p.playerId));
  const restAll = seatable.filter((p) => !bbSet.has(p.playerId)).sort(compareQueueOrder);
  const need = sizes.slice(0, g).reduce((s, x) => s + x, 0) - g;
  let rest = restAll.slice(0, Math.max(0, need));

  // ENTRY BIG BLIND (20261025050528, the SQL's v_entry): the newcomers the
  // pass seats outside its big blinds - only possible when the loop above
  // stopped because holding them would leave no hand - post a live entry big
  // blind, exactly as the big blind plays.
  const entryOn = snapshot.entryBigBlind ?? params.entryBigBlind;
  const entry = new Set(entryOn ? rest.filter(isLightningNewcomer).map((p) => p.playerId) : []);

  const seated = new Set([...bbs, ...rest].map((p) => p.playerId));
  const window = g > 0 ? recentWindow(snapshot, params) : [];
  const { encounters, recentSets } = encounterMemory(window, seated);
  // Ordered pairs a/b: b sat in a's most recent hand (an immediate repeat).
  const lastOf = new Map<string, string[]>();
  for (const h of window)
    for (const p of h.players) if (seated.has(p) && !lastOf.has(p)) lastOf.set(p, h.players);

  // The small blinds come from the players who are not entry posters first
  // (ORDER BY (pid = ANY (v_entry)), p2).
  const isEntry = (p: LightningPoolPlayer) => (entry.has(p.playerId) ? 1 : 0);
  const sbs = [...rest]
    .sort((a, b) => isEntry(a) - isEntry(b) || compareBlindOrder(a, b))
    .slice(0, g);
  const sbSet = new Set(sbs.map((p) => p.playerId));
  rest = rest.filter((p) => !sbSet.has(p.playerId));

  const grpIn: string[][] = [];
  const capLeft: number[] = [];
  for (let j = 0; j < g; j++) {
    grpIn.push(sbs[j] ? [bbs[j].playerId, sbs[j].playerId] : [bbs[j].playerId]);
    capLeft.push(sizes[j] - grpIn[j].length);
  }
  const assigned = diversityAssign(
    grpIn,
    rest.map((p) => p.playerId),
    capLeft,
    encounters,
    recentSets,
    weight
  );

  const groups: LightningPlannedGroup[] = [];
  let pairs = 0;
  let repeatPairs = 0;
  for (let j = 0; j < g; j++) {
    const members = assigned[j];
    const bb = bbs[j].playerId;
    const sb = sbs[j]?.playerId ?? bb;
    let left = members
      .filter((m) => m !== bb && m !== sb)
      .map((m) => byId.get(m)!)
      .sort(compareQueueOrder);
    const order: string[] = [];
    const size = members.length;
    if (
      size === 5 &&
      members.some(
        (id) => snapshot.nowMs - byId.get(id)!.idleSinceMs < LIGHTNING_FORMATION_MAX_WAIT_MS
      )
    )
      continue;
    for (let seat = size; seat >= 3; seat--) {
      const label =
        seat === size
          ? 'btn'
          : seat === size - 1
            ? 'co'
            : seat === size - 2
              ? 'hj'
              : seat === 3
                ? 'utg'
                : null;
      let pickIdx = -1;
      let pickKey = Infinity;
      for (let i = 0; i < left.length; i++) {
        const key =
          params.positionFairness && label
            ? left[i].positions[label as 'btn' | 'co' | 'hj' | 'utg']
            : 0;
        const better = knobs.p3TieTakesNewest ? key <= pickKey : key < pickKey;
        if (pickIdx < 0 || better) {
          pickIdx = i;
          pickKey = key;
        }
      }
      order.unshift(left[pickIdx].playerId);
      left = left.filter((_, i) => i !== pickIdx);
    }
    for (let a = 0; a < members.length; a++)
      for (let b = a + 1; b < members.length; b++) {
        pairs++;
        if ((encounters.get(pairKey(members[a], members[b])) ?? 0) > 0) repeatPairs++;
      }
    const players = sb === bb ? [bb, ...order] : [bb, sb, ...order];
    groups.push({
      players,
      bb,
      sb,
      btn: order.length > 0 ? order[order.length - 1] : sb,
      entryBb: players.filter((id) => entry.has(id)),
    });
  }
  return {
    matcherVersion: version,
    groups,
    legalCount: n,
    poolDiversityScore: pairs === 0 ? 1 : Math.round((1 - repeatPairs / pairs) * 10_000) / 10_000,
  };
}

/** The SQL plan's own knobs: CASE band WHEN large THEN weight_large WHEN medium THEN weight_medium ELSE 0. */
const M1_KNOBS: PlanKnobs = {
  weight: (band, p) =>
    band === 'large' ? p.diversityWeightLarge : band === 'medium' ? p.diversityWeightMedium : 0,
  p3TieTakesNewest: true,
};

const M1: LightningMatcherModel = {
  version: 'm1',
  note: 'The live SQL plan (fn_lightning_match_plan m1), ported line for line',
  plan: (snapshot, params) => planWith('m1', M1_KNOBS, snapshot, params),
};

/**
 * m1 under its own name, for the A/A calibration: the shadow runs the port
 * beside the live SQL m1 and the comparison records `m1` against `m1-port`.
 */
const M1_PORT: LightningMatcherModel = {
  version: 'm1-port',
  note: 'The live SQL plan m1, the same TypeScript port, named apart for an A/A calibration against live m1',
  plan: (snapshot, params) => planWith('m1-port', M1_KNOBS, snapshot, params),
};

function knob(v: number | null | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, 10) : fallback;
}

const M2: LightningMatcherModel = {
  version: 'm2',
  note: 'Candidate: m1 with P5 diversity in the thin band too, a diversity scale, and P3 ties to the longest wait',
  plan: (snapshot, params) =>
    planWith(
      'm2',
      {
        weight: (band, p) => {
          const scale = knob(p.candidate.diversityScale, 1);
          const thin = knob(p.candidate.thinWeight, p.diversityWeightMedium / 2);
          const base =
            band === 'large'
              ? p.diversityWeightLarge
              : band === 'medium'
                ? p.diversityWeightMedium
                : band === 'thin'
                  ? thin
                  : 0;
          return base * scale;
        },
        p3TieTakesNewest: false,
      },
      snapshot,
      params
    ),
};

/** Every matcher version the engine can model, by matcher_version. */
export const LIGHTNING_MATCHER_MODELS: ReadonlyMap<string, LightningMatcherModel> = new Map(
  [M1, M1_PORT, M2].map((m) => [m.version, m])
);

/** The version the shadow side runs when the config names none: the newest candidate. */
export const LIGHTNING_SHADOW_DEFAULT_VERSION = 'm2';

export function lightningMatcherModel(
  version: string | null | undefined
): LightningMatcherModel | null {
  if (!version) return null;
  return LIGHTNING_MATCHER_MODELS.get(version.trim()) ?? null;
}

/** The plan params from fn_lightning_config's jsonb (the SQL's defaults where absent). */
export function lightningMatcherParams(raw: unknown, maxGroups?: number): LightningMatcherParams {
  const d = LIGHTNING_MATCHER_PARAM_DEFAULTS;
  const row =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown, fb: number, min: number, max: number): number => {
    const n =
      typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb;
  };
  return {
    instanceMin: Math.round(num(row.instance_min, d.instanceMin, 2, 9)),
    instanceTarget: Math.round(num(row.instance_target, d.instanceTarget, 2, 9)),
    instanceMax: Math.round(num(row.instance_max, d.instanceMax, 2, 9)),
    // Always big_blind, whatever the row says (fn_lightning_config lists any
    // other value under `invalid` and uses big_blind).
    firstEntryRule: 'big_blind',
    // This engine posts the entry big blind (LightningHandHost).
    entryBigBlind: true,
    positionFairness:
      typeof row.position_fairness === 'boolean' ? row.position_fairness : d.positionFairness,
    recentWindowHands: Math.round(
      num(row.recent_opponent_window_hands, d.recentWindowHands, 0, 10_000)
    ),
    recentWindowSeconds: Math.round(
      num(row.recent_opponent_window_seconds, d.recentWindowSeconds, 0, 86_400)
    ),
    diversityThinMin: Math.round(num(row.diversity_thin_min, d.diversityThinMin, 0, 100_000)),
    diversityMediumMin: Math.round(num(row.diversity_medium_min, d.diversityMediumMin, 0, 100_000)),
    diversityLargeMin: Math.round(num(row.diversity_large_min, d.diversityLargeMin, 0, 100_000)),
    diversityWeightMedium: num(row.diversity_weight_medium, d.diversityWeightMedium, 0, 10),
    diversityWeightLarge: num(row.diversity_weight_large, d.diversityWeightLarge, 0, 10),
    maxGroups: Math.round(num(maxGroups ?? row.admission_batch_hands, d.maxGroups, 0, 64)),
    candidate: d.candidate,
  };
}
