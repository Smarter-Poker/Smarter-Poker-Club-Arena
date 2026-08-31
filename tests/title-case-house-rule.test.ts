import { describe, expect, it } from 'vitest';
import { enumToTitleCase, titleCase } from '../src/utils/titleCase';

describe('Club Arena title-case house rule', () => {
  it('capitalizes the first letter of every word, including joining words', () => {
    expect(titleCase('held in trust for the club')).toBe('Held In Trust For The Club');
    expect(titleCase('return to the top of the list')).toBe('Return To The Top Of The List');
  });

  it('applies the same rule to dynamic enum labels', () => {
    expect(enumToTitleCase('player_of_the_year')).toBe('Player Of The Year');
  });

  it('preserves product acronyms and removes banned dash characters', () => {
    expect(titleCase('vip rewards — nlh and plo4')).toBe('VIP Rewards - NLH And PLO4');
  });

  it('does not corrupt machine-readable examples or numeric suffixes', () => {
    expect(titleCase('https://example.com/banner.png')).toBe('https://example.com/banner.png');
    expect(titleCase('your@email.com')).toBe('your@email.com');
    expect(titleCase('/images/promo.png')).toBe('/images/promo.png');
    expect(titleCase('spring_spins_push')).toBe('spring_spins_push');
    expect(titleCase('1st of 100x')).toBe('1st Of 100x');
    expect(titleCase('3 breach(es)')).toBe('3 Breach(es)');
  });
});
