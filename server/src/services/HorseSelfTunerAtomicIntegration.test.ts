import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  write: vi.fn(),
  report: vi.fn(),
  raw: { style: 'lag', persona: { gtoAdherence: 0.9 } },
}));
vi.mock('./supabase.js', () => ({ supabase: { from: m.from, rpc: m.rpc } }));
vi.mock('./HorseTunerAtomicWrite.js', () => ({ recordHorseTunerUpdate: m.write }));
vi.mock('./errorReporter.js', () => ({ reportError: m.report }));
import { runSelfTune } from './HorseSelfTuner.js';
const actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
beforeEach(() => {
  vi.clearAllMocks();
  m.raw = { style: 'lag', persona: { gtoAdherence: 0.9 } };
  m.write.mockResolvedValue({ status: 'recorded', changed: true, replayed: false });
  m.rpc.mockResolvedValue({ data: [], error: null });
  m.from.mockImplementation((table: string) => {
    let data: unknown[] = [];
    if (table === 'profiles') data = [{ id: actor, horse_profile: m.raw }];
    if (table === 'horse_daily_play')
      data = [{ horse_user_id: actor, hands: 500, vpip: 300, pfr: 100 }];
    const q: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'order', 'limit', 'gte', 'gt', 'in', 'is', 'range'])
      q[method] = () => q;
    q.then = (resolve: (r: unknown) => unknown) => {
      if (table === 'horse_daily_nets') m.raw.persona.gtoAdherence = 0.5;
      return Promise.resolve({ data, error: null }).then(resolve);
    };
    return q;
  });
});
describe('nightly tuner atomic write integration', () => {
  it('executes the real study and submits the original profile, proposed dials and audit together', async () => {
    expect(await runSelfTune('2026-09-13')).toEqual({ studied: 1, tuned: 1 });
    expect(m.write).toHaveBeenCalledTimes(1);
    const r = m.write.mock.calls[0][0];
    expect(r.expectedProfile.persona.gtoAdherence).toBe(0.9);
    expect(r.audit.hands).toBe(500);
    expect(r.audit.modsAfter.tightness).toBeGreaterThan(1);
    // Changes to the caller-owned raw object must not enter the proposed profile either.
    expect(r.nextProfile.persona.gtoAdherence).toBe(0.9);
    expect(r.audit.reasons.length).toBeGreaterThan(0);
    expect(m.from.mock.calls.some(([table]) => table === 'horse_self_tune_log')).toBe(false);
  });
  it.each([
    { status: 'unknown' },
    { status: 'unavailable', reason: 'profile_changed' },
    { status: 'recorded', changed: true, replayed: true },
  ])('never counts an unconfirmed or replayed write as a new tune: %j', async (reply) => {
    m.write.mockResolvedValue(reply);
    expect(await runSelfTune('2026-09-13')).toEqual({ studied: 1, tuned: 0 });
    expect(m.write).toHaveBeenCalledTimes(1);
  });
});
