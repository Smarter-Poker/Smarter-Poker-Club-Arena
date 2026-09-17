import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  write: vi.fn(),
  progress: vi.fn(),
  complete: vi.fn(),
  prepare: vi.fn(),
  extraHorse: false,
  leaks: { big_loss: 7 } as Record<string, number>,
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
import { TAG_CONSUMERS } from '../engine/HorseDataLedger.js';
import { runSelfTune } from './HorseSelfTuner.js';
const actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
beforeEach(() => {
  vi.clearAllMocks();
  m.extraHorse = false;
  m.leaks = { big_loss: 7 };
  m.progress.mockResolvedValue({ status: 'snapshot', horseIds: [] });
  m.complete.mockResolvedValue(true);
  m.prepare.mockImplementation(async (_day, studied, horseIds) => ({
    status: 'prepared',
    studied,
    horseIds,
  }));
  m.raw = { style: 'lag', persona: { gtoAdherence: 0.9 } };
  m.write.mockResolvedValue({ status: 'recorded', changed: false, replayed: false });
  m.rpc.mockResolvedValue({ data: [], error: null });
  m.from.mockImplementation((table: string) => {
    let data: unknown[] = [];
    const ids = m.extraHorse ? [actor, second] : [actor];
    if (table === 'profiles') data = ids.map((id) => ({ id, horse_profile: m.raw }));
    if (table === 'horse_daily_play')
      data = ids.map((id) => ({ horse_user_id: id, hands: 500, vpip: 300, pfr: 100 }));
    if (table === 'horse_review_rollup')
      data = ids.map((id) => ({
        horse_user_id: id,
        game_variant: 'plo4',
        leak_counts: m.leaks,
        big_wins: 3,
        big_losses: 7,
      }));
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
  it('executes the real study, retaining proposed dials as diagnostics with no profile changes', async () => {
    expect(await runSelfTune('2026-09-13')).toEqual({ studied: 1, tuned: 0 });
    expect(m.write).toHaveBeenCalledTimes(1);
    const r = m.write.mock.calls[0][0];
    expect(r.expectedProfile.persona.gtoAdherence).toBe(0.9);
    expect(r.audit.hands).toBe(500);
    expect(r.intent).toBe('observational_only');
    expect(r.audit.stats.proposed_tightness).toBeGreaterThan(1);
    expect(r.audit.stats.causal_permission).toBe(0);
    expect(r.audit.stats.review_all_big_loss).toBe(7);
    expect(r.audit.stats.review_omaha_big_loss).toBe(7);
    expect(r.audit.stats.review_hands_omaha).toBe(10);
    expect(r.audit.modsAfter).toEqual(r.audit.modsBefore);
    expect(r.nextProfile).toEqual(r.expectedProfile);
    // Changes to the caller-owned raw object must not enter the proposed profile either.
    expect(r.nextProfile.persona.gtoAdherence).toBe(0.9);
    expect(r.audit.reasons.length).toBeGreaterThan(0);
    expect(m.from.mock.calls.some(([table]) => table === 'horse_self_tune_log')).toBe(false);
    expect(m.complete).toHaveBeenCalledWith('2026-09-13', 1, [actor]);
  });
  it.each(TAG_CONSUMERS.filter((t) => t.source.startsWith('horse_hand_reviews')))(
    'actually carries $key from rollup to the observational study without policy authority',
    async (tag) => {
      m.leaks = {};
      await runSelfTune('2026-09-13');
      const baseline = m.write.mock.calls.at(-1)![0].audit.stats;
      m.write.mockClear();
      m.leaks = { [tag.key]: 8 };
      expect(await runSelfTune('2026-09-13')).toEqual({ studied: 1, tuned: 0 });
      expect(m.write).toHaveBeenCalledTimes(1);
      const r = m.write.mock.calls[0][0];
      expect(r.audit.stats[`review_all_${tag.key}`]).toBe(8);
      expect(r.audit.stats[`review_omaha_${tag.key}`]).toBe(8);
      expect(r.audit.stats.causal_permission).toBe(0);
      expect(r.intent).toBe('observational_only');
      expect(r.nextProfile).toEqual(r.expectedProfile);
      expect(r.audit.modsAfter).toEqual(r.audit.modsBefore);
      const changed = [
        'proposed_tightness',
        'proposed_aggression',
        'proposed_bluff_frequency',
      ].some((key) => r.audit.stats[key] !== baseline[key]);
      // Eight is sufficient for each stackoff gate; big_bet_fold needs ten.
      if (tag.consumer === 'measurement') expect(changed).toBe(false);
      else if (tag.key !== 'big_bet_fold') expect(changed).toBe(true);
      else {
        m.leaks = { big_bet_fold: 10 };
        await runSelfTune('2026-09-13');
        const next = m.write.mock.calls.at(-1)![0];
        expect(next.audit.stats.proposed_bluff_frequency).not.toBe(
          baseline.proposed_bluff_frequency
        );
        expect(next.nextProfile).toEqual(next.expectedProfile);
      }
    }
  );

  it.each([
    { status: 'unknown' },
    { status: 'unavailable', reason: 'profile_changed' },
    { status: 'recorded', changed: false, replayed: true },
    { status: 'recorded', changed: true, replayed: false },
  ])('never counts an unconfirmed or replayed write as a new tune: %j', async (reply) => {
    m.write.mockResolvedValue(reply);
    expect(await runSelfTune('2026-09-13')).toEqual({ studied: 1, tuned: 0 });
    expect(m.write).toHaveBeenCalledTimes(1);
    if (reply.status !== 'recorded' || reply.changed) expect(m.complete).not.toHaveBeenCalled();
  });
  it('resumes a partial two-horse study without retuning the horse already committed', async () => {
    m.extraHorse = true;
    m.write
      .mockResolvedValueOnce({ status: 'recorded', changed: false, replayed: false })
      .mockResolvedValueOnce({ status: 'unknown' });
    expect(await runSelfTune('2026-09-13')).toEqual({ studied: 2, tuned: 0 });
    expect(m.complete).not.toHaveBeenCalled();
    m.progress.mockResolvedValue({ status: 'snapshot', horseIds: [actor] });
    m.write.mockClear();
    expect(await runSelfTune('2026-09-13')).toEqual({ studied: 2, tuned: 0 });
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
      return { status: 'recorded', changed: false, replayed: false };
    });
    await runSelfTune('2026-09-13', () => current);
    expect(m.complete).not.toHaveBeenCalled();
  });
});
