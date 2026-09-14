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
import ts from 'typescript';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// Read actual module edges, including multiline declarations and re-exports.
// A type-only edge is erased; every value or dynamic edge needs review here.
const runtimeModuleEdges = (source: string): string[] => {
  const file = ts.createSourceFile('entry.ts', source, ts.ScriptTarget.Latest, true);
  const edges: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const erased =
        clause?.isTypeOnly ||
        (clause &&
          !clause.name &&
          named &&
          ts.isNamedImports(named) &&
          named.elements.length > 0 &&
          named.elements.every((element) => element.isTypeOnly));
      if (!erased) edges.push(node.moduleSpecifier.getText(file).slice(1, -1));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const named = node.exportClause;
      const erased =
        node.isTypeOnly ||
        (named &&
          ts.isNamedExports(named) &&
          named.elements.length > 0 &&
          named.elements.every((element) => element.isTypeOnly));
      if (!erased) edges.push(node.moduleSpecifier.getText(file).slice(1, -1));
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      edges.push(node.getText(file));
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
      edges.push(node.moduleReference.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return edges.sort();
};

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
    // The display projection adds no dependencies. Pin the transitive graph,
    // so moving a lobby import into one of these helpers cannot hide the leak.
    const graph: Record<string, string[]> = {
      'src/components/lobby/lateRegWindow.ts': [
        '../../utils/tournamentEntryWindow',
        './tournamentFigures',
      ],
      'src/components/lobby/tournamentFigures.ts': ['../../utils/parseJsonCached'],
      'src/utils/tournamentEntryWindow.ts': [],
      'src/utils/parseJsonCached.ts': [],
    };
    for (const [path, expected] of Object.entries(graph)) {
      expect(runtimeModuleEdges(read(path)), path).toEqual(expected.sort());
    }
  });

  it('recognizes multiline, re-export and dynamic edges that would hide eager dependencies', () => {
    expect(
      runtimeModuleEdges(`
      import {\n lobbyEntries\n } from './lobbyEntries';
      export { gateway } from './operator';
      import('./lazy');
      require('./commonjs');
    `)
    ).toEqual(['./lobbyEntries', './operator', "import('./lazy')", "require('./commonjs')"]);
  });

  it('erases type-only edges but retains mixed value imports', () => {
    expect(
      runtimeModuleEdges(`
      import type { LobbyRow } from './lobbyEntries';
      import { type OtherRow } from './other';
      export type { Row } from './rows';
      export { type MoreRow } from './more';
      import { type Row, value } from './value';
    `)
    ).toEqual(['./value']);
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
