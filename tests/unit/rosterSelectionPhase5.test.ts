import { expect, it } from 'vitest';
import {
  allLoadedSelected,
  loadedRosterSelection,
  selectLoadedRoster,
} from '../../src/utils/rosterSelection';

it('does not clear a different same-size selection when selecting loaded identities', () => {
  expect(allLoadedSelected(new Set(['retired']), ['current'])).toBe(false);
  expect(allLoadedSelected(new Set(['current']), ['current', 'current'])).toBe(true);
  expect(allLoadedSelected(new Set(), [])).toBe(false);
});
it('limits unique selected identities to the server selection ceiling without counting duplicates', () => {
  const ids = Array.from({ length: 5001 }, (_, i) => `player-${i}`);
  const selected = selectLoadedRoster([ids[0], ...ids]);
  expect(selected.size).toBe(5000);
  expect(selected.has('player-4999')).toBe(true);
  expect(selected.has('player-5000')).toBe(false);
  expect(allLoadedSelected(selected, ids)).toBe(true);
});
it('retires identities absent from the currently loaded authorized directory', () => {
  expect([
    ...loadedRosterSelection(new Set(['removed', 'still-loaded']), ['still-loaded', 'new']),
  ]).toEqual(['still-loaded']);
});
