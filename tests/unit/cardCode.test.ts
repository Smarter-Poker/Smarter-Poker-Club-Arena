import { describe, it, expect } from 'vitest';
import { toCardCode, toCardCodes } from '@/utils/cardCode';

/**
 * Dan 2026-08-23, screenshot of Hand Detail: the flop, turn and river all read
 * "UNDEFINE" in red beside a diamond. That is the string "undefined" with its
 * last character sliced off for a rank, and the "d" read as diamonds.
 *
 * Production stores community_cards as ["Jdiamonds","6diamonds","4clubs",...]
 * while the adapter treated every entry as { rank, suit }. The naive repair —
 * take the last character of the string — is ALSO wrong and quieter:
 * "Jdiamonds".slice(-1) is "s", so the jack of diamonds renders as a spade.
 */
describe('toCardCode', () => {
  it('parses the full-suit-word strings production actually stores', () => {
    expect(toCardCode('Jdiamonds')).toBe('Jd');
    expect(toCardCode('6diamonds')).toBe('6d');
    expect(toCardCode('4clubs')).toBe('4c');
    expect(toCardCode('Ahearts')).toBe('Ah');
    expect(toCardCode('3spades')).toBe('3s');
  });

  it('never mistakes the last letter of a suit word for the suit', () => {
    // The whole point: "Jdiamonds" ends in "s" but is a DIAMOND.
    expect(toCardCode('Jdiamonds').endsWith('s')).toBe(false);
    expect(toCardCode('Qclubs')).toBe('Qc');
    expect(toCardCode('Khearts')).toBe('Kh');
  });

  it('parses the { rank, suit } objects the hole_cards column stores', () => {
    expect(toCardCode({ rank: 'A', suit: 'spades' })).toBe('As');
    expect(toCardCode({ rank: 'K', suit: 'hearts' })).toBe('Kh');
    expect(toCardCode({ rank: '10', suit: 'd' })).toBe('Td');
  });

  it('passes canonical short codes straight through', () => {
    expect(toCardCode('As')).toBe('As');
    expect(toCardCode('Td')).toBe('Td');
    expect(toCardCode('10h')).toBe('Th');
  });

  it('refuses the literal string that produced UNDEFINE', () => {
    expect(toCardCode('undefined')).toBe('');
    expect(toCardCode('null')).toBe('');
    expect(toCardCode(undefined)).toBe('');
    expect(toCardCode(null)).toBe('');
    expect(toCardCode({})).toBe('');
    expect(toCardCode('')).toBe('');
    expect(toCardCode('Zdiamonds')).toBe('');
    expect(toCardCode('Jbananas')).toBe('');
  });

  it('drops unparseable entries rather than rendering a word as a card', () => {
    expect(toCardCodes(['Jdiamonds', 'undefined', { rank: 'A', suit: 'clubs' }, null])).toEqual([
      'Jd',
      'Ac',
    ]);
    expect(toCardCodes(undefined)).toEqual([]);
  });

  it('always yields exactly two characters for a real card', () => {
    for (const c of ['Jdiamonds', 'As', { rank: '10', suit: 'hearts' }, '10c']) {
      expect(toCardCode(c)).toHaveLength(2);
    }
  });
});
