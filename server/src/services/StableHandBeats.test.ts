/**
 * THE HEARTBEAT. A snapshot endpoint can say what the floor is; it cannot say
 * whether the curve is being HELD, and it cannot say whether the controller is
 * running at all. The second one is the dangerous gap: a job that stops does
 * not fill a log with errors, it stops filling one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildBeats,
  beatVerdict,
  bankVerdict,
  bankRunwayDays,
  BEAT_STALE_MS,
  BANK_WARN_DAYS,
  BANK_CRITICAL_DAYS,
} from './StableHandBeats.js';
import { planFloor, type FloorSnapshot, type TableSnapshot } from './StableHandController.js';
import { MIDWAY_UNION_ID, DSS_CLUB_ID } from './StableHand.js';
import { dailyGuaranteePerHost } from './FreeBuy.js';

const horse = (id: string) => ({
  horseId: id,
  sittingOut: false,
  minutesAtTable: 30,
  isRed: false,
  stack: 100,
});

const table = (o: Partial<TableSnapshot> & { tableId: string; hostId: string }): TableSnapshot => ({
  variant: 'nlh',
  sb: 1,
  bb: 2,
  maxPlayers: 6,
  occupied: 6,
  humansSeated: 0,
  humansWaiting: 0,
  seatedHorses: Array.from({ length: 6 }, (_, i) => horse(`${o.tableId}-h${i}`)),
  status: 'waiting',
  ...o,
});

const twoHostSnap = (): FloorSnapshot => ({
  chicagoHour: 3,
  chicagoMinute: 0,
  killed: false,
  hosts: [
    {
      hostId: MIDWAY_UNION_ID,
      n: 584,
      uniqueLive: 178,
      tables: Array.from({ length: 12 }, (_, i) =>
        table({ tableId: `u${i}`, hostId: MIDWAY_UNION_ID })
      ),
    },
    {
      hostId: DSS_CLUB_ID,
      n: 416,
      uniqueLive: 130,
      tables: Array.from({ length: 10 }, (_, i) =>
        table({ tableId: `d${i}`, hostId: DSS_CLUB_ID })
      ),
    },
  ],
});

describe('a beat records what the floor IS and what the curve WANTS', () => {
  const snap = twoHostSnap();
  const plan = planFloor(snap);
  const rows = buildBeats(snap, plan, { yieldsByHost: new Map(), windDownsByHost: new Map() });

  it('one row per host', () => {
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.host_id).sort()).toEqual([MIDWAY_UNION_ID, DSS_CLUB_ID].sort());
  });

  it('carries the population, the live bodies and the cap together', () => {
    const u = rows.find((r) => r.host_id === MIDWAY_UNION_ID)!;
    expect(u.eligible_bodies).toBe(584);
    expect(u.unique_live).toBe(178);
    // 03:00 is the night window, so the cap is the 5% one
    expect(u.cap_max).toBe(29);
    expect(u.tables_open).toBe(12);
  });

  it("splits the alerts by host, so one host's problem is not the other's", () => {
    const u = rows.find((r) => r.host_id === MIDWAY_UNION_ID)!;
    const d = rows.find((r) => r.host_id === DSS_CLUB_ID)!;
    expect(u.alerts.every((a) => a.includes(MIDWAY_UNION_ID))).toBe(true);
    expect(d.alerts.every((a) => a.includes(DSS_CLUB_ID))).toBe(true);
  });
});

describe('PLANNED AND EXECUTED ARE BOTH RECORDED', () => {
  it('so a controller that decides correctly and cannot act is visible', () => {
    // A beat with plans and no executions for an hour is a different fault
    // from a beat with neither: an engine missing for a table, a cooldown
    // holding everything, a ceiling set too low.
    const snap = twoHostSnap();
    const plan = planFloor(snap);
    const rows = buildBeats(snap, plan, {
      yieldsByHost: new Map(),
      windDownsByHost: new Map([[MIDWAY_UNION_ID, 4]]),
    });
    const u = rows.find((r) => r.host_id === MIDWAY_UNION_ID)!;
    expect(u.winddowns_planned).toBeGreaterThan(0);
    expect(u.winddowns_executed).toBe(4);
    const d = rows.find((r) => r.host_id === DSS_CLUB_ID)!;
    expect(d.winddowns_executed).toBe(0);
  });

  it('counts the pending close and park lists per host', () => {
    const snap = twoHostSnap();
    // eight short-deck tables on one host: the exotic trim closes most
    snap.hosts[0].tables.push(
      ...Array.from({ length: 8 }, (_, i) =>
        table({
          tableId: `sd${i}`,
          hostId: MIDWAY_UNION_ID,
          variant: 'short_deck',
          occupied: 2,
          seatedHorses: [horse(`s${i}`), horse(`t${i}`)],
        })
      )
    );
    const plan = planFloor(snap);
    const rows = buildBeats(snap, plan, { yieldsByHost: new Map(), windDownsByHost: new Map() });
    const u = rows.find((r) => r.host_id === MIDWAY_UNION_ID)!;
    expect(u.close_pending).toBeGreaterThan(0);
    const d = rows.find((r) => r.host_id === DSS_CLUB_ID)!;
    expect(d.close_pending).toBe(0);
  });
});

describe('the silence watch', () => {
  const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);

  it('NEVER BEATING and GOING QUIET are different faults', () => {
    // Never having beaten is an install that did not take. Going quiet after
    // beating is something breaking. Different sentences, found at different
    // times.
    expect(beatVerdict({ lastBeatAtMs: null, nowMs: NOW, enabled: true })).toBe('never_beat');
    expect(beatVerdict({ lastBeatAtMs: NOW - BEAT_STALE_MS - 1, nowMs: NOW, enabled: true })).toBe(
      'stale'
    );
  });

  it('is quiet while the controller is deliberately switched off', () => {
    // Paging about a switch somebody chose to throw is how alerts get muted
    // for the ones nobody chose.
    expect(beatVerdict({ lastBeatAtMs: null, nowMs: NOW, enabled: false })).toBe('ok');
    expect(beatVerdict({ lastBeatAtMs: NOW - 99e6, nowMs: NOW, enabled: false })).toBe('ok');
  });

  it('allows a comfortable multiple of the cycle before complaining', () => {
    expect(beatVerdict({ lastBeatAtMs: NOW - 60_000, nowMs: NOW, enabled: true })).toBe('ok');
    // ten minutes is twenty cycles, so a slow tick or a maintenance break
    // cannot trip it
    expect(BEAT_STALE_MS / 30_000).toBeGreaterThanOrEqual(20);
  });
});

describe('the bank runway', () => {
  it("is measured in DAYS of the board's own exposure, not in chips", () => {
    // A chip threshold has to be re-chosen every time the board changes.
    expect(bankRunwayDays(1500, 1500)).toBe(1);
    expect(bankRunwayDays(66_571, dailyGuaranteePerHost())).toBeGreaterThan(BANK_WARN_DAYS);
  });

  it('grades the live Midway Union bank as healthy', () => {
    expect(bankVerdict({ bank: 66_571 })).toBe('ok');
  });

  it('warns before it is critical', () => {
    const daily = dailyGuaranteePerHost();
    expect(bankVerdict({ bank: daily * (BANK_WARN_DAYS - 1) })).toBe('warning');
    expect(bankVerdict({ bank: daily * (BANK_CRITICAL_DAYS - 1) })).toBe('critical');
    expect(BANK_CRITICAL_DAYS).toBeLessThan(BANK_WARN_DAYS);
  });

  it('a board that guarantees nothing has unbounded runway rather than a divide by zero', () => {
    expect(bankRunwayDays(0, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(bankVerdict({ bank: 0, dailyGuarantee: 0 })).toBe('ok');
  });
});

describe('SOURCE LAW: the heartbeat never blocks the floor', () => {
  const raw = readFileSync(resolve(__dirname, 'StableHandBeats.ts'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('swallows its own failures - a missing beat stops observation, not management', () => {
    expect(src).toContain("reportError(error, 'StableHandBeats.write')");
    expect(src).toContain('catch (err)');
  });

  it('prunes itself rather than needing a scheduled job', () => {
    expect(src).toContain('PRUNE_EVERY_BEATS');
    expect(src).toContain('.delete()');
    expect(src).toContain(".lt('beat_at', cutoff)");
  });

  it('touches only its own table', () => {
    const froms = src.match(/\.from\('([a-z_]+)'\)/g) ?? [];
    expect(froms.length).toBeGreaterThan(0);
    expect(new Set(froms)).toEqual(new Set([".from('stable_hand_beats')"]));
  });

  it('never moves a chip or a seat', () => {
    for (const banned of ['table_seats', 'atomic_table_buyin', 'leaveTable', 'chip_balance']) {
      expect(src).not.toContain(banned);
    }
  });
});

describe('SOURCE LAW: a beat read that failed is not "never beat" (CLAUDE.md 10.86)', () => {
  const raw = readFileSync(resolve(__dirname, 'StableHandBeats.ts'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const fn = src.slice(
    src.indexOf('export async function lastBeatAt('),
    src.indexOf('export type BeatVerdict')
  );

  it('throws on a read error instead of answering null', () => {
    // null means never_beat to beatVerdict, and never_beat files a financial
    // alert saying the controller is not running. A PostgREST blip is not that.
    expect(fn).toContain('if (error) {');
    expect(fn).toContain('throw new Error(');
    expect(fn).not.toContain('if (error || !data) return null;');
    // An honest empty table is still null: the controller genuinely never beat.
    expect(fn).toContain('if (!data) return null;');
  });

  it('every reader of lastBeatAt is inside a try/catch', async () => {
    const fleet = readFileSync(resolve(__dirname, 'HorseFleetManager.ts'), 'utf8');
    const i = fleet.indexOf('lastBeatAtMs: await lastBeatAt()');
    expect(i).toBeGreaterThan(-1);
    const before = fleet.slice(Math.max(0, i - 400), i);
    expect(before).toContain('try {');
    const handler = readFileSync(resolve(__dirname, '..', 'handlers', 'stableHand.ts'), 'utf8');
    expect(handler.indexOf('try {')).toBeLessThan(handler.indexOf('lastBeatAt()'));
  });
});
