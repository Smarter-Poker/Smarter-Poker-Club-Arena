/**
 * A table reduced to one player cannot deal and therefore has no table engine.
 * The balancer must still see that table or the remaining player can never be
 * consolidated with another table. Database seats, not dealing engines, own
 * the table roster used by both balance passes and the final-table count.
 *
 * Registry: docs/laws.d/a-table-with-one-player-is-still-the-balancers-problem.md
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sliceMethod } from './helpers/sourceWindow';

const MANAGER = readFileSync(
  join(process.cwd(), 'server/src/tournament/TournamentManager.ts'),
  'utf8'
);
const BASE = readFileSync(
  join(process.cwd(), 'server/src/tournament/TournamentManagerBase.ts'),
  'utf8'
);

describe("a table with one player is still the balancer's problem", () => {
  it('never derives either ordinary balance pass from the engine registry', () => {
    const balance = sliceMethod(MANAGER, 'protected async checkTableBalance');
    expect(balance).not.toContain('this.tableEngines.size <= 1');
    expect(balance).not.toContain('this.tableEngines.size > 1');
    expect(balance).not.toContain("[...this.tableEngines.keys()], 'balanceInitial'");
    expect(balance).not.toContain("[...this.tableEngines.keys()],\n        'balanceFresh'");
  });

  it('feeds both balance passes from live database seats', () => {
    const balance = sliceMethod(MANAGER, 'protected async checkTableBalance');
    expect(balance).toContain(
      'const liveTableIds = await this.liveTournamentTableIdsWithPlayers();'
    );
    expect(balance).toContain(
      'const freshTableIds = await this.liveTournamentTableIdsWithPlayers();'
    );
    expect(balance).toContain("this.loadBalancerTables(liveTableIds, 'balanceInitial')");
    expect(balance).toContain("this.loadBalancerTables(freshTableIds, 'balanceFresh')");
  });

  it('redrives both unreadable table-list results instead of calling them balanced', () => {
    const balance = sliceMethod(MANAGER, 'protected async checkTableBalance');
    for (const variable of ['liveTableIds', 'freshTableIds']) {
      expect(balance).toMatch(
        new RegExp(
          `if \\(\\s*${variable} === null\\s*\\) \\{[\\s\\S]*?` +
            `requestUrgentEliminationSweepAfter\\(TournamentManagerBase\\.BALANCE_REDRIVE_MS\\);` +
            `[\\s\\S]*?return;[\\s\\S]*?\\}`
        )
      );
    }
  });

  it('returns live table ids with unleft seats and preserves unknown as null', () => {
    const reader = sliceMethod(BASE, 'protected async liveTournamentTableIdsWithPlayers');
    expect(reader).toContain("in('status', ['running', 'waiting'])");
    expect(reader).toContain("is('left_at', null)");
    expect(reader).toContain('if (tablesErr || !liveTables) return null;');
    expect(reader).toContain('if (seatsErr || !seats) return null;');
    expect(reader).toContain('return ids.filter((id) => holding.has(id));');
  });

  it('keeps the final-table count on the same database authority', () => {
    const counter = sliceMethod(BASE, 'protected async countLiveTablesWithPlayers');
    expect(counter).toContain('await this.liveTournamentTableIdsWithPlayers()');
    expect(counter).toContain('ids === null ? null : ids.length');
  });
});
