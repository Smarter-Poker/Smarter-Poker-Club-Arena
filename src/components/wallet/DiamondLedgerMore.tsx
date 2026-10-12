import { useCallback, useEffect, useRef } from 'react';
import { DIAMOND_LEDGER_PAGE } from '../../hooks/useDiamondLedger';

/**
 * THE LEDGER FETCHES ITS NEXT PAGE BEFORE THE PLAYER ASKS.
 *
 * `useDiamondLedger` pages both wallet panes 25 rows at a time, and until now
 * the only route to page two was to scroll to the bottom, find a button and
 * press it. A player holding 390 credits pressed it fifteen times. This is
 * the same paging with the wait taken out: an invisible sentinel sits at the
 * foot of the list, and when it comes within a screenful of the viewport the
 * next page is already in flight by the time the last row is read.
 *
 * It lives here, once, because the Receive pane and the Send pane are the
 * same hook in two directions, and the three tail affordances they both carry
 * (retry a failed later page, load the next one by hand, say the ledger has
 * ended) were written out twice on the page. Two copies of a control is how
 * one of them quietly stops matching the other.
 *
 * -- THE FOUR THINGS THAT MAKE THIS SAFE ------------------------------------
 *
 *  1. THE RUNWAY IS SHORTER THAN A PAGE OF ROWS, AND THAT IS THE WHOLE GUARD.
 *     `rootMargin` grows the viewport downward, so the fetch starts while the
 *     sentinel is still that far below the fold. Tempting to set it to a full
 *     page, and that is the bug: a landed page is ~25 rows tall, so if the
 *     runway were as tall as a page, every page would push the sentinel a
 *     distance the margin still covers, it would re-arm immediately, and the
 *     ledger would walk itself to the end in a chain of `.range()` calls
 *     nobody asked for. A page here is at least 25 * ~54px of row plus
 *     24 * 8px of gap, about 1,540px; the runway is 480px, roughly one phone
 *     screen and eight rows. One landed page therefore ALWAYS carries the
 *     sentinel clear of the margin, so the chain cannot start. If the row
 *     height ever falls below about 19px, re-derive this number.
 *
 *  2. ONE PAGE AT A TIME, GUARDED ON A REF AND NOT ON A PROP. `loadingMore`
 *     is state: it is still `false` inside the observer callback that just
 *     asked for a page, so a second intersection in the same tick would ask
 *     again. `firedRef` closes that window and is re-armed only once the read
 *     has settled.
 *
 *  3. A FAILED PREFETCH STOPS PREFETCHING. `error` disarms the sentinel and
 *     unmounts it, so a page that failed is retried by the player on the
 *     control below and never by an observer that would spin on it. The pages
 *     already on screen stay (`useDiamondLedger` rule 4).
 *
 *  4. THE MANUAL CONTROL NEVER GOES AWAY. It is the route when
 *     `IntersectionObserver` is missing, the route after a failure, and the
 *     route for anyone driving by keyboard, who never scrolls a sentinel into
 *     view at all. Prefetch is added beside it, never in place of it.
 *
 * A `'refresh'` cannot trip any of this: it prepends rows above the list and
 * pushes the sentinel further DOWN, away from the viewport, and it is not
 * `'more'`, so it never sets `loadingMore` and never re-arms anything early.
 */

/**
 * How far below the fold the sentinel may sit and still start the fetch.
 * Derived in note 1 above: it must stay well under the rendered height of one
 * page of rows, or each landed page re-arms the sentinel.
 */
export const LEDGER_PREFETCH_RUNWAY_PX = 480;

interface LedgerPrefetchState {
  hasMore: boolean;
  loadingMore: boolean;
  error: boolean;
  /** Rows on screen; used only to re-arm the sentinel once a read has settled. */
  rowCount: number;
  onLoadMore: () => void;
}

/**
 * Returns a callback ref for the sentinel element. Attaching it starts
 * observing; React passing `null` on unmount disconnects, so no observer is
 * left behind by a tab change, a route change, or the sentinel being removed
 * when the ledger ends.
 */
export function useLedgerPrefetch({
  hasMore,
  loadingMore,
  error,
  rowCount,
  onLoadMore,
}: LedgerPrefetchState): (node: HTMLDivElement | null) => void {
  const hasMoreRef = useRef(hasMore);
  const loadingRef = useRef(loadingMore);
  const errorRef = useRef(error);
  const loadRef = useRef(onLoadMore);
  /* The one-page-at-a-time latch. See note 2: state is too late here. */
  const firedRef = useRef(false);
  const observerRef = useRef<IntersectionObserver | null>(null);

  /* Kept current on every render so the observer reads today's answer without
     being torn down and rebuilt each time a page lands. */
  hasMoreRef.current = hasMore;
  loadingRef.current = loadingMore;
  errorRef.current = error;
  loadRef.current = onLoadMore;

  /* Re-arm once the read has settled. ANY settled state re-arms, not just a
     `loadingMore` edge, so a load that never started cannot strand the latch. */
  useEffect(() => {
    if (!loadingMore) firedRef.current = false;
  }, [loadingMore, hasMore, error, rowCount]);

  const setSentinel = useCallback((node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!node) return;
    // No observer in this browser: the button below is the route. Not an error.
    if (typeof IntersectionObserver === 'undefined') return;

    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry || !entry.isIntersecting) return;
        if (firedRef.current || loadingRef.current) return;
        if (!hasMoreRef.current || errorRef.current) return;
        firedRef.current = true;
        loadRef.current();
      },
      { rootMargin: `0px 0px ${LEDGER_PREFETCH_RUNWAY_PX}px 0px` }
    );
    io.observe(node);
    observerRef.current = io;
  }, []);

  useEffect(
    () => () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
    },
    []
  );

  return setSentinel;
}

export interface DiamondLedgerMoreProps {
  /** Rows currently on screen. Nothing renders until there is a list to tail. */
  rowCount: number;
  hasMore: boolean;
  loadingMore: boolean;
  /** The most recent read failed. Earlier pages are still on screen. */
  error: boolean;
  /** Ask the hook for the next page: `load('more')`. */
  onLoadMore: () => void;
  /** Title Case, no em dashes: "Load Older Diamonds". */
  moreLabel: string;
  /** Title Case, no em dashes: "Could Not Load Older Diamonds." */
  errorLabel: string;
  /** What to say once every page has been read. */
  endLine: string;
}

/**
 * The tail of a paged diamond ledger: the prefetch sentinel, the retry after a
 * failed page, the manual control, and the line that says the ledger has
 * ended. Rendered by both wallet panes with their own copy.
 */
export function DiamondLedgerMore({
  rowCount,
  hasMore,
  loadingMore,
  error,
  onLoadMore,
  moreLabel,
  errorLabel,
  endLine,
}: DiamondLedgerMoreProps) {
  const setSentinel = useLedgerPrefetch({ hasMore, loadingMore, error, rowCount, onLoadMore });

  /* An empty list has no tail. The FIRST read's failure and its emptiness are
     the pane's own copy, because only the pane knows what an empty one says. */
  if (rowCount === 0) return null;

  const armed = hasMore && !error;

  return (
    <>
      {armed && (
        <div
          ref={setSentinel}
          className="ledger-prefetch-sentinel"
          data-testid="ledger-prefetch-sentinel"
          aria-hidden="true"
        />
      )}

      {/* A LATER page failed. The pages already read stay on screen, and the
          retry is on the control rather than on another observer pass. */}
      {error && (
        <div className="vault-empty" role="alert">
          {errorLabel}{' '}
          <button type="button" className="vault-link" onClick={onLoadMore}>
            Retry
          </button>
        </div>
      )}

      {/* Always present while there is more to read: the keyboard route, the
          no-observer route, and the route for anyone who would rather press. */}
      {armed && (
        <button
          type="button"
          className="vault-btn vault-btn--wide"
          onClick={onLoadMore}
          disabled={loadingMore}
        >
          {loadingMore ? 'Loading...' : moreLabel}
        </button>
      )}

      {/* Say the ledger has ended, rather than just running out of button. */}
      {!hasMore && !error && rowCount > DIAMOND_LEDGER_PAGE && (
        <p className="vault-panel__sub">{endLine}</p>
      )}
    </>
  );
}
