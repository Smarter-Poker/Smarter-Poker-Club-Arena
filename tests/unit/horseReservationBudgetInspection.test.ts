import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
const script = resolve(__dirname, '../../scripts/ci/inspect-tournament-refill.py');
const producer = readFileSync(
  resolve(__dirname, '../../server/src/services/TournamentRecurringService.ts'),
  'utf8'
);
function summarize(lines: string[]) {
  const r = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      'import json,runpy,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps(m["summarize"](json.loads(sys.stdin.read()))))',
      script,
    ],
    { input: JSON.stringify(lines.join('\n')), encoding: 'utf8', timeout: 5000 }
  );
  expect(r.status, r.stderr).toBe(0);
  return { data: JSON.parse(r.stdout), text: r.stdout };
}
it('retains original MTT and seat-first budget decline summaries without exporting raw logs', () => {
  expect(producer).toContain('Horse registration: ${registered} seated, skipped - ${summary}');
  expect(producer).toContain('the seat RPC answered ok:false - ${summary}');
  const { data, text } = summarize([
    '2026-10-27T06:30:00Z [TournamentRecurring] Horse registration: 0 seated, skipped - horse_tournament_reservation_budget x2 private-secret',
    '2026-10-27T06:30:01Z [TournamentRecurring] seat-first fill 12345678: the seat RPC answered ok:false - horse_tournament_reservation_budget x1 private-secret',
  ]);
  for (const key of ['horse_registration_summary', 'seat_first_rpc_noop']) {
    expect(data[key].count).toBe(1);
    expect(data[key].categories).toEqual({ horse_tournament_reservation_budget: 1 });
    expect(data[key].unclassifiedCount).toBe(0);
  }
  expect(text).not.toMatch(/private-secret|x2|12345678/);
});
it('does not report unrelated markers or partial category names as budget declines', () => {
  const { data, text } = summarize([
    '2026-10-27T06:30:00Z [OtherService] Horse registration: horse_tournament_reservation_budget private-secret',
    '2026-10-27T06:30:01Z [TournamentRecurring] Horse registration: horse_tournament_reservation_budget_suffix private-secret',
    '2026-10-27T06:30:02Z [TournamentRecurring] seat-first fill: the seat RPC answered ok:false - unrelated_reason private-secret',
  ]);
  expect(data.horse_registration_summary.count).toBe(1);
  expect(data.horse_registration_summary.categories).toEqual({});
  expect(data.seat_first_rpc_noop.categories).toEqual({});
  expect(text).not.toMatch(/private-secret|unrelated_reason|budget_suffix/);
});
