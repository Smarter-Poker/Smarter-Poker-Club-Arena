/**
 * ClubQuickLinkTile — the club-aware Cashier/Marketplace lobby tile.
 * Covers: tap-through to target club, empty-state handler, quick-switch
 * popover (open, select, per-club balances, keyboard), chunk prefetch on
 * intent, and the long-press latch regression.
 */

// Case-insensitive text matchers on purpose: Dan's house rule Title Cases every
// word on every forward-facing page (scripts/ci/check-title-case.mjs), so pinning
// the casing of copy makes these fail on a styling rule rather than on the
// behaviour they exist to protect. The words are the contract.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const authState = vi.hoisted(() => ({ userId: 'test-user-123' }));
const inMock = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ in: inMock })) })),
    })),
  },
}));

vi.mock('@/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: authState.userId } }),
}));

vi.mock('@/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: vi.fn(),
  useMasterBusSubscriptions: vi.fn(),
}));

const preloadRouteMock = vi.fn();
vi.mock('@/utils/ChunkPreloader', () => ({
  preloadRoute: (path: string) => preloadRouteMock(path),
  preloadCriticalChunks: vi.fn(),
}));

import ClubQuickLinkTile from '@/components/home/ClubQuickLinkTile';
import { clearClubChipBalanceCache } from '@/utils/clubQuickLink';
import * as clubQuickLink from '@/utils/clubQuickLink';

const TILE = {
  img: 'images/tiles/cashier-v8.jpg', // the tile the lobby actually ships
  alt: 'Cashier',
  route: null,
  shortcutKey: '4',
};

const A = { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Alpha Club' };
const B = { id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'Bravo Club' };
const UNION = {
  id: 'cccccccc-0000-0000-0000-000000000003',
  name: 'Midway Union',
  is_union: true,
  is_owner: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderTile(props: Record<string, unknown> = {}) {
  const merged = {
    tile: TILE,
    clubs: [A, B],
    targetClub: A,
    menuTitle: 'Open Cashier For',
    onSelect: vi.fn(),
    onEmpty: vi.fn(),
    ...props,
  };
  return { ...render(<ClubQuickLinkTile {...(merged as never)} />), props: merged };
}

beforeEach(() => {
  authState.userId = 'test-user-123';
  localStorage.clear();
  clearClubChipBalanceCache();
  inMock.mockReset();
  preloadRouteMock.mockReset();
  inMock.mockResolvedValue({ data: [], error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ClubQuickLinkTile', () => {
  it('carries the target club name in the accessible name/title and opens it on tap', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderTile({ onSelect });
    // The v8 tile art owns the visual — the club name lives in aria-label + title
    const tileBtn = screen.getByRole('button', { name: /Cashier For Alpha Club/ });
    expect(tileBtn).toHaveAttribute('title', 'Cashier - Alpha Club');
    await user.click(tileBtn);
    expect(onSelect).toHaveBeenCalledWith(A);
  });

  it('calls onEmpty when the user has no clubs', async () => {
    const user = userEvent.setup();
    const onEmpty = vi.fn();
    renderTile({ clubs: [], targetClub: null, onEmpty });
    await user.click(screen.getByRole('button', { name: /Cashier \(Press 4\)/ }));
    expect(onEmpty).toHaveBeenCalledOnce();
  });

  it('opens the wallet directory for a single eligible club too', async () => {
    renderTile({ clubs: [A] });
    const tileBtn = screen.getByRole('button', { name: /Cashier For Alpha Club/ });
    fireEvent.contextMenu(tileBtn);
    expect(screen.getByRole('menuitem', { name: /Alpha Club/ })).toBeInTheDocument();
    await act(async () => {});
  });

  it('opens the popover, lists clubs with chip balances, and selects one', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    inMock.mockResolvedValue({
      data: [
        { club_id: A.id, chip_balance: 1234 },
        { club_id: B.id, chip_balance: 50 },
      ],
      error: null,
    });
    renderTile({ onSelect });
    // Right-click is the pointer path to the quick-switch popover
    fireEvent.contextMenu(screen.getByRole('button', { name: /Hold To Choose A Wallet/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(
      await screen.findByText(new RegExp(`${(1234).toLocaleString()} Chips`, 'i'))
    ).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /Bravo Club/ }));
    expect(onSelect).toHaveBeenCalledWith(B);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('keeps the directory outside transformed scrollers while its desktop anchor follows the tile', async () => {
    const { container, unmount } = renderTile();
    container.style.transform = 'translateZ(0)';
    container.style.overflow = 'hidden';
    const trigger = screen.getByRole('button', { name: /Hold To Choose A Wallet/ });
    let rect = new DOMRect(200, 600, 60, 90);
    const measureTrigger = vi
      .spyOn(trigger, 'getBoundingClientRect')
      .mockImplementation(() => rect);

    fireEvent.contextMenu(trigger);
    const directory = screen.getByRole('menu').parentElement as HTMLDivElement;
    const overlay = document.querySelector('[class*="cashierSwitchOverlay"]');
    expect(container).not.toContainElement(directory);
    expect(directory.parentElement).toBe(document.body);
    expect(overlay?.parentElement).toBe(document.body);
    expect(directory.style.getPropertyValue('--quick-link-anchor-x')).toBe('230px');
    expect(directory.style.getPropertyValue('--quick-link-anchor-bottom')).toBe(
      `${window.innerHeight - 600 + 8}px`
    );

    rect = new DOMRect(200, 500, 60, 90);
    fireEvent.scroll(container);
    expect(directory.style.getPropertyValue('--quick-link-anchor-bottom')).toBe(
      `${window.innerHeight - 500 + 8}px`
    );
    rect = new DOMRect(100, 500, 60, 90);
    fireEvent.resize(window);
    expect(directory.style.getPropertyValue('--quick-link-anchor-x')).toBe('130px');

    await act(async () => {});
    unmount();
    expect(directory).not.toBeInTheDocument();
    expect(overlay).not.toBeInTheDocument();
    const measurementsBeforeViewportEvents = measureTrigger.mock.calls.length;
    fireEvent.scroll(document.body);
    fireEvent.resize(window);
    expect(measureTrigger).toHaveBeenCalledTimes(measurementsBeforeViewportEvents);
  });

  it('labels an owned union treasury and does not mislabel it as club chips', async () => {
    renderTile({ clubs: [A, UNION] });
    fireEvent.contextMenu(screen.getByRole('button', { name: /Hold To Choose A Wallet/ }));
    expect(screen.getByRole('menuitem', { name: /Midway Union Union Wallet/ })).toBeInTheDocument();
    await act(async () => {});
  });

  it('does not request club balances or show a false failure for a union-only directory', async () => {
    renderTile({ clubs: [UNION], targetClub: UNION });
    fireEvent.contextMenu(screen.getByRole('button', { name: /Hold To Choose A Wallet/ }));
    expect(screen.getByRole('menuitem', { name: /Midway Union Union Wallet/ })).toBeInTheDocument();
    await act(async () => {});
    expect(inMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('distinguishes a failed balance read and retries it successfully', async () => {
    const user = userEvent.setup();
    inMock
      .mockResolvedValueOnce({ data: null, error: new Error('balance read refused') })
      .mockResolvedValueOnce({ data: [{ club_id: A.id, chip_balance: 77 }], error: null });
    renderTile({ clubs: [A], targetClub: A });
    fireEvent.contextMenu(screen.getByRole('button', { name: /Hold To Choose A Wallet/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Wallet Balances Unavailable/i);
    expect(screen.getByRole('menuitem', { name: /Balance Unavailable/i })).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /Retry/i });
    // Finding the committed button does not flush its passive focus effect.
    await waitFor(() => expect(retry).toHaveFocus());
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('menuitem', { name: /77 Chips/i })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(inMock).toHaveBeenCalledTimes(2);
  });

  it('focuses Retry when loading completes after the error was already rendered', async () => {
    const user = userEvent.setup();
    let deliverResult!: (value: null) => void;
    let finishRead!: () => void;
    // Let React commit the failed result separately from promise cleanup.
    // In production these callbacks run in distinct microtasks; batching them
    // together in every test hides a missing loading-state focus dependency.
    vi.spyOn(clubQuickLink, 'fetchClubChipBalances').mockReturnValueOnce({
      then(callback: (value: null) => void) {
        deliverResult = callback;
        return {
          catch: () => ({
            finally: (callback: () => void) => {
              finishRead = callback;
            },
          }),
        };
      },
    } as unknown as ReturnType<typeof clubQuickLink.fetchClubChipBalances>);
    inMock.mockResolvedValue({ data: [{ club_id: A.id, chip_balance: 77 }], error: null });
    const { props } = renderTile({ clubs: [A], targetClub: A });
    fireEvent.contextMenu(screen.getByRole('button', { name: /Hold To Choose A Wallet/ }));
    act(() => deliverResult(null));
    expect(screen.getByRole('status')).toHaveTextContent(/Reading Wallet Balances/i);
    expect(screen.queryByRole('button', { name: /Retry/i })).not.toBeInTheDocument();
    act(() => finishRead());
    expect(screen.getByRole('button', { name: /Retry/i })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('menuitem', { name: /77 Chips/i })).toBeInTheDocument();
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(inMock).toHaveBeenCalledOnce();
  });

  it("never paints a previous account's balances while the next account read is pending", async () => {
    const nextRead = deferred<{ data: null; error: Error }>();
    inMock
      .mockResolvedValueOnce({ data: [{ club_id: A.id, chip_balance: 1234 }], error: null })
      .mockReturnValueOnce(nextRead.promise);
    const rendered = renderTile({ clubs: [A], targetClub: A });
    fireEvent.contextMenu(screen.getByRole('button', { name: /Hold To Choose A Wallet/ }));
    expect(await screen.findByRole('menuitem', { name: /1,234 Chips/i })).toBeInTheDocument();

    authState.userId = 'next-user-456';
    rendered.rerender(<ClubQuickLinkTile {...(rendered.props as never)} />);

    expect(screen.queryByText(/1,234 Chips/i)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/Reading Wallet Balances/i);

    await act(async () => {
      nextRead.resolve({ data: null, error: new Error('next account read failed') });
      await nextRead.promise;
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/Wallet Balances Unavailable/i);
    expect(screen.queryByText(/1,234 Chips/i)).not.toBeInTheDocument();
  });

  it('closes the popover on Escape and returns focus to the tile trigger', async () => {
    const user = userEvent.setup();
    renderTile();
    const trigger = screen.getByRole('button', { name: /Hold To Choose A Wallet/ });
    fireEvent.contextMenu(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('navigates the popover with arrow keys', async () => {
    const user = userEvent.setup();
    renderTile();
    fireEvent.contextMenu(screen.getByRole('button', { name: /Hold To Choose A Wallet/ }));
    expect(screen.getByRole('menuitem', { name: /Alpha Club/ })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: /Bravo Club/ })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: /Alpha Club/ })).toHaveFocus();
  });

  it('prefetches the destination chunk on pointer intent, once', async () => {
    const user = userEvent.setup();
    renderTile({ clubs: [A], preloadPath: '/cashier' });
    const tileBtn = screen.getByRole('button', { name: /Cashier For Alpha Club/ });
    await user.hover(tileBtn);
    await user.hover(tileBtn);
    expect(preloadRouteMock).toHaveBeenCalledTimes(1);
    expect(preloadRouteMock).toHaveBeenCalledWith('/cashier');
  });

  it('opens the popover on a long press', async () => {
    vi.useFakeTimers();
    renderTile();
    const tileBtn = screen.getByRole('button', { name: /Cashier For Alpha Club/ });
    fireEvent.pointerDown(tileBtn);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await act(async () => {}); // flush the balance fetch
  });

  it.each([
    ['ArrowDown', { key: 'ArrowDown' }],
    ['ContextMenu', { key: 'ContextMenu' }],
    ['Shift+F10', { key: 'F10', shiftKey: true }],
  ])('opens the wallet directory from the %s keyboard command', async (_label, keys) => {
    renderTile();
    const trigger = screen.getByRole('button', { name: /Hold To Choose A Wallet/ });
    fireEvent.keyDown(trigger, keys);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Alpha Club/ })).toHaveFocus();
    await act(async () => {});
  });

  it('returns focus to the trigger when the outside overlay dismisses the directory', async () => {
    renderTile();
    const trigger = screen.getByRole('button', { name: /Hold To Choose A Wallet/ });
    fireEvent.contextMenu(trigger);
    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();
    fireEvent.click(document.querySelector('[class*="cashierSwitchOverlay"]') as HTMLElement);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await act(async () => {});
  });

  it('does not open the popover when the press is cancelled early', () => {
    vi.useFakeTimers();
    renderTile();
    const tileBtn = screen.getByRole('button', { name: /Cashier For Alpha Club/ });
    fireEvent.pointerDown(tileBtn);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.pointerCancel(tileBtn);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  // REGRESSION: dismissing a long-press popover without the click landing back
  // on the tile used to leave the latch set, swallowing the NEXT tile tap.
  it('does not swallow the next tile tap after a long-press popover is dismissed', () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    renderTile({ onSelect });
    const tileBtn = screen.getByRole('button', { name: /Cashier For Alpha Club/ });

    fireEvent.pointerDown(tileBtn);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(tileBtn);
    expect(onSelect).toHaveBeenCalledWith(A);
  });

  it('marks the tile as a popup trigger whenever a wallet directory exists', () => {
    const { unmount } = renderTile({ clubs: [], targetClub: null });
    expect(screen.getByRole('button', { name: /Cashier \(Press 4\)/ })).not.toHaveAttribute(
      'aria-haspopup'
    );
    unmount();
    renderTile({ clubs: [A] });
    expect(screen.getByRole('button', { name: /Cashier For Alpha Club/ })).toHaveAttribute(
      'aria-haspopup',
      'menu'
    );
    expect(screen.getByRole('button', { name: /Cashier For Alpha Club/ })).toHaveAttribute(
      'aria-keyshortcuts',
      'ArrowDown Shift+F10'
    );
  });
});
