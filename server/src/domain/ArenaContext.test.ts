import { describe, expect, it } from 'vitest';
import { parseArenaIdentity, assertChipFundingArena } from './ArenaContext.js';

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
