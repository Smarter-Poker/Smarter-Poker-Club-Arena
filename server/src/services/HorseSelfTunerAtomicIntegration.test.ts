import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  write: vi.fn(),
  progress: vi.fn(),
  complete: vi.fn(),
  prepare: vi.fn(),
  extraHorse: false,
  report: vi.fn(),
  raw: { style: 'lag', persona: { gtoAdherence: 0.9 } },
}));
vi.mock('./supabase.js', () => ({ supabase: { from: m.from, rpc: m.rpc } }));
vi.mock('./HorseTunerAtomicWrite.js', () => ({ recordHorseTunerUpdate: m.write }));
vi.mock('./HorseTunerStudyCompletion.js', () => ({
  readRecordedHorseTunes: m.progress,
  completeHorseTunerStudy: m.complete,
  prepareHorseTunerStudy: m.prepare,
  TUNER_STUDY_MAX_HORSES: 2048,
}));
vi.mock('./errorReporter.js', () => ({ reportError: m.report }));
import { runSelfTune } from './HorseSelfTuner.js';
const actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
beforeEach(() => {
  vi.clearAllMocks();
  m.extraHorse = false;
  m.progress.mockResolvedValue({ status: 'snapshot', horseIds: [] });
  m.complete.mockResolvedValue(true);
  m.prepare.mockImplementation(async (_day, studied, horseIds) => ({
    status: 'prepared',
    studied,
    horseIds,
  }));
  m.raw = { style: 'lag', persona: { gtoAdherence: 0.9 } };
  m.write.mockResolvedValue({ status: 'recorded', changed: true, replayed: false });
  m.rpc.mockResolvedValue({ data: [], error: null });
  m.from.mockImplementation((table: string) => {
    let data: unknown[] = [];
    const ids = m.extraHorse ? [actor, second] : [actor];
    if (table === 'profiles') data = ids.map((id) => ({ id, horse_profile: m.raw }));
    if (table === 'horse_daily_play')
      data = ids.map((id) => ({ horse_user_id: id, hands: 500, vpip: 300, pfr: 100 }));
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
    expect(m.complete).toHaveBeenCalledWith('2026-09-13', 1, [actor]);
  });
  it.each([
    { status: 'unknown' },
    { status: 'unavailable', reason: 'profile_changed' },
    { status: 'recorded', changed: true, replayed: true },
  ])('never counts an unconfirmed or replayed write as a new tune: %j', async (reply) => {
    m.write.mockResolvedValue(reply);
    expect(await runSelfTune('2026-09-13')).toEqual({ studied: 1, tuned: 0 });
    expect(m.write).toHaveBeenCalledTimes(1);
    if (reply.status !== 'recorded') expect(m.complete).not.toHaveBeenCalled();
  });
  it('resumes a partial two-horse study without retuning the horse already committed', async () => {
    m.extraHorse = true;
    m.write
      .mockResolvedValueOnce({ status: 'recorded', changed: true, replayed: false })
      .mockResolvedValueOnce({ status: 'unknown' });
    expect(await runSelfTune('2026-09-13')).toEqual({ studied: 2, tuned: 1 });
    expect(m.complete).not.toHaveBeenCalled();
    m.progress.mockResolvedValue({ status: 'snapshot', horseIds: [actor] });
    m.write.mockClear();
    expect(await runSelfTune('2026-09-13')).toEqual({ studied: 2, tuned: 1 });
    expect(m.write).toHaveBeenCalledTimes(1);
    expect(m.write.mock.calls[0][0].horseId).toBe(second);
    expect(m.complete).toHaveBeenCalledWith('2026-09-13', 2, [actor, second]);
  });
  it('does not study or write when durable progress is unknown', async () => {
    m.progress.mockResolvedValue({ status: 'unknown' });
    expect(await runSelfTune('2026-09-13')).toEqual({ studied: 0, tuned: 0 });
    expect(m.from).not.toHaveBeenCalled();
    expect(m.write).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });
  it('does not drop an unfinished original horse when the next source snapshot omits it', async () => {
    m.prepare.mockResolvedValueOnce({ status: 'prepared', studied: 2, horseIds: [actor, second] });
    m.progress.mockResolvedValue({ status: 'snapshot', horseIds: [actor] });
    expect(await runSelfTune('2026-09-13')).toEqual({ studied: 1, tuned: 0 });
    expect(m.write).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });
  it('does not write before the eligible roster is durably acknowledged', async () => {
    m.prepare.mockResolvedValueOnce({ status: 'unknown' });
    await runSelfTune('2026-09-13');
    expect(m.write).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });
  it('does not seal a study interrupted after an accepted write', async () => {
    let current = true;
    m.write.mockImplementationOnce(async () => {
      current = false;
      return { status: 'recorded', changed: true, replayed: false };
    });
    await runSelfTune('2026-09-13', () => current);
    expect(m.complete).not.toHaveBeenCalled();
  });
});
