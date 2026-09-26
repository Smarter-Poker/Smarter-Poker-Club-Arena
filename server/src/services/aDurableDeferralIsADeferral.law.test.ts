/**
 * A DURABLE DEFERRAL IS A DEFERRAL, HOWEVER LONG IT TOOK TO ARRIVE (2026-09-26)
 *
 * The rakeback settler held its cursor at 2026-09-22 18:29:21 from 04:19 UTC
 * onward. Every page-scoped recompute of the open week was refused with
 * cash_source_receipts_incomplete (the hands after the page have no sources
 * yet) and the function recorded that deferral on its request row. When the
 * response arrived inside the engine's 15 s deadline the settler accepted it
 * and advanced. The blocked path costs 11-28 s on production, so the response
 * was usually lost, and the read-back refused the identical durable deferral:
 * "durable receipt not confirmed: request is blocked". The cursor could never
 * move while the week was open.
 *
 * The read-back now accepts exactly what the direct path accepts: a fresh
 * request row, with an id, whose receipt is the canonical deferral for this
 * club and week. Everything else is still refused.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase.js', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn(), reportWarning: vi.fn() }));

import { judgePeriodRecomputeReceipt } from './RakebackSettlerService.js';

const expected = {
  club_id: '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',
  period_start: '2026-09-21',
  period_end: '2026-09-27',
};
const CALL_STARTED = Date.parse('2026-09-26T04:37:40.000Z');
const FRESH = '2026-09-26 04:37:57.682634+00';
const STALE = '2026-09-26 04:10:42.875120+00';
const REQUEST_ID = 'c0d4b8e2-2a6f-4c55-9b0e-6e8a2f1d9a31';

const deferral = (over: Record<string, unknown> = {}) => ({
  accounting_version: 2,
  club_id: expected.club_id,
  period_start: expected.period_start,
  period_end: expected.period_end,
  status: 'blocked',
  written: 0,
  reason: 'cash_source_receipts_incomplete',
  source_count: 316722,
  ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  id: REQUEST_ID,
  club_id: expected.club_id,
  period_start: expected.period_start,
  period_end: expected.period_end,
  status: 'blocked',
  attempts: 574,
  attempted_at: FRESH,
  last_result: deferral(),
  ...over,
});
const judge = (r: unknown) => judgePeriodRecomputeReceipt(r, 46, expected, CALL_STARTED);

describe('a durable deferral is a deferral, however long it took to arrive', () => {
  it('the live shape: a fresh blocked row carrying the canonical deferral is accepted', () => {
    expect(judge(row())).toEqual({
      verdict: 'deferred',
      requestId: REQUEST_ID,
      reason: 'cash_source_receipts_incomplete',
    });
  });

  it('NEGATIVE: an earlier attempt’s deferral is not this call’s', () => {
    expect(judge(row({ attempted_at: STALE })).verdict).toBe('not_yet');
  });

  it.each([
    ['no request identity', { id: undefined }],
    ['a malformed request identity', { id: 'not-a-uuid' }],
    ['a receipt for another club', { last_result: deferral({ club_id: REQUEST_ID }) }],
    ['a receipt for another week', { last_result: deferral({ period_start: '2026-09-14' }) }],
    ['a receipt that wrote', { last_result: deferral({ written: 1 }) }],
    ['a receipt without a reason', { last_result: deferral({ reason: '' }) }],
    ['a receipt of another version', { last_result: deferral({ accounting_version: 1 }) }],
    ['a receipt that failed', { last_result: deferral({ failed: 1 }) }],
    ['a receipt carrying an error', { last_result: deferral({ error: 'boom' }) }],
    ['a receipt another writer cleared', { last_result: {} }],
    ['a ready receipt on a blocked row', { last_result: deferral({ status: 'ready' }) }],
  ])('NEGATIVE: %s is refused', (_label, over) => {
    expect(judge(row(over)).verdict).toBe('refused');
  });

  it('NEGATIVE: a blocked receipt on a row that is no longer blocked is not a deferral', () => {
    expect(judge(row({ status: 'pending' })).verdict).toBe('refused');
    expect(judge(row({ status: 'complete' })).verdict).toBe('refused');
  });
});
