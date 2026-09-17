import { describe, expect, it } from 'vitest';
import { readCashSourceBatch, verifyCashSourceRefusal } from './cashSourceReceipts.js';
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const accrued = () => ({
  receipt_version: 3,
  recorded: true,
  receipt_id: uid(1),
  rake_record_id: uid(2),
  earned_at: '2026-09-14T06:59:59.999999Z',
  attempt: 1,
  source_fingerprint: 'a'.repeat(32),
  status: 'accrued',
  reason: null,
  credits: [
    {
      player_id: uid(3),
      club_id: uid(4),
      rake_credit: 1.01,
      period_start: '2026-09-07',
      period_end: '2026-09-13',
    },
  ],
});
const blocked = () => ({
  ...accrued(),
  status: 'blocked',
  reason: 'cash_source_evidence_missing',
  credits: [],
});
const batch = (r: Record<string, unknown>) => ({
  receipt_version: 3,
  ok: r.status === 'accrued' ? 1 : 0,
  failed: r.status === 'accrued' ? 0 : 1,
  blocked: r.status === 'accrued' ? 0 : 1,
  receipts: [r],
});
describe('durable cash source receipt contract', () => {
  it('accepts one exact source and its original Pacific earning week', () => {
    expect(readCashSourceBatch(batch(accrued()), [uid(2)])[0].credits[0].rake_credit).toBe(1.01);
  });
  it.each([
    { rake_record_id: uid(99) },
    { receipt_id: 'bad' },
    { recorded: false },
    { receipt_version: 2 },
    { attempt: 0 },
    { source_fingerprint: '' },
    { reason: 'partial' },
    { credits: [] },
    { earned_at: 'not-a-date' },
  ])('rejects false identity or acknowledgement %j', (patch) => {
    expect(() => readCashSourceBatch(batch({ ...accrued(), ...patch }), [uid(2)])).toThrow();
  });
  it.each([
    { rake_credit: NaN },
    { rake_credit: Infinity },
    { rake_credit: -1 },
    { rake_credit: 0.001 },
    { rake_credit: '1.01' },
    { period_start: '2026-09-14' },
    { period_end: '2026-09-20' },
    { club_id: 'bad' },
  ])('rejects invalid source amount or week %j', (patch) => {
    const r = accrued();
    r.credits = [{ ...r.credits[0], ...patch }] as typeof r.credits;
    expect(() => readCashSourceBatch(batch(r), [uid(2)])).toThrow();
  });
  it('rejects duplicate contributors and duplicate source identities', () => {
    const r = accrued();
    r.credits.push(r.credits[0]);
    expect(() => readCashSourceBatch(batch(r), [uid(2)])).toThrow();
    expect(() =>
      readCashSourceBatch({
        receipt_version: 3,
        ok: 2,
        failed: 0,
        blocked: 0,
        receipts: [accrued(), accrued()],
      })
    ).toThrow();
  });
  it('never treats a durable refusal as a successful credit', () => {
    expect(() =>
      readCashSourceBatch({ ...batch(blocked()), ok: 1, failed: 0, blocked: 0 })
    ).toThrow();
    expect(readCashSourceBatch(batch(blocked()))[0].status).toBe('blocked');
  });
  it('rejects a success response carrying an unhandled error', () => {
    expect(() =>
      readCashSourceBatch({ ...batch(accrued()), first_error: 'posting failed' })
    ).toThrow();
  });
  it('rejects unrecorded errors despite an otherwise complete response', () => {
    expect(() => readCashSourceBatch({ ...batch(blocked()), failed: 2 })).toThrow();
  });
  it('matches immutable refusal and live retry work', () => {
    const r = readCashSourceBatch(batch(blocked()))[0];
    expect(() =>
      verifyCashSourceRefusal(
        r,
        { ...r, id: r.receipt_id, result: blocked() },
        {
          rake_record_id: r.rake_record_id,
          receipt_id: r.receipt_id,
          status: 'blocked',
          attempts: 1,
        }
      )
    ).not.toThrow();
  });
  it.each([
    { id: uid(99) },
    { reason: 'different source problem' },
    { attempt: 2 },
    { result: {} },
    { status: 'accrued' },
  ])('rejects mismatched immutable refusal readback %j', (patch) => {
    const r = readCashSourceBatch(batch(blocked()))[0];
    expect(() =>
      verifyCashSourceRefusal(
        r,
        { ...r, id: r.receipt_id, result: blocked(), ...patch },
        {
          rake_record_id: r.rake_record_id,
          receipt_id: r.receipt_id,
          status: 'blocked',
          attempts: 1,
        }
      )
    ).toThrow();
  });
  it.each([
    { rake_record_id: uid(99) },
    { receipt_id: uid(99) },
    { attempts: 0 },
    { status: 'complete' },
  ])('requires independently durable retry work %j', (patch) => {
    const r = readCashSourceBatch(batch(blocked()))[0];
    expect(() =>
      verifyCashSourceRefusal(
        r,
        { ...r, id: r.receipt_id, result: blocked() },
        {
          rake_record_id: r.rake_record_id,
          receipt_id: r.receipt_id,
          status: 'blocked',
          attempts: 1,
          ...patch,
        }
      )
    ).toThrow();
  });
  it('accepts a newer completed retry without requiring the old queue state to return', () => {
    const r = readCashSourceBatch(batch(blocked()))[0];
    expect(() =>
      verifyCashSourceRefusal(
        r,
        { ...r, id: r.receipt_id, result: blocked() },
        { rake_record_id: r.rake_record_id, receipt_id: uid(99), status: 'accrued', attempts: 2 }
      )
    ).not.toThrow();
  });
});
