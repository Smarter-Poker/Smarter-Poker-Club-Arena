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
import { CooperativeHandPause } from './CooperativeHandPause.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, 'ServerTableEngineDealing.ts'), 'utf8');

describe('dealHand re-reads the controller after every preparation await', () => {
  const construct = SRC.indexOf('this.handController = new HandController(');
  const awaitAt = SRC.indexOf('const [tbExtras, autoPreferences] = await Promise.all([', construct);
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
const runnerCall = SRC.indexOf('await this.runOriginalController(', begin);
const runner = SRC.indexOf('protected async runOriginalController(', runnerCall);
const preparationEnd = SRC.lastIndexOf('const attempt =', runnerCall);
const awaits: ts.AwaitExpression[] = [];
const guards: ts.IfStatement[] = [];
const calls: ts.CallExpression[] = [];
function visit(node: ts.Node): void {
  // The original wait/start owner is shared with recovery. Follow its actual
  // call rather than treating dealHand's subsequent cancellation/finally as
  // preparation just because it is lexically before the extracted method.
  if (
    (node.getStart(tree) >= begin && node.getEnd() <= preparationEnd) ||
    (node.getStart(tree) >= runner && node.getEnd() <= finish)
  ) {
    if (ts.isAwaitExpression(node)) awaits.push(node);
    if (ts.isCallExpression(node)) calls.push(node);
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(tree).includes('this.handController !== preparedController')
    )
      guards.push(node);
  }
  ts.forEachChild(node, visit);
}
visit(tree);
it('the normal deal invokes the same exact controller runner after preparation', () => {
  expect(preparationEnd).toBeGreaterThan(begin);
  expect(runnerCall).toBeGreaterThan(preparationEnd);
  expect(runner).toBeGreaterThan(runnerCall);
  expect(SRC.slice(runnerCall, SRC.indexOf(');', runnerCall))).toContain('preparedController');
});
for (const boundary of awaits) {
  const guard = guards.find((g) => g.getStart(tree) > boundary.getEnd());
  it('executes exact-owner refusal after ' + boundary.expression.getText(tree), async () => {
    expect(guard, 'every await needs its own revalidation').toBeDefined();
    // A cooperative wait may precede the final publication guard, but no
    // public actuation or replacement-controller mutation may pass it.
    for (const wait of awaits.filter(
      (a) => a.getStart(tree) > boundary.getEnd() && a.getStart(tree) < guard!.getStart(tree)
    ))
      expect([
        'this.weeklyHandPause.checkpoint()',
        'this.acquireFinancialControllerStart()',
        'this.awaitPauseGate()',
      ]).toContain(wait.expression.getText(tree));
    for (const call of calls.filter(
      (c) => c.getStart(tree) >= boundary.getEnd() && c.getEnd() <= guard!.getStart(tree)
    ))
      expect(call.expression.getText(tree)).not.toMatch(
        /(?:\.start|\.onEvent|this\.discardPreparedHandForPause|this\.markRetainedPreparedOriginal)$/
      );
    async function run(
      change: string,
      omitGuard = false,
      nullBoundary = false
    ): Promise<boolean | undefined> {
      const controller = { serializeRecoveryState: () => 'retained' };
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
      engine.retainOriginalBatch = settle;
      engine.awaitPauseGate = settle;
      engine.weeklyHandPause = { checkpoint: settle };
      engine.captureContinuationEngine = () => ({});
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
      const pauseText =
        boundary.getStart(tree) >= runner
          ? 'if (!original && this.discardPreparedHandForPause()) return;'
          : 'if (this.discardPreparedHandForPause()) return;';
      const pauseAt = SRC.indexOf(pauseText, guard!.getEnd());
      expect(pauseAt).toBeGreaterThan(guard!.getEnd() - 1);
      const pause = SRC.slice(pauseAt, pauseAt + pauseText.length);
      const code = `(async function() { const original = false; const seats=[]; const preparedController = this.handController; const publicationStart = ${boundary.getText(tree)}; try { ${omitGuard ? '' : guard!.getText(tree)} ${pause} return true; } finally { ${isPublication ? 'publicationStart?.release();' : ''} } })`;
      const js = ts.transpileModule(code, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const fn = vm.runInNewContext(js, {
        hcPlayers: [],
        tbNewPlayers: [],
        preferenceIds: [],
        preparedBatch: { controller: 'retained' },
        readAutoTimeBankPreferences: async () => {
          await settle();
          return new Map();
        },
        reportError() {},
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

// Run the actual original wait loop, not a linear approximation of its awaits.
const publicationAt = SRC.indexOf(
  'const publicationStart = await this.acquireFinancialControllerStart();',
  runner
);
const originalWaitAt = SRC.lastIndexOf('    if (original) {', publicationAt);
const finalGuard = guards.find((g) => g.getStart(tree) > publicationAt)!;
const originalWait = SRC.slice(originalWaitAt, finalGuard.getEnd());
for (const owner of ['weekly', 'physical'] as const) {
  it(`the actual original ${owner} wait retains exact ownership through release and stop`, async () => {
    expect(originalWaitAt).toBeGreaterThan(runner);
    expect(originalWait).toContain('for (;;)');
    expect(originalWait).toContain('continue;');
    expect(finalGuard.getStart(tree)).toBeLessThan(finish);
    async function run(change: string, omitGuard = false) {
      const weekly = new CooperativeHandPause();
      if (owner === 'weekly') weekly.hold('weekly-owner');
      let physicalHeld = owner === 'physical';
      let wakePhysical: (() => void) | undefined;
      let publications = 0,
        released = 0,
        settled = false;
      const preparedController = { pauseForWeeklyPayout() {} };
      const replacement = {};
      const engine = {
        handController: preparedController as object | null,
        running: true,
        current: true,
        lease: true,
        terminal: false,
        weeklyHandPause: weekly,
        weeklyPayoutPauseOwners: new Set(['weekly-owner']),
        handForHandPaused: false,
        isCurrentEngine() {
          return this.current;
        },
        lifecycleCanMutate() {
          return this.running && this.current && this.lease && !this.terminal;
        },
        isHandForHandReleaseBlocked() {
          return physicalHeld;
        },
        awaitPauseGate() {
          return new Promise<void>((resolve) => {
            wakePhysical = resolve;
          });
        },
        async acquireFinancialControllerStart() {
          return {
            release() {
              released++;
            },
          };
        },
      };
      const block = omitGuard ? originalWait.replace(finalGuard.getText(tree), '') : originalWait;
      const js = ts.transpileModule(
        `(async function() {
        // This extracted ownership test exercises the retained PREPARED path.
        // Already-started recovery is covered with real controllers/managers.
        const original = true, recovered = undefined, resumesStartedOriginal = false;
        ${block}
        publish(); return true;
        } finally { publicationStart?.release(); }
      })`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
      ).outputText;
      const fn = vm.runInNewContext(js, {
        preparedController,
        publish() {
          publications++;
        },
      });
      const result = fn.call(engine).then((value: boolean | undefined) => {
        settled = true;
        return value;
      });
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(settled).toBe(false);
      expect(publications).toBe(0);
      if (owner === 'physical') expect(wakePhysical).toBeTypeOf('function');
      if (change === 'null') engine.handController = null;
      if (change === 'replacement') engine.handController = replacement;
      if (change === 'stopped') {
        engine.running = false;
        weekly.stop();
      }
      if (change === 'superseded') engine.current = false;
      if (change === 'lease') engine.lease = false;
      if (change === 'terminal') engine.terminal = true;
      if (owner === 'weekly') weekly.release('weekly-owner');
      else {
        physicalHeld = false;
        wakePhysical!();
      }
      const actual = await result;
      expect(actual).toBe(change === 'current' || omitGuard ? true : undefined);
      expect(publications).toBe(change === 'current' || omitGuard ? 1 : 0);
      expect(released).toBe(owner === 'weekly' && change === 'stopped' ? 0 : 1);
      if (change === 'replacement') expect(engine.handController).toBe(replacement);
    }
    for (const change of [
      'current',
      'null',
      'replacement',
      'stopped',
      'superseded',
      'lease',
      'terminal',
    ])
      await run(change);
    await run('replacement', true);
  });
}
