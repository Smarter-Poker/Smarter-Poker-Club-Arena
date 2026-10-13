import { describe, expect, it } from 'vitest';
import { assertDiamondCashTable, hasDiamondCashClusterShape } from './DiamondCashBoundary.js';
import { isDiamondArenaCashTable } from '../services/HorseFleetFundingBoundary.js';

const arena = '002c2d27-9584-4e52-835a-bb2be148fc81';
const cluster = '33333333-3333-4333-8333-333333333333';
const table = {
  club_id: arena,
  union_id: null,
  arena: { id: arena, asset: 'diamonds', is_platform: true, union_id: null },
  cluster_id: cluster,
  role: 'main',
  main_index: 1,
  lifecycle: 'live',
  game_variant: 'nlh',
  tournament_id: null,
  status: 'running',
  small_blind: 1,
  big_blind: 2,
  min_buy_in: 20,
  max_buy_in: 200,
  ante: 0,
  rake_percent: 0,
  rake_cap_bb: 0,
  bbj_percent: 0,
  run_it_twice: false,
  allow_run_it_twice: false,
};

describe('a Diamond must-move table retains the Diamond funding boundary', () => {
  it('admits a declared main and feeder through the same table and horse-cycle boundaries', () => {
    for (const row of [
      table,
      { ...table, role: 'feeder', main_index: null, lifecycle: 'opening' },
    ]) {
      expect(() => assertDiamondCashTable(row)).not.toThrow();
      expect(isDiamondArenaCashTable(row, arena)).toBe(true);
    }
  });

  it('refuses an unconfigured or malformed cluster before a hand can start', () => {
    for (const change of [
      { cluster_id: 'unknown' },
      { role: null },
      { main_index: 0 },
      { main_index: 1.5 },
      { lifecycle: null },
      { lifecycle: 'closed' },
      { cluster_id: null, lifecycle: 'opening' },
    ]) {
      const row = { ...table, ...change };
      expect(hasDiamondCashClusterShape(row)).toBe(false);
      expect(() => assertDiamondCashTable(row)).toThrow();
      expect(isDiamondArenaCashTable(row, arena)).toBe(false);
    }
  });

  it('keeps the original no-chip-fee and whole-Diamond safeguards on a cluster', () => {
    for (const change of [
      { rake_percent: -1 },
      { rake_cap_bb: -1 },
      { bbj_percent: 100 },
      { insurance_enabled: true },
      { nit_game: true },
      { seven_deuce_enabled: true },
      { min_buy_in: 20.5 },
      { big_blind: 2.5 },
    ])
      expect(() => assertDiamondCashTable({ ...table, ...change })).toThrow();
  });

  it('preserves unclustered plain-table compatibility before ladder activation', () => {
    const plain = { ...table, cluster_id: null, role: null, main_index: null, lifecycle: null };
    expect(() => assertDiamondCashTable(plain)).not.toThrow();
    expect(isDiamondArenaCashTable(plain, arena)).toBe(true);
  });
});
