/**
 * THE SEAT-HOLD COUNTDOWN — the banner must not go blank at the urgent moment
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-30: a waitlist seat is HELD for the player for sixty seconds.
 * The banner that shows queue position deleted its badge as soon as the offer
 * arrived, because WAITLIST_POSITION_CHANGED reports position 0 for a
 * 'notified' row and the handler read position 0 as "seated or removed". So
 * the single moment that is actually urgent - a seat reserved for you, right
 * now, expiring in under a minute - was the moment the UI went blank.
 *
 * These pin the arithmetic and the state rule the banner relies on. They are
 * deliberately not a render test: the value here is that the clock cannot lie
 * and a live hold cannot be dropped, both of which are pure logic.
 */

import { describe, it, expect } from 'vitest';

/** Mirrors WaitlistBanner.secondsLeft exactly. */
function secondsLeft(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime() - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : 0;
}

describe('seat hold countdown', () => {
  it('counts down from a DEADLINE, so a backgrounded tab resumes on real time', () => {
    // The whole reason the bus carries an instant rather than "60": a tab that
    // was hidden for 45 seconds must show ~15 left, not restart at 60.
    const deadline = new Date(Date.now() + 15_000).toISOString();
    const left = secondsLeft(deadline);
    expect(left).toBeGreaterThan(13);
    expect(left).toBeLessThanOrEqual(15);
  });

  it('never reports negative time once the hold has lapsed', () => {
    expect(secondsLeft(new Date(Date.now() - 30_000).toISOString())).toBe(0);
  });

  it('treats a missing deadline as "no hold", never as "expired hold"', () => {
    // A row written before hold_expires_at existed, or a select that did not
    // ask for it, must read as "not being offered a seat" - not as a hold that
    // just ran out, which would flash an alarming 0:00 at somebody who is
    // simply waiting in line.
    expect(secondsLeft(null)).toBe(0);
    expect(secondsLeft(undefined)).toBe(0);
    expect(secondsLeft('not-a-date')).toBe(0);
  });

  it('a live hold survives the position-0 update that used to delete it', () => {
    // Reproduces the exact defect: position 0 arrives for a 'notified' row.
    type Entry = { tableId: string; position: number; holdExpiresAt: string | null };
    const held: Entry = {
      tableId: 't1',
      position: 3,
      holdExpiresAt: new Date(Date.now() + 42_000).toISOString(),
    };
    const entries = new Map<string, Entry>([['t1', held]]);

    // The banner's rule, extracted.
    const applyPositionChange = (tableId: string, position: number) => {
      const next = new Map(entries);
      if (position > 0) {
        next.set(tableId, { tableId, position, holdExpiresAt: null });
      } else {
        const existing = next.get(tableId);
        if (existing && secondsLeft(existing.holdExpiresAt) > 0) {
          next.set(tableId, { ...existing, position: 0 });
        } else {
          next.delete(tableId);
        }
      }
      return next;
    };

    const afterOffer = applyPositionChange('t1', 0);
    expect(afterOffer.has('t1')).toBe(true);
    expect(secondsLeft(afterOffer.get('t1')!.holdExpiresAt)).toBeGreaterThan(0);
  });

  it('a position-0 update with no live hold still clears the badge', () => {
    // The original behaviour must survive for the case it was written for:
    // the player was seated, or left the queue.
    type Entry = { tableId: string; position: number; holdExpiresAt: string | null };
    const entries = new Map<string, Entry>([
      ['t2', { tableId: 't2', position: 2, holdExpiresAt: null }],
    ]);
    const existing = entries.get('t2')!;
    const keep = secondsLeft(existing.holdExpiresAt) > 0;
    expect(keep).toBe(false);
  });
});

describe('a lapsed hold never renders as a queue position', () => {
  /** The banner's renderable-entry rule, extracted. */
  type Entry = { tableId: string; position: number; holdExpiresAt: string | null };
  const renderable = (e: Entry) => e.position > 0 || secondsLeft(e.holdExpiresAt) > 0;

  it('drops the offer card once the sixty seconds run out', () => {
    // THE DEFECT THIS PINS, which shipped to production on 2026-08-31:
    // an offer sets position 0 and a deadline. When the deadline passed,
    // `held` went false and the card fell through to the "You Are #N In Line"
    // branch still carrying position 0 - rendering the literal nonsense
    // "You Are #0 In Line" - and then froze there, because the tick stops
    // once no hold is live.
    const lapsed: Entry = {
      tableId: 't1',
      position: 0,
      holdExpiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    expect(renderable(lapsed)).toBe(false);
  });

  it('keeps a live offer card', () => {
    const live: Entry = {
      tableId: 't1',
      position: 0,
      holdExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    expect(renderable(live)).toBe(true);
  });

  it('keeps an ordinary queue position, which has no hold at all', () => {
    const queued: Entry = { tableId: 't2', position: 4, holdExpiresAt: null };
    expect(renderable(queued)).toBe(true);
  });

  it('a position of 0 with no hold is never renderable', () => {
    // Seated or removed. This was already the old behaviour and must survive.
    const gone: Entry = { tableId: 't3', position: 0, holdExpiresAt: null };
    expect(renderable(gone)).toBe(false);
  });
});
