import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('./supabase.js', () => ({ supabase: {} }));
vi.mock('./HorseOnboarding.js', () => ({ createHorse: vi.fn() }));
import { replacePatternedHorses } from './HorseReplacementBatch.js';
const oldIds = JSON.parse(
  readFileSync(
    new URL('../../../scripts/ci/fixtures/patterned-horse-retirement-cohort.json', import.meta.url),
    'utf8'
  )
) as string[];
const replacements = Array.from({ length: 62 }, (_, i) => ({
  retiredHorseId: oldIds[i],
  horseId: `8b27a10f-e57b-47d9-9af0-${String(i).padStart(12, '0')}`,
}));
const plan = { batch: 'patterned-retirement-20261006', replacements };
function fixture() {
  const rpc = vi.fn(async (name: string) => ({
    data:
      name === 'fn_reserve_patterned_horse_replacements'
        ? { ...plan, eligible_active: 1000, active_roster: 1000, completed_replacements: 62 }
        : { ok: true },
    error: null,
  }));
  const create = vi.fn(async ({ operation }: any) => ({
    id: operation.horseId,
    identity: {} as any,
  }));
  return { rpc, create };
}
describe('one finite original 62-replacement batch', () => {
  it('refuses a missing reservation door before any Auth account creation', async () => {
    const d = fixture();
    const refusal = { code: 'PGRST202', message: 'Original reservation function is not installed' };
    d.rpc.mockResolvedValue({ data: null, error: refusal } as any);
    await expect(replacePatternedHorses(true, d)).rejects.toEqual(refusal);
    expect(d.create).not.toHaveBeenCalled();
    expect(d.rpc).toHaveBeenCalledTimes(1);
  });
  it('inspection creates no accounts and reserves nothing', async () => {
    const d = fixture();
    expect((await replacePatternedHorses(false, d)).onboarded).toBe(0);
    expect(d.rpc).toHaveBeenCalledWith('fn_reserve_patterned_horse_replacements', {
      p_reserve: false,
    });
    expect(d.create).not.toHaveBeenCalled();
    expect(d.rpc).toHaveBeenCalledTimes(1);
  });
  it('reserves before auth, creates only the original62 and confirms the maintained roster owners', async () => {
    const d = fixture();
    const result = await replacePatternedHorses(true, d);
    expect(d.rpc.mock.invocationCallOrder[0]).toBeLessThan(d.create.mock.invocationCallOrder[0]);
    expect(d.create).toHaveBeenCalledTimes(62);
    expect(d.create.mock.calls.map((x) => x[0].operation.horseId)).toEqual(
      replacements.map((x) => x.horseId)
    );
    expect(result).toMatchObject({
      eligible_active: 1000,
      active_roster: 1000,
      seated: false,
      club_funded: false,
    });
    expect(d.rpc.mock.calls.map((x) => x[0])).toEqual([
      'fn_reserve_patterned_horse_replacements',
      'fn_ca_fleet_register_sync',
      'fn_ca_horse_roster_refresh',
      'fn_reserve_patterned_horse_replacements',
    ]);
  });
  it('stops a partial batch, then an explicit resumption uses the exact same reserved operations', async () => {
    const d = fixture();
    d.create
      .mockResolvedValueOnce({ id: replacements[0].horseId, identity: {} as any })
      .mockResolvedValueOnce(null as any);
    await expect(replacePatternedHorses(true, d)).rejects.toThrow('resume this batch');
    expect(d.create).toHaveBeenCalledTimes(2);
    expect(d.rpc).toHaveBeenCalledTimes(1);
    d.create.mockClear();
    await replacePatternedHorses(true, d);
    expect(d.create.mock.calls[0][0]).toEqual({ operation: replacements[0] });
  });
  it.each([61, 63])('refuses a changed cohort of%s before creating any account', async (count) => {
    const d = fixture();
    d.rpc.mockResolvedValue({
      data: {
        ...plan,
        replacements: Array.from({ length: count }, (_, i) => replacements[i % 62]),
      },
      error: null,
    } as any);
    await expect(replacePatternedHorses(true, d)).rejects.toThrow('cohort changed');
    expect(d.create).not.toHaveBeenCalled();
  });
  it('refuses duplicate reserved identities before creating an account', async () => {
    const d = fixture();
    d.rpc.mockResolvedValue({
      data: {
        ...plan,
        replacements: replacements.map((r, i) =>
          i === 1 ? { ...r, horseId: replacements[0].horseId } : r
        ),
      },
      error: null,
    } as any);
    await expect(replacePatternedHorses(true, d)).rejects.toThrow('duplicated');
    expect(d.create).not.toHaveBeenCalled();
  });
});

it('reports a legitimate population change without removing or hiding other horses', async () => {
  const d = fixture();
  d.rpc.mockImplementation(async (name: string) => ({
    data:
      name === 'fn_reserve_patterned_horse_replacements'
        ? {
            ...plan,
            eligible_active: 1001,
            active_roster: 1001,
            completed_replacements: 62,
            initial_active_count: 938,
            population_changed: true,
          }
        : { ok: true },
    error: null,
  }));
  await expect(replacePatternedHorses(true, d)).rejects.toThrow(
    'eligible=1001, roster=1001, completed=62'
  );
  expect(d.create).toHaveBeenCalledTimes(62);
  expect(d.rpc.mock.calls.map((x) => x[0])).toEqual([
    'fn_reserve_patterned_horse_replacements',
    'fn_ca_fleet_register_sync',
    'fn_ca_horse_roster_refresh',
    'fn_reserve_patterned_horse_replacements',
  ]);
});
