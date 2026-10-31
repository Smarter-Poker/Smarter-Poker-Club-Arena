import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readinessReadCanStart,
  READINESS_HEALTH_READ_MS,
} from '../e2e/support/readinessReadAdmission';
import { OperationalPollFailure } from '../e2e/support/tournamentHudWitness';

const now = 1_791_918_724_814;

describe('live-table readiness starts only admitted health reads', () => {
  it('rejects the original 52ms request rather than blaming transport', () => {
    const deadline = now + 52;
    expect(Math.max(1, Math.min(15_000, Math.floor(deadline - now)))).toBe(52);
    expect(readinessReadCanStart(deadline, now)).toBe(false);
  });

  it('preserves the existing full request budget and the fixed deadline', () => {
    expect(READINESS_HEALTH_READ_MS).toBe(15_000);
    expect(readinessReadCanStart(now + 15_000, now)).toBe(true);
    expect(readinessReadCanStart(now + 14_999, now)).toBe(false);
    expect(readinessReadCanStart(now + 90_000, now)).toBe(true);
    expect(readinessReadCanStart(now, now)).toBe(false);
    expect(readinessReadCanStart(now - 1, now)).toBe(false);
    expect(readinessReadCanStart(Infinity, now)).toBe(false);
    expect(readinessReadCanStart(NaN, now)).toBe(false);
  });

  it('cannot clear a genuine failed read when a later callback is not admitted', async () => {
    const failure = new OperationalPollFailure();
    const transportError = new Error('genuine complete-budget transport refusal');
    await expect(
      failure.attempt(async () => {
        throw transportError;
      })
    ).rejects.toBe(transportError);
    let reads = 0;
    const lateCallback = async () => {
      if (!readinessReadCanStart(now + 52, now)) return 0;
      return failure.attempt(async () => {
        reads++;
        return 0;
      });
    };
    expect(await lateCallback()).toBe(0);
    expect(reads).toBe(0);
    expect(() => failure.rethrowIfPresent()).toThrow(transportError);
  });

  it('wires admission before the operational wrapper in the real unchanged-budget poll', () => {
    const spec = readFileSync(
      join(__dirname, '../e2e/production-live-table-realtime.spec.ts'),
      'utf8'
    );
    const start = spec.indexOf('const readinessPollBudgetMs = pollBudgetMs();');
    const readiness = spec.slice(start, spec.indexOf('let after = before;', start));
    expect(readiness).toContain('if (!readinessReadCanStart(readinessReadDeadline)) return 0;');
    expect(readiness.indexOf('if (!readinessReadCanStart')).toBeLessThan(
      readiness.indexOf('operationalPollFailure.attempt')
    );
    expect(readiness).toContain('timeout: readinessPollBudgetMs');
    expect(readiness).toContain('operationalPollFailure.rethrowIfPresent();');
    expect(readiness).toContain("classification.verdict === 'stalled'");
    expect(readiness).toContain('throw new AbsentCertifiableSubject(');
  });
});

// Exercise the real progress block, including its admission and late-result
// guard, without a live engine or a production mutation.
import ts from 'typescript';
import { createProgressSilenceGuard } from '../e2e/support/progressSilence';
import { refreshPreNavigationSelection, nextHandAdvanced } from '../e2e/support/preNavigationBoard';
import { SelectionObservationDeadline } from '../e2e/support/selectionDeadline';
import { readinessReadTimeout } from '../e2e/support/readinessReadAdmission';
import { vi } from 'vitest';

function actualProgress(
  boardReader: Record<string, unknown> | undefined,
  read: (...args: unknown[]) => Promise<unknown>,
  poll: (callback: () => Promise<unknown> | boolean) => Promise<void>
) {
  const source = readFileSync(
    join(__dirname, '../e2e/production-live-table-realtime.spec.ts'),
    'utf8'
  );
  const start = source.indexOf('  const progressDeadline =');
  const end = source.indexOf('  if (!beforeTable || !afterTable)', start);
  const code = ts.transpileModule(
    `return async () => {
    let baselines = [{ tableId: 't', handCount: 1 }];
    let beforeTable = null, afterTable = null;
    let acceptedFacts = null, healthRead, before, lastScopedHealth;
    let after = { tableLiveness: [] };
    const excluded = new Set();
    ${source.slice(start, end)}
    return {beforeTable, afterTable};
  }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  const globals = {
    request: {},
    options: { deadline: 90_000, boardReader },
    pollBudgetMs: () => 90_000,
    readinessReadCanStart,
    readinessReadTimeout,
    OperationalPollFailure,
    operationalPollFailure: new OperationalPollFailure(),
    SelectionObservationDeadline,
    refreshPreNavigationSelection,
    readinessObservation: async () => {
      throw new Error('unexpected readmission');
    },
    readEngineHealth: read,
    healthyRunningTable: (health: { tableLiveness: unknown[] }) => health.tableLiveness[0],
    nextHandAdvanced,
    selectableWhileRunning: () => true,
    endedBeforeNextHand: () => false,
    continuouslyActive: createProgressSilenceGuard(45_000),
    gameFormat: 'mtt',
    CAUSAL_HAND_TIMEOUT_MS: 90_000,
    expect: {
      poll: (callback: () => Promise<unknown> | boolean) => ({ toBe: () => poll(callback) }),
    },
  };
  return new Function(...Object.keys(globals), code)(...Object.values(globals))();
}

it('actual progress callback refuses a late 14999ms read without clearing a prior failure', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(0);
  const refusal = new Error('poll deadline');
  const read = vi.fn();
  const result = actualProgress(undefined, read, async (callback) => {
    vi.mocked(Date.now).mockReturnValue(74_001);
    expect(await callback()).toBe(false);
    throw refusal;
  });
  await expect(result).rejects.toBe(refusal);
  expect(read).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

it('actual progress reads pass the inner deadline through every board read and reject late proof', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(0);
  const boardFacts = vi.fn(
    async (_ids: string[], _deadline?: number) => new Map([['t', { tableId: 't' }]])
  );
  const read = vi.fn(async (_request: unknown, _scope: unknown, timeout: unknown) => {
    expect(timeout).toBe(15_000);
    return { tableLiveness: [{ tableId: 't', handCount: 2, msSinceProgress: 0 }] };
  });
  const result = actualProgress({ boardFacts }, read, async (callback) => {
    expect(await callback()).toBe(true);
  });
  await expect(result).resolves.toMatchObject({
    beforeTable: { handCount: 1 },
    afterTable: { handCount: 2 },
  });
  expect(boardFacts.mock.calls).toHaveLength(3);
  for (const call of boardFacts.mock.calls) expect(call).toEqual([['t'], 89_000]);
  vi.restoreAllMocks();
});

it('actual progress cannot accept a health result delivered after the unchanged deadline', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(0);
  const read = vi.fn(async () => {
    vi.mocked(Date.now).mockReturnValue(89_001);
    return { tableLiveness: [{ tableId: 't', handCount: 2, msSinceProgress: 0 }] };
  });
  await expect(
    actualProgress(undefined, read, async (callback) => {
      await callback();
    })
  ).rejects.toBeInstanceOf(SelectionObservationDeadline);
  vi.restoreAllMocks();
});

it('the complete Diamond catalogue receives a finite count-derived budget in both orientations', () => {
  const source = readFileSync(join(__dirname, '../e2e/diamond-arena-route.spec.ts'), 'utf8');
  const ast = ts.createSourceFile('diamond.ts', source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'arenaDoorBudgetMs'
  )!;
  const code = ts.transpileModule(`return (${node.getText(ast)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const budget = new Function(code)();
  expect(budget(0)).toBe(30_000);
  expect(budget(61)).toBe(91_000);
  expect(budget(406)).toBe(436_000);
  expect(budget(690)).toBe(720_000);
  expect(() => budget(691)).toThrow('exceeds');
  expect(() => budget(-1)).toThrow('exceeds');
  expect(source).toContain('for (const card of cashCatalogue)');
  expect(source).toContain('for (const card of tournamentCatalogue)');
  expect(source).toContain('arenaDoorBudgetMs(cashCatalogue.length + tournamentCatalogue.length)');
  expect(source).toContain('for (const [orientation, viewport] of ORIENTATIONS)');
});

it('an admitted progress failure is not cleared by a later unadmitted callback', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(0);
  const refusal = new Error('HTTP 403');
  const read = vi.fn(async () => {
    throw refusal;
  });
  await expect(
    actualProgress(undefined, read, async (callback) => {
      await expect(callback()).rejects.toBe(refusal);
      vi.mocked(Date.now).mockReturnValue(74_001);
      expect(await callback()).toBe(false);
      throw new Error('poll expired');
    })
  ).rejects.toBe(refusal);
  expect(read).toHaveBeenCalledTimes(1);
  vi.restoreAllMocks();
});

it('every chained request preserves the full transport budget or refuses to start', () => {
  expect(readinessReadTimeout(15_000, 0)).toBe(15_000);
  expect(() => readinessReadTimeout(15_000, 1)).toThrow(SelectionObservationDeadline);
  expect(readinessReadTimeout()).toBe(15_000);
});
