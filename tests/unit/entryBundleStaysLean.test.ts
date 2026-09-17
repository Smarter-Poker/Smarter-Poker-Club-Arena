/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE APP SHELL DOES NOT CARRY OPERATOR CODE (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two modules are mounted eagerly, so everything they statically import lands
 * in the entry chunk that EVERY player downloads before first paint:
 *
 *   TournamentStartingTicker  mounts at the app root, outside <Routes>
 *   TableService              reached from App via TournamentRankingHost
 *
 * Table Management shipped with a static import in each, and the measured
 * cost was +11kB gzipped on the initial load: a 1,482-line lobby view-model
 * and its dependency tree pulled in for one function, and the whole operator
 * command gateway pulled in for four administrative methods. Neither is
 * needed to render a table for a player. Both were made lazy; the entry cost
 * of the feature fell to +3kB.
 *
 * These pins are cheap and the regression is not: nothing else in CI notices
 * a module quietly moving from a route chunk into the entry, because the
 * bundle gate measures a total, not who pays it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('the eager app shell stays free of lazy-only code', () => {
  it('the root-mounted ticker reads the late-reg window without the lobby view-model', () => {
    const ticker = read('src/components/tournament/TournamentStartingTicker.tsx');

    // The value import must come from the small extracted module.
    expect(ticker).toContain("import { lateRegEndMs } from '../lobby/lateRegWindow';");

    // Any remaining reference to lobbyEntries must be type-only, which
    // TypeScript erases, so no runtime edge is created.
    const lobbyImports = ticker
      .split('\n')
      .filter((line) => line.includes("'../lobby/lobbyEntries'"));
    expect(lobbyImports.length).toBeGreaterThan(0);
    for (const line of lobbyImports) {
      expect(line.startsWith('import type ')).toBe(true);
    }
  });

  it('the extracted late-reg module does not drag the lobby back in at runtime', () => {
    const extracted = read('src/components/lobby/lateRegWindow.ts');
    const valueImports = extracted
      .split('\n')
      .filter((line) => line.startsWith('import ') && !line.startsWith('import type '));

    // Keep both pure display helpers explicit. Neither may import the lobby or
    // another runtime dependency into the eagerly mounted ticker.
    expect(valueImports).toEqual([
      "import { tournamentEntryWindow } from '../../utils/tournamentEntryWindow';",
      "import { blindLevelMinutes, parseBlindStructure } from './tournamentFigures';",
    ]);
    const entryWindow = read('src/utils/tournamentEntryWindow.ts');
    expect(entryWindow).not.toMatch(/^import\s+(?!type\b)/m);
    expect(entryWindow).not.toMatch(/\b(?:import|require)\s*\(/);
  });

  it('lobbyEntries still exports lateRegEndMs, so no existing caller changed', () => {
    const lobby = read('src/components/lobby/lobbyEntries.ts');
    expect(lobby).toContain("import { lateRegEndMs } from './lateRegWindow';");
    expect(lobby).toContain('export { lateRegEndMs };');
  });

  it('the eager table service loads the operator command gateway on demand', () => {
    const service = read('src/services/TableService.ts');

    expect(service).not.toContain(
      "import { gameManagementService } from './GameManagementService';"
    );
    expect(service).toContain("await import('./GameManagementService')");

    // The governed routing itself is unchanged: every operator action still
    // goes through the command gateway rather than touching the database.
    expect(service).toContain("gameManagementService.close('table', tableId)");
    expect(service).toContain('gameManagementService.pause(tableId)');
    expect(service).toContain('gameManagementService.resume(tableId)');
  });
});
