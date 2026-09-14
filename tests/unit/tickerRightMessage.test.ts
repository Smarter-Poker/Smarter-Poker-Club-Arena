/**
 * THE RIGHT MESSAGE TO THE RIGHT PLAYER
 *
 * Three things the rail said to everybody that it should have said to
 * somebody.
 *
 * 1. A PLAYER WHO HAD ALREADY PAID read the same sales line as a stranger:
 *    "Starts In 3:30 - Buy-In 11 - 24 Entered". `isRegistered` was computed on
 *    every poll and consumed by nothing except the two personal toasts. The
 *    price is the one field certainly irrelevant to someone who has paid it.
 *
 * 2. AN ANNOUNCEMENT COULD BE ABOUT ANOTHER CLUB with nothing saying so. The
 *    feed is scoped to every club the player belongs to; the rail's colours
 *    and switches come from the club they are standing in. Club B's tournament
 *    could appear painted in club A's brand on club A's table.
 *
 * 3. EVERY EVENT GOT FIVE MINUTES. A 2-chip turbo and a 500-chip Sunday major
 *    had the same last call, which is not how a room calls a tournament.
 */

import { describe, expect, it } from 'vitest';
import {
  renderTickerItem,
  startingSoonItem,
  type UpcomingTournament,
} from '../../src/components/tournament/tickerMessages';
import {
  BASE_LEAD_MS,
  isInsideLastCall,
  leadMsFor,
  MAX_LEAD_MS,
} from '../../src/components/tournament/tickerLeadWindow';

const NOW = 1_800_000_000_000;

function upcoming(over: Partial<UpcomingTournament> = {}): UpcomingTournament {
  return {
    id: 't1',
    name: 'Sunday Slam',
    startsAt: NOW + 210_000,
    clubId: 'club-a',
    buyIn: 9,
    buyInFee: 2,
    registered: 24,
    isRegistered: false,
    ...over,
  };
}

describe('a player who already paid is not a prospect', () => {
  it('drops the price and leads with the seat', () => {
    const line = renderTickerItem(startingSoonItem(upcoming({ isRegistered: true })), NOW);
    expect(line).toContain('You Are In Sunday Slam');
    expect(line).toContain('Starts In 3:30');
    expect(line).not.toMatch(/Buy-In/i);
  });

  it('changes the chip, so the news is legible before the line is read', () => {
    const seated = startingSoonItem(upcoming({ isRegistered: true }));
    expect(seated.flag).toBe('YOU ARE IN');
    expect(seated.flagShort).toBe('SEATED');
  });

  it('still sells to somebody who has not entered', () => {
    const line = renderTickerItem(startingSoonItem(upcoming({ isRegistered: false })), NOW);
    expect(line).toContain('Buy-In 11');
    expect(line).not.toContain('You Are In');
  });

  it('keeps the field count for both, because a field is why you hurry', () => {
    for (const isRegistered of [true, false]) {
      expect(renderTickerItem(startingSoonItem(upcoming({ isRegistered })), NOW)).toContain(
        '24 Entered'
      );
    }
  });
});

describe('an announcement about somewhere else says so', () => {
  it('names the other club', () => {
    const line = renderTickerItem(
      startingSoonItem(upcoming({ foreignClubName: 'Midnight Club' })),
      NOW
    );
    expect(line).toContain('At Midnight Club');
  });

  it('says nothing about the club the player is already standing in', () => {
    const line = renderTickerItem(startingSoonItem(upcoming({ foreignClubName: null })), NOW);
    expect(line).not.toMatch(/\bAt\b/);
  });

  it('puts the club right after the event, not at the end of the line', () => {
    /* A marquee gives about a second of attention and the reader needs to know
       WHERE before they finish reading what it costs. */
    const line = renderTickerItem(
      startingSoonItem(upcoming({ foreignClubName: 'Midnight Club' })),
      NOW
    );
    expect(line.indexOf('At Midnight Club')).toBeLessThan(line.indexOf('Buy-In'));
  });

  it('works for a seated player too', () => {
    const line = renderTickerItem(
      startingSoonItem(upcoming({ isRegistered: true, foreignClubName: 'Midnight Club' })),
      NOW
    );
    expect(line).toContain('You Are In');
    expect(line).toContain('At Midnight Club');
  });
});

describe('the last call is proportional to the event', () => {
  it('gives the cheapest events exactly what Dan asked for', () => {
    expect(leadMsFor(0)).toBe(BASE_LEAD_MS);
    expect(leadMsFor(2)).toBe(BASE_LEAD_MS);
    expect(leadMsFor(24)).toBe(BASE_LEAD_MS);
  });

  it('calls a mid-stake event earlier', () => {
    expect(leadMsFor(25)).toBe(10 * 60_000);
    expect(leadMsFor(99)).toBe(10 * 60_000);
  });

  it('calls a major earliest', () => {
    expect(leadMsFor(100)).toBe(15 * 60_000);
    expect(leadMsFor(500)).toBe(15 * 60_000);
  });

  it('is monotonic, so a dearer event never gets a shorter call', () => {
    let previous = 0;
    for (const total of [0, 1, 10, 24, 25, 50, 99, 100, 250, 1000]) {
      const lead = leadMsFor(total);
      expect(lead, `total ${total}`).toBeGreaterThanOrEqual(previous);
      previous = lead;
    }
  });

  it('falls back rather than trusting a number it was not given', () => {
    expect(leadMsFor(Number.NaN)).toBe(BASE_LEAD_MS);
    expect(leadMsFor(-5)).toBe(BASE_LEAD_MS);
  });

  it('never claims a lead longer than the query horizon', () => {
    for (const total of [0, 25, 100, 10_000]) {
      expect(leadMsFor(total)).toBeLessThanOrEqual(MAX_LEAD_MS);
    }
  });
});

describe('and each event is held to its own window', () => {
  it('does not announce a cheap event fifteen minutes out', () => {
    /* The query horizon is the longest rung so one read serves every stake.
       Without the per-event gate a 2-chip turbo would ride that horizon. */
    expect(isInsideLastCall(NOW + 14 * 60_000, 2, NOW)).toBe(false);
    expect(isInsideLastCall(NOW + 4 * 60_000, 2, NOW)).toBe(true);
  });

  it('does announce a major fifteen minutes out', () => {
    expect(isInsideLastCall(NOW + 14 * 60_000, 200, NOW)).toBe(true);
  });

  it('keeps the thirty seconds of grace after the gun', () => {
    expect(isInsideLastCall(NOW - 20_000, 2, NOW)).toBe(true);
    expect(isInsideLastCall(NOW - 31_000, 2, NOW)).toBe(false);
  });

  it('drains across the window the event actually has', () => {
    const major = startingSoonItem(upcoming({ buyIn: 180, buyInFee: 20 }));
    const turbo = startingSoonItem(upcoming({ buyIn: 2, buyInFee: 0 }));
    expect(major.windowMs).toBe(15 * 60_000);
    expect(turbo.windowMs).toBe(BASE_LEAD_MS);
  });
});
