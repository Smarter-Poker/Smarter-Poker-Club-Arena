/**
 * PHASE 7: THE LEDGER FETCHES ITS NEXT PAGE BEFORE THE PLAYER ASKS.
 *
 * `DiamondLedgerMore` is the tail of both wallet diamond panes. These pins are
 * the five ways an auto-paging list goes wrong, each written before the
 * mechanism: it fires when nothing has asked it to, it fires twice for one
 * page, it keeps firing after the ledger has ended, it spins on a page that
 * failed, and it leaves an observer behind when the pane unmounts. The sixth
 * pin is the one that is not about the observer at all: the button a player
 * can press, and reach with a keyboard, is still there.
 *
 * Not a `*.law.test.*`: this is behaviour this phase chose, not a rule Dan
 * stated. See CLAUDE.md 10.8.
 */
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DiamondLedgerMore,
  LEDGER_PREFETCH_RUNWAY_PX,
} from '../../src/components/wallet/DiamondLedgerMore';

type IOCallback = (entries: { isIntersecting: boolean }[]) => void;

interface FakeObserver {
  callback: IOCallback;
  options: IntersectionObserverInit | undefined;
  observed: Element[];
  disconnects: number;
}

/** Every observer constructed during one test, newest last. */
let observers: FakeObserver[] = [];

function installObserver() {
  observers = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IOCallback, options?: IntersectionObserverInit) {
        const record: FakeObserver = { callback, options, observed: [], disconnects: 0 };
        observers.push(record);
        this.record = record;
      }
      record: FakeObserver;
      observe(el: Element) {
        this.record.observed.push(el);
      }
      unobserve() {}
      disconnect() {
        this.record.disconnects += 1;
      }
      takeRecords() {
        return [];
      }
    }
  );
}

/** The newest live observer: the one attached to the sentinel on screen. */
function current(): FakeObserver {
  const live = observers.filter((o) => o.observed.length > 0);
  expect(live.length).toBeGreaterThan(0);
  return live[live.length - 1];
}

function scrollSentinelIntoRunway() {
  act(() => {
    current().callback([{ isIntersecting: true }]);
  });
}

const base = {
  rowCount: 25,
  hasMore: true,
  loadingMore: false,
  error: false,
  moreLabel: 'Load Older Diamonds',
  errorLabel: 'Could Not Load Older Diamonds.',
  endLine: 'That Is Every Diamond You Have Received. 390 Credits.',
};

describe('the diamond ledger fetches its next page before the player asks', () => {
  beforeEach(() => {
    installObserver();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for exactly one page when the sentinel enters the runway', () => {
    const onLoadMore = vi.fn();
    render(<DiamondLedgerMore {...base} onLoadMore={onLoadMore} />);

    expect(onLoadMore).not.toHaveBeenCalled();
    scrollSentinelIntoRunway();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('starts the fetch early, from a runway shorter than one page of rows', () => {
    render(<DiamondLedgerMore {...base} onLoadMore={vi.fn()} />);

    // The margin grows the viewport DOWNWARD, so the fetch starts while the
    // sentinel is still that far below the last visible pixel.
    expect(current().options?.rootMargin).toBe(`0px 0px ${LEDGER_PREFETCH_RUNWAY_PX}px 0px`);
    // Shorter than the ~1,540px a landed page occupies. If this stops holding,
    // every landed page re-arms the sentinel and the ledger walks itself.
    expect(LEDGER_PREFETCH_RUNWAY_PX).toBeLessThan(1000);
  });

  it('does not queue a second page while one is in flight', () => {
    const onLoadMore = vi.fn();
    const view = render(<DiamondLedgerMore {...base} onLoadMore={onLoadMore} />);

    scrollSentinelIntoRunway();
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    // The observer fires again in the same tick, before React has committed
    // `loadingMore`. The ref latch, not the prop, is what refuses this.
    scrollSentinelIntoRunway();
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    // And it still refuses once the page IS visibly in flight.
    view.rerender(<DiamondLedgerMore {...base} loadingMore onLoadMore={onLoadMore} />);
    scrollSentinelIntoRunway();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('asks again only after the page it asked for has landed', () => {
    const onLoadMore = vi.fn();
    const view = render(<DiamondLedgerMore {...base} onLoadMore={onLoadMore} />);

    scrollSentinelIntoRunway();
    view.rerender(<DiamondLedgerMore {...base} loadingMore onLoadMore={onLoadMore} />);
    // Settled: 25 more rows arrived and there are still more behind them.
    view.rerender(<DiamondLedgerMore {...base} rowCount={50} onLoadMore={onLoadMore} />);

    scrollSentinelIntoRunway();
    expect(onLoadMore).toHaveBeenCalledTimes(2);
  });

  it('stops at the end of the ledger, and takes its observer with it', () => {
    const onLoadMore = vi.fn();
    const view = render(<DiamondLedgerMore {...base} onLoadMore={onLoadMore} />);
    const observer = current();

    view.rerender(
      <DiamondLedgerMore {...base} rowCount={390} hasMore={false} onLoadMore={onLoadMore} />
    );

    expect(screen.queryByTestId('ledger-prefetch-sentinel')).toBeNull();
    expect(observer.disconnects).toBeGreaterThan(0);
    expect(
      screen.getByText('That Is Every Diamond You Have Received. 390 Credits.')
    ).toBeInTheDocument();
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('stops prefetching when a page fails, and puts the retry on a control', () => {
    const onLoadMore = vi.fn();
    const view = render(<DiamondLedgerMore {...base} onLoadMore={onLoadMore} />);
    const observer = current();

    // The prefetch failed. Rule 4 of useDiamondLedger: the earlier pages stay.
    view.rerender(<DiamondLedgerMore {...base} error onLoadMore={onLoadMore} />);

    expect(screen.queryByTestId('ledger-prefetch-sentinel')).toBeNull();
    expect(observer.disconnects).toBeGreaterThan(0);

    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Could Not Load Older Diamonds.');

    retry.click();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('keeps the manual control, pressable and reachable, while there is more', () => {
    const onLoadMore = vi.fn();
    const view = render(<DiamondLedgerMore {...base} onLoadMore={onLoadMore} />);

    const button = screen.getByRole('button', { name: 'Load Older Diamonds' });
    expect(button).toBeEnabled();
    // The sentinel is decoration: never focusable, never announced.
    const sentinel = screen.getByTestId('ledger-prefetch-sentinel');
    expect(sentinel).toHaveAttribute('aria-hidden', 'true');
    expect(sentinel.tagName).toBe('DIV');

    button.click();
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    view.rerender(<DiamondLedgerMore {...base} loadingMore onLoadMore={onLoadMore} />);
    expect(screen.getByRole('button', { name: 'Loading...' })).toBeDisabled();
  });

  it('is still operable where IntersectionObserver does not exist', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const onLoadMore = vi.fn();

    expect(() => render(<DiamondLedgerMore {...base} onLoadMore={onLoadMore} />)).not.toThrow();

    const button = screen.getByRole('button', { name: 'Load Older Diamonds' });
    button.click();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('disconnects when the pane unmounts', () => {
    const view = render(<DiamondLedgerMore {...base} onLoadMore={vi.fn()} />);
    const observer = current();

    view.unmount();
    expect(observer.disconnects).toBeGreaterThan(0);
  });

  it('renders no tail at all for an empty ledger', () => {
    const { container } = render(
      <DiamondLedgerMore {...base} rowCount={0} hasMore={false} onLoadMore={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
    expect(observers.some((o) => o.observed.length > 0)).toBe(false);
  });
});
