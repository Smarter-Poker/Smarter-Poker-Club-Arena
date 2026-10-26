import { describe, expect, it } from 'vitest';
import { sanitizeStore } from '../../src/components/lobby/AdvancedFilters';
import {
  emptyFilterValue,
  FILTER_SPECS,
  rowPassesFilter,
} from '../../src/components/lobby/advancedFilterSpec';

const legacy = (styles: string[]) => ({
  ...emptyFilterValue(FILTER_SPECS.OMAHA),
  styles,
  stylesVersion: undefined,
});
describe('saved all-style filters discover Madness after the style split', () => {
  it('includes the new Madness style when an older client had selected both existing styles', () => {
    for (const styles of [
      ['classic', 'madness'],
      ['classic', 'action'],
      ['classic', 'lightning'],
    ]) {
      const clean = sanitizeStore({ OMAHA: legacy(styles) }).OMAHA!;
      expect(clean.styles).toEqual(['classic', 'madness', 'straight_madness']);
      expect(
        rowPassesFilter(FILTER_SPECS.OMAHA, clean, {
          variant: 'plo5',
          price: 2,
          seats: 6,
          style: 'straight_madness',
          row: {},
          settings: {},
        })
      ).toBe(true);
    }
  });
  it('keeps a deliberate Classic-only or Lightning-only choice', () => {
    for (const styles of [['classic'], ['madness'], []]) {
      expect(sanitizeStore({ OMAHA: legacy(styles) }).OMAHA?.styles).toEqual(styles);
    }
  });
  it('keeps a new-client choice that explicitly excludes Madness', () => {
    const selected = { ...emptyFilterValue(FILTER_SPECS.OMAHA), styles: ['classic', 'madness'] };
    expect(sanitizeStore({ OMAHA: selected }).OMAHA?.styles).toEqual(['classic', 'madness']);
  });
  it('is idempotent across cache, remote read and refresh', () => {
    const first = sanitizeStore({ OMAHA: legacy(['classic', 'madness']) });
    expect(sanitizeStore(JSON.parse(JSON.stringify(first)))).toEqual(first);
  });
});
