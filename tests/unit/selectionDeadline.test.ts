import { expect, it, vi } from 'vitest';
import {
  observeBeforeSelectionDeadline,
  createSelectionObservation,
  SelectionObservationDeadline,
} from '../e2e/support/selectionDeadline';
import { readinessReadCanStart } from '../e2e/support/readinessReadAdmission';
import { OperationalPollFailure } from '../e2e/support/tournamentHudWitness';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function actualSelector(
  options: Record<string, unknown>,
  read: () => Promise<unknown>,
  poll: (operation: () => Promise<unknown>) => Promise<void>,
  classification = { verdict: 'absent', inScope: 0, runningShape: 0 }
) {
  const source = readFileSync('tests/e2e/production-live-table-realtime.spec.ts', 'utf8');
  const ast = ts.createSourceFile('selector.ts', source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'selectProgressingTournamentTable'
  )!;
  const absence = ast.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === 'AbsentCertifiableSubject'
  )!;
  const js = ts.transpileModule(`${absence.getText(ast)}; return (${node.getText(ast)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const globals = {
    CAUSAL_HAND_TIMEOUT_MS: 90000,
    remainingObservationMs: (deadline: number) => deadline - Date.now(),
    CLUB_ID: 'club',
    UNION_ID: 'union',
    createSelectionObservation,
    observeBeforeSelectionDeadline,
    readinessReadCanStart,
    readEngineHealth: read,
    OperationalPollFailure,
    SelectionObservationDeadline,
    EXPECTED_ENGINE_SHA: 'engine',
    MAX_GAMEPLAY_SILENCE_MS: 45000,
    MTT_HUD_LEVEL_CAP_MS: 1000,
    HUD_DISCOVERY_CANDIDATE_LIMIT: 32,
    expect: {
      poll: (operation: () => Promise<unknown>) => ({ toBeGreaterThan: () => poll(operation) }),
    },
    classifyMissingTournamentSubject: () => classification,
    healthyRunningTable: (_health: unknown, _id: unknown, _format: unknown) => ({}),
    selectableWhileRunning: () => true,
    mergeHudCandidateTableIds: (discovered: unknown[], scoped: unknown[]) => [
      ...discovered,
      ...scoped,
    ],
    orderByEndurance: (tables: unknown) => tables,
  };
  const selector = new Function(...Object.keys(globals), js)(...Object.values(globals));
  return () => selector({}, 'sng', { attach: vi.fn() }, { deadline: 90000, ...options });
}
const emptyHealth = { tableLiveness: [] };
const occupiedHealth = {
  tableLiveness: [{ tableId: 't', gameFormat: 'sng', clubId: 'club', seated: 2, dealable: 2 }],
};

it('actual initial selection deadline is UNKNOWN without fabricated empty health', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(948);
  const select = actualSelector(
    { deadline: 1000 },
    async () => {
      vi.mocked(Date.now).mockReturnValue(1001);
      throw Object.assign(new Error('apiRequestContext.get: Timeout 52ms exceeded.'), {
        name: 'TimeoutError',
      });
    },
    async () => {}
  );
  await expect(select()).rejects.toMatchObject({
    name: 'AbsentCertifiableSubject',
    evidence: { lastScopedHealth: null, classification: null },
    message: expect.stringContaining('unknown'),
  });
  vi.restoreAllMocks();
});
it.each(['AuthorizationError', 'IdentityMismatch'])(
  'actual initial late %s remains failure',
  async (name) => {
    vi.spyOn(Date, 'now').mockReturnValue(948);
    const error = Object.assign(new Error('refusal'), { name });
    const select = actualSelector(
      { deadline: 1000 },
      async () => {
        vi.mocked(Date.now).mockReturnValue(1001);
        throw error;
      },
      async () => {}
    );
    await expect(select()).rejects.toBe(error);
    vi.restoreAllMocks();
  }
);
it.each(['HUD discovery', 'board refinement'])(
  'actual entire poll preserves earlier %s failure at deadline',
  async (path) => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const refusal = new Error(`${path} permission failure`);
    let observations = 0;
    const options =
      path === 'HUD discovery'
        ? {
            hudReader: {
              discoverSelectableTableIds: async () => {
                if (++observations === 2) throw refusal;
                return [];
              },
              refusalEvidence: () => null,
            },
          }
        : {
            boardReader: {
              boardFacts: async () => {
                throw refusal;
              },
            },
          };
    let reads = 0;
    const select = actualSelector(
      options,
      async () => {
        ++reads;
        if (reads === 3) {
          vi.mocked(Date.now).mockReturnValue(89001);
          throw Object.assign(new Error('admitted final health timeout'), { name: 'TimeoutError' });
        }
        return path === 'board refinement' && reads === 2 ? occupiedHealth : emptyHealth;
      },
      async (operation) => {
        await expect(operation()).rejects.toBe(refusal);
        // A second admitted observation reaches its deadline; a scoped read
        // must not erase the earlier failure in a different part of the poll.
        await expect(operation()).rejects.toBe(refusal);
        vi.mocked(Date.now).mockReturnValue(90001);
        await expect(operation()).resolves.toBe(0);
        throw new Error('poll deadline');
      }
    );
    await expect(select()).rejects.toBe(refusal);
    vi.restoreAllMocks();
  }
);
it('actual known stalled subject stays failure when the final observation expires', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(100);
  const select = actualSelector(
    {},
    async () => emptyHealth,
    async (operation) => {
      vi.mocked(Date.now).mockReturnValue(90001);
      await expect(operation()).resolves.toBe(0);
      throw new Error('poll deadline');
    },
    {
      verdict: 'stalled',
      inScope: 1,
      runningShape: 1,
      stalled: [{ tableId: 't', dealable: 2, secsIdle: 91, loopPhase: 'stalled' }],
    } as never
  );
  await expect(select()).rejects.toThrow('have stopped dealing');
  vi.restoreAllMocks();
});
it('actual initial HUD deadline retains a genuine scoped stalled witness', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(100);
  const select = actualSelector(
    {
      deadline: 1000,
      hudReader: {
        discoverSelectableTableIds: async () => {
          vi.mocked(Date.now).mockReturnValue(1001);
          throw Object.assign(new Error('final HUD request timeout'), { name: 'TimeoutError' });
        },
        refusalEvidence: () => null,
      },
    },
    async () => occupiedHealth,
    async () => {},
    {
      verdict: 'stalled',
      inScope: 1,
      runningShape: 1,
      stalled: [{ tableId: 't', dealable: 2, secsIdle: 91, loopPhase: 'stalled' }],
    } as never
  );
  await expect(select()).rejects.toThrow('have stopped dealing');
  vi.restoreAllMocks();
});

it('actual earlier health timeout remains a failure at deadline', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(100);
  const refusal = Object.assign(new Error('early timeout'), { name: 'TimeoutError' });
  let reads = 0;
  const select = actualSelector(
    {},
    async () => {
      if (++reads > 1) throw refusal;
      return emptyHealth;
    },
    async (operation) => {
      await expect(operation()).rejects.toBe(refusal);
      vi.mocked(Date.now).mockReturnValue(90001);
      await expect(operation()).resolves.toBe(0);
      throw new Error('poll deadline');
    }
  );
  await expect(select()).rejects.toBe(refusal);
  vi.restoreAllMocks();
});

it('actual admitted complete observation timing out at its deadline remains UNKNOWN', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(100);
  let reads = 0;
  const select = actualSelector(
    {},
    async () => {
      if (++reads === 1) return emptyHealth;
      vi.mocked(Date.now).mockReturnValue(90001);
      throw Object.assign(new Error('apiRequestContext.get: Timeout 15000ms exceeded.'), {
        name: 'TimeoutError',
      });
    },
    async (operation) => {
      await expect(operation()).rejects.toBeInstanceOf(SelectionObservationDeadline);
      throw new Error('poll deadline');
    }
  );
  await expect(select()).rejects.toMatchObject({
    name: 'AbsentCertifiableSubject',
    message: expect.stringContaining('unknown'),
  });
  expect(reads).toBe(2);
  vi.restoreAllMocks();
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
  let now = 999;
  const error = new Error('HTTP 403');
  await expect(
    observeBeforeSelectionDeadline(
      1000,
      async () => {
        now = 1001;
        throw error;
      },
      () => now
    )
  ).rejects.toBe(error);
});
