/**
 * LAW: a featured nightly tournament is pinned only on its own day (Dan, 2026-10-19).
 *
 * "do not pin the nightly 10k guarantees for future days, only for the current
 * day ... (sunday 200 stays, and 'todays 10K only' if its running, show it but
 * never show the next days until its that day."
 *
 * The fixture is the production board Dan screenshotted on Monday 2026-10-19 at
 * 21:52 Chicago: three Nightly 10K instances (Tue/Wed/Thu) and the Sunday 200,
 * all four pinned, all four floating above tonight's events.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { featuredNow, hasStarted, type PinFacts } from '../src/lib/featuredOnItsDay';

const CLUB = 'fade0000-0000-0000-0000-000000000001';
const row = (id: string, name: string, start: string, extra: Partial<PinFacts> = {}) => ({
  id,
  facts: {
    pinned: true,
    started: false,
    startTime: start,
    clubId: CLUB,
    name,
    ...extra,
  } as PinFacts,
});
const ids = (rows: ReturnType<typeof row>[], now: Date) =>
  [...featuredNow(rows, (r) => r.facts, now)].map((r) => r.id).sort();

/* Local wall-clock dates, so the test means the same thing in any zone CI runs in. */
const at = (y: number, m: number, d: number, h: number) =>
  new Date(y, m - 1, d, h, 0, 0).toISOString();

describe('a featured nightly event floats only on its own day', () => {
  const board = [
    row('tue', 'Nightly 10K (NLH)', at(2026, 10, 20, 19)),
    row('wed', 'Nightly 10K (NLH)', at(2026, 10, 21, 19)),
    row('thu', 'Nightly 10K (NLH)', at(2026, 10, 22, 19)),
    row('sun', 'Sunday 200 Deep Stack', at(2026, 10, 25, 13)),
  ];

  it('Monday night: no future Nightly 10K is pinned, the Sunday 200 stays', () => {
    expect(ids(board, new Date(2026, 9, 19, 21, 52))).toEqual(['sun']);
  });

  it("Tuesday: only Tuesday's Nightly 10K is pinned, plus the Sunday 200", () => {
    expect(ids(board, new Date(2026, 9, 20, 9))).toEqual(['sun', 'tue']);
  });

  it("today's nightly keeps its pin once it is running", () => {
    const live = [
      row('mon', 'Nightly 10K (NLH)', at(2026, 10, 19, 19), { started: true }),
      ...board,
    ];
    expect(ids(live, new Date(2026, 9, 19, 21, 52))).toEqual(['mon', 'sun']);
  });

  it('a row the host never pinned is never featured', () => {
    expect(
      ids(
        [row('x', 'Freeroll', at(2026, 10, 19, 22), { pinned: false })],
        new Date(2026, 9, 19, 12)
      )
    ).toEqual([]);
  });

  it('two clubs running the same name are two series', () => {
    const union = [
      row('a', 'Nightly 10K (NLH)', at(2026, 10, 21, 19), { clubId: 'club-a' }),
      row('b', 'Nightly 10K (NLH)', at(2026, 10, 21, 19), { clubId: 'club-b' }),
    ];
    expect(ids(union, new Date(2026, 9, 19, 12))).toEqual(['a', 'b']);
  });

  it('started statuses read in either case', () => {
    expect(hasStarted('RUNNING')).toBe(true);
    expect(hasStarted('late_reg')).toBe(true);
    expect(hasStarted('BAGGED')).toBe(true);
    expect(hasStarted('REGISTERING')).toBe(false);
  });

  it('every tournament display that floats pinned events goes through the rule', () => {
    for (const file of [
      'src/components/lobby/LobbyTable.tsx',
      'src/pages/TournamentPage.tsx',
      'src/pages/tournament/TournamentLobbyPage.tsx',
    ]) {
      const src = readFileSync(join(__dirname, '..', file), 'utf8');
      expect(src, file).toMatch(/featuredNow\(/);
    }
  });
});
