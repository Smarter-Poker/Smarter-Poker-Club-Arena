import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { recordHorseTunerUpdate, type HorseTunerWriteRequest } from './HorseTunerAtomicWrite.js';
const m = vi.hoisted(() => ({ rpc: vi.fn(), reply: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: m.rpc } }));
const request = (): HorseTunerWriteRequest => ({
  horseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  runDate: '2026-09-13',
  expectedProfile: { style: 'lag', tightness: 1 },
  nextProfile: { style: 'lag', tightness: 1.02 },
  audit: {
    hands: 300,
    stats: { vpip: 0.5 },
    modsBefore: { tightness: 1, aggression: 1, bluffFreq: 1 },
    modsAfter: { tightness: 1.02, aggression: 1, bluffFreq: 1 },
    reasons: ['bounded change'],
  },
});
const receipt = () => {
  const p = m.rpc.mock.calls[0][1].p_payload;
  const r = JSON.parse(p);
  return {
    data: {
      version: 1,
      status: 'recorded',
      horseId: r.horseId,
      runDate: r.runDate,
      requestHash: createHash('sha256').update(p).digest('hex'),
      changed: true,
      replayed: false,
    },
    error: null,
  };
};
beforeEach(() => {
  vi.clearAllMocks();
  m.rpc.mockReturnValue({ abortSignal: m.reply });
});
describe('atomic tuner transport', () => {
  it('captures the exact request before await and validates the matching committed receipt', async () => {
    let finish!: (value: unknown) => void;
    m.reply.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const r = request();
    const pending = recordHorseTunerUpdate(r);
    (r.expectedProfile as { style: string }).style = 'changed during study';
    r.audit.stats.vpip = 0.01;
    finish(receipt());
    expect(await pending).toEqual({ status: 'recorded', changed: true, replayed: false });
    const captured = JSON.parse(m.rpc.mock.calls[0][1].p_payload);
    expect(captured.expectedProfile.style).toBe('lag');
    expect(captured.audit.stats.vpip).toBe(0.5);
    expect(m.reply.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });
  it.each(['lost', 'database error', 'different hash', 'different horse', 'malformed'])(
    'keeps %s unknown with no separate-write fallback',
    async (mode) => {
      m.reply.mockImplementation(async () => {
        if (mode === 'lost') throw Error('lost');
        const r = receipt();
        if (mode === 'database error') return { data: null, error: Error('failed') };
        if (mode === 'different hash') r.data.requestHash = 'b'.repeat(64);
        if (mode === 'different horse') r.data.horseId = 'other';
        if (mode === 'malformed') return { data: { version: 1, status: 'recorded' }, error: null };
        return r;
      });
      expect(await recordHorseTunerUpdate(request())).toEqual({ status: 'unknown' });
      expect(m.rpc).toHaveBeenCalledTimes(1);
    }
  );
  it('surfaces stale profile refusal and strips untrusted error text', async () => {
    m.reply.mockResolvedValue({
      data: { version: 1, status: 'unavailable', reason: 'profile_changed' },
      error: null,
    });
    expect(await recordHorseTunerUpdate(request())).toEqual({
      status: 'unavailable',
      reason: 'profile_changed',
    });
    m.reply.mockResolvedValue({
      data: { version: 1, status: 'unavailable', reason: 'private raw error' },
      error: null,
    });
    expect(await recordHorseTunerUpdate(request())).toEqual({
      status: 'unavailable',
      reason: 'invalid_receipt',
    });
  });
  it('refuses oversized requests before transport', async () => {
    const r = request();
    expect(await recordHorseTunerUpdate({ ...r, expectedProfile: 'x'.repeat(65537) })).toEqual({
      status: 'unavailable',
      reason: 'request_budget_exceeded',
    });
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
