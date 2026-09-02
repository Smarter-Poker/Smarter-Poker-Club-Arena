/**
 * THE HOUSE BOARD CANNOT STARVE A CLUB BOARD (2026-09-02).
 *
 * Measured on production: Midway completes Spins faster than 12 creations per
 * tick can refill, so the house board logged "38 still to fill" on every tick,
 * consumed the whole shared BURST, and the owner loop broke on
 * `budget.left <= 0` before Deep Stack Society was ever reached. Deep Stack's
 * Spin board sat at ZERO open queues indefinitely while its pool was funded,
 * active and eligible. One shared budget across owners is that bug; one
 * budget per owner is the fix, and this pins the shape so a refactor cannot
 * quietly re-share it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, './TournamentRecurringService.ts'), 'utf8');

function method(name: string): string {
  const start = SRC.indexOf(`private async ${name}(`);
  expect(start, `${name} missing`).toBeGreaterThan(-1);
  const rest = SRC.slice(start);
  // ends at the next method definition
  const next = rest.slice(20).search(/\n  (private |async |public |protected )/);
  return next === -1 ? rest : rest.slice(0, next + 20);
}

for (const pass of ['checkAndLaunchSpins', 'checkAndLaunchSNGs']) {
  describe(`${pass}: every owner gets its own creation budget`, () => {
    const body = method(pass);

    it('does not declare a single shared budget for the whole pass', () => {
      expect(body).not.toMatch(/const budget = \{ left: BURST \};/);
    });

    it('does not break out of the owner loop when a previous owner spent its budget', () => {
      expect(body).not.toMatch(/if \(budget\.left <= 0\) break;/);
    });

    it('hands the house AND each owner a fresh { left: BURST }', () => {
      const fresh = body.match(/\{ left: BURST \}/g) || [];
      // one for the house call, one inside the owner loop
      expect(fresh.length).toBeGreaterThanOrEqual(2);
    });
  });
}
