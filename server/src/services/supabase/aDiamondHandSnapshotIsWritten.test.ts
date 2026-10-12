/**
 * A DIAMOND HAND'S SNAPSHOT IS WRITTEN TOO (2026-10-09)
 *
 * Every snapshot write on a Diamond cash table threw "Do not know how to
 * serialize a BigInt" because the recorded rake schedule carries BigInt
 * units. These assertions fail against the unsanitized write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client.js', () => ({
  supabase: { rpc: vi.fn().mockResolvedValue({ error: null }), from: vi.fn() },
}));

import { saveHandStateSnapshot, jsonSafeSnapshotValue } from './snapshots.js';
import { supabase } from './client.js';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

const diamondSchedule = {
  enabled: true,
  bigBlind: 100,
  noFlopNoDrop: true,
  rounding: 'truncate',
  minPot: { units: 1000n, scale: 1 },
  percent: { hu: { units: 50n, scale: 1 } },
};

function params(configJson: Record<string, unknown>, stateJson: Record<string, unknown> = {}) {
  return {
    tableId: 't-1',
    handNumber: 7,
    stateJson,
    configJson,
    dealerSeat: 1,
    playersJson: [{ seat: 1, user_id: 'u', username: 'a', stack: 100, is_horse: false }],
    stage: 'flop',
  };
}

describe("a Diamond hand's snapshot is written", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockResolvedValue({ error: null });
  });

  it('writes a Diamond snapshot whose BigInt units are exact decimal strings', async () => {
    await saveHandStateSnapshot(
      params({ tableId: 't-1', diamondRakeSchedule: diamondSchedule }, { pot: 5n })
    );
    expect(rpc).toHaveBeenCalledTimes(1);
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    // What supabase-js does to the body: it must not throw.
    expect(() => JSON.stringify(args)).not.toThrow();
    const config = args.p_config_json as { diamondRakeSchedule: typeof diamondSchedule };
    expect(config.diamondRakeSchedule.minPot).toEqual({ units: '1000', scale: 1 });
    expect(config.diamondRakeSchedule.percent.hu).toEqual({ units: '50', scale: 1 });
    expect(args.p_state_json).toEqual({ pot: '5' });
  });

  it('NEGATIVE: a chip or tournament snapshot is passed through untouched', async () => {
    const config = { tableId: 't-1', diamondRakeSchedule: null, rakeConfig: { percent: 5 } };
    const state = { pot: 10 };
    await saveHandStateSnapshot(params(config, state));
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_config_json).toBe(config);
    expect(args.p_state_json).toBe(state);
  });

  it('keeps every non-BigInt value exactly', () => {
    const v = { a: 1, b: 'x', c: [true, null, { d: 2.5 }], e: 12345678901234567890n };
    expect(jsonSafeSnapshotValue(v)).toEqual({
      a: 1,
      b: 'x',
      c: [true, null, { d: 2.5 }],
      e: '12345678901234567890',
    });
  });
});
