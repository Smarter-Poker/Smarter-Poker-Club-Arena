/**
 * LAW: NO USE-BEFORE-DECLARE ON THE TABLE ROUTE (2026-09-05, P0)
 *
 * The second sweep (#3089) made `anyTurnLive` in MultiTablePage read
 * `parseTimed(t.decision)`, and `parseTimed` was a `const` declared further
 * down the component body. That read runs synchronously during render, before
 * the declaration is reached, so EVERY table opened on the published build
 * threw "Cannot access 'parseTimed' before initialization" into the error
 * boundary. tsc does not flag a use-before-declare inside a nested callback,
 * no unit test renders the container, and it reached production.
 *
 * ESLint's `no-use-before-define` catches the shape. It cannot tell a read
 * that happens during render (a crash) from one inside a callback that runs
 * later (fine), so this is a RATCHET: every existing occurrence on the three
 * table-route files is listed below as an allowed baseline, and a NEW name
 * fails. To add one you must have read the code and be sure the reference is
 * deferred - and the honest fix is usually to move a pure helper above the
 * component, where there is nothing to be before.
 */
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const ROOT = resolve(__dirname, '..');
const FILES = [
  'src/pages/MultiTablePage.tsx',
  'src/pages/TablePage.tsx',
  'src/components/table/TableModalsLayer.tsx',
];

/** Names referenced before their declaration inside a DEFERRED callback, per file. */
const BASELINE: Record<string, string[]> = {
  'src/pages/MultiTablePage.tsx': ['goToLobby', 'sitOutStartedMessage'],
  'src/pages/TablePage.tsx': [
    'bustRebuyOpenRef',
    'clearEarlyTimers',
    'collectingChipSeatsRef',
    'exitIfBustedRef',
    'handleForceLeaveTable',
    'handleInsuranceDeclineForHand',
    'handleTournamentAddOn',
    'handleTournamentRebuy',
    'headsUpAnnouncedRef',
    'heroActedFenceRef',
    'heroCardFetchRef',
    'heroSeatRef',
    'peakStackRef',
    'rabbitExpiryTimerRef',
    'rabbitFloorTimerRef',
    'rabbitRevealClearTimerRef',
    'resetTimer',
    'seatAcquiredAtRef',
    'seatPositions',
    'setDecisionDeadline',
    'setShowCashier',
    'setShowHandHistory',
    'setShowLeaderboard',
    'setShowSessionStats',
    'setShowSettings',
    'showActionError',
    'tableStateRef',
    'takeSavedHandRef',
    'totalBuyInRef',
    'tournamentFormatRef',
  ],
  'src/components/table/TableModalsLayer.tsx': [],
};

/**
 * These two purchase reads are deferred by their exact React hook callbacks.
 * Do not add their names to the blanket baseline: a new render/dependency read
 * of either ref must still fail the law.
 */
function isDeferredPurchaseRead(ast: ts.SourceFile, offset: number, name: string): boolean {
  if (!['rebuyPurchasePendingRef', 'rebuyJustSucceededRef'].includes(name)) return false;
  let reference: ts.Identifier | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === name && node.getStart(ast) === offset)
      reference = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (let node: ts.Node | undefined = reference?.parent; node; node = node.parent) {
    if (!ts.isArrowFunction(node)) continue;
    const call = node.parent;
    if (
      !ts.isCallExpression(call) ||
      call.arguments[0] !== node ||
      !ts.isIdentifier(call.expression)
    )
      return false;
    if (name === 'rebuyPurchasePendingRef') {
      return (
        call.expression.text === 'useCallback' &&
        ts.isVariableDeclaration(call.parent) &&
        ts.isIdentifier(call.parent.name) &&
        call.parent.name.text === 'releaseBustHold'
      );
    }
    const dependencies = call.arguments[1];
    return (
      call.expression.text === 'useEffect' &&
      !!dependencies &&
      ts.isArrayLiteralExpression(dependencies) &&
      dependencies.elements.length === 2 &&
      dependencies.elements.every(
        (element, index) =>
          ts.isIdentifier(element) &&
          element.text === ['tournamentPurchaseContext', 'endRebuyPrompt'][index]
      )
    );
  }
  return false;
}

describe('LAW: no use-before-declare on the table route', () => {
  it('names used before their declaration are only the baselined, deferred ones', async () => {
    const eslint = new ESLint({
      cwd: ROOT,
      overrideConfigFile: resolve(ROOT, 'eslint.config.js'),
      overrideConfig: {
        rules: {
          '@typescript-eslint/no-use-before-define': [
            'error',
            { functions: false, classes: false, variables: true },
          ],
        },
      },
    });
    const results = await eslint.lintFiles(FILES.map((f) => resolve(ROOT, f)));
    const offenders: string[] = [];
    for (const r of results) {
      const rel = r.filePath.slice(ROOT.length + 1);
      const allowed = new Set(BASELINE[rel] ?? []);
      const ast = ts.createSourceFile(
        r.filePath,
        readFileSync(r.filePath, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );
      for (const m of r.messages) {
        if (m.ruleId !== '@typescript-eslint/no-use-before-define') continue;
        const name = /'([^']+)'/.exec(m.message)?.[1] ?? m.message;
        if (
          rel === 'src/pages/TablePage.tsx' &&
          isDeferredPurchaseRead(
            ast,
            ast.getPositionOfLineAndCharacter(m.line - 1, m.column - 1),
            name
          )
        )
          continue;
        if (!allowed.has(name)) offenders.push(`${rel}:${m.line} ${name}`);
      }
    }
    expect(
      offenders,
      'A name is read before its declaration. If the read happens during render this is the parseTimed crash again; move the helper above the component. If it is genuinely inside a deferred callback, add it to BASELINE with your eyes open.'
    ).toEqual([]);
  }, 60_000);

  it.each([
    [
      'const releaseBustHold = useCallback(() => rebuyPurchasePendingRef.current, []);',
      'rebuyPurchasePendingRef',
      true,
    ],
    [
      'useEffect(() => { rebuyJustSucceededRef.current = false; }, [tournamentPurchaseContext, endRebuyPrompt]);',
      'rebuyJustSucceededRef',
      true,
    ],
    ['const value = rebuyPurchasePendingRef.current;', 'rebuyPurchasePendingRef', false],
    ['const value = rebuyJustSucceededRef.current;', 'rebuyJustSucceededRef', false],
    [
      'const releaseBustHold = useCallback(() => {}, [rebuyPurchasePendingRef.current]);',
      'rebuyPurchasePendingRef',
      false,
    ],
    [
      'const releaseBustHold = useMemo(() => rebuyPurchasePendingRef.current, []);',
      'rebuyPurchasePendingRef',
      false,
    ],
    [
      'const releaseBustHold = useCallback((() => rebuyPurchasePendingRef.current)(), []);',
      'rebuyPurchasePendingRef',
      false,
    ],
    [
      'useEffect(() => { rebuyJustSucceededRef.current = false; }, []);',
      'rebuyJustSucceededRef',
      false,
    ],
  ])('scopes the deferred purchase allowance: %s', (source, name, allowed) => {
    const ast = ts.createSourceFile(
      'case.tsx',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    expect(isDeferredPurchaseRead(ast, source.indexOf(name), name)).toBe(allowed);
  });

  it('the helper that crashed the table lives above the component', () => {
    const src = readFileSync(resolve(ROOT, 'src/pages/MultiTablePage.tsx'), 'utf8');
    const helper = src.indexOf('export function parseTimed(');
    const component = src.indexOf('export default function MultiTablePage');
    expect(helper).toBeGreaterThan(-1);
    expect(helper).toBeLessThan(component);
  });
});
