/**
 * LAW (CLAUDE.md 10.5, multi-day R5 engine, 2026-09-24): a horse is bagged,
 * qualified and re-seated for the next day through exactly the same code as a
 * human. The multi-day engine never asks who is a horse; the seat draw is one
 * shuffle over every entitlement; and a bagged horse still occupies its event
 * when the fleet decides which horses are free.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { drawStageSeats } from './multiDayStages.js';

const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');

/** Code only: a comment may explain horses, code may not branch on them. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function multiDayBlock(): string {
  const base = read('src/tournament/TournamentManagerBase.ts');
  const start = base.indexOf('//  MULTI-DAY (R5 engine, 2026-09-24).');
  const end = base.indexOf('private applyManagerMutationFence(', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return base.slice(start, end);
}

describe('a bagged horse is a bagged player', () => {
  it.each([
    ['src/tournament/multiDayStages.ts', () => read('src/tournament/multiDayStages.ts')],
    ['src/tournament/stageResumeSchedule.ts', () => read('src/tournament/stageResumeSchedule.ts')],
    ['the multi-day block of TournamentManagerBase', multiDayBlock],
  ])('%s never asks whether a player is a horse', (_name, load) => {
    const body = code(load());
    expect(body).not.toMatch(/is_horse|isHorse|horse_id|horseId|HorseLogic/);
  });

  it('the next-day seat draw is one shuffle: renaming a horse to a human changes no chair', () => {
    const sequence = [2, 0, 1, 1, 0, 3, 2, 1, 0, 1];
    const rng = () => {
      let i = 0;
      return (max: number) => sequence[i++ % sequence.length] % max;
    };
    const tables = [
      { id: 't1', capacity: 3, occupied: new Set<number>() },
      { id: 't2', capacity: 3, occupied: new Set<number>([2]) },
    ];
    const asHorses = drawStageSeats(['horse-1', 'human-1', 'horse-2', 'human-2'], tables, rng());
    const asHumans = drawStageSeats(['human-9', 'human-8', 'human-7', 'human-6'], tables, rng());
    const chairs = (seats: typeof asHorses) =>
      seats!.map((seat) => `${seat.tableId}#${seat.seatNumber}`);
    expect(asHorses).not.toBeNull();
    expect(chairs(asHorses)).toEqual(chairs(asHumans));
    // The chair already taken on t2 is never handed out again.
    expect(chairs(asHorses)).not.toContain('t2#2');
  });

  it('a bagged horse still occupies its event when the fleet picks free horses', () => {
    const recurring = code(read('src/services/TournamentRecurringService.ts'));
    const load = recurring.slice(
      recurring.indexOf('private async horseLoadMap()'),
      recurring.indexOf('return buildHorseLoadMap(')
    );
    expect(load).toContain(".in('tournaments.status', ['ANNOUNCED', 'REGISTERING', 'BAGGED'])");
  });
});
