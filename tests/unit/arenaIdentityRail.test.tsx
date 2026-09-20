/**
 * Dan 2026-09-11, verbatim: "HAVE IT SAY JUST 'ACTIVE' AND THE NUMBER UNDER
 * IT. AND THE FREE ROLL STARTS CLOCK."
 *
 * Diamond Arena is one open club. It has no join code to level up and no
 * membership to count, so the identity master's painted "PLAYING NOW" rail and
 * its level plate both say nothing true there. The arena rail replaces both
 * with the two figures that are true: who is playing now, and when the next
 * free seat is.
 *
 * The label it replaces is PAINT, not markup, so the rail has to be opaque and
 * has to sit over both zones. That is the part a later tidy-up would quietly
 * undo, so the geometry is pinned here alongside the behaviour.
 */
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COUNT_UNKNOWN, COUNT_UNKNOWN_TEXT } from '../../src/lib/countFigure';
import {
  ClubIdentityCard,
  CLUB_IDENTITY_ZONES,
} from '../../src/components/club-buttons/ClubIdentityCard';
import {
  formatFreerollCountdown,
  useDiamondFreerollCountdown,
} from '../../src/hooks/useNextDiamondFreeroll';

/* The live read behind the lobby's clock: one chainable builder whose
   terminal `maybeSingle` answers whatever the test queued. */
const db = vi.hoisted(() => ({
  answer: vi.fn<() => Promise<{ data: unknown; error: unknown }>>(),
}));
vi.mock('../../src/lib/supabase', () => {
  const builder: Record<string, unknown> = {};
  for (const m of ['from', 'select', 'eq', 'gt', 'order', 'limit']) builder[m] = () => builder;
  builder.maybeSingle = () => db.answer();
  return { supabase: builder };
});
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

beforeEach(() => {
  db.answer.mockReset();
});

const base = {
  clubName: 'Diamond Arena',
  pokerAlias: 'KingFish',
  clubId: 68294,
  playerId: 1,
};

describe('The arena identity rail', () => {
  it('prints ACTIVE with the count under it and the freeroll clock beside it', () => {
    render(
      <ClubIdentityCard
        {...base}
        level={1}
        playersPlaying={0}
        arenaStats={{
          activeCount: 1284,
          freerollText: '4:31',
          freerollTitle: 'Midnight Freeroll Starts 12:00 AM',
        }}
      />
    );
    expect(screen.getByText('ACTIVE')).toBeTruthy();
    expect(screen.getByText('1,284')).toBeTruthy();
    expect(screen.getByText('FREEROLL')).toBeTruthy();
    expect(screen.getByRole('timer')).toHaveTextContent('4:31');
  });

  it('retires the painted playing rail and the level plate it sits over', () => {
    const { container } = render(
      <ClubIdentityCard
        {...base}
        level={9}
        playersPlaying={412}
        arenaStats={{ activeCount: 0, freerollText: '0:00', freerollTitle: 'No Freeroll' }}
      />
    );
    expect(container.querySelector('.club-identity__playing')).toBeNull();
    expect(container.querySelector('.club-identity__level')).toBeNull();
    expect(screen.queryByText('Level 9')).toBeNull();
  });

  it('leaves a chip club exactly as it was', () => {
    const { container } = render(
      <ClubIdentityCard {...base} clubName="Shark Club" level={29} playersPlaying={514} />
    );
    expect(container.querySelector('.club-identity__playing')).toBeTruthy();
    expect(screen.getByText('Level 29')).toBeTruthy();
    expect(container.querySelector('.club-identity__arena')).toBeNull();
    expect(screen.queryByText('ACTIVE')).toBeNull();
  });

  it('covers both painted zones completely', () => {
    const rail = CLUB_IDENTITY_ZONES.arenaStats;
    for (const zone of [CLUB_IDENTITY_ZONES.playing, CLUB_IDENTITY_ZONES.level]) {
      expect(zone.x, 'the rail starts left of the zone it covers').toBeGreaterThanOrEqual(rail.x);
      expect(zone.x + zone.width).toBeLessThanOrEqual(rail.x + rail.width);
      expect(zone.y).toBeGreaterThanOrEqual(rail.y);
      expect(zone.y + zone.height).toBeLessThanOrEqual(rail.y + rail.height);
    }
  });

  /* The playing zone starts two pixels above the share button's bottom edge,
     so a rail that covers it must clip that corner. Paint order is what keeps
     the button whole and clickable, and paint order is a line of JSX that a
     reorder would silently change. */
  it('paints the rail before the share button so the button stays on top', () => {
    const { container } = render(
      <ClubIdentityCard
        {...base}
        arenaStats={{ activeCount: 3, freerollText: '0:30', freerollTitle: 'Freeroll' }}
      />
    );
    const nodes = [...container.querySelectorAll('.club-identity__arena, .club-identity__share')];
    expect(nodes).toHaveLength(2);
    expect(nodes[0].className).toContain('club-identity__arena');
  });

  /* Both labels share a two-column rail inside about a third of the card, so
     each has roughly 48px. "NEXT FREEROLL" did not fit and shipped clipped to
     "NEXT FREEROL". Neither label may grow past the one that already fits. */
  it('keeps both rail labels short enough to fit the column they share', () => {
    render(
      <ClubIdentityCard
        {...base}
        arenaStats={{ activeCount: 0, freerollText: '0:00', freerollTitle: 'No Freeroll' }}
      />
    );
    const labels = [...document.querySelectorAll('.club-identity__arena-label')].map(
      (n) => n.textContent ?? ''
    );
    expect(labels).toEqual(['ACTIVE', 'FREEROLL']);
    for (const label of labels) {
      expect(label.length, `${label} is too long for the rail`).toBeLessThanOrEqual(8);
    }
  });

  /* The rail is opaque because what it retires is paint. A transparent
     background would print ACTIVE on top of PLAYING NOW. */
  it('paints an opaque ground under the rail', () => {
    const css = readFileSync(
      join(__dirname, '..', '..', 'src/components/club-buttons/ClubIdentityCard.css'),
      'utf8'
    );
    const rule = css.match(/\.club-identity__arena\s*\{([^}]*)\}/);
    expect(rule, 'the rail has no rule at all').not.toBeNull();
    expect(rule![1]).toMatch(/background:\s*#[0-9a-f]{6}\s*;/i);
    expect(rule![1]).not.toMatch(/transparent|rgba\([^)]*,\s*0?\.\d+\s*\)/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   A COUNT NOBODY COULD READ IS NOT ZERO (2026-09-20)

   Both rails on this card printed the string "0" for a null. For the arena
   that was not a transient null waiting to resolve: get_club_home
   short-circuits for a diamonds arena with `access_only` and carries no
   `players_playing` key at all, so the rail printed a confident 0 on every
   single load, for ever, while the arena held 17 live tables.

   The three answers a count can give are now distinct (src/lib/countFigure.ts)
   and these pin each one to its own rendering.
   ═══════════════════════════════════════════════════════════════════════════ */
describe('The arena rail says what it could not read', () => {
  it('prints the word, not a zero, when the active count could not be read', () => {
    render(
      <ClubIdentityCard
        {...base}
        arenaStats={{
          activeCount: COUNT_UNKNOWN,
          freerollText: '4:31',
          freerollTitle: 'Midnight Freeroll Starts 12:00 AM',
        }}
      />
    );
    const value = screen.getByText(COUNT_UNKNOWN_TEXT);
    expect(value).toBeTruthy();
    expect(screen.queryByText('0'), 'an unreadable count must never render as 0').toBeNull();
    /* Sized like the other word on this rail, and read aloud as one. */
    expect(value.className).toContain('club-identity__arena-value--word');
    expect(value.getAttribute('aria-label')).toBe(`Active ${COUNT_UNKNOWN_TEXT}`);
  });

  it('keeps a known zero a zero', () => {
    render(
      <ClubIdentityCard
        {...base}
        arenaStats={{
          activeCount: 0,
          freerollText: '4:31',
          freerollTitle: 'Midnight Freeroll Starts 12:00 AM',
        }}
      />
    );
    /* Nobody seated is a real, readable answer and it prints as one. The
       defect was never "0 is wrong", it was "0 when we had not looked". */
    expect(screen.getByText('0')).toBeTruthy();
    expect(screen.queryByText(COUNT_UNKNOWN_TEXT)).toBeNull();
  });

  it("still prints Dan's loading zero before anything has asked", () => {
    render(
      <ClubIdentityCard
        {...base}
        arenaStats={{
          activeCount: null,
          freerollText: '0:00',
          freerollTitle: 'Reading The Freeroll Schedule',
        }}
      />
    );
    /* "THEY SHOULD HAVE 0'S UNTIL THE CARD LOADS." A first paint has not
       failed at anything, so it is not an unknown. */
    expect(screen.getByText('0')).toBeTruthy();
    expect(screen.queryByText(COUNT_UNKNOWN_TEXT)).toBeNull();
  });

  it('applies the same three answers to a chip club playing rail', () => {
    const { rerender } = render(<ClubIdentityCard {...base} playersPlaying={12} />);
    expect(screen.getByText('12')).toBeTruthy();

    rerender(<ClubIdentityCard {...base} playersPlaying={COUNT_UNKNOWN} />);
    expect(screen.getByText(COUNT_UNKNOWN_TEXT)).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();

    rerender(<ClubIdentityCard {...base} playersPlaying={null} />);
    expect(screen.getByText('0'), 'a pending chip club rail is unchanged').toBeTruthy();
  });
});

describe('The freeroll clock', () => {
  it('prints M:SS under an hour, H:MM:SS under a day, and days beyond', () => {
    expect(formatFreerollCountdown(0)).toBe('0:00');
    expect(formatFreerollCountdown(59)).toBe('0:59');
    expect(formatFreerollCountdown(271)).toBe('4:31');
    expect(formatFreerollCountdown(3_661)).toBe('1:01:01');
    expect(formatFreerollCountdown(180_000)).toBe('2d 2h');
  });

  /* A COUNTDOWN WITH NOTHING TO COUNT TO IS NOT ZERO (2026-09-19). With no
     Diamond freeroll on the calendar the rail printed 0:00 under FREEROLL,
     which on a clock means "starting now". The read has four answers and the
     rail prints each one as itself. */
  it('says None Scheduled when the read answered and no freeroll is ahead', async () => {
    db.answer.mockResolvedValue({ data: null, error: null });
    const hook = renderHook(() => useDiamondFreerollCountdown());
    await waitFor(() => expect(hook.result.current.state).toBe('none'));
    expect(hook.result.current.text).toBe('None Scheduled');
    expect(hook.result.current.title).toBe('No Freeroll Scheduled Yet');
    expect(hook.result.current.imminent).toBe(false);
    expect(hook.result.current.startsAt).toBeNull();
  });

  it('prints zeros while the read is loading, and is neither none nor an error', () => {
    db.answer.mockReturnValue(new Promise(() => {}));
    const hook = renderHook(() => useDiamondFreerollCountdown());
    expect(hook.result.current.state).toBe('loading');
    expect(hook.result.current.text).toBe('0:00');
    expect(hook.result.current.title).toBe('Reading The Freeroll Schedule');
  });

  it('counts down when a freeroll is scheduled', async () => {
    db.answer.mockResolvedValue({
      data: {
        id: 't1',
        name: 'Midnight Freeroll',
        start_time: new Date(Date.now() + 4 * 60 * 1000 + 31_500).toISOString(),
      },
      error: null,
    });
    const hook = renderHook(() => useDiamondFreerollCountdown());
    await waitFor(() => expect(hook.result.current.state).toBe('scheduled'));
    expect(hook.result.current.text).toBe('4:31');
    expect(hook.result.current.title).toMatch(/^Midnight Freeroll Starts /);
  });

  it('says Unavailable, never 0:00 and never None Scheduled, when the read fails', async () => {
    db.answer.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    const hook = renderHook(() => useDiamondFreerollCountdown());
    await waitFor(() => expect(hook.result.current.state).toBe('error'));
    expect(hook.result.current.text).toBe('Unavailable');
    expect(hook.result.current.title).toBe('Could Not Read The Freeroll Schedule');
  });

  it('treats the null seam as a known none and a number as scheduled, reading nothing', () => {
    const none = renderHook(() => useDiamondFreerollCountdown(null));
    expect(none.result.current.state).toBe('none');
    expect(none.result.current.text).toBe('None Scheduled');
    const soon = renderHook(() => useDiamondFreerollCountdown(Date.now() + 90_500));
    expect(soon.result.current.state).toBe('scheduled');
    expect(soon.result.current.text).toBe('1:30');
    expect(db.answer).not.toHaveBeenCalled();
  });
});

describe('The arena identity rail prints a word where a clock would be', () => {
  it('sizes None Scheduled to fit the column and reads it without Starts In', () => {
    render(
      <ClubIdentityCard
        {...base}
        arenaStats={{
          activeCount: 0,
          freerollText: 'None Scheduled',
          freerollTitle: 'No Freeroll Scheduled Yet',
          freerollIsWord: true,
        }}
      />
    );
    const timer = screen.getByRole('timer');
    expect(timer).toHaveTextContent('None Scheduled');
    expect(timer.className).toContain('club-identity__arena-value--word');
    expect(timer.getAttribute('aria-label')).toBe('Next Freeroll None Scheduled');
    expect(screen.getByTitle('No Freeroll Scheduled Yet')).toBeTruthy();
  });

  it('keeps a clock a clock', () => {
    render(
      <ClubIdentityCard
        {...base}
        arenaStats={{
          activeCount: 0,
          freerollText: '4:31',
          freerollTitle: 'Freeroll Starts 12:00 AM',
        }}
      />
    );
    const timer = screen.getByRole('timer');
    expect(timer.className).not.toContain('club-identity__arena-value--word');
    expect(timer.getAttribute('aria-label')).toBe('Next Freeroll Starts In 4:31');
  });

  it('gives the word a rule that stacks it inside the column', () => {
    const css = readFileSync(
      join(__dirname, '..', '..', 'src/components/club-buttons/ClubIdentityCard.css'),
      'utf8'
    );
    const rule = css.match(/\.club-identity__arena-value--word\s*\{([^}]*)\}/);
    expect(rule, 'the word has no rule at all').not.toBeNull();
    expect(rule![1]).toMatch(/white-space:\s*normal/);
    expect(rule![1]).toMatch(/font-size:\s*1\.75cqw/);
  });
});
