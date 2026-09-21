/**
 * WHAT THE PUBLISHER ACTUALLY WRITES KEEPS THE SHARE IT WAS GIVEN
 *
 * advanceBlindLevel is the last thing between the resolved level and
 * fn_publish_tournament_blind_level, and it used to bound the level like this:
 *
 *   smallBlind: Math.min(resolved.smallBlind ?? 0, 10_000_000),
 *   bigBlind:   Math.min(resolved.bigBlind   ?? 0, 10_000_000),
 *   ante:       Math.min(resolved.ante       ?? 0, 10_000_000),
 *
 * Three independent ceilings on three related numbers - the same shape
 * repaired in fn_resolve_tournament_blinds for the ante (2026-09-20) and for
 * the small blind (2026-09-21). A Spin resolves its overflow levels from
 * spinBlindsForLevel, which continues its own ~1.4x cadence for ever and is
 * never chip-capped, so past roughly level 280 both the small and the big
 * blind are orders of magnitude over the ceiling and both saturate to exactly
 * 10,000,000. fn_publish_tournament_blind_level accepts it, because the one
 * relation it checks is `p_small_blind > p_big_blind` and these are equal.
 *
 * MEASURED IN PRODUCTION, 2026-09-21: 25 RUNNING Spin events held a
 * blind_level_state of {"small_blind":10000000,"big_blind":10000000}, and
 * tables.id 494b1580-a718-4016-920f-b8070d4f4ec9 (tournament
 * 36255650-2d1a-473a-8933-e3aea33ef9b2, level 294) was dealing a small blind
 * equal to its big blind.
 *
 * This test drives the REAL advanceBlindLevel, lifted from
 * TournamentManagerBase.ts the same way LevelDurationComposition.test.ts lifts
 * it, and asserts on the arguments it hands the publisher.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { sliceMethod } from '../testHelpers/sourceWindow.js';
import { acceleratedLevelMs } from './acceleratedLevels.js';
import {
  MAX_BLIND_VALUE,
  enforcePlayableBlindLevel,
  escalatedBlindLevel,
  lastPlayableIndex,
} from './blindEscalation.js';
import { observedStepRatio } from './blindLadder.js';
import { continueBookedSpinBlinds } from './SpinDrawReceipt.js';
import { spinBlindsForLevel } from '../config/spinSpec.js';
import { isPersistedSpin } from './tournamentEntryCapacity.js';

const source = readFileSync(
  path.join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'),
  'utf8'
);
const signatures = [
  'protected levelDurationMs(',
  'protected resolveBlindLevel(',
  'protected async advanceBlindLevel(',
];
if (source.includes('protected rawLevelDurationMs('))
  signatures.push('protected rawLevelDurationMs(');
const methods = signatures.map((signature) =>
  sliceMethod(source, signature).replace(/^protected\s+/, '')
);
const runtime = ts.transpileModule('return { ' + methods.join(',\n') + ' };', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

/** Drives the real method and returns the arguments the publisher was given. */
async function publish(spin: boolean, structure: any[], currentLevel: number) {
  const published: any[] = [];
  const tableStateHub = { emitEvent: vi.fn() };
  const supabase = {
    from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }),
    rpc: async (name: string, args: any) => {
      if (name === 'fn_publish_tournament_blind_level') published.push(args);
      return {
        error: null,
        data: {
          ok: true,
          tournament_id: args.p_tournament_id,
          current_level: args.p_next_level,
          level_started_at: new Date(0).toISOString(),
          blind_level_state: {
            index: args.p_next_level,
            small_blind: args.p_small_blind,
            big_blind: args.p_big_blind,
            ante: args.p_ante,
          },
        },
      };
    },
  };
  const state: any = {
    ...new Function(
      'acceleratedLevelMs',
      'enforcePlayableBlindLevel',
      'escalatedBlindLevel',
      'lastPlayableIndex',
      'observedStepRatio',
      'continueBookedSpinBlinds',
      'spinBlindsForLevel',
      'isPersistedSpin',
      'supabase',
      'tableStateHub',
      'reportError',
      'isMaintenanceFrozen',
      runtime
    )(
      acceleratedLevelMs,
      enforcePlayableBlindLevel,
      escalatedBlindLevel,
      lastPlayableIndex,
      observedStepRatio,
      continueBookedSpinBlinds,
      spinBlindsForLevel,
      isPersistedSpin,
      supabase,
      tableStateHub,
      vi.fn(),
      () => false
    ),
    tournamentCache: {
      accelerated_mtt: false,
      variant: spin ? 'spin' : 'mtt',
      format_contract: spin ? 'spin-v1' : 'mtt-v1',
    },
    isLateRegClosed: () => true,
    // The chip clamp is a separate, already-correct guard; this test is about
    // the ceiling, so it is a pass-through here exactly as in the sibling.
    capLevelToTournamentChips: (level: unknown) => level,
    tournamentId: 'published-share',
    getTournamentLeaseGeneration: () => 'active-generation',
    lifecycleEpoch: { current: () => 1 },
    lifecycleIsCurrent: () => true,
    isOnBreak: () => false,
    currentLevel,
    tableEngines: new Map([['table-share', {}]]),
    broadcast: vi.fn(async () => {}),
    reconcileTournamentEntryWindow: vi.fn(async () => {}),
    startBlindTimer: vi.fn(),
  };
  await state.advanceBlindLevel(structure);
  expect(published).toHaveLength(1);
  return published[0];
}

describe('a published level never has a small blind equal to its big blind', () => {
  it('the live Spin shape: deep past the ladder, the share survives the ceiling', async () => {
    // A 12-row Spin ladder, the shape every live Spin event carries.
    const structure = Array.from({ length: 12 }, (_, i) => {
      const b = spinBlindsForLevel(i + 1);
      return { level: i + 1, smallBlind: b.small, bigBlind: b.big, ante: 0, durationMinutes: 3 };
    });
    // tournament 36255650, which was at level 294 on 2026-09-21.
    const args = await publish(true, structure, 293);
    expect(args.p_big_blind).toBe(MAX_BLIND_VALUE);
    // This is the whole defect: it used to be MAX_BLIND_VALUE too.
    expect(args.p_small_blind).not.toBe(args.p_big_blind);
    expect(args.p_small_blind).toBeLessThan(args.p_big_blind);
    // The Spin ladder authors small = round(big / 2) at every level.
    expect(args.p_small_blind).toBeCloseTo(MAX_BLIND_VALUE / 2, -1);
    expect(args.p_ante).toBe(0);
  });

  it('an MTT deep past its ladder publishes half, not all, of its big blind', async () => {
    const structure = [
      { level: 1, smallBlind: 1_500_000, bigBlind: 3_000_000, ante: 0, durationMinutes: 5 },
      { level: 2, smallBlind: 2_000_000, bigBlind: 4_000_000, ante: 0, durationMinutes: 5 },
    ];
    for (const from of [4, 5, 6, 20, 200]) {
      const args = await publish(false, structure, from);
      expect(args.p_small_blind).toBeLessThan(args.p_big_blind);
      expect(args.p_small_blind).toBeLessThanOrEqual(args.p_big_blind / 2);
      expect(args.p_big_blind).toBeLessThanOrEqual(MAX_BLIND_VALUE);
    }
  });

  it('a level that never reaches the ceiling is published exactly as resolved', async () => {
    const structure = [
      { level: 1, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 5 },
      { level: 2, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 5 },
    ];
    const args = await publish(false, structure, 0);
    // Index 1 is still inside the structure, so it is the authored row.
    expect(args.p_small_blind).toBe(50);
    expect(args.p_big_blind).toBe(100);
    expect(args.p_ante).toBe(10);
  });
});
