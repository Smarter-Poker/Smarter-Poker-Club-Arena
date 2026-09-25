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
import { COUNT_UNKNOWN, COUNT_UNKNOWN_TEXT } from '../../src/lib/countFigure';

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

/* ═══════════════════════════════════════════════════════════════════════════
   THE ACTIVE FIGURE IS REAL OR IT IS UNKNOWN (2026-09-20)

   This rail's count came from fn_batch_club_realtime_active_counts, which
   reaches its seats through `club_members ... status IN ('active','approved')`.
   Diamond membership is an entitlement - ONE row, status `automatic` - so that
   join matched nobody and the figure was structurally 0: not a measurement
   that happened to be zero, an arithmetic certainty, for every player, on
   every load. lobbyFigureCache then filed that 0 as "the last known figure".

   The count now comes from live seats, and each of the three answers it can
   give prints differently.
   ═══════════════════════════════════════════════════════════════════════════ */
describe('the ACTIVE figure is real or it is unknown', () => {
  it('prints the word, not a zero, when the seat count could not be read', () => {
    const { container } = render(
      <DiamondArenaCard activePlayers={COUNT_UNKNOWN} nextFreerollAt={null} />
    );
    const value = container.querySelector('.club-card-stat .club-card-stat-value');
    expect(value?.textContent).toBe(COUNT_UNKNOWN_TEXT);
    expect(value?.className).toContain('club-card-stat-value--word');
    expect(value?.getAttribute('aria-label')).toBe(`Active ${COUNT_UNKNOWN_TEXT}`);
    /* An unknown is not an active room: the lit state must stay off. */
    expect(container.querySelector('.club-card-stat--active')).toBeNull();
  });

  it('keeps a known zero a zero, and lights up only for a real count', () => {
    const { container, rerender } = render(
      <DiamondArenaCard activePlayers={0} nextFreerollAt={null} />
    );
    expect(container.querySelector('.club-card-stat .club-card-stat-value')?.textContent).toBe('0');
    expect(container.querySelector('.club-card-stat--active')).toBeNull();

    rerender(<DiamondArenaCard activePlayers={1284} nextFreerollAt={null} />);
    expect(container.querySelector('.club-card-stat .club-card-stat-value')?.textContent).toBe(
      '1,284'
    );
    expect(container.querySelector('.club-card-stat--active')).not.toBeNull();
  });

  it('never files an unknown, and never reads a stored zero back as a figure', async () => {
    const cache = await import('../../src/lib/lobbyFigureCache');
    cache.resetLobbyFigureCacheForTests();

    render(<DiamondArenaCard activePlayers={COUNT_UNKNOWN} nextFreerollAt={null} />);
    expect(
      cache.readFigures('arena:diamond').active,
      'COUNT_UNKNOWN is a marker, not a figure, and must never reach the cache'
    ).toBeUndefined();
    cleanup();

    render(<DiamondArenaCard activePlayers={1284} nextFreerollAt={null} />);
    expect(cache.readFigures('arena:diamond').active).toBe('1284');
    cleanup();

    /* A stored zero - which every browser that opened the carousel before
       2026-09-20 already has for this scope - must not be served back as the
       last known figure while the live read is still pending. It renders as
       Dan's loading zero because nothing is KNOWN, not because the cache
       claims to have known nought. */
    cache.resetLobbyFigureCacheForTests();
    cache.rememberFigures('arena:diamond', { active: 0 });
    const { container } = render(<DiamondArenaCard activePlayers={null} nextFreerollAt={null} />);
    expect(container.querySelector('.club-card-stat .club-card-stat-value')?.textContent).toBe('0');
    expect(container.querySelector('.club-card-stat--active')).toBeNull();
    cleanup();

    /* And the same stored zero must not override a read that could not tell. */
    const unknown = render(
      <DiamondArenaCard activePlayers={COUNT_UNKNOWN} nextFreerollAt={null} />
    );
    expect(
      unknown.container.querySelector('.club-card-stat .club-card-stat-value')?.textContent
    ).toBe(COUNT_UNKNOWN_TEXT);

    cache.resetLobbyFigureCacheForTests();
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
