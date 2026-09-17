import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({ rpc: vi.fn(), abort: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: m.rpc } }));
import { processHorseCommittedPotAudit } from './HorseCommittedPotAudit.js';
import {
  parseCommittedPotAuditReceipt,
  isCommittedPotAuditReceipt,
} from './horseAdaptiveJournal/commitmentReceipt.js';
const receipt = {
  version: 1,
  status: 'recorded',
  day: '2026-09-13',
  scannedHands: 256,
  horseHands: 512,
  flaggedHorseHands: 90,
  unknownHorseHands: 3,
  handGaps: 2,
  sourceCoverage: 'not_established',
  activationAuthorized: false,
  gtoVerdict: 'unverified',
};
beforeEach(() => {
  vi.stubEnv('HORSE_COMMITMENT_AUDIT', 'on');
  vi.clearAllMocks();
  m.rpc.mockReturnValue({ abortSignal: m.abort });
  m.abort.mockResolvedValue({ data: receipt, error: null });
});
afterEach(() => vi.unstubAllEnvs());
describe('daily committed-over10BB audit transport', () => {
  it('calls the real bounded SQL consumer and exposes only aggregate observations', async () => {
    m.abort.mockResolvedValue({
      data: { ...receipt, privateCards: ['As'], horseId: 'private' },
      error: null,
    });
    const r = await processHorseCommittedPotAudit();
    expect(m.rpc).toHaveBeenCalledWith('fn_horse_commitment_audit_step', {});
    expect(m.abort.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(r).toEqual({
      status: 'recorded',
      scannedHands: 256,
      horseHands: 512,
      flaggedHorseHands: 90,
      unknownHorseHands: 3,
      handGaps: 2,
    });
    expect(isCommittedPotAuditReceipt(r)).toBe(true);
  });
  it.each([
    { error: { message: 'timeout' }, data: null },
    { error: null, data: null },
  ])('preserves an unconfirmed write as unknown', async (reply) => {
    m.abort.mockResolvedValue(reply);
    expect((await processHorseCommittedPotAudit()).status).toBe('unknown');
  });
  it('does not turn a rejected transport into a completed audit', async () => {
    m.abort.mockRejectedValue(Error('lost'));
    expect((await processHorseCommittedPotAudit()).status).toBe('unknown');
  });
  it.each(['off', 'typo'])('does not query when configuration is %s', async (mode) => {
    vi.stubEnv('HORSE_COMMITMENT_AUDIT', mode);
    expect((await processHorseCommittedPotAudit()).status).toBe(
      mode === 'off' ? 'disabled' : 'unknown'
    );
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { sourceCoverage: 'complete' },
    { activationAuthorized: true },
    { gtoVerdict: 'correct' },
    { scannedHands: NaN },
    { scannedHands: 255 },
    { horseHands: 2561 },
    { flaggedHorseHands: 513 },
    { unknownHorseHands: 600 },
    { handGaps: 257 },
    { status: 'pass_complete' },
    { version: 2 },
  ])('rejects malformed or inflated evidence %j', (over) => {
    expect(parseCommittedPotAuditReceipt({ ...receipt, ...over }).status).toBe('unknown');
  });
  it('distinguishes a completed eligibility pass from completed GTO review', () => {
    const r = parseCommittedPotAuditReceipt({
      ...receipt,
      status: 'pass_complete',
      scannedHands: 2,
      horseHands: 2,
      flaggedHorseHands: 1,
      unknownHorseHands: 1,
      handGaps: 1,
    });
    expect(r.status).toBe('pass_complete');
    expect(isCommittedPotAuditReceipt(r)).toBe(true);
    expect(isCommittedPotAuditReceipt({ ...r, status: 'idle' })).toBe(false);
    expect(isCommittedPotAuditReceipt({ ...r, flaggedHorseHands: Infinity })).toBe(false);
  });
});
