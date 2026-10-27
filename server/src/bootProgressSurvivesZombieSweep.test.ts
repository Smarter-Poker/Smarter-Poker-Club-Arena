import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './engine/ServerTableEngine.js';
import * as verdict from './fleetWideZombieVerdict.js';

// Execute the current production predicate with the real engine's two clocks.
const source = readFileSync(resolve(process.cwd(), 'src/GameServer.ts'), 'utf8');
const expression = source.match(
  /if \((shouldBeDealing && !parkedOnPurpose && [\s\S]*?)\) \{\s*zombieVerdicts\.push/
)?.[1];
if (!expression) throw new Error('Production zombie predicate not found');
const condemn = new Function(
  'engine',
  'zombieProgressAge',
  `const shouldBeDealing = true, parkedOnPurpose = false; return (${expression});`
);
const tableId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
afterEach(() => vi.restoreAllMocks());

function fixture(phase: string) {
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const engine = new ServerTableEngine(tableId) as any;
  // Admission and several successful boot reads may exceed 180s together.
  // That is not time stuck in the current read.
  now += 240_000;
  engine.setLoopPhase(phase);
  return {
    engine,
    advance: (ms: number) => {
      now += ms;
    },
    reaped: () => condemn(engine, Reflect.get(verdict, 'zombieProgressAge')),
  };
}

describe('boot read progress survives the zombie sweep', () => {
  it.each([
    'start_load_table',
    'start_seed_hand_count',
    'start_crash_recovery',
    'start_time_bank_restore',
    'start_wait_for_players',
  ])('keeps a recently entered %s after older admission work', (phase) => {
    const f = fixture(phase);
    f.advance(20_000);
    expect(f.engine.msSinceProgress()).toBe(260_000);
    expect(f.engine.msSinceLoopPhase()).toBe(20_000);
    expect(f.reaped()).toBe(false);
  });

  it('still recovers a boot read stuck for more than 180s', () => {
    const f = fixture('start_crash_recovery');
    f.advance(180_000);
    expect(f.reaped()).toBe(false);
    f.advance(1);
    expect(f.reaped()).toBe(true);
  });

  it('does not forgive an ordinary stalled game at a phase transition', () => {
    const f = fixture('load_seats');
    f.advance(1);
    expect(f.reaped()).toBe(true);
  });

  it('uses actual progress when it is newer than the boot phase', () => {
    const f = fixture('start_wait_for_players');
    f.advance(180_001);
    f.engine.markProgress();
    expect(f.reaped()).toBe(false);
    f.advance(180_001);
    expect(f.reaped()).toBe(true);
  });
});
