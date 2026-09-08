import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const approvedWorker = 'engine/equity/equityWorker.ts';
const forbiddenCalculators = new Set([
  'computeEquity',
  'computeInsuranceComponentsForHands',
  'insuranceEquity',
  'monteCarloEquity',
]);

function productionSources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      productionSources(absolute).forEach((file) => files.push(file));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(absolute);
    }
  }
  return files;
}

describe('live Monte Carlo worker boundary', () => {
  it('keeps every synchronous calculator call inside the approved worker entrypoint', () => {
    const violations: string[] = [];

    for (const absolute of productionSources(sourceRoot)) {
      const repoPath = relative(sourceRoot, absolute).replaceAll('\\', '/');
      const ast = ts.createSourceFile(
        absolute,
        readFileSync(absolute, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          forbiddenCalculators.has(node.expression.text) &&
          repoPath !== approvedWorker
        ) {
          const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
          violations.push(`${repoPath}:${line} calls ${node.expression.text} on a live thread`);
        }
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const modulePath = node.moduleSpecifier.text;
          const importsCalculatorModule =
            modulePath.endsWith('/MonteCarloEquity.js') ||
            modulePath.endsWith('/InsuranceEquity.js') ||
            modulePath.endsWith('/equityWorker.js') ||
            modulePath === './MonteCarloEquity.js' ||
            modulePath === './InsuranceEquity.js' ||
            modulePath === './equityWorker.js';
          if (importsCalculatorModule && repoPath !== approvedWorker) {
            const named = node.importClause?.namedBindings;
            if (named && ts.isNamedImports(named)) {
              for (const element of named.elements) {
                const imported = element.propertyName?.text ?? element.name.text;
                if (forbiddenCalculators.has(imported)) {
                  const line = ast.getLineAndCharacterOfPosition(element.getStart(ast)).line + 1;
                  violations.push(`${repoPath}:${line} imports ${imported} onto a live thread`);
                }
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }

    expect(violations).toEqual([]);
  });
});
