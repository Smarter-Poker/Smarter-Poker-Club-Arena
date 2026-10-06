/**
 * A SCHEDULE DELETED MID-PASS IS RETIRED, NOT FAILED (2026-10-03).
 *
 * 24 spawn_claim_failed reports across 9 deleted schedules (23503 on
 * tournament_schedule_spawns_schedule_id_fkey) were one per pending date of a
 * schedule deleted between the pass's read and its claims. Nothing was
 * spawned and nothing should be.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/services/ScheduledTournamentService.ts'), 'utf8');
const method = (name: string) => {
  const start = SRC.indexOf(`private async ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = SRC.slice(start);
  const end = rest.indexOf('\n  private ', 10);
  return end === -1 ? rest : rest.slice(0, end);
};

describe('a schedule deleted mid-pass', () => {
  it('stands the claim down on the schedule foreign key without reporting', () => {
    const claim = method('claimSpawn');
    const fk = claim.indexOf('tournament_schedule_spawns_schedule_id_fkey');
    const report = claim.indexOf('reportError(');
    expect(fk).toBeGreaterThan(-1);
    expect(fk).toBeLessThan(report);
    expect(claim).toMatch(/this\.retiredScheduleIds\.add\(scheduleId\)/);
  });

  it('skips the rest of that schedule for the pass and resets per pass', () => {
    expect(method('processTimedSchedule')).toMatch(
      /if \(this\.retiredScheduleIds\.has\(schedule\.id\)\) return;/
    );
    expect(SRC).toMatch(
      /this\.fundingBankReads = new Map\(\);\s*this\.retiredScheduleIds = new Set\(\);/
    );
  });
});
