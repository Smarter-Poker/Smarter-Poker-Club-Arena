import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { captureEngineFailureHealth } from '../e2e/support/liveTableFailureHealth';

const tableId = '01886f88-fa69-42e9-96e8-28efd06cf851';
const endpoint = 'https://engine.smarter.poker/health';
const response = (body: unknown, status = 200) => ({
  status: () => status,
  body: async () => Buffer.from(JSON.stringify(body)),
});

describe('MTT failure retains the engine phase before board closeout classification', () => {
  it('retains an unhealthy response and only the selected table diagnostic fields', async () => {
    const calls: Array<{ url: string; options: unknown }> = [];
    const evidence = await captureEngineFailureHealth(
      async (url, options) => {
        calls.push({ url, options });
        return response(
          {
            version: '74c1ff91',
            private: 'DO_NOT_RETAIN',
            tableLiveness: [
              { tableId: 'other', loopPhase: 'DO_NOT_RETAIN' },
              {
                tableId,
                loopPhase: 'load_next_hand_inputs+19s',
                paused: false,
                handCount: 45667640,
                msSinceProgress: 45079,
                private: 'DO_NOT_RETAIN',
              },
            ],
          },
          503
        );
      },
      endpoint,
      tableId
    );
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).searchParams.get('liveness_table_ids')).toBe(tableId);
    expect(calls[0].options).toEqual({ timeout: 3000, headers: { 'cache-control': 'no-store' } });
    expect(evidence).toMatchObject({
      kind: 'observed',
      httpStatus: 503,
      version: '74c1ff91',
      tableAvailability: 'observed',
      table: {
        tableId,
        loopPhase: 'load_next_hand_inputs+19s',
        paused: false,
        handCount: 45667640,
        msSinceProgress: 45079,
      },
    });
    expect(JSON.stringify(evidence)).not.toContain('DO_NOT_RETAIN');
  });

  it('names a missing table as unavailable, without inventing a healthy table', async () => {
    const evidence = await captureEngineFailureHealth(
      async () =>
        response({
          version: '74c1ff91',
          tableLiveness: [],
        }),
      endpoint,
      tableId
    );
    expect(evidence).toMatchObject({
      kind: 'observed',
      tableAvailability: 'unavailable',
      table: null,
    });
  });

  it('keeps transport, malformed, oversized and rejected reads from replacing the original failure', async () => {
    for (const read of [
      async () => {
        throw new Error('DO_NOT_RETAIN');
      },
      async () => ({ status: () => 200, body: async () => Buffer.from('DO_NOT_RETAIN') }),
      async () => ({ status: () => 200, body: async () => Buffer.alloc(256 * 1024 + 1) }),
      async () => response({}, 401),
    ]) {
      const evidence = await captureEngineFailureHealth(read, endpoint, tableId);
      expect(evidence).toMatchObject({
        kind: 'unavailable',
        reason: 'engine_health_read_unavailable',
      });
      expect(JSON.stringify(evidence)).not.toContain('DO_NOT_RETAIN');
    }
  });

  it('captures the failed MTT phase before delayed board classification and preserves the silence limit', () => {
    const source = readFileSync('tests/e2e/production-live-table-realtime.spec.ts', 'utf8');
    const catchBody = source.slice(
      source.indexOf('if (error instanceof PreHudCandidateAttrition) throw error;')
    );
    expect(catchBody.indexOf('captureEngineFailureHealth(')).toBeGreaterThan(0);
    expect(catchBody.indexOf('captureEngineFailureHealth(')).toBeLessThan(
      catchBody.indexOf('boardReader.boardFacts(')
    );
    expect(source).toContain('const MAX_GAMEPLAY_SILENCE_MS = 45_000;');
  });
});
