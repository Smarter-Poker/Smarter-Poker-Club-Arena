import { describe, expect, it, vi } from 'vitest';
import {
  assertCashAttributionComplete,
  readRakeAttributionLedger,
} from './rakeAttributionLedger.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entry = (n: number) => ({
  id: id(n),
  hand_id: id(9001),
  player_id: id(n),
  weighted_rake_credit: '0.01',
});
const cash = { hand_id: id(9001), rake_amount: 10.05, player_contributions: { [id(1)]: 100 } };

describe('complete stored rake attribution', () => {
  it('reads beyond the 1000-row API cap and a smaller server cap', async () => {
    const entries = Array.from({ length: 1005 }, (_, i) => entry(i + 1));
    const read = vi.fn(async (_hands: string[], afterId: string | null) => ({
      data: entries.filter((r) => afterId === null || r.id > afterId).slice(0, 400),
      error: null,
    }));
    const ledger = await readRakeAttributionLedger([cash.hand_id, cash.hand_id], read);
    expect(ledger.get(cash.hand_id)?.size).toBe(1005);
    expect(read).toHaveBeenCalledTimes(4);
    expect(() => assertCashAttributionComplete([cash], ledger)).not.toThrow();
  });
  it('rejects an error on a later page instead of returning its partial result', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ data: [entry(1)], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'timeout' } });
    await expect(readRakeAttributionLedger([cash.hand_id], read)).rejects.toThrow('read failed');
  });
  it.each([null, {}, 'not a page'])('rejects missing page evidence %j', async (data) => {
    await expect(
      readRakeAttributionLedger([cash.hand_id], async () => ({ data, error: null }))
    ).rejects.toThrow('page missing');
  });
  it.each([null, '', 'NaN', 'Infinity', -1, 0.001])(
    'rejects invalid stored amounts %j',
    async (amount) => {
      await expect(
        readRakeAttributionLedger([cash.hand_id], async () => ({
          data: [{ ...entry(1), weighted_rake_credit: amount }],
          error: null,
        }))
      ).rejects.toThrow();
    }
  );
  it('rejects a repeated cursor rather than looping or multiplying a player', async () => {
    await expect(
      readRakeAttributionLedger([cash.hand_id], async () => ({ data: [entry(1)], error: null }))
    ).rejects.toThrow('cursor did not advance');
  });
  it('rejects two attribution IDs for the same hand/player', async () => {
    await expect(
      readRakeAttributionLedger([cash.hand_id], async () => ({
        data: [entry(1), { ...entry(2), player_id: id(1) }],
        error: null,
      }))
    ).rejects.toThrow('Duplicate player');
  });
  it('rejects an attribution outside the requested hands', async () => {
    await expect(
      readRakeAttributionLedger([id(9002)], async () => ({ data: [entry(1)], error: null }))
    ).rejects.toThrow('Invalid rake attribution row');
  });
  it('refuses missing and partial cash attribution even when fallback math could sum correctly', () => {
    expect(() => assertCashAttributionComplete([cash], new Map())).toThrow('incomplete');
    const partial = new Map([[cash.hand_id, new Map([[id(1), 10]])]]);
    expect(() => assertCashAttributionComplete([cash], partial)).toThrow('incomplete');
  });
  it('does not impose cash attribution on tournament or null-hand records', () => {
    expect(() =>
      assertCashAttributionComplete(
        [
          { ...cash, is_tournament: true },
          { ...cash, tournament_id: id(42) },
          { ...cash, hand_id: null },
        ],
        new Map()
      )
    ).not.toThrow();
  });
  it('does not read when there are no hand references', async () => {
    const read = vi.fn();
    expect(await readRakeAttributionLedger([], read)).toEqual(new Map());
    expect(read).not.toHaveBeenCalled();
  });
});
