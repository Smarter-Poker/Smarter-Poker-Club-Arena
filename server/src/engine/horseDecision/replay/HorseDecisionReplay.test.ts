import { describe, expect, it } from 'vitest';
import { replayHorseDecisionById, replayHorseDecisionRecord } from './HorseDecisionReplay.js';
import { openHorseJournalCopy } from './journalSource.js';
import { buildHorseDecisionKey, type FastHorseDecisionRequest } from '../protocol.js';
import {
  PHASE6C_FIXTURE_IDS as IDS,
  PHASE6C_FIXTURE_PATH,
  phase6cFixtureRecord,
  resignHorseJournalRecord,
} from './fixtures/index.js';

const ENGINE = 'a'.repeat(40);
const replay = (id: string) =>
  replayHorseDecisionRecord(phase6cFixtureRecord(id), { engineSha: ENGINE });

describe('Phase 6C exact-input replay through the worker runtime', () => {
  it('reproduces a natural atlas-evaluated tournament preflop decision deterministically', async () => {
    const first = await replay(IDS.tournamentAtlasEvaluated);
    expect(first.status, first.reason).toBe('reproduced');
    expect(first.replayedAction).toEqual(first.originalAction);
    expect(first.originalAction).toEqual({ action: 'fold', amount: null });
    expect(first.qualification.status).toBe('agreed');
    expect(first.qualification.route).toEqual({
      original: 'intent_engine',
      replayed: 'intent_engine',
    });
    expect(first.qualification.atlasCell.replayed).toBe(first.qualification.atlasCell.original);
    expect(first.qualification.rng.before.replayed).toBe(first.qualification.rng.before.original);
    expect(first.authority.original.module).toBe('reference:intent_engine');
    expect(first.authority.same).toBe(true);
    expect(first.latency.computeMs).toBeGreaterThanOrEqual(0);
    expect(first.latency.wallMs).toBeGreaterThan(0);
    expect(first.work.nodeVisits).toBe(8);
    expect(first.work.equitySamples).toBeGreaterThan(0);
    expect(first.engineSha).toBe(ENGINE);
    expect(first.recordedRelease).toMatch(/^[0-9a-f]{40}$/);
    const second = await replay(IDS.tournamentAtlasEvaluated);
    expect(second.status).toBe('reproduced');
    expect(second.qualification.receiptDigest.replayed).toBe(
      first.qualification.receiptDigest.replayed
    );
    expect(second.qualification.rng.after.replayed).toBe(first.qualification.rng.after.replayed);
  });

  it('reproduces a labeled-fallback tournament raise and a cash decision', async () => {
    for (const id of [IDS.tournamentLabeledFallback, IDS.cashNlhPreflop, IDS.cashPlo4Preflop]) {
      const verdict = await replay(id);
      expect(verdict.status, `${id}: ${verdict.reason}`).toBe('reproduced');
      expect(verdict.replayedAction).toEqual(verdict.originalAction);
    }
  });

  it('refuses a chart-route decision while the chart store it consulted is not loaded', async () => {
    const verdict = await replayHorseDecisionRecord(
      phase6cFixtureRecord(IDS.tournamentChartOpenJam),
      {
        engineSha: ENGINE,
        stores: { charts: 0, postflop: 0, postflopV31: 0, postflopV31Dataset: null },
      }
    );
    expect(verdict.status).toBe('refused');
    expect(verdict.reason).toBe('reference_unavailable:chart_store');
    expect(verdict.replayedAction).toBeNull();
    expect(verdict.originalAction).toEqual({ action: 'fold', amount: null });
    expect(verdict.qualification.status).toBe('refused');
  });

  it('refuses a deep second look and an incomplete record with their named reasons', async () => {
    const deep = await replay(IDS.deepSecondLook);
    expect(deep.status).toBe('refused');
    expect(deep.reason).toBe('replay_unsupported:DECIDE_DEEP');
    const broken = await replayHorseDecisionRecord(
      { eventId: 'x', body: '{}' },
      { engineSha: ENGINE }
    );
    expect(broken.status).toBe('refused');
    expect(broken.reason).toBe('replay_input_incomplete:record');
  });

  it('loads one decision by id from a journal copy and reports a missing id as a refusal', async () => {
    const source = openHorseJournalCopy(PHASE6C_FIXTURE_PATH);
    const record = phase6cFixtureRecord(IDS.tournamentAtlasEvaluated);
    const verdict = await replayHorseDecisionById(source, record.eventId, { engineSha: ENGINE });
    expect(verdict.decisionId).toBe(record.eventId);
    expect(verdict.status).toBe('reproduced');
    const missing = await replayHorseDecisionById(source, 'f'.repeat(64), { engineSha: ENGINE });
    expect(missing.status).toBe('refused');
    expect(missing.reason).toBe('replay_input_incomplete:record');
    expect(source.newestDecisions(3).map((row) => row.record.kind)).toEqual([
      'decision',
      'decision',
      'decision',
    ]);
  });

  it('reports a substituted recorded action as diverged, never as reproduced', async () => {
    const substituted = resignHorseJournalRecord(
      phase6cFixtureRecord(IDS.tournamentAtlasEvaluated),
      (body) => {
        (body.decision as { action: string }).action = 'call';
      }
    );
    const verdict = await replayHorseDecisionRecord(substituted, { engineSha: ENGINE });
    expect(verdict.status).toBe('diverged');
    expect(verdict.reason).toBe('action');
    expect(verdict.originalAction).toEqual({ action: 'call', amount: null });
    expect(verdict.replayedAction).toEqual({ action: 'fold', amount: null });
  });

  it('refuses a substituted RNG stream: the runtime derives the original seed, not the claimed one', async () => {
    const substituted = resignHorseJournalRecord(
      phase6cFixtureRecord(IDS.tournamentAtlasEvaluated),
      (body) => {
        body.rngBefore = ((body.rngBefore as number) ^ 0x5a5a5a5a) >>> 0;
      }
    );
    const verdict = await replayHorseDecisionRecord(substituted, { engineSha: ENGINE });
    expect(verdict.status).toBe('refused');
    expect(verdict.reason).toBe('rng_stream_mismatch');
  });

  it('refuses stale M evidence even when the decision key is re-signed around it', async () => {
    const stale = resignHorseJournalRecord(
      phase6cFixtureRecord(IDS.tournamentAtlasEvaluated),
      (body) => {
        const request = body.snapshot as unknown as FastHorseDecisionRequest;
        const m = request.gameState.tournament!.m as { realM: number };
        m.realM += 1;
        request.decisionKey = buildHorseDecisionKey(request);
      }
    );
    const verdict = await replayHorseDecisionRecord(stale, { engineSha: ENGINE });
    expect(verdict.status).not.toBe('reproduced');
    expect(verdict.qualification.checks.m_state.status).toBe('disagreed');
  });
});
