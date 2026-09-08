import { describe, expect, it } from 'vitest';
import {
  parseArenaIdentity,
  parseTableArenaIdentity,
  assertChipFundingArena,
} from './ArenaContext.js';

describe('Arena asset boundary', () => {
  it('accepts a chip club and its existing funding path', () => {
    const arena = parseArenaIdentity({
      id: 'club',
      asset: 'chips',
      is_platform: false,
      union_id: 'union',
    });
    expect(arena.kind).toBe('chip_club');
    expect(() => assertChipFundingArena(arena)).not.toThrow();
  });
  it('recognizes global Diamond identity but refuses chip funding', () => {
    const arena = parseArenaIdentity({
      id: 'diamond',
      asset: 'diamonds',
      is_platform: true,
      union_id: null,
    });
    expect(arena.kind).toBe('diamond_arena');
    expect(() => assertChipFundingArena(arena)).toThrow('Diamond Funding Cannot Use Chip Wallets');
  });
  it.each([
    null,
    {},
    { id: 'x' },
    { id: 'x', asset: 'CHIPS', is_platform: false },
    { id: 'x', asset: 'chips', is_platform: true },
    { id: 'x', asset: 'diamonds', is_platform: true, union_id: 'union' },
  ])('never defaults malformed input to chips', (value) => {
    expect(() => parseArenaIdentity(value)).toThrow();
  });
});

describe('Authoritative table asset scope', () => {
  it('preserves union-only chip tables without inventing a club membership', () => {
    const arena = parseTableArenaIdentity({ club_id: null, union_id: 'union', arena: null });
    expect(arena).toEqual({ id: 'union', kind: 'chip_union', asset: 'chips' });
    expect(() => assertChipFundingArena(arena)).not.toThrow();
  });
  it.each([
    {},
    { club_id: null, union_id: '' },
    { club_id: 'club', union_id: 'union', arena: null },
    {
      club_id: null,
      union_id: 'union',
      arena: { id: 'diamond', asset: 'diamonds', is_platform: true, union_id: null },
    },
    {
      club_id: 'diamond',
      union_id: 'union',
      arena: { id: 'diamond', asset: 'diamonds', is_platform: true, union_id: null },
    },
    {
      club_id: 'other',
      arena: { id: 'diamond', asset: 'diamonds', is_platform: true, union_id: null },
    },
  ])('refuses missing, mismatched or cross-asset table scope %#', (table) => {
    expect(() => parseTableArenaIdentity(table)).toThrow();
  });
});
