import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HorseFleetManager } from './HorseFleetManager.js';
import { fetchAllRows } from './supabase/pagination.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';

vi.mock('./supabase/pagination.js', async (original) => ({
  ...(await original<typeof import('./supabase/pagination.js')>()),
  fetchAllRows: vi.fn(),
}));

type Harness = {
  seedAllTables(): Promise<void>;
  publishFleetState(beat: unknown, duration: number): Promise<void>;
  seeding: boolean;
  overrunTicks: number;
};

describe('a horse cycle releases ownership even when its diagnostics fail', () => {
  beforeEach(() => {
    setMaintenanceFrozen(false);
    vi.mocked(fetchAllRows).mockResolvedValue({ rows: [], complete: false });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    setMaintenanceFrozen(false);
  });

  it.each([
    ['log', 0, 'EPIPE'],
    ['warn', 1, 'EAGAIN'],
  ] as const)(
    'survives %s with %s dropped ticks throwing %s and admits the next real cycle',
    async (method, dropped, code) => {
      const fleet = new HorseFleetManager() as unknown as Harness;
      const publish = vi.spyOn(fleet, 'publishFleetState').mockResolvedValue();
      fleet.overrunTicks = dropped;
      const failure = Object.assign(new Error(code), { code });
      vi.mocked(console[method]).mockImplementation((message) => {
        if (String(message).includes('Seeding cycle took')) throw failure;
      });
      await expect(fleet.seedAllTables()).rejects.toBe(failure);
      expect(publish).toHaveBeenCalledOnce();
      expect(fleet.seeding).toBe(false);
      expect(fleet.overrunTicks).toBe(0);

      vi.mocked(console[method]).mockImplementation(() => {});
      await fleet.seedAllTables();
      expect(fetchAllRows).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenCalledTimes(2);
    }
  );

  it('releases the gate after an unexpected publisher rejection', async () => {
    const fleet = new HorseFleetManager() as unknown as Harness;
    const failure = new Error('publisher rejected');
    const publish = vi
      .spyOn(fleet, 'publishFleetState')
      .mockRejectedValueOnce(failure)
      .mockResolvedValue();
    await expect(fleet.seedAllTables()).rejects.toBe(failure);
    expect(fleet.seeding).toBe(false);
    await fleet.seedAllTables();
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('keeps ownership until the final write settles, including concurrent cycle attempts', async () => {
    const fleet = new HorseFleetManager() as unknown as Harness;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publish = vi
      .spyOn(fleet, 'publishFleetState')
      .mockReturnValueOnce(pending)
      .mockResolvedValue();
    const first = fleet.seedAllTables();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(fleet.seeding).toBe(true);
    await fleet.seedAllTables();
    expect(fetchAllRows).toHaveBeenCalledOnce();
    release();
    await first;
    expect(fleet.seeding).toBe(false);
    await fleet.seedAllTables();
    expect(fetchAllRows).toHaveBeenCalledTimes(2);
  });
});
