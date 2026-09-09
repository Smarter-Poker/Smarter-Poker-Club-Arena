import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ from: vi.fn(), kick: vi.fn(), emit: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: mock.from } }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mock.emit } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/SeatLeaveIntent', () => ({ kickSeatWithIntent: mock.kick }));
import { adminRemovePlayerFromClubTables } from '../../src/services/IntegrityActionService';
beforeEach(() => {
  vi.resetAllMocks();
  mock.kick.mockResolvedValue({ success: true, chipsReturned: 25 });
});
function arrange(read: (table: string) => Promise<unknown>) {
  mock.from.mockImplementation(() => {
    let table = '';
    const chain: any = {};
    chain.select = chain.is = () => chain;
    chain.eq = (field: string, value: string) => {
      if (field === 'table_id') table = value;
      return chain;
    };
    chain.maybeSingle = () => read(table);
    return chain;
  });
}
describe('whole selection occupancy capture', () => {
  it('counts an accepted mid-hand request as pending rather than removed', async () => {
    arrange(() =>
      Promise.resolve({ data: { seat_number: 1, occupancy_id: 'original' }, error: null })
    );
    mock.kick.mockResolvedValue({ success: true, chipsReturned: 0, deferred: true });
    expect(await adminRemovePlayerFromClubTables(['a'], 'player', 'reason')).toEqual({
      removed: 0,
      pending: 1,
      failed: 0,
      firstError: null,
    });
  });

  it('finishes every original read before any kick and never refreshes later seats', async () => {
    let release!: (value: unknown) => void;
    arrange((table) =>
      table === 'first'
        ? Promise.resolve({ data: { seat_number: 1, occupancy_id: 'first-original' }, error: null })
        : new Promise((resolve) => {
            release = resolve;
          })
    );
    const work = adminRemovePlayerFromClubTables(['first', 'second', 'first'], 'player', 'reason');
    await vi.waitFor(() => expect(mock.from).toHaveBeenCalledTimes(2));
    expect(mock.kick).not.toHaveBeenCalled();
    release({ data: { seat_number: 2, occupancy_id: 'second-original' }, error: null });
    expect(await work).toMatchObject({ removed: 2, failed: 0 });
    expect(mock.kick.mock.calls).toEqual([
      ['first', 'player', 'reason', { seatNumber: 1, occupancyId: 'first-original' }],
      ['second', 'player', 'reason', { seatNumber: 2, occupancyId: 'second-original' }],
    ]);
    expect(mock.from).toHaveBeenCalledTimes(2);
  });
  it('reports unreadable targets as failures without dispatching them', async () => {
    arrange((table) =>
      Promise.resolve(
        table === 'missing'
          ? { data: null, error: null }
          : { data: { seat_number: 2, occupancy_id: 'original' }, error: null }
      )
    );
    expect(
      await adminRemovePlayerFromClubTables(['missing', 'present'], 'player', 'reason')
    ).toMatchObject({ removed: 1, failed: 1, firstError: 'The Original Seat Could Not Be Read.' });
    expect(mock.kick).toHaveBeenCalledTimes(1);
  });
  it('retains partial refusal counts', async () => {
    arrange((table) =>
      Promise.resolve({ data: { seat_number: 1, occupancy_id: table }, error: null })
    );
    mock.kick.mockResolvedValueOnce({ success: false, error: 'stale occupancy' });
    expect(await adminRemovePlayerFromClubTables(['a', 'b'], 'player', 'reason')).toMatchObject({
      removed: 1,
      failed: 1,
      firstError: 'stale occupancy',
    });
  });
});
