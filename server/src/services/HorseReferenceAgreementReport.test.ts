/**
 * The daily reference-agreement report job: it writes the last COMPLETE UTC
 * day, closes a day only on a complete row, claims the day before writing,
 * and never throws past its boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();
const existing = vi.hoisted(() => ({ row: null as unknown }));
const claimMock = vi.hoisted(() => vi.fn());
vi.mock('./supabase/client.js', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: existing.row, error: null }) }),
      }),
    }),
  },
}));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../benchmark/HorseLeague.js', () => ({ claimNightlyJob: claimMock }));

const load = () => import('./HorseReferenceAgreementReport.js');

describe('HorseReferenceAgreementReport', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    claimMock.mockReset();
    existing.row = null;
  });
  afterEach(async () => {
    await (await load()).stopHorseReferenceAgreementReport();
  });

  it('reports yesterday (UTC) by default through the SQL writer', async () => {
    rpcMock.mockResolvedValue({
      data: { decisions: 10, findings: 0, complete: true },
      error: null,
    });
    const { runReferenceAgreementReport } = await load();
    await expect(runReferenceAgreementReport()).resolves.toBe(true);
    const [fn, args] = rpcMock.mock.calls[0] as [string, { p_day: string }];
    expect(fn).toBe('fn_run_horse_reference_agreement');
    expect(args.p_day).toBe(new Date(Date.now() - 86_400_000).toISOString().slice(0, 10));
  });

  it('a failed or incomplete write does not close the day and never throws', async () => {
    const { runReferenceAgreementReport } = await load();
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await expect(runReferenceAgreementReport('2026-10-15')).resolves.toBe(false);
    rpcMock.mockResolvedValueOnce({ data: { complete: false }, error: null });
    await expect(runReferenceAgreementReport('2026-10-15')).resolves.toBe(false);
  });

  it('runs only inside its window, claims the day first and stands down on a lost claim', async () => {
    const mod = await load();
    mod.startHorseReferenceAgreementReport();
    rpcMock.mockResolvedValue({ data: { complete: true }, error: null });
    // Outside the 07:00-10:00 UTC window: nothing.
    await mod.referenceAgreementTickForTest(new Date('2026-10-16T05:00:00Z'));
    expect(claimMock).not.toHaveBeenCalled();
    // Lost claim: no write.
    claimMock.mockResolvedValueOnce(false);
    await mod.referenceAgreementTickForTest(new Date('2026-10-16T07:05:00Z'));
    expect(claimMock).toHaveBeenCalledWith('reference_agreement', '2026-10-15');
    expect(rpcMock).not.toHaveBeenCalled();
    // Won claim: writes 2026-10-15.
    claimMock.mockResolvedValueOnce(true);
    await mod.referenceAgreementTickForTest(new Date('2026-10-16T07:15:00Z'));
    expect(rpcMock).toHaveBeenCalledWith('fn_run_horse_reference_agreement', {
      p_day: '2026-10-15',
    });
  });

  it('does not rewrite a day that already has a complete row', async () => {
    const mod = await load();
    mod.startHorseReferenceAgreementReport();
    existing.row = { day: '2026-10-14', complete: true };
    await mod.referenceAgreementTickForTest(new Date('2026-10-15T08:00:00Z'));
    expect(claimMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
