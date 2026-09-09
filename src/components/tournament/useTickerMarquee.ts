/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MEASURING THE RAIL SO THE LOOP IS SEAMLESS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The arithmetic is in `marqueeMetrics.ts` and asserted there. This hook is the
 * part that has to touch the DOM: read the track's visible width and one copy's
 * rendered width, and keep both current.
 *
 * BOTH numbers move, which is why this observes rather than measuring once:
 *
 *   the track   the rail is full-bleed, so it changes on every resize and on
 *               every rotation, and the flag beside it grows and shrinks with
 *               the word on it
 *   the copy    the message is rebuilt whenever a poll returns different news,
 *               and a countdown's own width changes when it crosses from 10:00
 *               to 9:59
 *
 * A `scrollWidth` read is a layout flush, so it happens inside a
 * ResizeObserver callback and on nothing else - never per animation frame.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marqueeMetrics, pxPerSecondFor, type MarqueeMetrics } from './marqueeMetrics';

export interface TickerMarquee extends MarqueeMetrics {
  /** Put this on the clipping region. */
  trackRef: (node: HTMLElement | null) => void;
  /** Put this on the FIRST copy of the message. */
  copyRef: (node: HTMLElement | null) => void;
}

/**
 * @param speedSeconds the operator's stored `speed_seconds`
 * @param contentKey changes whenever the message text changes, so the copy is
 *        re-measured even when its box happens to keep the same size
 */
export function useTickerMarquee(speedSeconds: number, contentKey: string): TickerMarquee {
  const [trackWidth, setTrackWidth] = useState(0);
  const [copyWidth, setCopyWidth] = useState(0);
  const trackEl = useRef<HTMLElement | null>(null);
  const copyEl = useRef<HTMLElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);

  const measure = useCallback(() => {
    const track = trackEl.current;
    const copy = copyEl.current;
    if (track) setTrackWidth(track.clientWidth || 0);
    // getBoundingClientRect keeps the fractional width. Rounding here is how a
    // half-pixel per loop accumulates into a visible stutter after a minute.
    if (copy) setCopyWidth(copy.getBoundingClientRect().width || 0);
  }, []);

  const observe = useCallback(
    (node: HTMLElement | null, slot: React.MutableRefObject<HTMLElement | null>) => {
      if (slot.current && observer.current) observer.current.unobserve(slot.current);
      slot.current = node;
      if (node && observer.current) observer.current.observe(node);
      if (node) measure();
    },
    [measure]
  );

  useEffect(() => {
    if (typeof ResizeObserver !== 'undefined') {
      observer.current = new ResizeObserver(() => measure());
      if (trackEl.current) observer.current.observe(trackEl.current);
      if (copyEl.current) observer.current.observe(copyEl.current);
    }
    measure();
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      observer.current?.disconnect();
      observer.current = null;
    };
  }, [measure]);

  // A new message is a new measurement even when the old box was the same size.
  useEffect(() => {
    measure();
  }, [contentKey, measure]);

  const trackRef = useCallback((node: HTMLElement | null) => observe(node, trackEl), [observe]);
  const copyRef = useCallback((node: HTMLElement | null) => observe(node, copyEl), [observe]);

  const metrics = useMemo(
    () =>
      marqueeMetrics({
        trackWidth,
        copyWidth,
        pxPerSecond: pxPerSecondFor(speedSeconds),
      }),
    [trackWidth, copyWidth, speedSeconds]
  );

  return { ...metrics, trackRef, copyRef };
}

export default useTickerMarquee;
