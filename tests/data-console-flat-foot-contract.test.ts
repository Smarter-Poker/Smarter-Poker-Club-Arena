import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const DATA_AND_ACCOUNTING_SURFACES = [
  'src/pages/club/ClubDataPage.tsx',
  'src/components/club/RakeSnapshotPanel.tsx',
  'src/components/stats/CashIntelligencePanel.tsx',
  'src/components/stats/ExactCashSessionsPanel.tsx',
  'src/components/stats/FinancialReportingPanel.tsx',
  'src/pages/ClubFinancialsPage.tsx',
  'src/pages/club/ClubBombPotReportPage.tsx',
  'src/pages/club/ClubInsuranceReportPage.tsx',
  'src/pages/UnionStatementsPage.tsx',
  'src/pages/SettlementPage.tsx',
  'src/pages/SettlementDashboardPage.tsx',
  'src/pages/SettlementHistoryPage.tsx',
  'src/pages/RateAuditPage.tsx',
  'src/pages/FinancialAdminHub.tsx',
  'src/pages/FinancialHealthPage.tsx',
  'src/pages/DisputeManagementPage.tsx',
  'src/pages/DriftIncidentsPage.tsx',
  'src/pages/DriftGatePanel.tsx',
  'src/pages/AgentPortalPage.tsx',
  'src/components/admin/RakeReports.tsx',
  'src/components/union/UnionOpsPanel.tsx',
] as const;

function unsafeFlatFeet(path: string): string[] {
  const source = read(path);
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const failures: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(ast) === 'SpadeConsole') {
        const attributes = new Map(
          node.attributes.properties
            .filter(ts.isJsxAttribute)
            .map((attribute) => [attribute.name.getText(ast), attribute] as const)
        );
        const literal = (name: string) => {
          const initializer = attributes.get(name)?.initializer;
          return initializer && ts.isStringLiteral(initializer) ? initializer.text : null;
        };
        const family = literal('family') ?? 'spade';
        const foot = literal('foot') ?? (attributes.has('plates') ? 'plates' : 'foot');
        if ((family === 'shark' || family === 'riveted') && foot === 'foot') {
          const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
          failures.push(`${path}:${line} uses ${family} plate artwork as a flat foot`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return failures;
}

function mismatchedPaintedPlates(path: string): string[] {
  const source = read(path);
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const failures: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(ast) === 'SpadeConsole') {
        const attributes = new Map(
          node.attributes.properties
            .filter(ts.isJsxAttribute)
            .map((attribute) => [attribute.name.getText(ast), attribute] as const)
        );
        const literal = (name: string) => {
          const initializer = attributes.get(name)?.initializer;
          return initializer && ts.isStringLiteral(initializer) ? initializer.text : null;
        };
        const family = literal('family') ?? 'spade';
        const foot = literal('foot') ?? (attributes.has('plates') ? 'plates' : 'foot');
        if (foot === 'plates') {
          const plates = attributes.get('plates')?.initializer;
          const expression = plates && ts.isJsxExpression(plates) ? plates.expression : null;
          const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
          if (!expression || !ts.isObjectLiteralExpression(expression)) {
            failures.push(`${path}:${line} does not declare its painted actions explicitly`);
          } else {
            const names = new Set(
              expression.properties
                .filter(ts.isPropertyAssignment)
                .map((property) => property.name.getText(ast))
            );
            const correct =
              family === 'shark'
                ? names.has('primary') && !names.has('secondary')
                : names.has('primary') && names.has('secondary');
            if (!correct) {
              failures.push(
                `${path}:${line} seats ${[...names].join(',') || 'no'} actions in ${family} artwork`
              );
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return failures;
}

describe('Data and accounting consoles never expose unlabeled painted plates', () => {
  it.each(DATA_AND_ACCOUNTING_SURFACES)('%s uses the genuine flat master for foot mode', (path) => {
    expect(unsafeFlatFeet(path)).toEqual([]);
  });

  it.each(DATA_AND_ACCOUNTING_SURFACES)(
    '%s fills every painted action plate exactly once',
    (path) => {
      expect(mismatchedPaintedPlates(path)).toEqual([]);
    }
  );

  it('locks the artwork distinction that makes shark and riveted unsafe for foot mode', () => {
    const css = read('src/components/console/SpadeConsole.css');
    const spadeFoot = css.match(/\.sc__foot\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const sharkFoot =
      css.match(/\.sc--family-shark \.sc__foot,[\s\S]*?\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const rivetedFoot =
      css.match(/\.sc--family-riveted \.sc__foot,[\s\S]*?\{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(spadeFoot).toContain('spade-console-v1/bottom-foot.png');
    expect(spadeFoot).not.toContain('bottom-plates.png');
    expect(sharkFoot).toContain('shark-console-v2/bottom-plate.png');
    expect(rivetedFoot).toContain('riveted-console-v2/bottom.png');
  });
});
