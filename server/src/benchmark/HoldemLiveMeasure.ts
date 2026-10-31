/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOLD'EM LIVE MEASURE - the four numbers the October 30 release is judged on
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure. No imports, no network, no clock. The CLI (server/scripts/
 * holdem-live-measure.ts) fetches rows and health samples and hands them
 * here; these functions turn them into the four measurements the owner asked
 * for once a revision containing #8692 (heap), #8694 (V60), #8733 (V62) and
 * #8705 (V61) serves:
 *
 *   1. heap growth        - GB/hour slope of heapUsedMb and rssMb per engine
 *                           instance, from /health samples. A restart is a new
 *                           instanceId and a new line; slopes never span one.
 *   2. 3-bet shares       - 3-bet% and fold-to-3-bet% from horse_daily_play,
 *                           the same accumulator the tuner and the panel read.
 *   3. river one-pair     - how often a horse that called a river bet holding
 *      call outcomes        one pair won, by the V62 size class of the bet it
 *                           faced (small < 0.4 pot, medium < 0.7, large / raise),
 *                           from horse_hand_reviews. THOSE ROWS EXIST ONLY FOR
 *                           HANDS WITH |net| >= 20bb (HorseHandReview.FLAG_BB),
 *                           so this is the big-pot subset, stated in the report.
 *   4. receipt counts     - horse_brain_telemetry fires per day for
 *                           v61_river_one_pair_shade and v62_river_bettor_polarity.
 *
 * Every function answers "could not tell" distinctly from a number (CLAUDE.md
 * 10.86): a slope over too few samples is null with a reason, never 0.
 *
 * NEVER refer to the horses as "bots" - they are HORSES only.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Heap growth
// ─────────────────────────────────────────────────────────────────────────────

export interface HealthSample {
  /** epoch milliseconds when the sample was taken */
  at: number;
  instanceId: string;
  releaseSha: string;
  heapUsedMb: number;
  rssMb: number;
}

export interface HeapSlope {
  instanceId: string;
  releaseSha: string;
  samples: number;
  spanMinutes: number;
  /** least-squares slope in GB per hour, or null with `reason` */
  heapGbPerHour: number | null;
  rssGbPerHour: number | null;
  heapR2: number | null;
  firstHeapMb: number;
  lastHeapMb: number;
  reason?: string;
}

/** Minimum evidence for a slope: three samples over at least twenty minutes. */
export const MIN_SLOPE_SAMPLES = 3;
export const MIN_SLOPE_SPAN_MINUTES = 20;

function leastSquares(xs: number[], ys: number[]): { slope: number; r2: number } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const r2 = sxx === 0 || syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, r2 };
}

/** One slope per instance, oldest first. Samples are sorted; duplicates kept. */
export function heapSlopes(samples: HealthSample[]): HeapSlope[] {
  const byInstance = new Map<string, HealthSample[]>();
  for (const s of samples) {
    if (!s || typeof s.at !== 'number' || !Number.isFinite(s.at)) continue;
    if (typeof s.instanceId !== 'string' || !s.instanceId) continue;
    if (!Number.isFinite(s.heapUsedMb) || !Number.isFinite(s.rssMb)) continue;
    const list = byInstance.get(s.instanceId) ?? [];
    list.push(s);
    byInstance.set(s.instanceId, list);
  }
  const out: HeapSlope[] = [];
  for (const [instanceId, list] of byInstance) {
    list.sort((a, b) => a.at - b.at);
    const spanMinutes = (list[list.length - 1].at - list[0].at) / 60000;
    const base: HeapSlope = {
      instanceId,
      releaseSha: list[list.length - 1].releaseSha,
      samples: list.length,
      spanMinutes: Math.round(spanMinutes * 10) / 10,
      heapGbPerHour: null,
      rssGbPerHour: null,
      heapR2: null,
      firstHeapMb: list[0].heapUsedMb,
      lastHeapMb: list[list.length - 1].heapUsedMb,
    };
    if (list.length < MIN_SLOPE_SAMPLES) {
      out.push({ ...base, reason: `only ${list.length} sample(s); ${MIN_SLOPE_SAMPLES} needed` });
      continue;
    }
    if (spanMinutes < MIN_SLOPE_SPAN_MINUTES) {
      out.push({ ...base, reason: `${base.spanMinutes} minutes of samples; ${MIN_SLOPE_SPAN_MINUTES} needed` });
      continue;
    }
    const hours = list.map((s) => (s.at - list[0].at) / 3600000);
    const heap = leastSquares(hours, list.map((s) => s.heapUsedMb / 1000));
    const rss = leastSquares(hours, list.map((s) => s.rssMb / 1000));
    out.push({
      ...base,
      heapGbPerHour: Math.round(heap.slope * 1000) / 1000,
      rssGbPerHour: Math.round(rss.slope * 1000) / 1000,
      heapR2: Math.round(heap.r2 * 1000) / 1000,
    });
  }
  // Oldest instance first, so a restart reads top to bottom.
  const firstAt = new Map([...byInstance].map(([id, list]) => [id, list[0].at]));
  out.sort((a, b) => (firstAt.get(a.instanceId) ?? 0) - (firstAt.get(b.instanceId) ?? 0));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 3-bet shares
// ─────────────────────────────────────────────────────────────────────────────

export interface PlayRow {
  horse_user_id: string;
  day: string;
  format: string;
  hands: number;
  three_bets: number;
  three_bet_opps: number;
  faced_3bets: number;
  fold_to_3bets: number;
}

export interface ThreeBetShare {
  format: string;
  horses: number;
  hands: number;
  threeBets: number;
  threeBetOpps: number;
  /** percent, or null when there was no opportunity */
  threeBetPct: number | null;
  faced3Bets: number;
  foldTo3Bets: number;
  foldTo3BetPct: number | null;
}

const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((1000 * n) / d) / 10 : null);

/** Shares per format plus an `all` line. Rows with non-finite counts are skipped. */
export function threeBetShares(rows: PlayRow[]): ThreeBetShare[] {
  const acc = new Map<string, ThreeBetShare & { ids: Set<string> }>();
  const touch = (format: string) => {
    let s = acc.get(format);
    if (!s) {
      s = { format, horses: 0, hands: 0, threeBets: 0, threeBetOpps: 0, threeBetPct: null, faced3Bets: 0, foldTo3Bets: 0, foldTo3BetPct: null, ids: new Set() };
      acc.set(format, s);
    }
    return s;
  };
  for (const r of rows) {
    const counts = [r.hands, r.three_bets, r.three_bet_opps, r.faced_3bets, r.fold_to_3bets].map(Number);
    if (counts.some((c) => !Number.isFinite(c) || c < 0)) continue;
    for (const s of [touch(String(r.format || 'cash')), touch('all')]) {
      s.ids.add(r.horse_user_id);
      s.hands += counts[0];
      s.threeBets += counts[1];
      s.threeBetOpps += counts[2];
      s.faced3Bets += counts[3];
      s.foldTo3Bets += counts[4];
    }
  }
  return [...acc.values()]
    .map(({ ids, ...s }) => ({
      ...s,
      horses: ids.size,
      threeBetPct: pct(s.threeBets, s.threeBetOpps),
      foldTo3BetPct: pct(s.foldTo3Bets, s.faced3Bets),
    }))
    .sort((a, b) => (a.format === 'all' ? 1 : b.format === 'all' ? -1 : a.format.localeCompare(b.format)));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. River one-pair call outcomes by size class
// ─────────────────────────────────────────────────────────────────────────────

export interface ReviewAction {
  userId?: string;
  action?: string;
  amount?: number;
  stage?: string;
  isFullRaise?: boolean;
}

export interface ReviewRow {
  horse_user_id: string;
  game_variant: string | null;
  net_bb: number | string | null;
  hole_cards: unknown;
  board: unknown;
  actions: ReviewAction[] | null;
  leak_tags: string[] | null;
}

export type SizeClass = 'small' | 'medium' | 'large';

export interface RiverOnePairCell {
  sizeClass: SizeClass;
  calls: number;
  won: number;
  /** percent of calls that won the hand, or null without a call */
  wonPct: number | null;
}

export interface RiverOnePairReport {
  cells: RiverOnePairCell[];
  /** rows considered after the Hold'em / parsable filters */
  consideredRows: number;
  /** rows that could not be read (missing cards, board or actions) */
  unreadableRows: number;
  caveat: string;
}

export const RIVER_ONE_PAIR_CAVEAT =
  'horse_hand_reviews holds only hands with |net| >= 20bb, so these are big-pot river calls; compare before/after on the same subset';

const RANKS = '23456789TJQKA';

interface Card {
  r: number;
  s: string;
}

function parseCard(value: unknown): Card | null {
  if (typeof value === 'string') {
    const m = /^([2-9TJQKA])([shdc])$/i.exec(value.trim());
    if (!m) return null;
    return { r: RANKS.indexOf(m[1].toUpperCase()), s: m[2].toLowerCase() };
  }
  if (value && typeof value === 'object') {
    const o = value as { rank?: unknown; suit?: unknown };
    const rank = typeof o.rank === 'string' ? o.rank.toUpperCase() : typeof o.rank === 'number' ? RANKS[o.rank - 2] : '';
    const suit = typeof o.suit === 'string' ? o.suit[0].toLowerCase() : '';
    if (!rank || !RANKS.includes(rank) || !'shdc'.includes(suit)) return null;
    return { r: RANKS.indexOf(rank), s: suit };
  }
  return null;
}

function parseCards(value: unknown): Card[] | null {
  if (typeof value === 'string') {
    const parts = value.trim().split(/[\s,]+/).filter(Boolean);
    const cards = parts.map(parseCard);
    return cards.every((c): c is Card => c !== null) ? cards : null;
  }
  if (Array.isArray(value)) {
    const cards = value.map(parseCard);
    return cards.every((c): c is Card => c !== null) ? cards : null;
  }
  return null;
}

/**
 * Does hero hold exactly one pair with a five-card river board: a pocket pair
 * that does not trip up, or one hole card pairing the board once, on a board
 * that is itself unpaired, with no flush or straight possible for hero? Kept
 * simple on purpose - this is the same shape HorseHandReview's
 * one_pair_river_stackoff reads, not a full evaluator.
 */
export function isOnePairOnRiver(hole: Card[], board: Card[]): boolean {
  if (hole.length !== 2 || board.length !== 5) return false;
  const boardCounts = new Map<number, number>();
  for (const c of board) boardCounts.set(c.r, (boardCounts.get(c.r) ?? 0) + 1);
  if ([...boardCounts.values()].some((n) => n >= 2)) return false;
  const [a, b] = hole;
  const hits = [a, b].filter((c) => boardCounts.has(c.r)).length;
  const pocket = a.r === b.r;
  if (pocket && hits > 0) return false; // a set
  if (!pocket && hits !== 1) return false; // no pair, or two pair
  // Flush: five of a suit among the seven. A board flush plays for everyone,
  // so hero's pair is not what the hand is about either way.
  const all = [...hole, ...board];
  for (const suit of 'shdc') {
    if (all.filter((c) => c.s === suit).length >= 5) return false;
  }
  // Straight among the seven (board straights included, for the same reason).
  const ranks = new Set(all.map((c) => c.r));
  if (ranks.has(12)) ranks.add(-1); // wheel ace
  for (let low = -1; low <= 8; low++) {
    if ([0, 1, 2, 3, 4].every((i) => ranks.has(low + i))) return false;
  }
  return true;
}

/** V62's size classes from the bet fraction of the pot it was made into. */
export function sizeClassOf(betFraction: number, raised: boolean): SizeClass {
  if (raised || betFraction >= 0.7) return 'large';
  if (betFraction >= 0.4) return 'medium';
  return 'small';
}

const STREETS = ['preflop', 'flop', 'turn', 'river'];

/**
 * The river call hero made facing a bet, with the bet's pot fraction, or null
 * when hero made no river call. Amounts are street totals per player (the
 * engine's ActionRecord convention), so a street's contribution per player is
 * its maximum amount on that street; the pot before the river bet is every
 * player's preflop/flop/turn contribution. Production review rows carry the
 * forced posts as actions too (`sb` / `bb` with their amounts, read
 * 2026-10-30), so the preflop maximum per player already includes the blind.
 */
export function riverCallFaced(
  actions: ReviewAction[],
  hero: string
): { betFraction: number; raised: boolean } | null {
  const perStreet = new Map<string, Map<string, number>>();
  for (const st of STREETS) perStreet.set(st, new Map());
  const river = actions.filter((a) => a.stage === 'river');
  for (const a of actions) {
    if (typeof a.userId !== 'string' || typeof a.stage !== 'string' || !perStreet.has(a.stage)) continue;
    if (a.stage === 'river') continue;
    const amt = typeof a.amount === 'number' && Number.isFinite(a.amount) ? a.amount : 0;
    const m = perStreet.get(a.stage)!;
    m.set(a.userId, Math.max(m.get(a.userId) ?? 0, amt));
  }
  let pot = 0;
  for (const st of ['preflop', 'flop', 'turn']) for (const v of perStreet.get(st)!.values()) pot += v;
  const riverPaid = new Map<string, number>();
  let aggressions = 0;
  let lastBet = 0;
  let lastBetPotBefore = pot;
  for (const a of river) {
    if (typeof a.userId !== 'string') continue;
    const amt = typeof a.amount === 'number' && Number.isFinite(a.amount) ? a.amount : 0;
    const isCall = a.action === 'call' || (a.action === 'all_in' && a.isFullRaise === undefined);
    const isAggr = a.action === 'bet' || a.action === 'raise' || (a.action === 'all_in' && a.isFullRaise !== undefined);
    if (a.userId === hero && isCall && aggressions > 0) {
      const betFraction = lastBetPotBefore > 0 ? lastBet / lastBetPotBefore : 1;
      return { betFraction: Math.round(betFraction * 1000) / 1000, raised: aggressions >= 2 };
    }
    if (isAggr) {
      const already = riverPaid.get(a.userId) ?? 0;
      const potBefore = pot + [...riverPaid.values()].reduce((x, y) => x + y, 0);
      lastBet = Math.max(0, amt - already);
      lastBetPotBefore = potBefore;
      aggressions += 1;
    }
    if (amt > 0) riverPaid.set(a.userId, Math.max(riverPaid.get(a.userId) ?? 0, amt));
  }
  return null;
}

/** Hold'em river one-pair calls by the size class faced, and how many won. */
export function riverOnePairCalls(rows: ReviewRow[]): RiverOnePairReport {
  const cells = new Map<SizeClass, RiverOnePairCell>(
    (['small', 'medium', 'large'] as SizeClass[]).map((k) => [k, { sizeClass: k, calls: 0, won: 0, wonPct: null }])
  );
  let considered = 0;
  let unreadable = 0;
  for (const row of rows) {
    // Hold'em only, named: a row with no variant is not assumed to be one.
    const variant = String(row.game_variant ?? '').toLowerCase();
    if (!/^(nlh|holdem|hold_em|texas_holdem|nl_holdem)$/.test(variant)) continue;
    const hole = parseCards(row.hole_cards);
    const board = parseCards(row.board);
    if (!hole || !board || !Array.isArray(row.actions)) {
      unreadable += 1;
      continue;
    }
    considered += 1;
    if (board.length !== 5 || !isOnePairOnRiver(hole, board)) continue;
    const faced = riverCallFaced(row.actions, row.horse_user_id);
    if (!faced) continue;
    const cell = cells.get(sizeClassOf(faced.betFraction, faced.raised))!;
    cell.calls += 1;
    if (Number(row.net_bb) > 0) cell.won += 1;
  }
  for (const c of cells.values()) c.wonPct = pct(c.won, c.calls);
  return { cells: [...cells.values()], consideredRows: considered, unreadableRows: unreadable, caveat: RIVER_ONE_PAIR_CAVEAT };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Receipt counts
// ─────────────────────────────────────────────────────────────────────────────

export interface TelemetryRow {
  day: string;
  feature: string;
  fires: number | string;
}

export const RECEIPT_FEATURES = ['v61_river_one_pair_shade', 'v62_river_bettor_polarity', 'v38_river_call', 'v38_river_fold'] as const;

export interface ReceiptCount {
  feature: string;
  byDay: Array<{ day: string; fires: number }>;
  total: number;
}

export function receiptCounts(rows: TelemetryRow[], features: readonly string[] = RECEIPT_FEATURES): ReceiptCount[] {
  return features.map((feature) => {
    const byDay = rows
      .filter((r) => r.feature === feature && Number.isFinite(Number(r.fires)))
      .map((r) => ({ day: String(r.day), fires: Number(r.fires) }))
      .sort((a, b) => a.day.localeCompare(b.day));
    return { feature, byDay, total: byDay.reduce((a, b) => a + b.fires, 0) };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

export interface LiveMeasureReport {
  generatedAt: string;
  servingReleaseSha: string | null;
  heap: HeapSlope[];
  threeBet: ThreeBetShare[];
  riverOnePair: RiverOnePairReport;
  receipts: ReceiptCount[];
}

const fmt = (v: number | null, unit = ''): string => (v === null ? 'n/a' : `${v}${unit}`);

export function renderMarkdown(report: LiveMeasureReport): string {
  const lines: string[] = [];
  lines.push(`# Hold'em live measure - ${report.generatedAt}`);
  lines.push('');
  lines.push(`Serving release: ${report.servingReleaseSha ?? 'unknown'}`);
  lines.push('');
  lines.push('## 1. Heap growth (per engine instance)');
  lines.push('');
  lines.push('| instance | release | samples | span (min) | heap GB/h | rss GB/h | r2 | heap first -> last (MB) | note |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const h of report.heap) {
    lines.push(
      `| ${h.instanceId} | ${h.releaseSha.slice(0, 9)} | ${h.samples} | ${h.spanMinutes} | ${fmt(h.heapGbPerHour)} | ${fmt(h.rssGbPerHour)} | ${fmt(h.heapR2)} | ${h.firstHeapMb} -> ${h.lastHeapMb} | ${h.reason ?? ''} |`
    );
  }
  if (report.heap.length === 0) lines.push('| (no samples) | | | | | | | | |');
  lines.push('');
  lines.push('## 2. 3-bet shares (horse_daily_play)');
  lines.push('');
  lines.push('| format | horses | hands | 3-bet % | fold to 3-bet % | 3-bets / opps | folds / faced |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const t of report.threeBet) {
    lines.push(`| ${t.format} | ${t.horses} | ${t.hands} | ${fmt(t.threeBetPct, '%')} | ${fmt(t.foldTo3BetPct, '%')} | ${t.threeBets} / ${t.threeBetOpps} | ${t.foldTo3Bets} / ${t.faced3Bets} |`);
  }
  if (report.threeBet.length === 0) lines.push('| (no rows) | | | | | | |');
  lines.push('');
  lines.push('## 3. River one-pair calls by size class faced (horse_hand_reviews)');
  lines.push('');
  lines.push(`Caveat: ${report.riverOnePair.caveat}. Rows read: ${report.riverOnePair.consideredRows}; unreadable: ${report.riverOnePair.unreadableRows}.`);
  lines.push('');
  lines.push('| size class | calls | won | won % |');
  lines.push('|---|---|---|---|');
  for (const c of report.riverOnePair.cells) lines.push(`| ${c.sizeClass} | ${c.calls} | ${c.won} | ${fmt(c.wonPct, '%')} |`);
  lines.push('');
  lines.push('## 4. Receipt counts (horse_brain_telemetry)');
  lines.push('');
  lines.push('| feature | total | by day |');
  lines.push('|---|---|---|');
  for (const r of report.receipts) {
    lines.push(`| ${r.feature} | ${r.total} | ${r.byDay.map((d) => `${d.day}: ${d.fires}`).join(', ') || 'none'} |`);
  }
  lines.push('');
  return lines.join('\n');
}
