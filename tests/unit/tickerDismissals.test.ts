/**
 * A CLOSE BUTTON THAT DOES NOT CLOSE IS WORSE THAN NO CLOSE BUTTON
 *
 * Two of the eight sources persisted a dismissal and six did not. Registration
 * closing, guarantees, table openings, results, service notices and club
 * updates were "dismissed" by filtering a React state array, and the next
 * thirty-second poll rebuilt that array from the database and put the message
 * straight back. The player learns the control is a lie and stops reaching for
 * it, which is the expensive part.
 *
 * One store, every source, with a TTL - because a dismissal is "not now", not
 * "never", and the two old keys had no expiry at all.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  DISMISS_TTL_MS,
  dismissItem,
  readDismissed,
  resetDismissalsForTests,
} from '../../src/components/tournament/tickerDismissals';

const NOW = 1_800_000_000_000;

beforeEach(() => {
  resetDismissalsForTests();
});

describe('every source can be closed, and stays closed', () => {
  it('remembers a dismissal across a rebuild of the feed', () => {
    /* The regression: an operational message survived its own close button
       because only its React state was filtered. */
    dismissItem('reg-t9', 'registration_closing', NOW);
    expect(readDismissed(NOW + 1_000).has('reg-t9')).toBe(true);
  });

  it('remembers each of the eight kinds', () => {
    const kinds = Object.keys(DISMISS_TTL_MS) as Array<keyof typeof DISMISS_TTL_MS>;
    kinds.forEach((kind, index) => dismissItem(`item-${index}`, kind, NOW));
    const live = readDismissed(NOW + 1_000);
    kinds.forEach((_, index) => expect(live.has(`item-${index}`)).toBe(true));
  });

  it('keeps one dismissal from silencing another', () => {
    dismissItem('soon-a', 'starting_soon', NOW);
    const live = readDismissed(NOW);
    expect(live.has('soon-a')).toBe(true);
    expect(live.has('soon-b')).toBe(false);
  });
});

describe('a dismissal is "not now", not "never"', () => {
  it('lets an operational message come back after half an hour', () => {
    /* A table that was closed at 9pm can legitimately open again at 11. */
    dismissItem('table-4', 'table_openings', NOW);
    expect(readDismissed(NOW + 29 * 60_000).has('table-4')).toBe(true);
    expect(readDismissed(NOW + 31 * 60_000).has('table-4')).toBe(false);
  });

  it('holds an alert for six hours, long past the event it is about', () => {
    dismissItem('overlay-o1', 'overlays', NOW);
    expect(readDismissed(NOW + 5 * 60 * 60_000).has('overlay-o1')).toBe(true);
    expect(readDismissed(NOW + 7 * 60 * 60_000).has('overlay-o1')).toBe(false);
  });

  it("holds a club's own notice for half a day", () => {
    dismissItem('maintenance-0-abc', 'maintenance', NOW);
    expect(readDismissed(NOW + 11 * 60 * 60_000).has('maintenance-0-abc')).toBe(true);
  });

  it('prunes what has expired instead of growing without bound', () => {
    dismissItem('table-1', 'table_openings', NOW);
    dismissItem('soon-1', 'starting_soon', NOW);
    const later = readDismissed(NOW + 60 * 60_000);
    expect(later.has('table-1')).toBe(false);
    expect(later.has('soon-1')).toBe(true);
    expect(later.size).toBe(1);
  });
});

describe('the two pre-2026-09-05 keys are imported, not orphaned', () => {
  it('carries a starting-soon dismissal forward through the deploy', () => {
    /* A player who closed an announcement thirty seconds before this shipped
       should not have it reappear because the storage key changed. */
    sessionStorage.setItem('ca_mtt_ticker_dismissed', JSON.stringify(['t1', 't2']));
    const live = readDismissed(NOW);
    expect(live.has('soon-t1')).toBe(true);
    expect(live.has('soon-t2')).toBe(true);
  });

  it('carries an overlay dismissal forward too', () => {
    sessionStorage.setItem('ca_overlay_ticker_dismissed', JSON.stringify(['o9']));
    expect(readDismissed(NOW).has('overlay-o9')).toBe(true);
  });

  it('removes the old keys once, so the import cannot loop', () => {
    sessionStorage.setItem('ca_mtt_ticker_dismissed', JSON.stringify(['t1']));
    readDismissed(NOW);
    expect(sessionStorage.getItem('ca_mtt_ticker_dismissed')).toBeNull();
  });

  it('survives a legacy value that is not an array', () => {
    sessionStorage.setItem('ca_mtt_ticker_dismissed', 'not json at all');
    expect(() => readDismissed(NOW)).not.toThrow();
  });
});

describe('storage is never allowed to break the announcement', () => {
  it('survives a corrupt store', () => {
    sessionStorage.setItem('ca_ticker_dismissed_v2', '{{{');
    expect(readDismissed(NOW).size).toBe(0);
  });

  it('survives a store holding the wrong shape', () => {
    sessionStorage.setItem('ca_ticker_dismissed_v2', JSON.stringify(['an', 'array']));
    expect(readDismissed(NOW).size).toBe(0);
  });

  it('ignores entries whose expiry is not a number', () => {
    sessionStorage.setItem(
      'ca_ticker_dismissed_v2',
      JSON.stringify({ good: NOW + 60_000, bad: 'soon' })
    );
    const live = readDismissed(NOW);
    expect(live.has('good')).toBe(true);
    expect(live.has('bad')).toBe(false);
  });
});
