import { describe, expect, it } from 'vitest';
import { HorseReplayRefusal, reconstructHorseReplayInput } from './reconstruct.js';
import {
  PHASE6C_FIXTURE_IDS as IDS,
  phase6cFixtureRecord,
  resignHorseJournalRecord,
} from './fixtures/index.js';

const refusal = (raw: unknown): string => {
  try {
    reconstructHorseReplayInput(raw);
  } catch (error) {
    if (error instanceof HorseReplayRefusal) return error.reason;
    throw error;
  }
  return 'accepted';
};
type Body = { snapshot: Record<string, unknown> & { gameState: Record<string, unknown> } } & Record<
  string,
  unknown
>;
const changed = (id: string, mutate: (body: Body) => void) =>
  resignHorseJournalRecord(phase6cFixtureRecord(id), (body) => mutate(body as Body));

describe('Phase 6C reconstruction of the exact original input', () => {
  it('rebuilds a journaled FAST decision with every declared input present', () => {
    const input = reconstructHorseReplayInput(phase6cFixtureRecord(IDS.tournamentAtlasEvaluated));
    expect(input.request.type).toBe('DECIDE_FAST');
    expect(typeof input.request.style).toBe('string');
    expect(input.request.mods).toBeTypeOf('object');
    expect(Array.isArray(input.request.gameState.actionHistory)).toBe(true);
    expect(input.request.gameState.dealtSeatIds?.length).toBeGreaterThan(1);
    expect(input.request.gameState.tournament?.contextProvenance?.source?.generation).toBe(631);
    expect(input.request.gameState.tournament?.m?.schemaVersion).toBe(1);
    expect(input.rngBefore).toBeGreaterThan(0);
    expect(input.readFrame.version).toBe('horse-decision-reads-v2');
    expect(input.original.action).toBe('fold');
    expect(input.recordedRelease).toMatch(/^[0-9a-f]{40}$/);
  });

  it('refuses a record whose digest no longer holds, before reading its body', () => {
    const record = phase6cFixtureRecord(IDS.tournamentAtlasEvaluated);
    expect(refusal({ ...record, body: record.body.replace('"fold"', '"call"') })).toBe(
      'replay_input_incomplete:record'
    );
    expect(refusal(null)).toBe('replay_input_incomplete:record');
  });

  it('refuses a record that is not a decision', () => {
    const record = phase6cFixtureRecord(IDS.tournamentAtlasEvaluated);
    const execution = resignHorseJournalRecord({ ...record, kind: 'execution' }, () => {});
    expect(refusal(execution)).toBe('replay_input_incomplete:kind');
  });

  it('refuses a deep second look: it is not an original decision', () => {
    expect(refusal(phase6cFixtureRecord(IDS.deepSecondLook))).toBe(
      'replay_unsupported:DECIDE_DEEP'
    );
  });

  it.each([
    ['persona', (b: Body) => delete b.snapshot.style],
    ['profile', (b: Body) => delete b.snapshot.mods],
    ['public_history', (b: Body) => delete b.snapshot.gameState.actionHistory],
    ['field', (b: Body) => delete b.snapshot.gameState.dealtSeatIds],
    ['field', (b: Body) => delete b.snapshot.gameState.tournament],
    [
      'source',
      (b: Body) =>
        delete (b.snapshot.gameState.tournament as Record<string, unknown>).contextProvenance,
    ],
    ['atlas', (b: Body) => delete (b.snapshot.gameState.tournament as Record<string, unknown>).m],
    ['rng', (b: Body) => delete b.rngBefore],
    ['rng', (b: Body) => (b.rngAfter = -1)],
    ['governor', (b: Body) => (b.governorScale = 0)],
    ['read_frame', (b: Body) => (b.readFrame = null)],
    ['solver_stores', (b: Body) => delete b.readiness],
    ['decision', (b: Body) => delete b.decision],
    ['actor', (b: Body) => delete b.snapshot.player],
    ['decision_key', (b: Body) => (b.snapshot.decisionKey = 'phase5-v1:' + '0'.repeat(64))],
  ])('refuses with replay_input_incomplete:%s and never substitutes a default', (field, mutate) => {
    expect(refusal(changed(IDS.tournamentAtlasEvaluated, mutate))).toBe(
      `replay_input_incomplete:${field}`
    );
  });

  it('accepts a journaled store identity and refuses a malformed one as solver_stores', () => {
    const empty = {
      version: 'solver-store-identity-v1',
      rows: 0,
      digest: 'e'.repeat(64),
      revision: null,
    };
    const withIdentity = (identity: unknown) =>
      changed(IDS.tournamentAtlasEvaluated, (b) => {
        (b.readiness as Record<string, unknown>).solverStoreIdentity = identity;
      });
    expect(refusal(withIdentity({ charts: empty, postflop: empty }))).toBe('accepted');
    expect(
      reconstructHorseReplayInput(withIdentity({ charts: empty, postflop: empty })).readiness
        .solverStoreIdentity?.charts.digest
    ).toBe('e'.repeat(64));
    expect(refusal(withIdentity({ charts: empty }))).toBe('replay_input_incomplete:solver_stores');
    expect(refusal(withIdentity({ charts: { ...empty, digest: 'short' }, postflop: empty }))).toBe(
      'replay_input_incomplete:solver_stores'
    );
  });

  it('refuses an input whose bytes no longer match the decision key that bound them', () => {
    const substitutedStack = changed(IDS.tournamentAtlasEvaluated, (b) => {
      (b.snapshot.player as { stack: number }).stack += 1;
    });
    expect(refusal(substitutedStack)).toBe('replay_input_incomplete:decision_key');
  });

  it('does not require tournament inputs of a cash decision, and still requires the rest', () => {
    expect(refusal(phase6cFixtureRecord(IDS.cashNlhPreflop))).toBe('accepted');
    expect(refusal(changed(IDS.cashNlhPreflop, (b) => delete b.snapshot.style))).toBe(
      'replay_input_incomplete:persona'
    );
  });
});
