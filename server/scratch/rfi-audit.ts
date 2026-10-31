/**
 * RFI AUDIT (2026-10-31): what the Hold'em horses actually OPEN, folded to them.
 *
 * Drives HorseLogic.decide end to end (every graph owner after the preflop
 * reference included) on an unopened pot for each of the 169 hand classes
 * at each position, across seeds, and reports raise / limp / fold
 * frequency, combo-weighted RFI per position and a 13x13 grid.
 *
 *   SUPABASE_URL=https://supabase.invalid SUPABASE_SERVICE_ROLE_KEY=offline-league-placeholder \
 *   EQUITY_GOVERNOR=off npx tsx scratch/rfi-audit.ts [seeds] [style|fleet] [off] [grid] [json]
 */
import { HorseLogic, type HorseGameStateV2 } from '../src/engine/HorseLogic.js';
import { seedFastRandom } from '../src/engine/HorseEval.js';
import type { Card, SeatPlayer, ActionRecord, HorseStyle } from '../src/types.js';

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const BB = 2;

export type Ctx = {
  name: string;
  seats: number;
  stackBB: number;
  mode: 'cash' | 'tournament';
  ante: boolean;
  format?: 'mtt' | 'spin' | 'sng' | 'hu_sng';
};

const args = process.argv.slice(2);
const seeds = Number(args[0] ?? 40);
const styleArg = args[1] ?? 'balanced';
const offArm = args.includes('off');
const showGrid = args.includes('grid');
const asJson = args.includes('json');
const only = args.find((a) => a.startsWith('ctx='))?.slice(4);

/** Fleet tightness mods measured in production profiles (median per style, 2026-10-31). */
const FLEET_TIGHT: Record<HorseStyle, number> = {
  balanced: 1.05,
  grinder: 1.02,
  lag: 1.07,
  tag: 1.034,
  tricky: 1.047,
};

const CONTEXTS: Ctx[] = [
  { name: 'cash6_100', seats: 6, stackBB: 100, mode: 'cash', ante: false },
  { name: 'cash6_40', seats: 6, stackBB: 40, mode: 'cash', ante: false },
  { name: 'cash6_200', seats: 6, stackBB: 200, mode: 'cash', ante: false },
  { name: 'cash9_100', seats: 9, stackBB: 100, mode: 'cash', ante: false },
  { name: 'mtt9_100', seats: 9, stackBB: 100, mode: 'tournament', ante: true },
  { name: 'mtt9_50', seats: 9, stackBB: 50, mode: 'tournament', ante: true },
  { name: 'mtt9_30', seats: 9, stackBB: 30, mode: 'tournament', ante: true },
  { name: 'mtt9_25', seats: 9, stackBB: 25, mode: 'tournament', ante: true },
  { name: 'mtt9_20', seats: 9, stackBB: 20, mode: 'tournament', ante: true },
  { name: 'mtt9_15', seats: 9, stackBB: 15, mode: 'tournament', ante: true },
  { name: 'mtt6_30', seats: 6, stackBB: 30, mode: 'tournament', ante: true },
  { name: 'mtt6_40na', seats: 6, stackBB: 40, mode: 'tournament', ante: false },
  { name: 'mtt8_50', seats: 8, stackBB: 50, mode: 'tournament', ante: true },
  { name: 'cash5_100', seats: 5, stackBB: 100, mode: 'cash', ante: false },
  { name: 'cash4_100', seats: 4, stackBB: 100, mode: 'cash', ante: false },
  { name: 'cash3_100', seats: 3, stackBB: 100, mode: 'cash', ante: false },
  { name: 'cash2_100', seats: 2, stackBB: 100, mode: 'cash', ante: false },
  { name: 'mtt3_30', seats: 3, stackBB: 30, mode: 'tournament', ante: true },
  { name: 'spin3_25', seats: 3, stackBB: 25, mode: 'tournament', ante: false, format: 'spin' },
  { name: 'spin3_18', seats: 3, stackBB: 18, mode: 'tournament', ante: false, format: 'spin' },
  { name: 'hu_40', seats: 2, stackBB: 40, mode: 'tournament', ante: true },
  { name: 'hu_25', seats: 2, stackBB: 25, mode: 'tournament', ante: true },
  { name: 'hu_20na', seats: 2, stackBB: 20, mode: 'tournament', ante: false, format: 'hu_sng' },
  { name: 'hu_12', seats: 2, stackBB: 12, mode: 'tournament', ante: true },
  { name: 'mtt6_20na', seats: 6, stackBB: 20, mode: 'tournament', ante: false },
];

function posNames(n: number): string[] {
  // order of action preflop, excluding BB: first to act ... BTN, SB
  if (n === 6) return ['UTG', 'HJ', 'CO', 'BTN', 'SB'];
  if (n === 9) return ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB'];
  if (n === 8) return ['UTG', 'UTG1', 'LJ', 'HJ', 'CO', 'BTN', 'SB'];
  if (n === 7) return ['UTG', 'LJ', 'HJ', 'CO', 'BTN', 'SB'];
  if (n === 5) return ['HJ', 'CO', 'BTN', 'SB'];
  if (n === 4) return ['CO', 'BTN', 'SB'];
  if (n === 3) return ['BTN', 'SB'];
  if (n === 2) return ['SB'];
  throw new Error('seats');
}

function classes(): {
  cls: string;
  combos: number;
  r1: string;
  r2: string;
  kind: 'p' | 's' | 'o';
}[] {
  const out: { cls: string; combos: number; r1: string; r2: string; kind: 'p' | 's' | 'o' }[] = [];
  for (let i = 0; i < 13; i++)
    for (let j = 0; j < 13; j++) {
      if (i === j)
        out.push({ cls: RANKS[i] + RANKS[j], combos: 6, r1: RANKS[i], r2: RANKS[j], kind: 'p' });
      else if (j > i)
        out.push({
          cls: RANKS[i] + RANKS[j] + 's',
          combos: 4,
          r1: RANKS[i],
          r2: RANKS[j],
          kind: 's',
        });
      else
        out.push({
          cls: RANKS[j] + RANKS[i] + 'o',
          combos: 12,
          r1: RANKS[j],
          r2: RANKS[i],
          kind: 'o',
        });
    }
  return out;
}

function tourney(stackBB: number, seats: number) {
  return {
    schemaVersion: 1 as const,
    contextStatus: 'complete' as const,
    contextIssues: [],
    playersLeft: seats <= 3 ? seats : 180,
    spotsPaid: seats <= 3 ? 1 : 30,
    entrants: seats <= 3 ? 3 : 300,
    avgStackChips: stackBB * BB,
    medianStackChips: stackBB * BB,
    seatsPerTable: seats,
    playersAtTable: seats,
    nearBubble: false,
    inMoney: false,
    payoutPct: seats <= 3 ? [100] : [30, 20, 14, 10, 8, 6, 4, 3, 3, 2],
    currentSmallBlind: 1,
    currentBigBlind: 2,
    currentAnte: 2,
    anteType: 'big_blind' as const,
    nextSmallBlind: 2,
    nextBigBlind: 4,
    nextAnte: 4,
    nextBlindInMin: 10,
  };
}

export type Cell = { raise: number; limp: number; fold: number; size: number };

export function auditPosition(
  ctx: Ctx,
  posIdx: number,
  style: HorseStyle,
  mods: Record<string, unknown>,
  opts: Record<string, unknown>,
  nSeeds: number
): Map<string, Cell> {
  const n = ctx.seats;
  // seats 1..n, dealer = n. SB = 1, BB = 2, first to act = 3.
  // HU: the dealer (seat 2) posts the small blind; seat 1 is the big blind.
  const dealer = n === 2 ? 2 : n;
  const order = n === 2 ? [2] : [...Array(n - 2).keys()].map((k) => 3 + k).concat([1]); // UTG.. BTN, SB
  const heroSeat = order[posIdx];
  const res = new Map<string, Cell>();
  let ts = 1000;
  for (const c of classes()) {
    const cell: Cell = { raise: 0, limp: 0, fold: 0, size: 0 };
    for (let s = 0; s < nSeeds; s++) {
      const seed = (s + 1) * 7919 + posIdx * 104729 + c.cls.charCodeAt(0) * 31 + c.cls.length;
      // suits
      const su = (s * 3) % 4;
      let s1 = SUITS[su];
      let s2 = SUITS[su];
      if (c.kind !== 's') s2 = SUITS[(su + 1 + (s % 3)) % 4];
      const hole: Card[] = [{ rank: c.r1, suit: s1 } as Card, { rank: c.r2, suit: s2 } as Card];
      const used = new Set(hole.map((h) => h.rank + h.suit));
      const deck: Card[] = [];
      for (const r of RANKS)
        for (const su2 of SUITS) if (!used.has(r + su2)) deck.push({ rank: r, suit: su2 } as Card);
      const players: SeatPlayer[] = [];
      const history: ActionRecord[] = [];
      let di = (seed % 40) + 1;
      for (let seat = 1; seat <= n; seat++) {
        const isHero = seat === heroSeat;
        const cards = isHero
          ? hole
          : [deck[(di++ * 7) % deck.length], deck[(di++ * 11) % deck.length]];
        let bet = 0;
        const sbSeat = n === 2 ? 2 : 1;
        const bbSeat = n === 2 ? 1 : 2;
        if (seat === sbSeat) bet = 1;
        if (seat === bbSeat) bet = 2;
        const stackStart = ctx.stackBB * BB;
        players.push({
          seat,
          user_id: `audit-${seat}`,
          username: `Audit${seat}`,
          stack: stackStart - bet - (seat === bbSeat && ctx.ante ? 2 : 0),
          bet,
          totalInvested: bet + (seat === bbSeat && ctx.ante ? 2 : 0),
          cards,
          is_folded: false,
          is_all_in: false,
          is_sitting_out: false,
          is_horse: true,
        } as SeatPlayer);
      }
      // everyone before hero folds
      const actOrder = n === 2 ? [2, 1] : [...Array(n - 2).keys()].map((k) => 3 + k).concat([1, 2]);
      for (const seat of actOrder) {
        if (seat === heroSeat) break;
        const p = players[seat - 1];
        p.is_folded = true;
        history.push({
          seat,
          userId: p.user_id,
          action: 'fold',
          amount: 0,
          timestamp: ts++,
          stage: 'preflop',
        } as ActionRecord);
      }
      const pot = 3 + (ctx.ante ? 2 : 0);
      const gs = {
        players,
        communityCards: [],
        pot,
        currentBet: 2,
        minRaise: 2,
        lastRaise: 2,
        stage: 'preflop',
        gameVariant: 'nlh',
        bigBlind: BB,
        dealerSeat: dealer,
        actionHistory: history,
        gameMode: ctx.mode,
        ante: ctx.ante ? 2 : 0,
        bigBlindAnte: ctx.ante,
        format: ctx.mode === 'cash' ? 'cash' : (ctx.format ?? 'mtt'),
        ...(ctx.mode === 'tournament' ? { tournament: tourney(ctx.stackBB, n) } : {}),
      } as unknown as HorseGameStateV2;
      seedFastRandom(seed);
      const hero = players[heroSeat - 1];
      const d = HorseLogic.decide(
        hero,
        gs,
        style,
        mods as never,
        { mind: false, telemetry: false, ...opts } as never
      );
      const a = d.action;
      if (a === 'raise' || a === 'bet' || a === 'all_in') {
        cell.raise++;
        const to = a === 'all_in' ? hero.stack + hero.bet : (d.amount ?? 0);
        cell.size += to / BB;
      } else if (a === 'call') cell.limp++;
      else cell.fold++;
    }
    cell.size = cell.raise ? cell.size / cell.raise : 0;
    cell.raise /= nSeeds;
    cell.limp /= nSeeds;
    cell.fold /= nSeeds;
    res.set(c.cls, cell);
  }
  return res;
}

export function summarize(m: Map<string, Cell>): { rfi: number; limp: number; size: number } {
  let r = 0;
  let l = 0;
  let sz = 0;
  for (const c of classes()) {
    const cell = m.get(c.cls)!;
    r += cell.raise * c.combos;
    l += cell.limp * c.combos;
    sz += cell.size * cell.raise * c.combos;
  }
  return { rfi: (100 * r) / 1326, limp: (100 * l) / 1326, size: r ? sz / r : 0 };
}

function grid(m: Map<string, Cell>): string {
  const lines: string[] = [];
  lines.push('     ' + RANKS.map((r) => r.padStart(4)).join(''));
  for (let i = 0; i < 13; i++) {
    let line = RANKS[i].padEnd(5);
    for (let j = 0; j < 13; j++) {
      const cls =
        i === j
          ? RANKS[i] + RANKS[j]
          : j > i
            ? RANKS[i] + RANKS[j] + 's'
            : RANKS[j] + RANKS[i] + 'o';
      const c = m.get(cls)!;
      const v = Math.round(c.raise * 100);
      line += (v === 0 ? (c.limp > 0 ? `L${Math.round(c.limp * 100)}` : '.') : String(v)).padStart(
        4
      );
    }
    lines.push(line);
  }
  return lines.join('\n');
}

const isMain = process.argv[1]?.endsWith('rfi-audit.ts');
if (isMain) {
  const styles: HorseStyle[] =
    styleArg === 'fleet'
      ? ['balanced', 'tag', 'lag', 'tricky', 'grinder']
      : [styleArg as HorseStyle];
  const out: Record<string, unknown> = {};
  for (const ctx of CONTEXTS) {
    if (only && !only.split(',').includes(ctx.name)) continue;
    const names = posNames(ctx.seats);
    for (const style of styles) {
      const mods = styleArg === 'fleet' ? { tightness: FLEET_TIGHT[style] } : {};
      const opts = offArm ? { v70GtoOpeningRanges: false } : {};
      const row: string[] = [];
      const per: Record<string, unknown> = {};
      for (let p = 0; p < names.length; p++) {
        const m = auditPosition(ctx, p, style, mods, opts, seeds);
        const s = summarize(m);
        row.push(
          `${names[p]} ${s.rfi.toFixed(1)}${s.limp > 0.05 ? `+L${s.limp.toFixed(1)}` : ''} @${s.size.toFixed(2)}`
        );
        per[names[p]] = { ...s, cells: Object.fromEntries(m) };
        if (showGrid)
          console.log(`\n${ctx.name} ${style} ${names[p]} RFI ${s.rfi.toFixed(1)}%\n${grid(m)}`);
      }
      out[`${ctx.name}|${style}`] = per;
      console.log(`${ctx.name.padEnd(10)} ${style.padEnd(9)} ${row.join(' | ')}`);
    }
  }
  if (asJson) {
    const fs = await import('node:fs');
    fs.writeFileSync(`/tmp/rfi-${offArm ? 'off' : 'on'}-${styleArg}.json`, JSON.stringify(out));
  }
  process.exit(0);
}
