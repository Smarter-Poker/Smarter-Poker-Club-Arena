/**
 * GAME LANES + OVERLAY GUARD (Dan 2026-08-27)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  gameLaneFor,
  setHorseLanes,
  assignedLaneCount,
  type HorseGameLane,
} from './HorseBehavior.js';
import {
  topUpTargetFor,
  freerollTargetFor,
  MIDWAY_UNION_ID,
  type OverlayRisk,
  type FreerollTarget,
} from './HorseOverlayGuard.js';

vi.mock('./supabase/client.js', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));

describe('assigned lanes beat the hash', () => {
  it('an assigned lane wins over whatever the hash would have said', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const hashed = gameLaneFor(id);
    const opposite: HorseGameLane = hashed === 'cash' ? 'events' : 'cash';
    setHorseLanes([{ id, lane: opposite }]);
    expect(gameLaneFor(id)).toBe(opposite);
    expect(assignedLaneCount()).toBeGreaterThan(0);
  });

  it('an unassigned horse still gets a lane from the fallback', () => {
    const lane = gameLaneFor('never-assigned-horse-id');
    expect(['events', 'cash', 'both']).toContain(lane);
  });

  it('garbage lane values are ignored rather than trusted', () => {
    const id = 'aaaa1111-bbbb-2222-cccc-333344445555';
    const before = gameLaneFor(id);
    setHorseLanes([
      { id, lane: 'nonsense' },
      { id: '', lane: 'cash' },
    ]);
    expect(gameLaneFor(id)).toBe(before);
  });

  it('the hash fallback is measurably skewed - which is why lanes are assigned', () => {
    // Documents the defect rather than asserting the fix: over UUID-shaped
    // ids the weak hash does not land near 33/33/34. Measured on the real
    // fleet: 32.0 / 39.0 / 28.9.
    const counts: Record<string, number> = { events: 0, cash: 0, both: 0 };
    for (let i = 0; i < 600; i++) {
      const id = `${i.toString(16).padStart(8, '0')}-1111-4222-8333-444455556666`;
      counts[gameLaneFor(id)]++;
    }
    const total = counts.events + counts.cash + counts.both;
    expect(total).toBe(600);
    // Every lane is represented, but we deliberately do NOT assert 33/33/34:
    // that is exactly the guarantee the hash cannot give.
    for (const k of ['events', 'cash', 'both']) expect(counts[k]).toBeGreaterThan(0);
  });
});

describe('overlay top-up target', () => {
  const risk = (over: Partial<OverlayRisk> = {}): OverlayRisk => ({
    tournament_id: 't1',
    name: 'Union PKO Afternoon (PLO4)',
    status: 'REGISTERING',
    buy_in: 18,
    guaranteed_prize: 600,
    entries_needed: 34,
    current_players: 11,
    shortfall: 23,
    max_players: 80,
    minutes_to_start: 25,
    ...over,
  });

  it('targets the entries the guarantee needs, not the room size', () => {
    // 600 / 18 = 34 entries. max_players is 80 - we do NOT fill the room.
    expect(topUpTargetFor(risk())).toBe(34);
  });

  it('never exceeds max_players', () => {
    expect(topUpTargetFor(risk({ entries_needed: 200, max_players: 50 }))).toBe(50);
  });

  it('a huge guarantee on an empty board fills over several cycles', () => {
    // 40-per-cycle ceiling: one call cannot monopolise the free-horse pool.
    const t = topUpTargetFor(risk({ entries_needed: 500, max_players: 500, current_players: 0 }));
    expect(t).toBe(40);
  });

  it('an event that already covers its guarantee asks for nothing more', () => {
    const t = topUpTargetFor(risk({ entries_needed: 34, current_players: 34, shortfall: 0 }));
    expect(t).toBe(34);
  });

  it('keeps the funding step bounded when the RPC projects an unlimited MTT', () => {
    expect(topUpTargetFor(risk({ entries_needed: 500, max_players: null, current_players: 200 }))).toBe(240);
  });

  it('points at Midway Union by default', () => {
    expect(MIDWAY_UNION_ID).toBe('fade0000-0000-0000-0000-000000000001');
  });
});

describe('freerolls fill from every lane', () => {
  const fr = (over: Partial<FreerollTarget> = {}): FreerollTarget => ({
    tournament_id: 'f1',
    name: 'Coffee Break Freeroll (PLO4)',
    status: 'REGISTERING',
    current_players: 4,
    max_players: 50,
    minutes_to_start: 12,
    ...over,
  });

  it('fills toward capacity, not merely to a quorum', () => {
    // 4 of 50 is the measured state Dan objected to. The target moves to the
    // per-cycle ceiling above the field, heading for the full 50.
    expect(freerollTargetFor(fr())).toBe(44);
  });

  it('a big freeroll fills over several cycles instead of draining the fleet', () => {
    // 24 of 500 (the live "$100 Freeroll"): one cycle adds at most 40, so the
    // cash room is not emptied in a single call.
    expect(freerollTargetFor(fr({ current_players: 24, max_players: 500 }))).toBe(64);
  });

  it('never exceeds capacity', () => {
    expect(freerollTargetFor(fr({ current_players: 48, max_players: 50 }))).toBe(50);
  });

  it('a full freeroll asks for nobody', () => {
    const t = fr({ current_players: 50, max_players: 50 });
    expect(freerollTargetFor(t)).toBe(50);
    expect(freerollTargetFor(t) - t.current_players).toBe(0);
  });

  it('continues unlimited freerolls without an artificial field maximum', () => {
    expect(freerollTargetFor(fr({ max_players: null, current_players: 10000 }))).toBe(10040);
  });

  it('a capacity-less row is ignored rather than treated as infinite', () => {
    expect(freerollTargetFor(fr({ max_players: 0 }))).toBe(0);
  });
});
