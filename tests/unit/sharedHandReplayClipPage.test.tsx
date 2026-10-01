/**
 * SHARED HAND REPLAY PAGE, CLIP MODE (Phase 9.1, 2026-09-30).
 *
 * `/replay?clip=1` with `window.__SP_CLIP__` injected renders the clip stage
 * from the payload: no `h=`, no footer, no database read. Without the payload
 * the page is exactly what it is today: an unreadable link says so.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ClipRow } from '@/lib/clipMode';

vi.mock('@/services/SoundService', () => ({
  soundService: new Proxy({}, { get: () => vi.fn() }),
  haptic: new Proxy({}, { get: () => vi.fn() }),
}));
vi.mock('@/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: null }) }));
const getHand = vi.fn();
vi.mock('@/services/HandHistoryService', () => ({ handHistoryService: { getHand } }));

const HERO = 'hero-uuid';
const VILLAIN = 'villain-uuid';

const ROW: ClipRow = {
  id: 'hand-uuid',
  hand_number: 77,
  game_variant: 'nlh',
  small_blind: 1,
  big_blind: 2,
  pot_size: 20,
  button_seat: 1,
  started_at: '2026-09-30T12:00:00.000Z',
  community_cards: ['7c', '2c', '9h'],
  players: [
    { userId: HERO, username: 'kingfish', seat: 1, stack: 110, cards: [] },
    { userId: VILLAIN, username: 'Emerson', seat: 2, stack: 90, cards: [] },
  ],
  actions: [
    { seat: 1, userId: HERO, action: 'raise', amount: 6, stage: 'preflop' },
    { seat: 2, userId: VILLAIN, action: 'call', amount: 4, stage: 'preflop' },
    { seat: 2, userId: VILLAIN, action: 'check', amount: 0, stage: 'flop' },
    { seat: 1, userId: HERO, action: 'bet', amount: 8, stage: 'flop' },
    { seat: 2, userId: VILLAIN, action: 'fold', amount: 0, stage: 'flop' },
  ],
  winners: [{ userId: HERO, amount: 20, potIndex: 0 }],
  winner_name: 'kingfish',
  hole_cards: null,
  showdown: null,
};

const win = window as unknown as { __SP_CLIP__?: unknown };

function inject(payload: unknown) {
  win.__SP_CLIP__ = payload;
}

async function openPage(search: string) {
  const { default: SharedHandReplayPage } = await import('@/pages/share/SharedHandReplayPage');
  render(
    <MemoryRouter initialEntries={[`/replay${search}`]}>
      <SharedHandReplayPage />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  delete win.__SP_CLIP__;
  getHand.mockClear();
});

describe('/replay?clip=1 with the injected payload', () => {
  it('renders the clip stage from the payload: no h=, no footer, no database read', async () => {
    inject({
      v: 1,
      style: 'felt-720p',
      heroId: HERO,
      row: ROW,
      privateHoleCards: { [HERO]: ['Ac', 'Kc'] },
      discardedCards: {},
      minMs: 15000,
      maxMs: 40000,
    });
    await openPage('?clip=1');
    await waitFor(() =>
      expect(document.querySelector('.hand-replay--clip')?.getAttribute('data-clip-state')).toBe(
        'ready'
      )
    );
    expect(document.querySelector('.shared-replay--clip')).not.toBeNull();
    expect(document.querySelector('.shared-replay__footer')).toBeNull();
    expect(document.body.textContent).not.toContain('Shared From');
    expect(document.body.textContent).not.toContain('Not Readable');
    expect(document.body.textContent).toContain('Seat 2');
    expect(document.body.textContent).not.toContain('Emerson');
    expect(getHand).not.toHaveBeenCalled();
    const handle = (window as unknown as { __spClip?: { v: number } }).__spClip;
    expect(handle?.v).toBe(1);
  });

  it('a malformed payload is not a clip: the link reads as today', async () => {
    inject({ v: 1, style: 'felt-720p', heroId: HERO, row: { id: 'x' } });
    await openPage('?clip=1');
    expect(await screen.findByText('This Replay Link Is Not Readable')).toBeTruthy();
    expect(document.querySelector('.hand-replay--clip')).toBeNull();
  });
});

describe('without the payload, the page is what it is today', () => {
  it('clip=1 alone still needs h=', async () => {
    await openPage('?clip=1');
    expect(await screen.findByText('This Replay Link Is Not Readable')).toBeTruthy();
    expect(document.querySelector('.shared-replay--clip')).toBeNull();
  });

  it('an ordinary link with no readable payload says so, with the lobby link', async () => {
    await openPage('?h=not-a-hand');
    expect(await screen.findByText('This Replay Link Is Not Readable')).toBeTruthy();
    expect(screen.getByText('Go To The Lobby')).toBeTruthy();
  });

  it('a payload that is present without clip=1 is ignored', async () => {
    inject({
      v: 1,
      style: 'felt-720p',
      heroId: HERO,
      row: ROW,
      privateHoleCards: {},
      discardedCards: {},
      minMs: 15000,
      maxMs: 40000,
    });
    await openPage('');
    expect(await screen.findByText('This Replay Link Is Not Readable')).toBeTruthy();
    expect(document.querySelector('.hand-replay--clip')).toBeNull();
  });
});
