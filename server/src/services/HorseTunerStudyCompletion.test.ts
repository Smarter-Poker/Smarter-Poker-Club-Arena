import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const m = vi.hoisted(() => ({ rpc: vi.fn(), response: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: m.rpc } }));
import {
  completeHorseTunerStudy,
  readRecordedHorseTunes,
  prepareHorseTunerStudy,
} from './HorseTunerStudyCompletion.js';
const day = '2026-09-14',
  a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
beforeEach(() => {
  vi.clearAllMocks();
  m.rpc.mockReturnValue({ abortSignal: m.response });
  m.response.mockResolvedValue({
    data: { version: 1, status: 'snapshot', runDate: day, horseIds: [a] },
    error: null,
  });
});
describe('nightly completion boundaries', () => {
  it('resumes the original roster even when the proposed roster shrinks', async () => {
    const payload = JSON.stringify({ version: 1, runDate: day, studied: 1, horseIds: [a] });
    m.response.mockResolvedValue({
      error: null,
      data: {
        version: 1,
        status: 'prepared',
        payload,
        requestHash: createHash('sha256').update(payload).digest('hex'),
      },
    });
    const result = await prepareHorseTunerStudy(day, 0, []);
    expect(result).toEqual({ status: 'prepared', studied: 1, horseIds: [a] });
    expect(Object.isFrozen(result)).toBe(true);
  });
  it.each(['digest', 'date', 'duplicate', 'budget'])(
    'refuses an invalid prepared roster %s',
    async (defect) => {
      const payload = JSON.stringify({
        version: 1,
        runDate: defect === 'date' ? '2026-09-13' : day,
        studied: defect === 'budget' ? 2049 : 2,
        horseIds: defect === 'duplicate' ? [a, a] : [a],
      });
      m.response.mockResolvedValue({
        error: null,
        data: {
          version: 1,
          status: 'prepared',
          payload,
          requestHash:
            defect === 'digest'
              ? '0'.repeat(64)
              : createHash('sha256').update(payload).digest('hex'),
        },
      });
      expect(await prepareHorseTunerStudy(day, 1, [a])).toEqual({ status: 'unknown' });
    }
  );
  it('captures bounded durable progress and freezes it', async () => {
    const r = await readRecordedHorseTunes(day);
    expect(r).toEqual({ status: 'snapshot', horseIds: [a] });
    expect(Object.isFrozen(r)).toBe(true);
    if (r.status === 'snapshot') expect(Object.isFrozen(r.horseIds)).toBe(true);
    expect(m.response.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });
  it.each([
    { version: 1, status: 'snapshot', runDate: '2026-09-13', horseIds: [a] },
    { version: 1, status: 'snapshot', runDate: day, horseIds: [a, a] },
    { version: 1, status: 'snapshot', runDate: day, horseIds: Array(2049).fill(a) },
    { version: 1, status: 'unavailable', runDate: day, horseIds: [] },
    { version: 1, status: 'snapshot', runDate: day, horseIds: ['invalid'] },
    null,
  ])('refuses incomplete, oversized or mismatched progress: %j', async (data) => {
    m.response.mockResolvedValue({ data, error: null });
    expect(await readRecordedHorseTunes(day)).toEqual({ status: 'unknown' });
  });
  it('requires a completion receipt bound to the exact request', async () => {
    m.response.mockImplementation(async () => {
      const p = m.rpc.mock.calls[0][1].p_payload;
      return {
        error: null,
        data: {
          version: 1,
          status: 'recorded',
          runDate: day,
          requestHash: createHash('sha256').update(p).digest('hex'),
          eligible: 1,
          replayed: false,
        },
      };
    });
    expect(await completeHorseTunerStudy(day, 2, [a])).toBe(true);
  });
  it.each(['hash', 'count', 'day', 'shape'])('rejects a wrong completion %s', async (field) => {
    m.response.mockImplementation(async () => {
      const p = m.rpc.mock.calls[0][1].p_payload;
      return {
        error: null,
        data: {
          version: 1,
          status: 'recorded',
          runDate: field === 'day' ? '2026-09-13' : day,
          requestHash:
            field === 'hash' ? '0'.repeat(64) : createHash('sha256').update(p).digest('hex'),
          eligible: field === 'count' ? 0 : 1,
          replayed: field === 'shape' ? null : false,
        },
      };
    });
    expect(await completeHorseTunerStudy(day, 2, [a])).toBe(false);
  });
  it.each(['2026-02-30', 'bad', '2026-13-01'])(
    'rejects invalid dates before I/O: %s',
    async (d) => {
      expect(await readRecordedHorseTunes(d)).toEqual({ status: 'unknown' });
      expect(await completeHorseTunerStudy(d, 1, [a])).toBe(false);
      expect(m.rpc).not.toHaveBeenCalled();
    }
  );
  it('refuses duplicate, too-large and undersized study declarations before I/O', async () => {
    expect(await completeHorseTunerStudy(day, 2, [a, a])).toBe(false);
    expect(await completeHorseTunerStudy(day, 0, [a])).toBe(false);
    expect(await completeHorseTunerStudy(day, 2049, [a])).toBe(false);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it('keeps lost read and completion responses unknown', async () => {
    m.response.mockRejectedValue(Error('reply lost'));
    expect(await readRecordedHorseTunes(day)).toEqual({ status: 'unknown' });
    expect(await completeHorseTunerStudy(day, 1, [a])).toBe(false);
  });
});
