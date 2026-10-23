import { describe, expect, it, beforeEach } from 'vitest';
import {
  __setPloRosterForTest,
  isOpenStakePlo,
  ploRosterAllows,
  PLO_OPEN_MAX_BIG_BLIND,
} from './HorsePloRoster.js';

/* Dan 2026-10-23 12:59: "all horses can play the lower stakes plo games under
   .10-.25 and .25-.50. make sure thats enabled". The PLO roster gates 0.50/1
   and up only. */
describe('the PLO roster gates only the stakes above 0.25/0.50', () => {
  beforeEach(() => __setPloRosterForTest(['proven-winner']));

  it('opens 0.10/0.25 and 0.25/0.50 PLO to every horse', () => {
    for (const variant of ['plo4', 'plo5', 'plo6', 'plo8']) {
      expect(ploRosterAllows('any-horse', variant, 0.25)).toBe(true);
      expect(ploRosterAllows('any-horse', variant, '0.50')).toBe(true);
    }
    expect(PLO_OPEN_MAX_BIG_BLIND).toBe(0.5);
  });

  it('keeps 0.50/1 and 1/2 PLO to the proven winners', () => {
    expect(ploRosterAllows('any-horse', 'plo4', 1)).toBe(false);
    expect(ploRosterAllows('any-horse', 'plo5', '2.00')).toBe(false);
    expect(ploRosterAllows('proven-winner', 'plo5', 2)).toBe(true);
  });

  it('never widens the gate on an unknown blind', () => {
    expect(isOpenStakePlo(undefined)).toBe(false);
    expect(isOpenStakePlo('x')).toBe(false);
    expect(isOpenStakePlo(0)).toBe(false);
    expect(ploRosterAllows('any-horse', 'plo4')).toBe(false);
  });

  it('an unread roster still seats nobody above the open stakes', () => {
    __setPloRosterForTest(null);
    expect(ploRosterAllows('any-horse', 'plo4', 1)).toBeUndefined();
    expect(ploRosterAllows('any-horse', 'plo4', 0.5)).toBe(true);
  });

  it('leaves every other variant alone', () => {
    expect(ploRosterAllows('any-horse', 'nlh', 2)).toBe(true);
  });
});
