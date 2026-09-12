/**
 * A HAND TORN DOWN MID-DEAL IS NOT DEALT (2026-09-06).
 *
 * `dealHand` builds the HandController, awaits asynchronous boundaries (the VIP time-bank
 * allowance), then captures that exact controller, registers its listener and
 * starts the hand. `stop()` and `killForRestart()` set `handController` to
 * null, and between 09:30 and 12:30 CDT on 2026-09-06 they did so four times
 * inside that await - every one a table the cluster controller had just
 * broken - and the `!` dereferenced null:
 *
 *     TypeError: Cannot read properties of null (reading 'onEvent')
 *
 * The guard is pinned by position: after the await, before the listener.
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, 'ServerTableEngineDealing.ts'), 'utf8');

describe('dealHand re-reads the controller after every preparation await', () => {
  const construct = SRC.indexOf(
    'this.handController = new HandController(config, hcPlayers, dealerSeat);'
  );
  const awaitAt = SRC.indexOf('const tbExtras = await this.fetchTimeBankExtras(', construct);
  const guardTree = ts.createSourceFile('dealing.ts', SRC, ts.ScriptTarget.Latest, true);
  const matchingGuards: ts.IfStatement[] = [];
  function findGuard(node: ts.Node): void {
    if (ts.isIfStatement(node) && node.getStart(guardTree) > awaitAt) {
      const condition = node.expression.getText(guardTree).replace(/\s+/g, '');
      if (
        condition ===
        'this.handController!==preparedController||!this.running||!this.isCurrentEngine()||!this.lifecycleCanMutate()'
      )
        matchingGuards.push(node);
    }
    ts.forEachChild(node, findGuard);
  }
  findGuard(guardTree);
  const guard = matchingGuards[0]?.getStart(guardTree) ?? -1;
  const capture = SRC.indexOf('const controllerForHand = preparedController;', guard);
  const listener = SRC.indexOf('unsub = controllerForHand.onEvent(', capture);
  const start = SRC.indexOf('controllerForHand.start();', listener);

  it('the guard sits between the await and the listener', () => {
    expect(construct).toBeGreaterThan(0);
    expect(awaitAt).toBeGreaterThan(construct);
    expect(guard).toBeGreaterThan(awaitAt);
    expect(capture).toBeGreaterThan(guard);
    expect(listener).toBeGreaterThan(capture);
    expect(start).toBeGreaterThan(listener);
  });

  it('revalidates original controller, running state and ownership after each preparation await', () => {
    const first = SRC.slice(awaitAt, SRC.indexOf('for (const p of hcPlayers)', awaitAt));
    const secondAt = SRC.indexOf(
      'const publicationStart = await this.acquireFinancialControllerStart();',
      awaitAt
    );
    const second = SRC.slice(secondAt, capture);
    for (const checkpoint of [first, second]) {
      expect(checkpoint).toContain('this.discardPreparedHandForPause()');
      expect(checkpoint.indexOf('this.handController !== preparedController')).toBeLessThan(
        checkpoint.indexOf('this.discardPreparedHandForPause()')
      );
      expect(checkpoint).toContain('this.handController !== preparedController');
      expect(checkpoint).toContain('!this.running');
      expect(checkpoint).toContain('!this.isCurrentEngine()');
      expect(checkpoint).toContain('!this.lifecycleCanMutate()');
      expect(checkpoint).toMatch(/return;/);
    }
    expect(secondAt).toBeGreaterThan(awaitAt);
    expect(SRC.slice(secondAt, start)).toContain('try {');
    expect(SRC.slice(start)).toContain('publicationStart?.release();');
  });

  it('the guard returns without dealing and says why', () => {
    const body = SRC.slice(guard, listener);
    expect(body).toContain('not dealt - the engine was');
    expect(body).toMatch(/\n\s*return;\n/);
  });
});

// Execute the actual await expression and its following guard, not a modeled guard.
const tree = ts.createSourceFile('dealing.ts', SRC, ts.ScriptTarget.Latest, true);
const begin = SRC.indexOf('const preparedController = this.handController;');
const finish = SRC.indexOf('const controllerForHand = preparedController;', begin);
const awaits: ts.AwaitExpression[] = [];
const guards: ts.IfStatement[] = [];
function visit(node: ts.Node): void {
  if (node.getStart(tree) >= begin && node.getEnd() <= finish) {
    if (ts.isAwaitExpression(node)) awaits.push(node);
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(tree).includes('this.handController !== preparedController')
    )
      guards.push(node);
  }
  ts.forEachChild(node, visit);
}
visit(tree);
for (const boundary of awaits) {
  const guard = guards.find((g) => g.getStart(tree) > boundary.getEnd());
  it('executes exact-owner refusal after ' + boundary.expression.getText(tree), async () => {
    expect(guard, 'every await needs its own revalidation').toBeDefined();
    const nextAwait = awaits.find((a) => a.getStart(tree) > boundary.getEnd());
    if (nextAwait) expect(guard!.getStart(tree)).toBeLessThan(nextAwait.getStart(tree));
    async function run(
      change: string,
      omitGuard = false,
      nullBoundary = false
    ): Promise<boolean | undefined> {
      const controller = {};
      const replacement = {};
      let discarded = 0,
        released = 0;
      const engine: any = {
        handController: controller,
        running: true,
        current: true,
        paused: false,
        isNextHandPaused() {
          return this.paused;
        },
        currentHandDealtStacks: new Map([['original', 1]]),
        handSpan: null,
        shadowRecorder: {},
        notifyBoundaryPauseWaiters() {
          discarded++;
        },
        terminal: false,
        lease: true,
        isCurrentEngine() {
          return this.current;
        },
        lifecycleCanMutate() {
          return this.running && !this.terminal && this.current && this.lease;
        },
      };
      const baseSource = readFileSync(join(here, 'ServerTableEngineBase.ts'), 'utf8');
      const baseTree = ts.createSourceFile('base.ts', baseSource, ts.ScriptTarget.Latest, true);
      const baseClass = baseTree.statements
        .filter(ts.isClassDeclaration)
        .find((c) => c.name?.text === 'ServerTableEngineBase')!;
      const discardMethod = baseClass.members.find(
        (m) => m.name?.getText(baseTree) === 'discardPreparedHandForPause'
      ) as ts.MethodDeclaration;
      engine.discardPreparedHandForPause = vm.runInNewContext(
        ts.transpileModule('(function() ' + discardMethod.body!.getText(baseTree) + ')', {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText
      );
      const changeOwner = () => {
        if (change === 'null') engine.handController = null;
        if (change === 'replacement') engine.handController = replacement;
        if (change === 'pausedReplacement') {
          engine.handController = replacement;
          engine.paused = true;
        }
        if (change === 'pausedOriginal') engine.paused = true;
        if (change === 'stopped') engine.running = false;
        if (change === 'superseded') engine.current = false;
        if (change === 'terminal') engine.terminal = true;
        if (change === 'lease') engine.lease = false;
      };
      const settle = async () => {
        await Promise.resolve();
        changeOwner();
        return {
          release() {
            released++;
          },
        };
      };
      engine.fetchTimeBankExtras = settle;
      engine.acquireFinancialControllerStart = settle;
      if (nullBoundary) {
        const base = readFileSync(join(here, 'ServerTableEngineBase.ts'), 'utf8');
        const ast = ts.createSourceFile('base.ts', base, ts.ScriptTarget.Latest, true);
        const cls = ast.statements
          .filter(ts.isClassDeclaration)
          .find((c) => c.name?.text === 'ServerTableEngineBase')!;
        const method = cls.members.find(
          (m) => m.name?.getText(ast) === 'acquireFinancialControllerStart'
        )!;
        const helper = ts.transpileModule(
          '(async function() ' + (method as ts.MethodDeclaration).body!.getText(ast) + ')',
          { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
        ).outputText;
        engine.acquireFinancialControllerStart = vm.runInNewContext(helper);
        Object.defineProperty(engine, 'financialPublicationBoundary', {
          get() {
            queueMicrotask(changeOwner);
            return null;
          },
        });
      }
      const isPublication = boundary.expression
        .getText(tree)
        .includes('acquireFinancialControllerStart');
      const pauseAt = SRC.indexOf(
        'if (this.discardPreparedHandForPause()) return;',
        guard!.getEnd()
      );
      expect(pauseAt).toBeGreaterThan(guard!.getEnd() - 1);
      const pause = SRC.slice(
        pauseAt,
        pauseAt + 'if (this.discardPreparedHandForPause()) return;'.length
      );
      const code = `(async function() { const preparedController = this.handController; const publicationStart = ${boundary.getText(tree)}; try { ${omitGuard ? '' : guard!.getText(tree)} ${pause} return true; } finally { ${isPublication ? 'publicationStart?.release();' : ''} } })`;
      const js = ts.transpileModule(code, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const fn = vm.runInNewContext(js, {
        hcPlayers: [],
        tbNewPlayers: [],
        handNumber: 1,
        console: { log() {} },
      });
      const result = await fn.call(engine);
      if (isPublication) expect(released).toBe(nullBoundary ? 0 : 1);
      if (change === 'pausedReplacement' && !omitGuard) {
        expect(engine.handController).toBe(replacement);
        expect(discarded).toBe(0);
        expect(engine.currentHandDealtStacks.size).toBe(1);
        expect(engine.shadowRecorder).not.toBeNull();
      }
      if (change === 'pausedReplacement' && omitGuard) {
        expect(engine.handController).toBeNull();
        expect(discarded).toBe(1);
      }
      if (change === 'pausedOriginal') {
        expect(engine.handController).toBeNull();
        expect(discarded).toBe(1);
      }
      return result;
    }
    expect(await run('current')).toBe(true);
    expect(await run('pausedOriginal')).toBeUndefined();
    expect(await run('pausedReplacement')).toBeUndefined();
    expect(await run('pausedReplacement', true)).toBeUndefined();
    for (const change of ['null', 'replacement', 'stopped', 'superseded', 'terminal', 'lease']) {
      expect(await run(change)).toBeUndefined();
      expect(await run(change, true), 'negative control must expose missing guard').toBe(true);
      if (boundary.expression.getText(tree).includes('acquireFinancialControllerStart')) {
        expect(await run(change, false, true)).toBeUndefined();
        expect(await run(change, true, true)).toBe(true);
      }
    }
  });
}
