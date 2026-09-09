/**
 * A SATELLITE PLAN HAS ONE PRODUCTION AUTHORITY.
 *
 * `satelliteAwardPlan.ts` remains a pure regression oracle. Re-importing it
 * into TournamentManager would restore two independently evolving payout
 * planners and let the engine pay a shape the atomic database finalizer did
 * not freeze. This source law keeps the runtime on the all-or-none RPC.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(here, '..');
const manager = readFileSync(join(here, 'TournamentManager.ts'), 'utf8');

function runtimeTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return runtimeTypeScriptFiles(path);
    if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
    if (/\.(?:test|spec)\.ts$/.test(entry.name)) return [];
    if (path === join(here, 'satelliteAwardPlan.ts')) return [];
    return [path];
  });
}

function legacyPlannerRuntimeReferences(): string[] {
  const references: string[] = [];
  const isLegacyModule = (value: string): boolean =>
    /(?:^|\/)satelliteAwardPlan(?:\.js)?$/.test(value);
  for (const path of runtimeTypeScriptFiles(sourceRoot)) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const inspect = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        isLegacyModule(node.moduleSpecifier.text)
      ) {
        references.push(`${path}:module`);
      }
      if (
        ts.isCallExpression(node) &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]) &&
        isLegacyModule(node.arguments[0].text) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        references.push(`${path}:dynamic-module`);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ['planSatelliteAwards', 'remainderRecipientIndex'].includes(node.expression.text)
      ) {
        references.push(`${path}:${node.expression.text}`);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
  return references;
}

function satelliteSettlementMethod(): string {
  const start = manager.indexOf('protected async processSatelliteAwards');
  const end = manager.indexOf('protected async ensureLateRegSeated', start);
  expect(start, 'processSatelliteAwards exists').toBeGreaterThan(-1);
  expect(end, 'the next TournamentManager method bounds settlement').toBeGreaterThan(start);
  return manager.slice(start, end);
}

describe('the database is the only satellite settlement planner', () => {
  it('settles through exactly one atomic database RPC call site', () => {
    expect(
      satelliteSettlementMethod().match(/supabase\.rpc\('fn_settle_satellite_finish_atomic'/g)
    ).toHaveLength(1);
  });

  it('does not import, re-export, or call the legacy plan from any runtime module', () => {
    expect(legacyPlannerRuntimeReferences()).toEqual([]);
  });
});
