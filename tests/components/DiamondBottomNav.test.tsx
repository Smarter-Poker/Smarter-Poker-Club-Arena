/**
 * THE DIAMOND ARENA FOOTER OFFERS THE PLAYER DOORS, AND ONLY THOSE.
 *
 * Dan 2026-09-11: one open club, no unions or agents, played with Diamonds.
 * The chip footer is kept off the arena; this bar stands in its place and
 * carries exactly Lobby, Hand History, Stats, Players, Messages and Wallet.
 * The wallet opens in place and never navigates.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DiamondBottomNav, {
  DIAMOND_FOOTER_DOORS,
  activeDiamondTabForPath,
} from '../../src/components/arena/DiamondBottomNav';

const mocks = vi.hoisted(() => ({ wallet: vi.fn(), topUp: vi.fn() }));

vi.mock('../../src/components/wallet/DiamondWalletModal', () => ({
  default: (props: { onClose: () => void; onBuyClick?: () => void }) => {
    mocks.wallet(props);
    return (
      <div role="dialog" aria-label="Diamond Wallet">
        <button type="button" onClick={props.onBuyClick}>
          Buy Diamonds
        </button>
        <button type="button" onClick={props.onClose}>
          Close Wallet
        </button>
      </div>
    );
  },
}));
vi.mock('../../src/components/vip/DiamondTopUpModal', () => ({
  DiamondTopUpModal: (props: { onClose: () => void }) => {
    mocks.topUp(props);
    return <div role="dialog" aria-label="Top Up" />;
  },
}));

const LABELS = ['Lobby', 'Hand History', 'Stats', 'Players', 'Messages', 'Wallet'];
const CHIP_ONLY = /agent|union|finance|operation|cashier|wheel|data|market|settlement|control/i;

async function renderAt(path: string) {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <DiamondBottomNav />
    </MemoryRouter>
  );
  await act(async () => Promise.resolve());
  return view;
}

beforeEach(() => {
  mocks.wallet.mockClear();
  mocks.topUp.mockClear();
});

describe('the six doors', () => {
  it('are the player surfaces, in order, and nothing an operator owns', () => {
    expect(DIAMOND_FOOTER_DOORS.map((d) => d.label)).toEqual(LABELS);
    for (const door of DIAMOND_FOOTER_DOORS) {
      expect(door.label, `${door.label} is a chip operator door`).not.toMatch(CHIP_ONLY);
      expect(door.to ?? '', `${door.label} leads to a chip operator door`).not.toMatch(CHIP_ONLY);
    }
  });

  it('lead where the player expects', () => {
    const to = Object.fromEntries(DIAMOND_FOOTER_DOORS.map((d) => [d.key, d.to]));
    expect(to.lobby).toBe('/clubs/diamond-arena');
    expect(to['hand-history']).toBe('/hand-history?arena=diamond');
    expect(to.stats).toBe('/stats?club=diamond-arena');
    expect(to.players).toBe('/clubs/diamond-arena/members');
    expect(to.messages).toBe('/clubs/diamond-arena/messages');
    expect(to.wallet).toBeNull();
  });
});

describe('the rendered bar', () => {
  it('renders five links and one wallet button under the Diamond Arena landmark', async () => {
    await renderAt('/clubs/diamond-arena');
    const nav = screen.getByRole('navigation', { name: 'Diamond Arena' });
    expect(nav.getAttribute('data-arena-footer')).toBe('diamond');
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual(LABELS.slice(0, 5));
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/clubs/diamond-arena',
      '/hand-history?arena=diamond',
      '/stats?club=diamond-arena',
      '/clubs/diamond-arena/members',
      '/clubs/diamond-arena/messages',
    ]);
    expect(screen.getByRole('button', { name: 'Wallet' })).toBeTruthy();
  });

  it('marks the page you are on and no other', async () => {
    await renderAt('/clubs/diamond-arena/members');
    const current = document.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute('aria-label')).toBe('Players');
  });

  it('opens the Diamond wallet in place, then the top-up over it, without navigating', async () => {
    await renderAt('/clubs/diamond-arena');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Wallet' }));
    expect(await screen.findByRole('dialog', { name: 'Diamond Wallet' })).toBeTruthy();
    expect(mocks.wallet).toHaveBeenCalledWith(expect.objectContaining({ isOpen: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Buy Diamonds' }));
    expect(await screen.findByRole('dialog', { name: 'Top Up' })).toBeTruthy();
    // Closing the top-up returns to the wallet; closing the wallet clears it.
    act(() => mocks.topUp.mock.calls[0][0].onClose());
    expect(await screen.findByRole('dialog', { name: 'Diamond Wallet' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Wallet' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Still on the same page: the wallet never navigated.
    expect(screen.getByRole('link', { name: 'Lobby' }).getAttribute('aria-current')).toBe('page');
  });

  it('prints every label as live text in the master ink, not as an icon glyph', async () => {
    await renderAt('/clubs/diamond-arena');
    for (const label of LABELS) {
      // The visually hidden name for assistive tech AND the printed word.
      expect(screen.getAllByText(label)).toHaveLength(2);
    }
    expect(document.querySelector('svg')).toBeNull();
  });
});

describe('activeDiamondTabForPath', () => {
  it.each([
    ['/clubs/diamond-arena', 'lobby'],
    ['/clubs/diamond-arena/', 'lobby'],
    ['/clubs/diamond-arena/lobby', 'lobby'],
    ['/clubs/002c2d27-9584-4e52-835a-bb2be148fc81', 'lobby'],
    ['/hand-history', 'hand-history'],
    ['/stats', 'stats'],
    ['/stats/user-1', 'stats'],
    ['/clubs/diamond-arena/members', 'players'],
    ['/clubs/diamond-arena/members/user-1', 'players'],
    ['/clubs/diamond-arena/members/user-1/statistics', 'players'],
    ['/clubs/diamond-arena/messages', 'messages'],
    ['/clubs/diamond-arena/tournaments', null],
    ['/clubs/diamond-arena/finance', null],
    ['/clubs/shark-club', null],
    ['/table/abc', null],
  ])('%s -> %s', (path, expected) => {
    expect(activeDiamondTabForPath(path)).toBe(expected);
  });
});
