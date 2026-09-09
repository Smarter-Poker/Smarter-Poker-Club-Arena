/**
 * WHAT THE RAIL SAYS, AND WHICH THING SAYS IT FIRST
 *
 * Four defects from the 2026-09-05 audit are pinned here.
 *
 * THE CLOCK WAS FROZEN. "Registration Closes In 4:12" was baked into a string
 * at poll time and only the starting-soon line was recomposed by the local
 * tick, so for up to thirty seconds the bar showed a number that was simply
 * wrong - on the one message whose entire value is the number.
 *
 * THE BUY-IN WAS THE WRONG NUMBER. The bar printed `buy_in_amount`, the prize
 * side, so an 11-chip event advertised "Buy-In 9".
 *
 * NOTHING EVER EXPIRED. A custom message ran until an operator deleted it.
 *
 * AN OPERATOR COULD NOT BE HEARD OVER A TABLE OPENING. Priority was a
 * hardcoded if/else ladder in the render.
 */

import { describe, expect, it } from 'vitest';
import {
  announcementFor,
  countdown,
  FIELD_SEPARATOR,
  guaranteeItem,
  hashMessage,
  operatorItem,
  overlayItem,
  rankTickerItems,
  registrationClosingItem,
  renderTickerItem,
  secondsLeft,
  startingSoonItem,
  tableOpeningItem,
  tickerLaneFor,
  winnerResultsItem,
  type TickerItem,
  type UpcomingTournament,
} from '../../src/components/tournament/tickerMessages';
import type { OverlayAnnouncement } from '../../src/utils/overlayAnnouncements';

const NOW = 1_800_000_000_000;

function upcoming(over: Partial<UpcomingTournament> = {}): UpcomingTournament {
  return {
    id: 't1',
    name: 'DSS Saturday nlh Daily',
    startsAt: NOW + 210_000,
    clubId: 'club-1',
    buyIn: 9,
    buyInFee: 2,
    registered: 24,
    isRegistered: false,
    ...over,
  };
}

const liveOverlay: OverlayAnnouncement = {
  id: 'o1',
  name: 'Sunday Slam',
  tier: 'live',
  overlay: 8400,
  guarantee: 20000,
  prizePool: 9000,
  entered: 90,
  entriesToClose: 42,
  startsAt: NOW - 600_000,
};

describe('the clock is live, from every source', () => {
  it('substitutes the countdown at render, not at compose', () => {
    const entry = startingSoonItem(upcoming());
    // The stored parts still hold the token, so the same item renders a
    // different number a second later without being rebuilt.
    /* Title Case runs at compose, so the stored token reads `{Clock}`. The
       substitution is case-insensitive for exactly that reason. */
    expect(entry.parts.join(' ').toLowerCase()).toContain('{clock}');
    expect(renderTickerItem(entry, NOW)).toContain('3:30');
    expect(renderTickerItem(entry, NOW + 60_000)).toContain('2:30');
  });

  it('is the regression: registration-closing counts down too', () => {
    /* This is the message that used to be frozen for up to thirty seconds. */
    const entry = registrationClosingItem('t9', 'Nightly Turbo', NOW + 252_000);
    expect(renderTickerItem(entry, NOW)).toContain('4:12');
    expect(renderTickerItem(entry, NOW + 12_000)).toContain('4:00');
    expect(renderTickerItem(entry, NOW + 240_000)).toContain('0:12');
  });

  it('and so does a guarantee', () => {
    const entry = guaranteeItem('t3', 'Big Sunday', 20000, 12, NOW + 3_600_000);
    expect(renderTickerItem(entry, NOW)).toContain('60:00');
  });

  it('never renders a negative clock', () => {
    const entry = startingSoonItem(upcoming({ startsAt: NOW - 5_000 }));
    expect(renderTickerItem(entry, NOW)).toContain('0:00');
    expect(countdown(-90_000)).toBe('0:00');
  });

  it('reports the seconds left, or null when there is no clock', () => {
    expect(secondsLeft(startingSoonItem(upcoming()), NOW)).toBe(210);
    expect(secondsLeft(operatorItem('custom_messages', 0, 'Welcome'), NOW)).toBeNull();
  });
});

describe('the buy-in is what the player pays', () => {
  it('is the regression: 9 + 2 advertises as 11, not as 9', () => {
    const entry = startingSoonItem(upcoming({ buyIn: 9, buyInFee: 2 }));
    const line = renderTickerItem(entry, NOW);
    expect(line).toContain('Buy-In 11');
    expect(line).not.toContain('Buy-In 9');
  });

  it('says the event is free rather than quoting a zero', () => {
    const line = renderTickerItem(startingSoonItem(upcoming({ buyIn: 0, buyInFee: 0 })), NOW);
    expect(line).toMatch(/Free Buy/i);
  });

  it('shouts the game variant, as the house rule requires', () => {
    expect(renderTickerItem(startingSoonItem(upcoming()), NOW)).toContain('NLH');
  });

  it('counts entries with a thousands separator, never padStart', () => {
    const line = renderTickerItem(startingSoonItem(upcoming({ registered: 1234 })), NOW);
    expect(line).toContain('1,234 Entered');
  });
});

describe('everything expires', () => {
  it('drops a started event thirty seconds after the gun', () => {
    const entry = startingSoonItem(upcoming({ startsAt: NOW }));
    expect(rankTickerItems([entry], NOW + 20_000)).toHaveLength(1);
    expect(rankTickerItems([entry], NOW + 31_000)).toHaveLength(0);
  });

  it('drops a registration notice the moment the door shuts', () => {
    const entry = registrationClosingItem('t9', 'Turbo', NOW + 60_000);
    expect(rankTickerItems([entry], NOW)).toHaveLength(1);
    expect(rankTickerItems([entry], NOW + 61_000)).toHaveLength(0);
  });

  it('drops a result ten minutes after the tournament ended', () => {
    const entry = winnerResultsItem('t4', 'Deep Stack', 5000, NOW);
    expect(rankTickerItems([entry], NOW + 9 * 60_000)).toHaveLength(1);
    expect(rankTickerItems([entry], NOW + 11 * 60_000)).toHaveLength(0);
  });

  it('drops a table opening ten minutes after it opened', () => {
    const entry = tableOpeningItem('tbl1', 'Table 4', 'plo4', NOW);
    expect(rankTickerItems([entry], NOW + 11 * 60_000)).toHaveLength(0);
  });
});

describe('priority is data, and an operator can be heard', () => {
  it('an overlay still takes the bar from a countdown', () => {
    const ranked = rankTickerItems([startingSoonItem(upcoming()), overlayItem(liveOverlay)], NOW);
    expect(ranked[0].kind).toBe('overlays');
  });

  it('a countdown still takes the bar from anything operational', () => {
    const ranked = rankTickerItems(
      [
        tableOpeningItem('tbl1', 'Table 4', 'nlh', NOW),
        startingSoonItem(upcoming()),
        registrationClosingItem('t9', 'Turbo', NOW + 60_000),
      ],
      NOW
    );
    expect(ranked[0].kind).toBe('starting_soon');
  });

  it('is the fix: a service notice now outranks a table opening', () => {
    /* The whole reason the maintenance source exists is to be heard. Under the
       old if/else ladder every operational source outranked it, so "Scheduled
       Maintenance Begins Tonight" lost the bar to "New PLO Table Open". */
    const ranked = rankTickerItems(
      [
        tableOpeningItem('tbl1', 'Table 4', 'nlh', NOW),
        winnerResultsItem('t4', 'Deep Stack', 5000, NOW),
        operatorItem('maintenance', 0, 'Scheduled Maintenance Begins Tonight At 2 AM'),
      ],
      NOW
    );
    expect(ranked[0].kind).toBe('maintenance');
  });

  it('but a door closing in four minutes still beats tonight is maintenance', () => {
    const ranked = rankTickerItems(
      [
        operatorItem('maintenance', 0, 'Scheduled Maintenance Begins Tonight'),
        registrationClosingItem('t9', 'Turbo', NOW + 240_000),
      ],
      NOW
    );
    expect(ranked[0].kind).toBe('registration_closing');
  });

  it('breaks a tie on urgency, then on id, so the order never flickers', () => {
    const a = registrationClosingItem('a', 'A', NOW + 120_000);
    const b = registrationClosingItem('b', 'B', NOW + 60_000);
    expect(rankTickerItems([a, b], NOW)[0].id).toBe(b.id);
    expect(rankTickerItems([b, a], NOW)[0].id).toBe(b.id);
  });
});

describe('one bar, and the strongest claim wins it', () => {
  it('carries every item in the winning lane and nothing from another', () => {
    const lane = tickerLaneFor(
      [
        startingSoonItem(upcoming({ id: 'a' })),
        startingSoonItem(upcoming({ id: 'b', startsAt: NOW + 60_000 })),
        tableOpeningItem('tbl1', 'Table 4', 'nlh', NOW),
      ],
      NOW
    );
    expect(lane).toHaveLength(2);
    expect(lane.every((entry) => entry.lane === 'countdown')).toBe(true);
  });

  it('does not mix an overlay in with a countdown', () => {
    const lane = tickerLaneFor([startingSoonItem(upcoming()), overlayItem(liveOverlay)], NOW);
    expect(lane).toHaveLength(1);
    expect(lane[0].kind).toBe('overlays');
  });

  it('groups the four operational sources together, as the ladder did', () => {
    const lane = tickerLaneFor(
      [
        registrationClosingItem('t9', 'Turbo', NOW + 60_000),
        guaranteeItem('t3', 'Big Sunday', 20000, 12, NOW + 3_600_000),
        tableOpeningItem('tbl1', 'Table 4', 'nlh', NOW),
      ],
      NOW
    );
    expect(lane).toHaveLength(3);
  });

  it('returns nothing when there is nothing to say', () => {
    expect(tickerLaneFor([], NOW)).toEqual([]);
  });
});

describe('the copy follows the house rules', () => {
  it('joins fields with the middle dot and nothing else', () => {
    const line = renderTickerItem(startingSoonItem(upcoming()), NOW);
    expect(line).toContain(FIELD_SEPARATOR.trim());
    /* Messages are NOT joined with a character any more. An operator can type a
       bullet into a tournament name - one arrived in the screenshot that opened
       this audit - so the separator between announcements is a drawn pip in
       TickerRail, which nobody can type. */
    expect(line).not.toContain('•');
  });

  it('Title Cases every word and carries no em dash', () => {
    const line = renderTickerItem(
      operatorItem('custom_messages', 0, 'welcome to the club - good luck'),
      NOW
    );
    expect(line).toBe('Welcome To The Club - Good Luck');
    expect(line).not.toContain('—');
  });

  it('leads an overlay with the chips, because that is the reason to look', () => {
    expect(renderTickerItem(overlayItem(liveOverlay), NOW)).toMatch(/^8,400 Overlay/);
  });
});

describe('what a screen reader hears', () => {
  it('is coarse, so it does not re-announce sixty times a minute', () => {
    /* The strip used to be a polite live region wrapped around a 1Hz
       countdown. Rounded to the minute, this changes about five times across a
       five-minute window instead of three hundred. */
    const entry = startingSoonItem(upcoming());
    expect(announcementFor(entry, NOW)).toBe(announcementFor(entry, NOW + 4_000));
    expect(announcementFor(entry, NOW)).toContain('3 Minutes');
    expect(announcementFor(entry, NOW + 200_000)).toContain('Under A Minute');
  });

  it('says what pressing the bar does, because nothing else does', () => {
    expect(announcementFor(startingSoonItem(upcoming()), NOW)).toContain('Press To Register');
    expect(announcementFor(tableOpeningItem('tbl1', 'Table 4', 'nlh', NOW), NOW)).toContain(
      'Press To Open The Table'
    );
  });

  it('leads with the flag, so the kind of news arrives first', () => {
    expect(announcementFor(startingSoonItem(upcoming()), NOW)).toMatch(/^STARTING SOON/);
  });
});

describe('operator message identity', () => {
  it('is stable while the text is, so a poll does not un-dismiss it', () => {
    const a = operatorItem('custom_messages', 0, 'Freeroll At 8');
    const b = operatorItem('custom_messages', 0, 'Freeroll At 8');
    expect(a.id).toBe(b.id);
  });

  it('changes when the club rewrites the message, which is new news', () => {
    const a = operatorItem('custom_messages', 0, 'Freeroll At 8');
    const b = operatorItem('custom_messages', 0, 'Freeroll At 9');
    expect(a.id).not.toBe(b.id);
  });

  it('hashes to something short and url-safe', () => {
    expect(hashMessage('anything at all')).toMatch(/^[0-9a-z]+$/);
  });
});

describe('the shape every item keeps', () => {
  it('carries a tone, a flag, a lane and a severity', () => {
    const all: TickerItem[] = [
      startingSoonItem(upcoming()),
      overlayItem(liveOverlay),
      registrationClosingItem('t9', 'Turbo', NOW + 60_000),
      guaranteeItem('t3', 'Big Sunday', 20000, 12, NOW + 60_000),
      winnerResultsItem('t4', 'Deep', 5000, NOW),
      tableOpeningItem('tbl1', 'Table 4', 'nlh', NOW),
      operatorItem('maintenance', 0, 'Back At 3 AM'),
      operatorItem('custom_messages', 0, 'Welcome'),
    ];
    for (const entry of all) {
      expect(entry.id).toBeTruthy();
      expect(entry.flag).toBe(entry.flag.toUpperCase());
      expect(entry.severity).toBeGreaterThan(0);
      expect(entry.parts.length).toBeGreaterThan(0);
    }
  });
});
