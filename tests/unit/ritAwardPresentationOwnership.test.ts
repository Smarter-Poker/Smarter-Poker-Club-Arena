import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/pages/TablePage.tsx', 'utf8');
const file = ts.createSourceFile(
  'TablePage.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
function declaration(name: string) {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found?.initializer) throw new Error(`Missing ${name}`);
  return found.initializer;
}
const fire = declaration('fireGroup') as ts.ArrowFunction;
// Execute the actual hand/river admission statements; the rest is a launch witness.
const admission = (fire.body as ts.Block).statements
  .slice(0, 2)
  .map((node) => node.getText(file))
  .join('\n');
const callback = (declaration('markRitBoardPresented') as ts.CallExpression)
  .arguments[0] as ts.ArrowFunction;
const completion = (callback.body as ts.Block).statements
  .map((node) => node.getText(file))
  .join('\n');
function fixture(runs: number) {
  const deps = {
    tableStateRef: { current: { handNumber: 42 } },
    awardHand: 42,
    ritExpectedRunsRef: { current: runs },
    ritResultRef: { current: { boards: Array(runs) } },
    ritFaceUpBoardsRef: { current: new Set<number>() },
    pendingRitAwardsRef: { current: new Map<number, Array<() => void>>() },
    setRitFaceUpBoards: (_update: unknown) => {},
    launched: [] as unknown[],
  };
  const names = Object.keys(deps).join(',');
  const launch = new Function(
    'deps',
    `const {${names}}=deps; const fireGroup=(g)=>{${admission}\nlaunched.push(g);};return fireGroup;`
  )(deps);
  const presented = new Function(
    'deps',
    `const {${names}}=deps;return (board,hand)=>{${completion}};`
  )(deps);
  return { deps, launch, presented };
}
describe('the original payout owner waits for its own board and hand', () => {
  for (const runs of [2, 3])
    it(`${runs} runs retain each payout until its river is presented`, () => {
      const f = fixture(runs);
      const one = { events: [{}], board: 1 };
      const last = { events: [{}], board: runs };
      f.launch(one);
      f.launch(last);
      expect(f.deps.launched).toEqual([]);
      f.presented(0, 42);
      expect(f.deps.launched).toEqual([one]);
      f.presented(runs - 1, 42);
      expect(f.deps.launched).toEqual([one, last]);
      expect(f.deps.pendingRitAwardsRef.current.size).toBe(0);
    });
  it('a delayed river completion cannot launch an award on the next hand', () => {
    const f = fixture(3);
    f.launch({ events: [{}], board: 1 });
    f.deps.tableStateRef.current.handNumber = 43;
    f.presented(0, 42);
    expect(f.deps.launched).toEqual([]);
  });
});
