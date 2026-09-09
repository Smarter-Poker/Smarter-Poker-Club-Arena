/**
 * LAW: no process-side stack repair exists. A paid tournament seat is born
 * with its authoritative stack inside the database transaction or it is not
 * created. A restart, timer, or manager launch can never top up a loser.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = readFileSync(join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
const ELIMINATIONS = readFileSync(
  join(process.cwd(), 'src/tournament/TournamentManagerEliminations.ts'),
  'utf8'
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

describe('a process cannot rescue a losing tournament stack', () => {
  it('has no credit helper, selector import, or direct stack top-up', () => {
    expect(BASE).not.toMatch(/creditSeatStacks/);
    expect(BASE).not.toMatch(/selectSeatsToFund|tournamentChipSupply|seatStackCredit/);
    expect(BASE).not.toMatch(/\.update\(\{\s*stack:\s*target\s*\}\)/);
  });

  it('has no resume, reveal-timer, or delayed-busting repair state', () => {
    expect(BASE).not.toMatch(/deferStacksForSpinReveal|stacksMayBeDeferred|seats_credited/);
    expect(BASE).not.toMatch(/bustingArmedAt|POST_CREDIT_BUST_SLACK_MS/);
    expect(ELIMINATIONS).not.toMatch(/bustingArmedAt|stacks not credited yet/i);
  });
});
