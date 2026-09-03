/**
 * EVERY PRESET NAME THE SCHEDULES USE MUST RESOLVE (2026-08-31).
 *
 * 19 active production schedules carried `blindPreset: "DEEPSTACK"` and the
 * preset map only knew SLOW/STANDARD/TURBO/HYPER_TURBO/DEEP — so every one of
 * those events was skipped with `structure_missing` on each spawn attempt and
 * never ran once. A schedule that names a preset the engine cannot resolve is
 * a tournament that silently does not exist.
 */
import { describe, expect, it } from 'vitest';
import {
  SCHEDULE_BLIND_PRESETS,
  SCHEDULE_PAYOUT_PRESETS,
  // .js extension is mandatory: TournamentFixes.guard.test.ts pins it because
  // Node resolves the specifier literally at runtime.
} from './ScheduledTournamentService.js';

describe('schedule preset names resolve', () => {
  it('every blind preset name used by production schedules exists', () => {
    for (const name of ['SLOW', 'STANDARD', 'TURBO', 'HYPER_TURBO', 'DEEP', 'DEEPSTACK']) {
      expect(SCHEDULE_BLIND_PRESETS[name], `blind preset ${name}`).toBeDefined();
      expect(SCHEDULE_BLIND_PRESETS[name].length).toBeGreaterThan(0);
    }
  });

  it('every payout preset name used by production schedules exists', () => {
    for (const name of ['THREE', 'FIVE', 'NINE', 'WINNER_TAKE_ALL', 'HEADS_UP']) {
      expect(SCHEDULE_PAYOUT_PRESETS[name], `payout preset ${name}`).toBeDefined();
      const total = SCHEDULE_PAYOUT_PRESETS[name].reduce((s, p) => s + p.percentage, 0);
      expect(Math.abs(total - 100)).toBeLessThan(0.001);
    }
  });
});
