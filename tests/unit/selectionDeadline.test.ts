import { expect, it, vi } from 'vitest';
import {
  observeBeforeSelectionDeadline,
  SelectionObservationDeadline,
} from '../e2e/support/selectionDeadline';
import { OperationalPollFailure } from '../e2e/support/tournamentHudWitness';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function actualSelectorRead(
  read: () => Promise<unknown>,
  now: () => number,
  source = readFileSync('tests/e2e/production-live-table-realtime.spec.ts', 'utf8')
) {
  const ast = ts.createSourceFile('selector.ts', source, ts.ScriptTarget.Latest, true);
  let arrow = '';
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'readCandidateHealth')
      arrow = node.initializer!.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const js = ts.transpileModule(
    `let precedingHealthReadFailure: unknown = null; return (${arrow});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  return new Function(
    'options',
    'Date',
    'pollBudgetMs',
    'remainingObservationMs',
    'readEngineHealth',
    'request',
    'gameFormat',
    'observeBeforeSelectionDeadline',
    'SelectionObservationDeadline',
    js
  )(
    { deadline: 1000 },
    { now },
    () => 90000,
    (deadline: number) => deadline - now(),
    read,
    {},
    'sng',
    <T>(deadline: number, call: () => Promise<T>) =>
      observeBeforeSelectionDeadline(deadline, call, now),
    SelectionObservationDeadline
  );
}

it('executes the actual selector boundary and retains a preceding failed read', async () => {
  let now = 100;
  const early = Object.assign(new Error('early timeout'), { name: 'TimeoutError' });
  const selector = actualSelectorRead(
    async () => {
      throw early;
    },
    () => now
  );
  await expect(selector(1000)).rejects.toBe(early);
  now = 1001;
  await expect(selector(1000)).rejects.toBe(early);
});
it('executes the actual selector final request as unknown rather than fabricated health', async () => {
  let now = 948;
  const selector = actualSelectorRead(
    async () => {
      now = 1001;
      throw Object.assign(new Error('52ms'), { name: 'TimeoutError' });
    },
    () => now
  );
  await expect(selector(1000)).rejects.toBeInstanceOf(SelectionObservationDeadline);
});

it('the final 52ms request reaching the deadline records unknown observation', async () => {
  let now = 948;
  const error = Object.assign(new Error('apiRequestContext.get: Timeout 52ms exceeded.'), {
    name: 'TimeoutError',
  });
  await expect(
    observeBeforeSelectionDeadline(
      1000,
      async () => {
        now = 1001;
        throw error;
      },
      () => now
    )
  ).rejects.toBeInstanceOf(SelectionObservationDeadline);
});
it('does not launch an already expired read or invent empty health', async () => {
  const read = vi.fn();
  await expect(observeBeforeSelectionDeadline(1000, read, () => 1000)).rejects.toBeInstanceOf(
    SelectionObservationDeadline
  );
  expect(read).not.toHaveBeenCalled();
});
it.each(['TimeoutError', 'AuthorizationError', 'StalledTable', 'IdentityMismatch'])(
  'preserves early %s as a real operational failure',
  async (name) => {
    const error = Object.assign(new Error('refusal'), { name });
    const tracker = new OperationalPollFailure();
    await expect(
      tracker.attempt(() =>
        observeBeforeSelectionDeadline(
          1000,
          async () => {
            throw error;
          },
          () => 100
        )
      )
    ).rejects.toBe(error);
    expect(() => tracker.rethrowIfPresent()).toThrow(error);
  }
);
it('preserves non-timeout refusal even when the deadline expires', async () => {
  const error = new Error('HTTP 403');
  await expect(
    observeBeforeSelectionDeadline(
      1000,
      async () => {
        throw error;
      },
      () => 999
    )
  ).rejects.toBe(error);
});
