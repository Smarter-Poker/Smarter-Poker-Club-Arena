import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The selector is a plain ES module script with no emitted declaration.
import * as selector from '../../../scripts/phase6d-population.mjs';
const {
  CHAIN_LINKS,
  admitChain,
  assembleChain,
  cellKey,
  cellStatus,
  classifyDecision,
  createPopulation,
  declaredCells,
  enforceDeclaration,
  loadDeclaration,
  requestFromDeclaration,
  requestFromReport,
  serializePopulation,
  strataCount,
  validateDeclaration,
} = selector;

const declarationPath = new URL(
  '../../../../docs/evidence/phase6d/population-declaration-2026-09-26.json',
  import.meta.url
).pathname;

const loaded = loadDeclaration(declarationPath);
const exactRequest = () => ({
  declarationDigest: loaded.digest,
  window: { ...loaded.declaration.window },
  targetPerCell: loaded.declaration.population.targetPerCell,
  handsPerStratum: loaded.declaration.selection.handsPerStratum,
  releases: loaded.declaration.admittedReleases.map((r: { sha: string }) => r.sha),
  servingRelease: loaded.declaration.servingRelease.sha,
});

describe('Phase 6D declaration enforcement', () => {
  it('binds the committed declaration by its exact bytes', () => {
    const digest = createHash('sha256').update(readFileSync(declarationPath)).digest('hex');
    expect(loaded.digest).toBe(digest);
    expect(validateDeclaration(loaded.declaration)).toBe(true);
    expect(loaded.declaration.window.endMs - loaded.declaration.window.startMs).toBe(86_400_000);
  });

  it('enumerates exactly the declared finite cell set', () => {
    const cells = declaredCells(loaded.declaration);
    expect(cells.size).toBe(3969);
    expect(cells.has('cash|none|6|none|normal')).toBe(true);
    expect(cells.has('cash|open_facing|6|none|normal')).toBe(false);
    expect(cells.has('mtt|open_facing|9|big_blind|bypass')).toBe(true);
    expect(cells.has('mtt|open_facing|11|big_blind|bypass')).toBe(false);
  });

  it('accepts a run that restates the declaration and refuses every drift', () => {
    expect(enforceDeclaration(loaded, exactRequest())).toBe(true);
    const shifted = exactRequest();
    shifted.window.startMs += 1;
    expect(() => enforceDeclaration(loaded, shifted)).toThrow(/window differs/);
    const widened = exactRequest();
    widened.window.endMs += 3_600_000;
    expect(() => enforceDeclaration(loaded, widened)).toThrow(/window differs/);
    const other = exactRequest();
    other.declarationDigest = 'f'.repeat(64);
    expect(() => enforceDeclaration(loaded, other)).toThrow(/digest changed/);
    const extra = exactRequest();
    extra.releases.push('0'.repeat(40));
    expect(() => enforceDeclaration(loaded, extra)).toThrow(/not admitted/);
    const target = exactRequest();
    target.targetPerCell = 30;
    expect(() => enforceDeclaration(loaded, target)).toThrow(/target differs/);
  });

  it('refuses to overwrite a report written under another window, target or release set', () => {
    expect(enforceDeclaration(loaded, requestFromDeclaration(loaded))).toBe(true);
    const prior = {
      declaration: { sha256: loaded.digest },
      window: { ...loaded.declaration.window },
      targetPerCell: loaded.declaration.population.targetPerCell,
      handsPerStratum: loaded.declaration.selection.handsPerStratum,
      admittedReleases: loaded.declaration.admittedReleases.map((r: { sha: string }) => r.sha),
      servingRelease: loaded.declaration.servingRelease.sha,
    };
    expect(enforceDeclaration(loaded, requestFromReport(prior))).toBe(true);
    const moved = {
      ...prior,
      window: {
        startMs: prior.window.startMs + 86_400_000,
        endMs: prior.window.endMs + 86_400_000,
      },
    };
    expect(() => enforceDeclaration(loaded, requestFromReport(moved))).toThrow(/window differs/);
    expect(() =>
      enforceDeclaration(loaded, requestFromReport({ ...prior, targetPerCell: 5 }))
    ).toThrow(/target differs/);
    expect(() =>
      enforceDeclaration(
        loaded,
        requestFromReport({
          ...prior,
          admittedReleases: [...prior.admittedReleases, '1'.repeat(40)],
        })
      )
    ).toThrow(/not admitted/);
    expect(() =>
      enforceDeclaration(
        loaded,
        requestFromReport({ ...prior, declaration: { sha256: '0'.repeat(64) } })
      )
    ).toThrow(/digest changed/);
    expect(() => enforceDeclaration(loaded, requestFromReport({}))).toThrow(/Phase 6D run refused/);
  });

  it('refuses an undeclared cell and never creates it', () => {
    const population = createPopulation(loaded);
    const before = population.cells.size;
    const result = admitChain(population, {
      cell: { format: 'cash', branch: 'open_facing', size: 6, anteMode: 'none', path: 'normal' },
      sourceRelease: loaded.declaration.servingRelease.sha,
      complete: true,
      links: {},
    });
    expect(result).toMatchObject({ admitted: false, reason: 'undeclared_cell' });
    expect(population.cells.size).toBe(before);
    expect(population.chains).toHaveLength(0);
    expect(population.rejected.undeclared_cell).toBe(1);
    const unclassified = admitChain(population, { rejectReason: 'unclassified_path' });
    expect(unclassified.admitted).toBe(false);
    expect(population.rejected['unclassified:unclassified_path']).toBe(1);
  });

  it('marks every untouched cell unobserved and counts overflow past the target', () => {
    const population = createPopulation(loaded);
    for (const cell of population.cells.values()) expect(cellStatus(cell)).toBe('unobserved');
    const cell = {
      format: 'mtt',
      branch: 'unopened',
      size: 9,
      anteMode: 'per_player',
      path: 'normal',
    };
    const chain = {
      cell,
      sourceRelease: loaded.declaration.servingRelease.sha,
      complete: false,
      links: {},
    };
    for (let i = 0; i < loaded.declaration.population.targetPerCell + 2; i++)
      admitChain(population, chain);
    const stored = population.cells.get(cellKey(cell))!;
    expect(stored.observed).toBe(loaded.declaration.population.targetPerCell);
    expect(stored.overflow).toBe(2);
    expect(cellStatus(stored)).toBe(`observed ${stored.target}/${stored.target}`);
    const serialized = serializePopulation(population);
    const cells: Array<{ observed: number; status: string }> = Object.values(serialized.cells);
    expect(cells.filter((c) => c.observed > 0)).toHaveLength(1);
    expect(cells.filter((c) => c.status === 'unobserved')).toHaveLength(3968);
    expect(serialized.perRelease[loaded.declaration.servingRelease.sha]).toEqual({
      decisions: 5,
      admitted: 3,
      complete: 0,
    });
  });

  it('classifies by the declared rules and rejects what the declaration does not cover', () => {
    const declaration = loaded.declaration;
    const cash = classifyDecision({
      snapshot: {
        gameState: { stage: 'preflop', gameMode: 'cash', players: [{}, {}, {}, {}, {}, {}] },
      },
      decision: {
        tournamentPreflopAttribution: {
          status: 'unavailable',
          route: 'intent_engine',
          reason: 'outside_tournament',
          lookup: null,
        },
      },
      witness: null,
      acceptedOrigin: 'horse_policy',
      declaration,
    });
    expect(cash.cell).toEqual({
      format: 'cash',
      branch: 'none',
      size: 6,
      anteMode: 'none',
      path: 'normal',
    });
    const atlas = classifyDecision({
      snapshot: {
        gameState: { stage: 'preflop', gameMode: 'tournament', format: 'mtt', players: [] },
      },
      decision: {
        tournamentPreflopAttribution: {
          status: 'atlas_evaluated',
          route: 'intent_engine',
          reason: 'atlas_forwarded',
          lookup: { coordinate: { branch: 'open_facing', tableSize: 8, anteType: 'big_blind' } },
        },
      },
      witness: null,
      acceptedOrigin: 'horse_policy',
      declaration,
    });
    expect(atlas.cell).toEqual({
      format: 'mtt',
      branch: 'open_facing',
      size: 8,
      anteMode: 'big_blind',
      path: 'normal',
    });
    const bypass = classifyDecision({
      snapshot: {
        gameState: {
          stage: 'preflop',
          gameMode: 'tournament',
          format: 'sng',
          tournament: { playersAtTable: 6, anteType: 'per_player' },
        },
      },
      decision: {
        tournamentPreflopAttribution: {
          status: 'bypassed',
          route: 'chart_open_jam',
          reason: 'chart_return',
          lookup: null,
        },
      },
      witness: null,
      acceptedOrigin: 'horse_policy',
      declaration,
    });
    expect(bypass.cell).toEqual({
      format: 'sng',
      branch: 'none',
      size: 6,
      anteMode: 'per_player',
      path: 'bypass',
    });
    const fallback = classifyDecision({
      snapshot: {
        gameState: {
          stage: 'preflop',
          gameMode: 'tournament',
          format: 'mtt',
          tournament: { playersAtTable: 9, anteType: 'none' },
        },
      },
      decision: {
        tournamentPreflopAttribution: {
          status: 'unavailable',
          route: 'intent_engine',
          reason: 'incomplete_context',
          lookup: null,
        },
      },
      witness: null,
      acceptedOrigin: 'horse_policy',
      declaration,
    });
    expect(fallback.cell?.path).toBe('fallback');
    const exception = classifyDecision({
      snapshot: { gameState: { stage: 'preflop', gameMode: 'cash', players: [{}, {}] } },
      decision: { policyFallback: 'brain_exception' },
      witness: null,
      acceptedOrigin: null,
      declaration,
    });
    expect(exception.cell?.path).toBe('fallback');
    expect(
      classifyDecision({
        snapshot: { gameState: { stage: 'flop' } },
        decision: {},
        witness: null,
        acceptedOrigin: null,
        declaration,
      })
    ).toEqual({ rejectReason: 'postflop' });
    expect(
      classifyDecision({
        snapshot: { gameState: { stage: 'preflop', gameMode: 'cash', players: [] } },
        decision: {},
        witness: null,
        acceptedOrigin: null,
        declaration,
      }).rejectReason
    ).toBe('unclassified_path');
    const eleven = classifyDecision({
      snapshot: {
        gameState: { stage: 'preflop', gameMode: 'tournament', format: 'mtt', players: [] },
      },
      decision: {
        tournamentPreflopAttribution: {
          status: 'atlas_evaluated',
          route: 'intent_engine',
          reason: 'atlas_forwarded',
          lookup: { coordinate: { branch: 'unopened', tableSize: 11, anteType: 'none' } },
        },
      },
      witness: null,
      acceptedOrigin: null,
      declaration,
    });
    expect(eleven.rejectReason).toBe('undeclared_cell');
  });
});

describe('Phase 6D serving-release declaration of 2026-09-27', () => {
  const servingPath = new URL(
    '../../../../docs/evidence/phase6d/population-declaration-2026-09-27.json',
    import.meta.url
  ).pathname;
  const serving = loadDeclaration(servingPath);

  it('admits the serving release only, over a window from its start minute', () => {
    const d = serving.declaration;
    expect(d.admittedReleases.map((r: { sha: string }) => r.sha)).toEqual([
      '6b6eabb1b169aed14fcb9fbd0ae54ee2bc42b2d4',
    ]);
    expect(d.servingRelease.sha).toBe('6b6eabb1b169aed14fcb9fbd0ae54ee2bc42b2d4');
    expect(d.window.start).toBe('2026-09-27T16:06:00Z');
    expect(d.window.startMs).toBe(Date.parse('2026-09-27T16:06:00Z'));
    expect(d.window.endMs).toBe(Date.parse(d.window.end));
    expect(strataCount(d)).toBe(Math.ceil((d.window.endMs - d.window.startMs) / 3_600_000));
    expect(strataCount(loaded.declaration)).toBe(24);
  });

  it('keeps the cells and targets of the 2026-09-26 declaration', () => {
    expect(declaredCells(serving.declaration).size).toBe(3969);
    expect(serving.declaration.population).toEqual(loaded.declaration.population);
    expect(serving.declaration.chain).toEqual(loaded.declaration.chain);
    expect(serving.declaration.selection.handsPerStratum).toBe(
      loaded.declaration.selection.handsPerStratum
    );
  });

  it('refuses the earlier releases, a moved window and a window longer than a day', () => {
    const request = {
      declarationDigest: serving.digest,
      window: { ...serving.declaration.window },
      targetPerCell: 3,
      handsPerStratum: serving.declaration.selection.handsPerStratum,
      releases: ['6b6eabb1b169aed14fcb9fbd0ae54ee2bc42b2d4'],
      servingRelease: '6b6eabb1b169aed14fcb9fbd0ae54ee2bc42b2d4',
    };
    expect(enforceDeclaration(serving, request)).toBe(true);
    expect(() =>
      enforceDeclaration(serving, {
        ...request,
        releases: [...request.releases, '4946473bb65a27d964a3ad9401eaf4948014a0a8'],
      })
    ).toThrow(/not admitted/);
    expect(() =>
      enforceDeclaration(serving, {
        ...request,
        window: { ...request.window, endMs: request.window.endMs + 60_000 },
      })
    ).toThrow(/window differs/);
    const long = structuredClone(serving.declaration);
    long.window.endMs = long.window.startMs + 25 * 3_600_000;
    expect(() => validateDeclaration(long)).toThrow(/at most 24 hours/);
    const reversed = structuredClone(serving.declaration);
    reversed.window.endMs = reversed.window.startMs;
    expect(() => validateDeclaration(reversed)).toThrow(/at most 24 hours/);
  });
});

const HAND_KEY = 'a'.repeat(64);
const TURN_KEY = 'b'.repeat(64);
const PRODUCER = '11111111-2222-4333-8444-555555555555';
const RELEASE = 'c'.repeat(40);
const record = (kind: string, body: unknown, sequence: number, turnKey = TURN_KEY) => ({
  version: 1,
  producerId: PRODUCER,
  sequence,
  eventId: `event-${sequence}`,
  atMs: 1_790_400_000_000 + sequence,
  sourceRelease: RELEASE,
  kind,
  handKey: HAND_KEY,
  turnKey,
  body: JSON.stringify(body),
  sha256: 'd'.repeat(64),
  bytes: 1,
});
const snapshot = {
  type: 'DECIDE_FAST',
  requestId: 7,
  gameState: {
    stage: 'preflop',
    gameMode: 'tournament',
    format: 'mtt',
    gameVariant: 'nlh',
    players: [],
  },
};
const deps = {
  lifecycleRequestDigest: () => 'digest-1',
  samplingStateIsValid: () => true,
  computeMetadataIsValid: () => true,
  decisionReceiptIsValid: () => true,
  attributionMatchesSnapshot: () => true,
  completedHandKey: () => 'coordinate',
  bindToCommittedHand: () => ({ status: 'bound', actionOrdinal: 2 }),
  journalHash: (value: string) => (value === 'coordinate' ? HAND_KEY : 'other'),
};
const fullRecords = (decisionBody: Record<string, unknown>) => [
  record('request_lifecycle', { phase: 'requested', requestDigest: 'digest-1' }, 1),
  record(
    'decision',
    { snapshot, rngBefore: 1, rngAfter: 2, computeMs: 3, governorScale: 1, ...decisionBody },
    2
  ),
  record(
    'execution',
    {
      executionStatus: 'intended',
      retirementReason: null,
      policyFallback: null,
      acceptedActions: [
        { intended: true, record: { action: 'raise', amount: 300, seat: 1, stage: 'preflop' } },
      ],
    },
    3
  ),
  record(
    'accepted_hand',
    {
      committedHandId: 'hand',
      actions: [
        { action: 'fold' },
        { action: 'call' },
        { action: 'raise', origin: 'horse_policy' },
      ],
    },
    4,
    HAND_KEY
  ),
];

describe('Phase 6D chain assembly', () => {
  it('marks a decision without a phase 6 receipt as missing:reference and every other link present', () => {
    const records = fullRecords({ decision: { action: 'raise', amount: 300 } });
    const chain = assembleChain({ records, decisionRecord: records[1], handKey: HAND_KEY, deps });
    expect(chain.links).toEqual({
      request: 'present',
      calculation: 'present',
      reference: 'missing:reference',
      acceptedAction: 'present',
      completedHand: 'present',
    });
    expect(chain.complete).toBe(false);
    expect(chain.acceptedOrigin).toBe('horse_policy');
    expect(chain.acceptedAction).toBe('raise');
    expect(CHAIN_LINKS).toEqual([
      'request',
      'calculation',
      'reference',
      'acceptedAction',
      'completedHand',
    ]);
  });

  it('is complete only when all five links are present, and names each absent link', () => {
    const attributed = {
      decision: {
        action: 'raise',
        amount: 300,
        tournamentPreflopAttribution: {
          version: 'horse-phase6-attribution-v2',
          status: 'atlas_evaluated',
          route: 'intent_engine',
          reason: 'atlas_forwarded',
          atlasEvaluated: true,
          lookup: {
            coordinate: { branch: 'unopened', tableSize: 9, anteType: 'none', stackBB: 20 },
            policy: { cell: 'phase6-v1:x' },
          },
        },
      },
    };
    const complete = assembleChain({
      records: fullRecords(attributed),
      decisionRecord: fullRecords(attributed)[1],
      handKey: HAND_KEY,
      deps,
    });
    expect(complete.complete).toBe(true);
    expect(complete.attribution).toMatchObject({
      status: 'atlas_evaluated',
      cell: 'phase6-v1:x',
      stackBB: 20,
    });
    const noHand = fullRecords(attributed).filter((r) => r.kind !== 'accepted_hand');
    expect(
      assembleChain({ records: noHand, decisionRecord: noHand[1], handKey: HAND_KEY, deps }).links
        .completedHand
    ).toBe('missing:accepted_hand');
    const noWitness = fullRecords(attributed).filter((r) => r.kind !== 'execution');
    const chain = assembleChain({
      records: noWitness,
      decisionRecord: noWitness[1],
      handKey: HAND_KEY,
      deps,
    });
    expect(chain.links.acceptedAction).toBe('missing:execution_witness');
    expect(chain.links.completedHand).toBe('missing:hand_binding:no_witness');
    const noRequest = fullRecords(attributed).filter((r) => r.kind !== 'request_lifecycle');
    expect(
      assembleChain({ records: noRequest, decisionRecord: noRequest[0], handKey: HAND_KEY, deps })
        .links.request
    ).toBe('missing:request_lifecycle');
    const retired = fullRecords(attributed);
    retired[2] = record(
      'execution',
      { executionStatus: 'not_executed', retirementReason: 'turn_abandoned', acceptedActions: [] },
      3
    );
    expect(
      assembleChain({ records: retired, decisionRecord: retired[1], handKey: HAND_KEY, deps }).links
        .acceptedAction
    ).toBe('missing:accepted_action:turn_abandoned');
    const mismatched = assembleChain({
      records: fullRecords(attributed),
      decisionRecord: fullRecords(attributed)[1],
      handKey: HAND_KEY,
      deps: {
        ...deps,
        attributionMatchesSnapshot: () => false,
        decisionReceiptIsValid: () => false,
      },
    });
    expect(mismatched.links.reference).toBe('missing:reference_mismatch');
    expect(mismatched.links.calculation).toBe('missing:calculation_receipt');
  });
});
