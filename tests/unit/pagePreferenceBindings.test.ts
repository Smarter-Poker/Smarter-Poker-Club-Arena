import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const pages = {
  DisputeManagementPage: {
    persisted: ['activeTab', 'searchQuery'],
    transient: ['resolutionText', 'adjustmentAmount', 'adjustmentType'],
  },
  CashierTradePage: {
    persisted: [
      'search',
      'recordQuery',
      'recordDirection',
      'groupByRole',
      'historyPerson',
      'historyScope',
      'historyKind',
      'historyRange',
    ],
    transient: ['clubUuid', 'clubResolveFailed', 'historySearch'],
  },
  ClubDetailPage: { persisted: ['activeTab', 'memberSearch'], transient: [] },
};

describe('page preference ownership bindings', () => {
  for (const [page, { persisted, transient }] of Object.entries(pages)) {
    it(`${page} persists rendered controls, never transaction drafts or authoritative data`, () => {
      const source = ts.createSourceFile(
        page,
        readFileSync(`src/pages/${page}.tsx`, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );
      const bindings = new Map<string, { hook: string; key?: string; setter?: string }>();
      function collect(node: ts.Node): void {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isArrayBindingPattern(node.name) &&
          node.initializer &&
          ts.isCallExpression(node.initializer)
        ) {
          bindings.set(node.name.elements[0].getText(source), {
            hook: node.initializer.expression.getText(source),
            key:
              node.initializer.arguments[0] && ts.isStringLiteral(node.initializer.arguments[0])
                ? node.initializer.arguments[0].text
                : undefined,
            setter: node.name.elements[1]?.getText(source),
          });
        }
        ts.forEachChild(node, collect);
      }
      collect(source);
      for (const name of persisted) {
        expect(bindings.get(name)?.hook, name).toBe('usePlayerPreference');
        expect(bindings.get(name)?.key, name).toBe(`${page}:${name}`);
      }
      for (const name of transient) expect(bindings.get(name)?.hook, name).toBe('useState');
      const setters = new Set(persisted.map((name) => bindings.get(name)?.setter));
      const resetCalls: string[] = [];
      function inspect(node: ts.Node, inEffect = false): void {
        const effect =
          inEffect ||
          (ts.isCallExpression(node) &&
            ['useEffect', 'useLayoutEffect'].includes(node.expression.getText(source)));
        if (effect && ts.isCallExpression(node) && setters.has(node.expression.getText(source)))
          resetCalls.push(node.getText(source));
        ts.forEachChild(node, (child) => inspect(child, effect));
      }
      inspect(source);
      expect(resetCalls).toEqual([]);
    });
  }
});
