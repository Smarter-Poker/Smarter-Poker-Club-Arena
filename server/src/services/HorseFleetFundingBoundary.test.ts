import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isChipFleetTable } from './HorseFleetFundingBoundary.js';

describe('treasury horses remain in authoritative chip games', () => {
  it('keeps chip clubs and union-only tables, refusing Diamond and unknown scope', () => {
    const rows = [
      { club_id: 'chips', arena: { id: 'chips', asset: 'chips', is_platform: false } },
      { club_id: null, union_id: 'union', arena: null },
      {
        club_id: 'diamond',
        arena: { id: 'diamond', asset: 'diamonds', is_platform: true, union_id: null },
      },
      { club_id: 'missing' },
      { club_id: 'wrong', arena: { id: 'chips', asset: 'chips', is_platform: false } },
    ];
    expect(rows.filter(isChipFleetTable)).toEqual(rows.slice(0, 2));
  });

  it('loads the authoritative arena and filters before candidate allocation', () => {
    const source = readFileSync('src/services/HorseFleetManager.ts', 'utf8');
    expect(source).toContain('arena:clubs!fk_tables_club_id(id, asset, is_platform, union_id)');
    expect(source).toContain('const tables = tablePage.rows.filter(isChipFleetTable);');
  });
});
