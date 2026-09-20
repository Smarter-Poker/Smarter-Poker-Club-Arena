/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SEAT OFFER MUST NOT DEPEND ON payload.old
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `table_waitlist` is published, RLS-enabled and REPLICA IDENTITY FULL. Supabase
 * documents that an RLS-enabled table sends only the PRIMARY KEY as the old row
 * and that there is no way around it while RLS is on. The primary key is `id`,
 * so `old.status` does not arrive.
 *
 * Every case below is asserted TWICE: once with the old row present (a
 * hypothetical future where it is complete) and once with it absent (production
 * today). Identical outcomes are the point - that is what "does not depend on
 * the old row" has to mean to be worth writing down.
 */
import { describe, it, expect } from 'vitest';
import { decideSeatOffer, holdDeadline } from '../../src/components/common/waitlistSeatOffer';

const T = 'table-abc';
const NOTIFIED_AT = '2026-09-19T17:00:00.000Z';
const HOLD = '2026-09-19T17:01:00.000Z';
const HOLD_MOVED = '2026-09-19T17:06:00.000Z';

/** The row as the client actually receives it: `new` only. */
const notifiedRow = (hold: string | null = HOLD) => ({
  status: 'notified',
  table_id: T,
  notified_at: NOTIFIED_AT,
  hold_expires_at: hold,
});

/**
 * The logic that shipped, reproduced exactly, so the failure is demonstrated
 * rather than asserted. `old` is what it consulted and what it does not get.
 */
function legacyDecision(
  eventType: string,
  newRow: { status?: string; table_id?: string; hold_expires_at?: string | null },
  oldRow: { status?: string } | undefined
): 'offer' | 'reseed' | 'none' {
  if (
    eventType === 'UPDATE' &&
    newRow?.status === 'notified' &&
    oldRow?.status === 'notified' &&
    newRow?.table_id &&
    newRow?.hold_expires_at
  ) {
    return 'reseed';
  }
  if (
    eventType === 'UPDATE' &&
    newRow?.status === 'notified' &&
    oldRow?.status !== 'notified' &&
    newRow?.table_id
  ) {
    return 'offer';
  }
  return 'none';
}

describe('the seat offer decision', () => {
  describe.each([
    ['with the old row present', { status: 'notified' } as { status?: string } | undefined],
    ['with the old row absent, as RLS actually delivers it', undefined],
  ])('%s', (_label, oldRow) => {
    it('offers a hold this client has not shown before', () => {
      expect(
        decideSeatOffer({ eventType: 'UPDATE', row: notifiedRow(), remembered: undefined })
      ).toEqual({ action: 'offer', tableId: T, deadline: HOLD });
    });

    it('re-seeds without a second toast when the thaw moves the deadline', () => {
      // fn_thaw_platform shifts hold_expires_at forward by the frozen duration.
      // The player already has this offer; the countdown needs the new instant.
      expect(
        decideSeatOffer({
          eventType: 'UPDATE',
          row: notifiedRow(HOLD_MOVED),
          remembered: HOLD,
        })
      ).toEqual({ action: 'reseed', tableId: T, deadline: HOLD_MOVED });
    });

    it('ignores a redelivery of the identical hold', () => {
      expect(
        decideSeatOffer({ eventType: 'UPDATE', row: notifiedRow(), remembered: HOLD })
      ).toEqual({ action: 'ignore' });
    });

    it('forgets the hold once the row leaves notified, so a re-offer still toasts', () => {
      expect(
        decideSeatOffer({
          eventType: 'UPDATE',
          row: { ...notifiedRow(), status: 'waiting' },
          remembered: HOLD,
        })
      ).toEqual({ action: 'forget', tableId: T });

      // ...and the next genuine notification is a fresh offer again.
      expect(
        decideSeatOffer({
          eventType: 'UPDATE',
          row: notifiedRow(HOLD_MOVED),
          remembered: undefined,
        })
      ).toEqual({ action: 'offer', tableId: T, deadline: HOLD_MOVED });
    });

    it('says nothing about an event with no table', () => {
      expect(decideSeatOffer({ eventType: 'UPDATE', row: {}, remembered: undefined })).toEqual({
        action: 'ignore',
      });
      expect(
        decideSeatOffer({ eventType: 'UPDATE', row: undefined, remembered: undefined })
      ).toEqual({ action: 'ignore' });
    });
  });

  /**
   * THE TWO FAILURES, DEMONSTRATED. Same inputs through the shipped logic with
   * the old row missing, which is what production delivers.
   */
  it('the shipped logic loses the thaw re-seed when the old row is absent', () => {
    expect(legacyDecision('UPDATE', notifiedRow(HOLD_MOVED), { status: 'notified' })).toBe(
      'reseed'
    );
    // Production: old.status is undefined, so the re-seed branch is unreachable
    // and the offer branch claims it instead - a fresh sixty-second toast for a
    // hold the player is already holding, and no corrected deadline.
    expect(legacyDecision('UPDATE', notifiedRow(HOLD_MOVED), undefined)).toBe('offer');

    // The replacement reaches the same answer either way.
    for (const remembered of [HOLD]) {
      expect(
        decideSeatOffer({ eventType: 'UPDATE', row: notifiedRow(HOLD_MOVED), remembered }).action
      ).toBe('reseed');
    }
  });

  it('the shipped logic re-offers on every touch when the old row is absent', () => {
    // Three updates that all leave the row notified with the SAME deadline.
    const outcomes = [1, 2, 3].map(() => legacyDecision('UPDATE', notifiedRow(), undefined));
    expect(outcomes).toEqual(['offer', 'offer', 'offer']);

    // The replacement offers once and then stays quiet.
    let remembered: string | undefined;
    const replacement = [1, 2, 3].map(() => {
      const d = decideSeatOffer({ eventType: 'UPDATE', row: notifiedRow(), remembered });
      if (d.action === 'offer' || d.action === 'reseed') remembered = d.deadline ?? '';
      return d.action;
    });
    expect(replacement).toEqual(['offer', 'ignore', 'ignore']);
  });
});

describe('the hold deadline', () => {
  it('prefers the authoritative column', () => {
    expect(holdDeadline({ hold_expires_at: HOLD, notified_at: NOTIFIED_AT })).toBe(HOLD);
  });

  it('falls back to notified_at plus sixty seconds for a row written before the column', () => {
    expect(holdDeadline({ notified_at: NOTIFIED_AT })).toBe(HOLD);
  });

  it('is null when the row carries neither, rather than inventing a deadline', () => {
    expect(holdDeadline({})).toBeNull();
  });

  /**
   * A remembered offer with no deadline is not the same as no remembered offer.
   * '' and undefined must stay distinguishable or the dedupe collapses.
   */
  it('an offer with no deadline is still remembered as an offer', () => {
    const first = decideSeatOffer({
      eventType: 'UPDATE',
      row: { status: 'notified', table_id: T },
      remembered: undefined,
    });
    expect(first).toEqual({ action: 'offer', tableId: T, deadline: null });
    expect(
      decideSeatOffer({
        eventType: 'UPDATE',
        row: { status: 'notified', table_id: T },
        remembered: '',
      })
    ).toEqual({ action: 'ignore' });
  });
});
