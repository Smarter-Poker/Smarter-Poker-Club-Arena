import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  is: vi.fn(),
  maybeSingle: vi.fn(),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: db }));
import { fetchStoppedLightningAnchor } from '../../src/lightning/lightningLeaveAnchor';
const TABLE = '11111111-1111-4111-8111-111111111111';
const OCCUPANCY = '22222222-2222-4222-8222-222222222222';
const session = { poolSessionId: null, seatTableId: TABLE, seatNumber: 2 } as any;
const row = {
  table_id: TABLE,
  user_id: 'hero',
  seat_number: 2,
  occupancy_id: OCCUPANCY,
  left_at: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  for (const fn of [db.from, db.select, db.eq, db.is]) fn.mockReturnValue(db);
});
describe('stopping between hands still leaves through the real anchor', () => {
  it('reads the current own occupancy after the pool has closed', async () => {
    db.maybeSingle.mockResolvedValue({ data: row, error: null });
    expect(await fetchStoppedLightningAnchor(session, 'hero')).toEqual({
      anchorTableId: TABLE,
      seatNumber: 2,
      occupancyId: OCCUPANCY,
    });
    expect(db.eq.mock.calls).toEqual([
      ['table_id', TABLE],
      ['user_id', 'hero'],
      ['seat_number', 2],
    ]);
    expect(db.is).toHaveBeenCalledWith('left_at', null);
  });
  it('does not invent a seat after cash-out already completed', async () => {
    db.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await fetchStoppedLightningAnchor(session, 'hero')).toBeNull();
    expect(await fetchStoppedLightningAnchor({ ...session, seatTableId: null }, 'hero')).toBeNull();
  });
  it.each([
    { ...row, user_id: 'peer' },
    { ...row, seat_number: 3 },
    { ...row, occupancy_id: null },
    { ...row, left_at: 'ended' },
  ])('refuses a changed or incomplete occupancy', async (data) => {
    db.maybeSingle.mockResolvedValue({ data, error: null });
    await expect(fetchStoppedLightningAnchor(session, 'hero')).rejects.toThrow('Unverified');
  });
  it('preserves an unreadable result as an error', async () => {
    db.maybeSingle.mockResolvedValue({ data: null, error: new Error('offline') });
    await expect(fetchStoppedLightningAnchor(session, 'hero')).rejects.toThrow('offline');
  });
});
