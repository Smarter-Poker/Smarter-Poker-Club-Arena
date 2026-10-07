/**
 * SHARED HAND REPLAY PAGE, CLIP MODE (Phase 9.1, 2026-09-30; the arena's own
 * replayer since 2026-10-07).
 *
 * `/replay?clip=1` with `window.__SP_CLIP__` injected renders the hand
 * replayer as the arena shows it, from the payload, pixel for pixel (owner
 * decision, Dan, 2026-10-07): every screen name, the table name and the hand
 * number in the header, the transport and the seat strip, the camera
 * contract on top, and NO share footer, because the arena's replayer has
 * none. No `h=`, no database read. Without the payload the page is exactly
 * what it is today: a link renders the replayer with the footer under it,
 * and an unreadable link says so.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ClipRow } from '@/lib/clipMode';
import { encodeHand } from '@/components/table/ShareHand';
import { shareableFromModel } from '@/lib/shareHandModel';
import { buildReplay, replayInputFromRow } from '@/utils/handReplay';

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
  it("renders the arena's replayer from the payload: every screen name, the table name and hand number in the header, no footer, no h=, no database read", async () => {
    inject({
      v: 1,
      style: 'felt-720p',
      heroId: HERO,
      row: ROW,
      tableName: 'Kingfish Club',
      privateHoleCards: { [HERO]: ['Ac', 'Kc'] },
      discardedCards: {},
      minMs: 15000,
      maxMs: 40000,
    });
    await openPage('?clip=1');
    await waitFor(() =>
      expect(document.querySelector('.hand-replay')?.getAttribute('data-clip-state')).toBe('ready')
    );
    /* The column the arena's by-id page holds the replayer in (the same frame
       as `.hand-replayer-page`), not a clip frame of its own. */
    expect(document.querySelector('.shared-replay')).not.toBeNull();
    expect(document.querySelector('.shared-replay')?.children).toHaveLength(1);
    expect(document.querySelector('.shared-replay > .hand-replay')).not.toBeNull();
    expect(document.querySelector('.shared-replay--clip')).toBeNull();
    expect(document.querySelector('.hand-replay--clip')).toBeNull();
    expect(document.querySelector('.hand-replay__clip-eyebrow')).toBeNull();
    /* The header the arena prints: the table name, the blinds, the hand number. */
    const header = document.querySelector('.hand-replay__header');
    expect(header).not.toBeNull();
    expect(header?.querySelector('.hand-replay__eyebrow')?.textContent).toContain('Kingfish Club');
    expect(header?.querySelector('.hand-replay__title')?.textContent).toBe('Hand #77');
    /* The transport and the seat strip the arena shows. */
    expect(document.querySelector('.hand-replay__controls')).not.toBeNull();
    expect(document.querySelector('.hand-replay__seats')).not.toBeNull();
    /* Every screen name; nobody is a seat number. */
    expect(document.body.textContent).toContain('kingfish');
    expect(document.body.textContent).toContain('Emerson');
    expect(document.body.textContent).not.toContain('Seat 2');
    /* No share footer: the arena's replayer has none. Nothing but the replayer. */
    expect(document.querySelector('.shared-replay__footer')).toBeNull();
    expect(document.body.textContent).not.toContain('Shared From');
    expect(document.body.textContent).not.toContain('Smarter Poker');
    expect(document.body.textContent).not.toContain('Not Readable');
    /* No h= was given and nothing asked the database for the hand. */
    expect(getHand).not.toHaveBeenCalled();
    /* The camera contract is on top of it all. */
    const handle = (window as unknown as { __spClip?: { v: number; frames: number } }).__spClip;
    expect(handle?.v).toBe(1);
    expect(handle?.frames).toBeGreaterThan(0);
    expect(document.querySelector('.hand-replay')?.getAttribute('data-clip-step')).toBe('0');
  });

  it('a malformed payload is not a clip: the link reads as today', async () => {
    inject({ v: 1, style: 'felt-720p', heroId: HERO, row: { id: 'x' } });
    await openPage('?clip=1');
    expect(await screen.findByText('This Replay Link Is Not Readable')).toBeTruthy();
    expect(document.querySelector('.hand-replay')).toBeNull();
    expect((window as unknown as { __spClip?: unknown }).__spClip).toBeUndefined();
  });
});

describe('without the payload, the page is what it is today', () => {
  it('a link renders the replayer with the footer under it', async () => {
    const hand = shareableFromModel(buildReplay(replayInputFromRow(ROW)), {
      id: ROW.id,
      tableName: 'Kingfish Club',
      heroUserId: HERO,
    });
    await openPage(`?h=${encodeHand(hand)}`);
    await screen.findByText('Hand #77');
    expect(document.querySelector('.shared-replay > .hand-replay')).not.toBeNull();
    expect(document.querySelector('.shared-replay__footer')?.textContent).toBe(
      "Shared From kingfish's Hand History · Smarter Poker"
    );
    expect(document.querySelector('.hand-replay')?.hasAttribute('data-clip-state')).toBe(false);
    expect((window as unknown as { __spClip?: unknown }).__spClip).toBeUndefined();
    expect(getHand).not.toHaveBeenCalled();
  });

  it('clip=1 alone still needs h=', async () => {
    await openPage('?clip=1');
    expect(await screen.findByText('This Replay Link Is Not Readable')).toBeTruthy();
    expect(document.querySelector('.hand-replay')).toBeNull();
    expect((window as unknown as { __spClip?: unknown }).__spClip).toBeUndefined();
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
      tableName: 'Kingfish Club',
      privateHoleCards: {},
      discardedCards: {},
      minMs: 15000,
      maxMs: 40000,
    });
    await openPage('');
    expect(await screen.findByText('This Replay Link Is Not Readable')).toBeTruthy();
    expect(document.querySelector('.hand-replay')).toBeNull();
    expect((window as unknown as { __spClip?: unknown }).__spClip).toBeUndefined();
  });
});
