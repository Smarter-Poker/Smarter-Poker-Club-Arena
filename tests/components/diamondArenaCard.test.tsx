/**
 * THE DIAMOND ARENA IS A CLUB CARD, WITH A CLOCK ON IT.
 *
 * Dan, 2026-09-09: "THE DIAMOND ARENA CARD HAS TO LOOK AND FEEL EXACTLY LIKE
 * THE CLUB ARENA CARDS DO, SAME SQUARE SHAPE, ON THE BOTTOM HAVE AN ACTIVE
 * PLAYERS TAB, AND NEXT FREE ROLL STARTS IN X:XX TIMER." And, on review:
 * "IT SHOULDN'T SAY AUTOMATIC ENTRY ANYWHERE."
 *
 * The card used to be a 2:3 poster dropped into the carousel between two
 * four-zone club cards. These pins keep it on the club chassis, keep the two
 * figures on its rail, keep the countdown honest, and keep the words Dan
 * struck off it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import DiamondArenaCard, {
  formatFreerollCountdown,
} from '../../src/components/club/DiamondArenaCard';

/* The live read, for the states the seam cannot express: loading and a
   failed read only ever come from the database. One chainable builder whose
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('formatFreerollCountdown', () => {
  it('prints M:SS under an hour, H:MM:SS under a day, days beyond', () => {
    expect(formatFreerollCountdown(42 * 60 + 17)).toBe('42:17');
    expect(formatFreerollCountdown(5)).toBe('0:05');
    expect(formatFreerollCountdown(3 * 3600 + 5 * 60 + 9)).toBe('3:05:09');
    expect(formatFreerollCountdown(2 * 86400 + 4 * 3600 + 30)).toBe('2d 4h');
    expect(formatFreerollCountdown(0)).toBe('0:00');
  });
});

describe('DiamondArenaCard', () => {
  it('is the club card chassis: four zones, two figures on the rail', () => {
    const { container } = render(
      <DiamondArenaCard
        activePlayers={1284}
        nextFreerollAt={Date.now() + 42 * 60 * 1000 + 17_500}
      />
    );
    expect(container.querySelector('.club-card-panel.club-card-panel--arena')).not.toBeNull();
    expect(container.querySelector('.club-card-id-plate')).not.toBeNull();
    expect(container.querySelector('.club-card-viewport img')).not.toBeNull();
    expect(container.querySelector('.club-card-name-plate')?.textContent).toBe('DIAMOND ARENA');
    expect(container.querySelectorAll('.club-card-stats-row .club-card-stat')).toHaveLength(2);
    /* Dan 2026-09-11, of this card: "HAVE IT SAY JUST 'ACTIVE' AND THE NUMBER
       UNDER IT." It said ACTIVE PLAYERS until 2026-09-12, which was also the
       one label on the carousel that did not match its neighbours - every chip
       club card says ACTIVE - so the pin moved with the label. */
    expect(screen.getByText('ACTIVE')).toBeTruthy();
    expect(screen.queryByText('ACTIVE PLAYERS'), 'the label Dan asked to shorten').toBeNull();
    expect(screen.getByText('NEXT FREEROLL')).toBeTruthy();
    expect(screen.getByText('1,284')).toBeTruthy();
    expect(screen.getByRole('timer').textContent).toBe('42:17');
  });

  it('never says Automatic Entry anywhere on the card', () => {
    const { container } = render(<DiamondArenaCard activePlayers={0} nextFreerollAt={null} />);
    expect(container.innerHTML.toLowerCase()).not.toContain('automatic entry');
  });

  /* A COUNTDOWN WITH NOTHING TO COUNT TO IS NOT ZERO (2026-09-19). Until
     today this pin demanded "0:00" here, and with no Diamond freeroll on the
     calendar every player who opened the arena read a freeroll starting this
     second. The four answers the read can give each print differently now,
     and none of them borrows another's figure. */
  it('says None Scheduled, never 0:00, when the read answered and no freeroll is ahead', () => {
    const { container } = render(<DiamondArenaCard activePlayers={null} nextFreerollAt={null} />);
    const timer = screen.getByRole('timer');
    expect(timer.textContent).toBe('None Scheduled');
    expect(timer.getAttribute('aria-label')).toBe('Next Freeroll None Scheduled');
    expect(timer.className).toContain('club-card-stat-value--word');
    expect(container.querySelector('.club-card-stat--timer')?.getAttribute('title')).toBe(
      'No Freeroll Scheduled Yet'
    );
    expect(container.querySelector('.club-card-stat--imminent')).toBeNull();
  });

  it('prints zeros while the live read is still loading, like every other figure on the rail', () => {
    db.answer.mockReturnValue(new Promise(() => {}));
    render(<DiamondArenaCard activePlayers={null} />);
    const timer = screen.getByRole('timer');
    expect(timer.textContent).toBe('0:00');
    expect(timer.className).not.toContain('club-card-stat-value--word');
    expect(screen.getByTitle('Reading The Freeroll Schedule')).toBeTruthy();
  });

  it('resolves the live read to None Scheduled when no row comes back', async () => {
    db.answer.mockResolvedValue({ data: null, error: null });
    render(<DiamondArenaCard activePlayers={null} />);
    await waitFor(() => expect(screen.getByRole('timer').textContent).toBe('None Scheduled'));
  });

  it('resolves the live read to a running clock when a freeroll is ahead', async () => {
    db.answer.mockResolvedValue({
      data: {
        id: 't1',
        name: 'Midnight Freeroll',
        start_time: new Date(Date.now() + 42 * 60 * 1000 + 17_500).toISOString(),
      },
      error: null,
    });
    render(<DiamondArenaCard activePlayers={null} />);
    await waitFor(() => expect(screen.getByRole('timer').textContent).toBe('42:17'));
    const timer = screen.getByRole('timer');
    expect(timer.getAttribute('aria-label')).toBe('Next Freeroll Starts In 42:17');
    expect(timer.className).not.toContain('club-card-stat-value--word');
    expect(screen.getByTitle(/^Midnight Freeroll Starts /)).toBeTruthy();
  });

  it('says Unavailable, not 0:00 and not None Scheduled, when the read fails', async () => {
    db.answer.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    render(<DiamondArenaCard activePlayers={null} />);
    await waitFor(() => expect(screen.getByRole('timer').textContent).toBe('Unavailable'));
    const timer = screen.getByRole('timer');
    expect(timer.getAttribute('aria-label')).toBe('Next Freeroll Unavailable');
    expect(timer.className).toContain('club-card-stat-value--word');
    expect(screen.getByTitle('Could Not Read The Freeroll Schedule')).toBeTruthy();
  });

  it('ticks down once a second and turns red inside the last ten seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T00:00:00Z'));
    const { container } = render(
      <DiamondArenaCard activePlayers={3} nextFreerollAt={Date.now() + 12_000} />
    );
    expect(screen.getByRole('timer').textContent).toBe('0:12');
    expect(container.querySelector('.club-card-stat--imminent')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByRole('timer').textContent).toBe('0:09');
    expect(container.querySelector('.club-card-stat--imminent')).not.toBeNull();
  });
});
