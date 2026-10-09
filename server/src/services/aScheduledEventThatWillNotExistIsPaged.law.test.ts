/**
 * LAW: A SCHEDULED EVENT THAT WILL NOT EXIST IS PAGED (2026-10-09).
 *
 * Every refusal on the scheduled spawn path was an error-log line only. Four
 * Diamond Arena "$100 Freeroll" schedules were refused on every poll from the
 * moment they were seeded and not one occurrence ever existed. A refusal near
 * the start now raises one open alert per schedule, and the schedule's next
 * successful spawn closes it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MISSED_OCCURRENCE_PAGE_WITHIN_MS,
  MISSED_OCCURRENCE_SOURCE,
  missedOccurrenceIsPageable,
} from './ScheduledTournamentService.js';

const src = readFileSync(
  fileURLToPath(new URL('./ScheduledTournamentService.ts', import.meta.url)),
  'utf8'
);
const between = (a: string, b: string) => {
  const i = src.indexOf(a);
  return src.slice(i, src.indexOf(b, i + a.length));
};

describe('a scheduled event that will not exist is paged', () => {
  it('pages only when the start is within the hour or already passed', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    expect(missedOccurrenceIsPageable(new Date('2026-10-10T12:00:00Z'), now)).toBe(false);
    expect(
      missedOccurrenceIsPageable(
        new Date(now.getTime() + MISSED_OCCURRENCE_PAGE_WITHIN_MS + 1),
        now
      )
    ).toBe(false);
    expect(
      missedOccurrenceIsPageable(new Date(now.getTime() + MISSED_OCCURRENCE_PAGE_WITHIN_MS), now)
    ).toBe(true);
    expect(missedOccurrenceIsPageable(new Date('2026-10-09T11:00:00Z'), now)).toBe(true);
    expect(MISSED_OCCURRENCE_SOURCE).toBe('ScheduledTournaments.occurrence_not_created');
  });

  it('every refusal on the spawn path pages', () => {
    const spawn = between(
      'private async spawnInstance(',
      '\n  private async scheduleIsDiamondArena('
    );
    expect(spawn).toMatch(/if \(!row\) \{[\s\S]{0,400}?await this\.pageMissedOccurrence\(/);
    expect(spawn).toMatch(
      /diamond_config_refused'\s*\);\s*await this\.pageMissedOccurrence\(schedule, startTime, mapped\.reason\);/
    );
    expect(spawn).toMatch(
      /'ScheduledTournaments\.insert_failed'\s*\);\s*await this\.pageMissedOccurrence\(schedule, startTime, msg\);/
    );
    const diamond = between('private async spawnDiamondInstance(', '\n  /**');
    expect(diamond).toMatch(
      /'ScheduledTournaments\.diamond_spawn_refused'\s*\);\s*await this\.pageMissedOccurrence\(schedule, startTime, answer\.reason\);/
    );
  });

  it('never pages a satellite that is only waiting for its target to exist', () => {
    const spawn = between(
      'private async spawnInstance(',
      '\n  private async scheduleIsDiamondArena('
    );
    expect(spawn).toMatch(
      /if \(this\.waitingForSatelliteTarget\.delete\(occurrenceKey\(schedule\.id, startTime\)\)\) return;\s*await this\.pageMissedOccurrence\(/
    );
    expect(src).toMatch(
      /no pre-start satellite target matching[\s\S]{0,200}?this\.waitingForSatelliteTarget\.add\(occurrenceKey\(schedule\.id, startTime\)\);\s*return null;/
    );
  });

  it('is one alert per schedule, and the next successful spawn closes it', () => {
    const page = between(
      'private async pageMissedOccurrence(',
      'private async clearMissedOccurrencePage('
    );
    expect(page).toContain('`scheduled-occurrence-not-created:${schedule.id}`');
    const spawn = between(
      'private async spawnInstance(',
      '\n  private async scheduleIsDiamondArena('
    );
    expect(
      spawn.match(
        /await this\.clearMissedOccurrencePage\(schedule\.id\);\s*await this\.finishSpawn\(/g
      )
    ).toHaveLength(2);
    const clear = between('private async clearMissedOccurrencePage(', 'private async finishSpawn(');
    expect(clear).toContain(".eq('source', MISSED_OCCURRENCE_SOURCE)");
    expect(clear).toContain(".eq('context->>schedule_id', scheduleId)");
  });
});
