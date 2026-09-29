import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function actualBootstrap(leader: boolean, stop: () => Promise<void>) {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const declarations = ast.statements.filter(
    (s) =>
      ts.isFunctionDeclaration(s) &&
      ['startLeaderOwnedServices', 'stopLeaderOwnedServices'].includes(s.name?.text ?? '')
  );
  expect(declarations).toHaveLength(2);
  const js = ts.transpileModule(declarations.map((s) => s.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const worker = { start: vi.fn(), stop: vi.fn(stop) };
  const context: Record<string, unknown> = {
    console: { log: vi.fn() },
    gameServer: {
      start: async () => undefined,
      isLeaderBooted: () => leader,
      getTableEngine: vi.fn(),
    },
    horseAdaptiveJournalWorker: worker,
    trackLeaderBootMutation: vi.fn(),
    leaderLifecycleIsCurrent: () => true,
    sweepIncompleteHorses: async () => undefined,
    drainLeaderBootMutations: async () => undefined,
    startHorseOverlayGuard: () => ({ stop: async () => undefined }),
    HorseSessionRotator: class {
      start() {}
      async stop() {}
    },
    StableHandExecutor: class {
      start() {}
      async stop() {}
    },
  };
  for (const name of [
    'HorseSelfTuner',
    'HorseLeague',
    'HorseDailyAudit',
    'BrainTelemetryFlush',
    'HorseDataLedgerSync',
    'HorseLaneLoader',
    'GtoAggregationDriver',
    'GtoAggregationDriverV31',
    'CommerceRenewalConsumer',
  ]) {
    context['start' + name] = vi.fn();
    context['stop' + name] = async () => undefined;
  }
  const controls = runInNewContext(
    `let shuttingDown=false,leaderServicesActive=false,leaderLifecycleGeneration=0,leaderStopOperation=null;
    let horseOverlayGuard=null,horseSessionRotator=null,stableHandExecutor=null;
    ${js};({start:startLeaderOwnedServices,stop:stopLeaderOwnedServices})`,
    context
  ) as { start: () => Promise<void>; stop: () => Promise<void> };
  return { worker, ...controls };
}
describe('actual leader bootstrap owns isolated journal', () => {
  it('starts no journal worker on standby', async () => {
    const b = actualBootstrap(false, async () => undefined);
    await b.start();
    await b.stop();
    expect(b.worker.start).not.toHaveBeenCalled();
    expect(b.worker.stop).not.toHaveBeenCalled();
  });
  it('joins the real journal stop before certifying external ownership release', async () => {
    let release!: () => void;
    const b = actualBootstrap(
      true,
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    await b.start();
    expect(b.worker.start).toHaveBeenCalledTimes(1);
    const stop = b.stop();
    expect(b.stop()).toBe(stop);
    let finished = false;
    void stop.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(b.worker.stop).toHaveBeenCalledTimes(1);
    release();
    await stop;
    expect(finished).toBe(true);
  });
  it('keeps a rejected journal shutdown in the ownership certificate', async () => {
    const b = actualBootstrap(true, async () => {
      throw Error('termination unconfirmed');
    });
    await b.start();
    await expect(b.stop()).rejects.toThrow(
      'index-owned service(s) did not certify shutdown ownership'
    );
    await expect(b.stop()).rejects.toThrow(
      'index-owned service(s) did not certify shutdown ownership'
    );
    expect(b.worker.stop).toHaveBeenCalledTimes(1);
  });
});
