import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
const upsert = vi.fn();
vi.mock('./supabase.js', () => ({ supabase: { from: () => ({ upsert }) } }));

import {
  STABLE_HAND_STATE_ALERT_SOURCE,
  closeStableHandStateAlert,
  type StableHandAlertStore,
} from './stableHandStateAlert.js';

const here = dirname(fileURLToPath(import.meta.url));

function fakeStore(result: {
  data: Array<{ id: string }> | null;
  error: { message: string } | null;
}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const store: StableHandAlertStore = {
    from(table: 'financial_alerts') {
      calls.push(['from', table]);
      return {
        update(values: Record<string, unknown>) {
          calls.push(['update', values]);
          return {
            eq(c1: string, v1: unknown) {
              calls.push(['eq', c1, v1]);
              return {
                eq(c2: string, v2: unknown) {
                  calls.push(['eq', c2, v2]);
                  return {
                    select(cols: string) {
                      calls.push(['select', cols]);
                      return Promise.resolve(result);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  return { store, calls };
}

describe('the Stable Hand counter alert closes when the counters write again', () => {
  it('resolves only open rows of its own source and says why', async () => {
    const { store, calls } = fakeStore({ data: [{ id: 'a' }], error: null });
    const closed = await closeStableHandStateAlert(store, 134, Date.parse('2026-10-17T11:00:00Z'));
    expect(closed).toBe(1);
    expect(calls).toContainEqual(['eq', 'source', STABLE_HAND_STATE_ALERT_SOURCE]);
    expect(calls).toContainEqual(['eq', 'resolved', false]);
    const update = calls.find((c) => c[0] === 'update')?.[1] as Record<string, unknown>;
    expect(update.resolved).toBe(true);
    expect(String(update.resolution)).toContain('134 of 134');
  });

  it('throws on a database error so the caller reports it', async () => {
    const { store } = fakeStore({ data: null, error: { message: 'boom' } });
    await expect(closeStableHandStateAlert(store, 1, 0)).rejects.toThrow('boom');
  });

  it('the fleet closes it only after a cycle in which every folded row was accepted', () => {
    const src = readFileSync(join(here, 'HorseFleetManager.ts'), 'utf8');
    expect(src).toContain('written === folded.rows.length');
    expect(src).toContain('closeStableHandStateAlert(supabase, written, nowMs)');
  });
});

describe('one failed round trip is not a failed write', () => {
  it('sends a failed chunk once more and counts it when the second attempt lands', async () => {
    const { writeStateRows } = await import('./StableHandState.js');
    upsert.mockReset();
    upsert
      .mockResolvedValueOnce({ error: { message: 'fetch failed' } })
      .mockResolvedValueOnce({ error: null });
    const written = await writeStateRows([{ horse_id: 'h1' } as never]);
    expect(written).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second attempt and returns 0, never throwing the cycle away', async () => {
    const { writeStateRows } = await import('./StableHandState.js');
    upsert.mockReset();
    upsert.mockResolvedValue({ error: { message: 'still down' } });
    expect(await writeStateRows([{ horse_id: 'h1' } as never])).toBe(0);
    expect(upsert).toHaveBeenCalledTimes(2);
  });
});
