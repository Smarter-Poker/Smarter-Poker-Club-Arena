import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('./HorseTunerAtomicWrite.js', () => ({ recordHorseTunerUpdate: m.write }));
import { recordObservationalHorseStudy as record } from './HorseTunerObservationalAudit.js';
import type { HorseTunerWriteRequest } from './HorseTunerAtomicWrite.js';
type MutableRequest = { -readonly [K in keyof HorseTunerWriteRequest]: HorseTunerWriteRequest[K] };
const request = (): MutableRequest => ({
  horseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  runDate: '2026-09-14',
  expectedProfile: { style: 'lag', persona: { adherence: 0.9 }, leaks: { old: 4 } },
  nextProfile: { style: 'lag', persona: { adherence: 0.9 }, tightness: 1.02, leaks: { new: 5 } },
  audit: {
    hands: 500,
    stats: { vpip: 0.6, review_all_big_loss: 5 },
    modsBefore: { tightness: 1, aggression: 1, bluffFreq: 1 },
    modsAfter: { tightness: 1.02, aggression: 0.98, bluffFreq: 0.99 },
    reasons: ['loose sample proposes tighter play'],
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  m.write.mockResolvedValue({ status: 'recorded', changed: false, replayed: false });
});
describe('observational nightly study boundary', () => {
  it('records proposals and diagnostics without changing authored or historical profile fields', async () => {
    const r = request();
    expect(await record(r)).toEqual({ status: 'recorded', changed: false, replayed: false });
    const submitted = m.write.mock.calls[0][0];
    expect(submitted.intent).toBe('observational_only');
    expect(submitted.expectedProfile).toEqual(r.expectedProfile);
    expect(submitted.nextProfile).toEqual(r.expectedProfile);
    expect(submitted.audit.modsAfter).toEqual(r.audit.modsBefore);
    expect(submitted.audit.stats).toMatchObject({
      vpip: 0.6,
      review_all_big_loss: 5,
      causal_permission: 0,
      observational_audit_version: 1,
      proposed_profile_change: 1,
      proposed_tightness: 1.02,
      proposed_aggression: 0.98,
      proposed_bluff_frequency: 0.99,
    });
    expect(submitted.audit.reasons[1]).toContain('not applied');
    expect(r.audit.modsAfter.tightness).toBe(1.02);
  });
  it.each(['lag', null, { bluff_freq: 0.9 }, { tightness: 1.5 }])(
    'preserves the exact raw profile encoding: %j',
    async (profile) => {
      const r = request();
      r.expectedProfile = profile;
      await record(r);
      expect(m.write.mock.calls[0][0].nextProfile).toEqual(profile);
    }
  );
  it('binds nested diagnostics before an asynchronous writer yields', async () => {
    let release!: (value: unknown) => void;
    m.write.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const r = request();
    const pending = record(r);
    (r.expectedProfile as { persona: { adherence: number } }).persona.adherence = 0.1;
    r.audit.stats.vpip = 0.1;
    r.audit.modsAfter.tightness = 1.18;
    const submitted = m.write.mock.calls[0][0];
    expect(submitted.nextProfile.persona.adherence).toBe(0.9);
    expect(submitted.audit.stats.vpip).toBe(0.6);
    expect(submitted.audit.stats.proposed_tightness).toBe(1.02);
    release({ status: 'recorded', changed: false, replayed: false });
    await pending;
  });
  it.each([
    { status: 'unknown' },
    { status: 'unavailable', reason: 'profile_changed' },
    { status: 'recorded', changed: false, replayed: true },
  ])('preserves uncertainty and exact replay outcomes: %j', async (reply) => {
    m.write.mockResolvedValue(reply);
    expect(await record(request())).toEqual(reply);
  });
  it('treats a contradictory changed receipt as unknown', async () => {
    m.write.mockResolvedValue({ status: 'recorded', changed: true, replayed: false });
    expect(await record(request())).toEqual({ status: 'unknown' });
  });
  it('refuses unbounded or unserializable proposals before writer I/O', async () => {
    const r = request();
    r.nextProfile = { oversized: 'a'.repeat(65537) };
    expect(await record(r)).toEqual({ status: 'unavailable', reason: 'request_budget_exceeded' });
    r.nextProfile = r;
    expect(await record(r)).toEqual({ status: 'unavailable', reason: 'invalid_request' });
    expect(m.write).not.toHaveBeenCalled();
  });
});
