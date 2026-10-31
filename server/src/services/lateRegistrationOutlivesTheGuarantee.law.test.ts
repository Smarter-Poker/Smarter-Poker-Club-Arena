/**
 * LAW: LATE REGISTRATION DOES NOT END AT THE GUARANTEE (Dan 2026-10-19)
 * ═══════════════════════════════════════════════════════════════════════════
 * "just because the 'guarantee was met' doesn't mean horses shouldn't still
 *  late register throughout the tournament..."
 *
 * The overlay pass was the only thing that entered a horse into a RUNNING
 * event, and it stops by design once the guarantee is covered and 30 minutes
 * after the start. Measured on production 2026-10-20: every late entry in
 * three days arrived 0-30 minutes after the start although late registration
 * runs 25-90 minutes, and "Monday Mystery" (400 guaranteed, 400 in the pool,
 * late registration open) took no late entry at all.
 *
 * This pins the replacement rule: every RUNNING MTT whose late registration is
 * open keeps taking horse entries, at a realistic cadence, until it closes -
 * and the decision never reads the guarantee.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  topUp: vi.fn(async (_id: string, _target: number, _opts?: unknown) => 0),
  rpc: vi.fn(),
  tables: new Map<string, unknown>(),
  frozen: false,
}));

vi.mock('./supabase/client.js', () => {
  // A chainable read: every filter returns the builder, awaiting it resolves
  // the table's canned answer. tournament_players answers by the filter used.
  const from = (table: string) => {
    const filters: string[] = [];
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'gt', 'or', 'order', 'limit']) {
      builder[m] = (...args: unknown[]) => {
        filters.push(`${m}:${String(args[0])}`);
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown) => {
      if (table === 'tournament_players') {
        const counts = h.tables.get('tournament_players') as {
          late: number;
          live: number;
          all: number;
        };
        const count = filters.includes('gt:registered_at')
          ? counts.late
          : filters.includes('in:status')
            ? counts.live
            : counts.all;
        return Promise.resolve({ count, error: null }).then(resolve);
      }
      return Promise.resolve({ data: h.tables.get(table) ?? [], error: null }).then(resolve);
    };
    return builder;
  };
  return { supabase: { from, rpc: h.rpc } };
});
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => h.frozen }));
vi.mock('./TournamentRecurringService.js', () => ({
  TournamentRecurringService: class {
    topUpWithHorses = h.topUp;
  },
}));

import {
  lateRegArrivalsFor,
  lateRegisterHorsesOnce,
  lateRegProgress,
  LATE_REG_MAX_STEP,
  LATE_REG_SHARE_MIN,
  LATE_REG_SHARE_SPREAD,
  MIDWAY_UNION_ID,
  type LateRegEvent,
} from './HorseOverlayGuard.js';

const START = Date.parse('2026-10-20T03:00:00Z');
const MIN = 60_000;

const event = (over: Partial<LateRegEvent> = {}): LateRegEvent => ({
  tournament_id: '541a5040-06f8-4ac2-8e41-384436187839',
  startedAtMs: START,
  nowMs: START + 30 * MIN,
  lateRegMins: 81,
  lateRegLevels: 9,
  currentLevel: 2,
  entriesAtStart: 80,
  lateEntries: 0,
  ...over,
});

/** Walk the window cycle by cycle, as the guard does, every arrival admitted. */
function simulate(ev: LateRegEvent, levelEveryMin = Infinity) {
  let late = 0;
  const arrivals: Array<{ minute: number; n: number }> = [];
  for (let minute = 0; minute <= ev.lateRegMins + 4; minute += 2) {
    const n = lateRegArrivalsFor({
      ...ev,
      nowMs: ev.startedAtMs + minute * MIN,
      currentLevel: Number.isFinite(levelEveryMin) ? Math.floor(minute / levelEveryMin) : 0,
      lateEntries: late,
    });
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(
      Math.max(LATE_REG_MAX_STEP, Math.ceil((ev.entriesAtStart * 2) / ev.lateRegMins) + 1)
    );
    late += n;
    if (n > 0) arrivals.push({ minute, n });
  }
  return { late, arrivals };
}

describe('the late-registration decision never reads the guarantee', () => {
  it('a guarantee-covered event with late registration open still takes arrivals', () => {
    // Monday Mystery as measured: 80 in, the 400 guarantee exactly covered,
    // 30 minutes into an 81-minute window, zero late entries.
    expect(lateRegArrivalsFor(event())).toBeGreaterThan(0);
  });

  it('has no guarantee, prize pool or overlay input at all', () => {
    const src = readFileSync(join(__dirname, 'HorseOverlayGuard.ts'), 'utf8');
    const start = src.indexOf('export interface LateRegEvent');
    const end = src.indexOf('/** One full cycle:');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const lateRegCode = src
      .slice(start, end)
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    expect(lateRegCode).not.toMatch(/prize_pool\b|prizePool|overlay_at_risk|shortfall/i);
  });

  it('runs inside the guard cycle, after the overlay and freeroll passes', () => {
    const src = readFileSync(join(__dirname, 'HorseOverlayGuard.ts'), 'utf8');
    const cycle = src.slice(src.indexOf('function launchOwnedCycle'));
    expect(cycle).toContain('lateRegisterHorsesOnce(host');
    const fill = src.slice(src.indexOf('export async function runEventFillCycle'));
    expect(fill.slice(0, fill.indexOf('\n}\n'))).toContain('lateRegisterHorsesOnce(');
  });
});

describe('arrivals flow across the whole window, not the first half hour', () => {
  it('keeps arriving after 30 minutes and right up to the close', () => {
    const { late, arrivals } = simulate(event({ lateRegLevels: 0 }));
    expect(arrivals.some((a) => a.minute > 30)).toBe(true);
    expect(arrivals.some((a) => a.minute > 60)).toBe(true);
    // A realistic share of the starting field, not a refill to the room.
    expect(late).toBeGreaterThanOrEqual(Math.round(80 * LATE_REG_SHARE_MIN) - 1);
    expect(late).toBeLessThanOrEqual(Math.round(80 * (LATE_REG_SHARE_MIN + LATE_REG_SHARE_SPREAD)));
  });

  it('arrives a few at a time, not in one burst', () => {
    const { arrivals } = simulate(
      event({ entriesAtStart: 126, lateRegMins: 25, lateRegLevels: 0 })
    );
    expect(arrivals.length).toBeGreaterThanOrEqual(6);
    for (const a of arrivals) expect(a.n).toBeLessThanOrEqual(12);
  });

  it('a small field still sees late arrivals', () => {
    expect(simulate(event({ entriesAtStart: 3, lateRegLevels: 0 })).late).toBeGreaterThanOrEqual(2);
  });

  it('counts entries that already arrived late, whoever made them', () => {
    expect(lateRegArrivalsFor(event({ lateEntries: 500 }))).toBe(0);
  });
});

describe('late registration closing still closes it', () => {
  it('nothing once the clock window has passed', () => {
    expect(lateRegArrivalsFor(event({ nowMs: START + 81 * MIN, lateRegLevels: 0 }))).toBe(0);
  });

  it('nothing once the level window has passed, whichever deadline comes first', () => {
    expect(lateRegArrivalsFor(event({ currentLevel: 9 }))).toBe(0);
    expect(lateRegProgress(event({ currentLevel: 9 }))).toBe(1);
  });

  it('nothing for an event with no late window configured', () => {
    expect(lateRegArrivalsFor(event({ lateRegMins: 0, lateRegLevels: 0 }))).toBe(0);
  });
});

describe('the pass enters horses through the ordinary door', () => {
  const running = {
    id: '541a5040-06f8-4ac2-8e41-384436187839',
    name: 'Monday Mystery',
    status: 'RUNNING',
    format_contract: 'mtt-v2',
    started_at: new Date(START).toISOString(),
    current_level: 2,
    late_reg_levels: 9,
    rebuy_levels: null,
    late_reg_mins: 81,
    buy_in_amount: 9,
    prize_pool_finalized: false,
  };

  beforeEach(() => {
    h.topUp.mockClear();
    h.rpc.mockReset();
    h.frozen = false;
    h.tables.set('clubs', [{ id: MIDWAY_UNION_ID }]);
    h.tables.set('tournaments', [running]);
    h.tables.set('tournament_players', { late: 0, live: 77, all: 80 });
  });

  it('a covered-guarantee event with late registration open is topped up by this cycle', async () => {
    h.rpc.mockResolvedValue({ data: true, error: null });
    await lateRegisterHorsesOnce(MIDWAY_UNION_ID, () => true, START + 30 * MIN);
    expect(h.rpc).toHaveBeenCalledWith('fn_tournament_late_registration_open', {
      p_tournament_id: running.id,
    });
    expect(h.topUp).toHaveBeenCalledTimes(1);
    const [id, target, opts] = h.topUp.mock.calls[0];
    expect(id).toBe(running.id);
    // The live field plus this cycle's arrivals; paid events keep their lanes.
    expect(target).toBeGreaterThan(77);
    expect(target).toBeLessThanOrEqual(77 + LATE_REG_MAX_STEP);
    expect(opts).toEqual({ allLanes: false });
  });

  it('a closed late registration is left alone', async () => {
    h.rpc.mockResolvedValue({ data: false, error: null });
    await lateRegisterHorsesOnce(MIDWAY_UNION_ID, () => true, START + 30 * MIN);
    expect(h.topUp).not.toHaveBeenCalled();
  });

  it('an unreadable late-registration answer enters nobody', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await lateRegisterHorsesOnce(MIDWAY_UNION_ID, () => true, START + 30 * MIN);
    expect(h.topUp).not.toHaveBeenCalled();
  });

  it('the maintenance freeze stops it', async () => {
    h.frozen = true;
    h.rpc.mockResolvedValue({ data: true, error: null });
    await lateRegisterHorsesOnce(MIDWAY_UNION_ID, () => true, START + 30 * MIN);
    expect(h.topUp).not.toHaveBeenCalled();
  });

  it('a free event draws from every lane, as the freeroll filler does', async () => {
    h.tables.set('tournaments', [{ ...running, buy_in_amount: 0 }]);
    h.rpc.mockResolvedValue({ data: true, error: null });
    await lateRegisterHorsesOnce(MIDWAY_UNION_ID, () => true, START + 30 * MIN);
    expect(h.topUp.mock.calls[0][2]).toEqual({ allLanes: true });
  });
});
