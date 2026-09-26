/**
 * THE LOBBY'S DAY GROUPS FOLLOW THE CALENDAR (2026-09-26).
 *
 * The tournament lobby grouped every event starting 6 to 24 hours out as
 * "Tomorrow" and everything past 24 hours as "Coming Soon". At 09:00 an event
 * at 20:00 the same evening was listed under Tomorrow, and at 23:00 an event
 * at 20:00 the next evening was listed under Coming Soon. "Later Today" and
 * "Tomorrow" name calendar days, so the groups are now read off the viewer's
 * local calendar. Dates are built from local components so the test holds in
 * any time zone.
 */
import { describe, expect, it } from 'vitest';
import { tournamentLobbyTimeGroup } from '../../src/utils/tournamentLobbyTimeGroup';

const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute, 0, 0);
const group = (start: Date, now: Date) =>
  tournamentLobbyTimeGroup(start.toISOString(), now.getTime());

describe('tournamentLobbyTimeGroup', () => {
  const morning = at(26, 9);

  it('keeps the near-term groups by minutes', () => {
    expect(group(at(26, 8, 59), morning).label).toBe('Now');
    expect(group(at(26, 9, 20), morning).label).toBe('Starting Soon (< 30 Min)');
    expect(group(at(26, 10, 30), morning).label).toBe('Next Hour (30 Min - 2 Hours)');
    expect(group(at(26, 13), morning).label).toBe('Later Today');
  });

  it('lists an event later the same evening under Later Today, not Tomorrow', () => {
    expect(group(at(26, 20), morning)).toEqual({ label: 'Later Today', order: 3 });
    expect(group(at(26, 23, 59), morning).label).toBe('Later Today');
  });

  it('lists an event on the next calendar day under Tomorrow, however far into it', () => {
    const lateNight = at(26, 23);
    expect(group(at(27, 3), lateNight).label).toBe('Tomorrow');
    expect(group(at(27, 20), lateNight)).toEqual({ label: 'Tomorrow', order: 4 });
    expect(group(at(27, 8), morning).label).toBe('Tomorrow');
  });

  it('lists two days out and later under Coming Soon', () => {
    expect(group(at(28, 0, 1), morning)).toEqual({ label: 'Coming Soon', order: 5 });
    expect(group(at(28, 8), at(26, 23)).label).toBe('Coming Soon');
  });

  it('crosses a month boundary by calendar day', () => {
    const lastNight = new Date(2026, 8, 30, 22, 0, 0, 0);
    expect(group(new Date(2026, 9, 1, 21, 0, 0, 0), lastNight).label).toBe('Tomorrow');
    expect(group(new Date(2026, 9, 2, 1, 0, 0, 0), lastNight).label).toBe('Coming Soon');
  });
});
