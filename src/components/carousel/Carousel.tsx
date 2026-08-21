/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ENDLESS CAROUSEL — the World Hub's interaction model, rendered as DOM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-21: "you have the game cards, a user can join and be a part of
 * unlimited amounts of clubs, but the display is limited. We need to add the
 * same exact functionality that the World Hub page has, with the tiles swiping
 * back and forth in an endless carousel. (I do not want the floating
 * functionality added to the Club Arena.) Just the ability to swipe through to
 * the next card. Can you do a deep dive on /hub and isolate the code and use
 * what exists exactly here."
 *
 * WHAT /hub ACTUALLY IS, AND WHY THIS IS NOT A COPY-PASTE
 *
 * src/world/carousel/CarouselEngine.tsx in the World Hub repo is
 * react-three-fiber: it renders 3D orbs onto a WebGL canvas, drives itself
 * from useFrame, and positions with three.js `<group position scale>`. The
 * Club Arena club cards are DOM (ClubCardPanel, images, live stats, a context
 * menu). The file cannot be imported here, and rebuilding these cards in WebGL
 * to reuse it would be a rewrite of the wrong half.
 *
 * What IS portable, and what actually produces the feel Dan is pointing at, is
 * the interaction model. Every constant below is lifted from that engine
 * unchanged so this behaves identically under the hand:
 *
 *   sensitivity      0.003 * (1000 / viewportWidth)   scales with screen width
 *   fast swipe       |v| > 0.5   -> jump min(3, ceil(|v|)) cards
 *   medium swipe     |v| > 0.1   -> momentum of -v * 2, rounded
 *   slow             -> snap to nearest
 *   snap easing      position += (target - position) * 0.12  per frame
 *   click vs drag    a move under 10px is a click, not a drag
 *   click a side card-> snap to it rather than open it
 *
 * THE ENDLESS PART is the modulo fold, also taken verbatim: an index's offset
 * from centre is wrapped into [-N/2, +N/2], so the strip has no ends. Card 1
 * sits to the right of card N because that is simply where the shortest path
 * puts it. Nothing is cloned and no scroll position is reset at a seam.
 *
 * WHAT IS DELIBERATELY LEFT BEHIND
 *
 * The 3D engine also drops each card on the Y axis, pushes it back in Z and
 * spins it on entry. That is the floating Dan explicitly does not want here,
 * so the transform is flat: translateX and a scale that keeps the off-centre
 * cards readable as "next". No Y drift, no rotation, no bob.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from 'react';
import './Carousel.css';

/* ── Constants, all from the World Hub engine ──────────────────────────── */

/** Drag distance per card, relative to screen width. */
const SENSITIVITY_BASE = 0.003;
const SENSITIVITY_REFERENCE_WIDTH = 1000;

/** Above this px/ms the swipe is a fling and skips cards. */
const FLING_VELOCITY = 0.5;
/** Above this it carries a little momentum; below it, it just snaps. */
const MOMENTUM_VELOCITY = 0.1;
/** A fling never jumps more than this, however hard it is thrown. */
const MAX_FLING_CARDS = 3;
/** Per-frame approach to the target. Lower is slower and softer. */
const SNAP_EASING = 0.12;
/** Movement under this is a tap, not a drag. */
const CLICK_SLOP_PX = 10;
/** |offset| under this counts as "the centre card". */
const ACTIVE_OFFSET = 0.3;

/** How many cards each side of centre are rendered. */
const VISIBLE_HALF = 2.5;

/**
 * An index's signed distance from centre, wrapped into [-N/2, +N/2].
 *
 * THIS is the endless part, and it is the World Hub engine's fold verbatim.
 * The nearest way round is the way it is drawn, so with five clubs and the
 * first one centred, the FIFTH sits immediately to its left at offset -1 and
 * the strip has no ends. Nothing is cloned; no scroll position is silently
 * reset at a seam.
 *
 * Exported so the wrap can be tested directly. It is the one piece of maths
 * here that is easy to get subtly wrong and impossible to eyeball in a
 * screenshot.
 */
export function foldOffset(index: number, position: number, total: number): number {
  if (total <= 0) return 0;
  let offset = (index - position) % total;
  if (offset > total / 2) offset -= total;
  if (offset < -total / 2) offset += total;
  /* Normalise negative zero. JS `%` yields -0 for a negative dividend, so a
     card centred after the position has wrapped backwards came out as -0.
     It renders identically, but it is not equal to 0 under Object.is, so any
     later `offset === 0` check or sign test would quietly disagree with what
     is on screen. Cheaper to remove here than to debug there. */
  return offset === 0 ? 0 : offset;
}

export interface CarouselProps<T> {
  items: T[];
  renderItem: (item: T, index: number, isActive: boolean) => ReactNode;
  /** Stable key per item. Index keys break as the strip wraps. */
  getKey: (item: T, index: number) => string;
  /** Opening the centre card. Not called when the gesture was a drag. */
  onSelect?: (item: T, index: number) => void;
  /**
   * Card width. Omit to size responsively from the track, mirroring the
   * card's own `clamp(200px, 55vw, 300px)`.
   */
  itemWidth?: number;
  /** Horizontal distance between adjacent card centres, in px. */
  spacing?: number;
  /** Fraction of the item width between adjacent card centres. */
  spacingRatio?: number;
  /** Scale of a card one step off centre. 1 disables the size falloff. */
  edgeScale?: number;
  className?: string;
  ariaLabel?: string;
}

export function Carousel<T>({
  items,
  renderItem,
  getKey,
  onSelect,
  itemWidth,
  spacing,
  spacingRatio = 0.88,
  edgeScale = 0.82,
  className,
  ariaLabel = 'Cards',
}: CarouselProps<T>) {
  const total = items.length;
  const trackRef = useRef<HTMLDivElement>(null);

  const [scrollPosition, setScrollPosition] = useState(0);
  const targetRef = useRef(0);
  const positionRef = useRef(0);

  const isDragging = useRef(false);
  const startX = useRef(0);
  const lastX = useRef(0);
  const velocityX = useRef(0);
  const lastTime = useRef(0);
  const rafRef = useRef<number | null>(null);

  /**
   * Size from the track, not from the viewport.
   *
   * Mirrors `.carouselCardFeatured`'s own `clamp(200px, 55vw, 300px)` so the
   * carousel and the card cannot disagree about how wide a card is, which is
   * what decides whether neighbours peek or overlap. Measured from the track
   * rather than `window.innerWidth` because the strip is not always full
   * bleed, and a card sized to the viewport inside a narrower container
   * overlaps its neighbours by however much the container is inset.
   */
  const [trackWidth, setTrackWidth] = useState(0);
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => setTrackWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const resolvedItemWidth =
    itemWidth ?? (trackWidth > 0 ? Math.min(300, Math.max(200, trackWidth * 0.55)) : 300);
  /* 0.88 leaves the neighbours clearly readable with only a slight tuck under
     the centre card. The 3D engine can pack tighter because depth and scale do
     the separating; flat cards carrying a club name and live stats cannot. */
  const step = spacing ?? resolvedItemWidth * spacingRatio;

  /* Keep a ref alongside the state. The animation loop and the pointer
     handlers both need the CURRENT position, and a state read inside a
     long-lived listener sees whatever render created it. */
  const setPosition = useCallback((next: number) => {
    positionRef.current = next;
    setScrollPosition(next);
  }, []);

  /**
   * Normalise when the item count changes (a club joined or left) so the
   * modulo arithmetic below stays inside one lap. Taken from the engine, which
   * needs it for the same reason when a card is hidden.
   */
  useEffect(() => {
    if (total === 0) return;
    const normalised = ((positionRef.current % total) + total) % total;
    if (Math.abs(normalised - positionRef.current) > 0.01) {
      setPosition(normalised);
      targetRef.current = Math.round(normalised);
    }
  }, [total, setPosition]);

  /* ── The snap loop. useFrame in the 3D engine; rAF here. ──────────────── */
  useEffect(() => {
    const tick = () => {
      if (!isDragging.current) {
        const diff = targetRef.current - positionRef.current;
        if (Math.abs(diff) > 0.001) {
          setPosition(positionRef.current + diff * SNAP_EASING);
        } else if (positionRef.current !== targetRef.current) {
          setPosition(targetRef.current);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [setPosition]);

  /* ── Pointer + touch, matching the engine's canvas listeners ──────────── */
  useEffect(() => {
    const el = trackRef.current;
    if (!el || total === 0) return;

    const handleStart = (clientX: number) => {
      isDragging.current = true;
      startX.current = clientX;
      lastX.current = clientX;
      lastTime.current = Date.now();
      velocityX.current = 0;
      el.classList.add('sp-carousel--grabbing');
    };

    const handleMove = (clientX: number) => {
      if (!isDragging.current) return;
      const deltaX = clientX - lastX.current;
      const now = Date.now();
      const deltaTime = now - lastTime.current;
      if (deltaTime > 0) velocityX.current = deltaX / deltaTime;

      const width = el.clientWidth || window.innerWidth || SENSITIVITY_REFERENCE_WIDTH;
      const sensitivity = SENSITIVITY_BASE * (SENSITIVITY_REFERENCE_WIDTH / width);
      const scrollDelta = -deltaX * sensitivity;

      setPosition(positionRef.current + scrollDelta);
      targetRef.current += scrollDelta;

      lastX.current = clientX;
      lastTime.current = now;
    };

    const handleEnd = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      el.classList.remove('sp-carousel--grabbing');

      const absVelocity = Math.abs(velocityX.current);
      if (absVelocity > FLING_VELOCITY) {
        const direction = velocityX.current > 0 ? -1 : 1;
        const cards = Math.min(MAX_FLING_CARDS, Math.ceil(absVelocity));
        targetRef.current = Math.round(positionRef.current) + direction * cards;
      } else if (absVelocity > MOMENTUM_VELOCITY) {
        targetRef.current = Math.round(positionRef.current + -velocityX.current * 2);
      } else {
        targetRef.current = Math.round(positionRef.current);
      }
    };

    const onMouseDown = (e: MouseEvent) => handleStart(e.clientX);
    const onMouseMove = (e: MouseEvent) => handleMove(e.clientX);
    const onMouseUp = () => handleEnd();
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) handleStart(e.touches[0].clientX);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      // Claim the gesture only once it is clearly horizontal, so a vertical
      // flick still scrolls the page the card sits on.
      if (Math.abs(e.touches[0].clientX - startX.current) > 6) e.preventDefault();
      handleMove(e.touches[0].clientX);
    };
    const onTouchEnd = () => handleEnd();

    el.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);

    return () => {
      el.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [total, setPosition]);

  /** Move by whole cards. Used by the keyboard and the wheel. */
  const nudge = useCallback((by: number) => {
    targetRef.current = Math.round(targetRef.current) + by;
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      // Trackpads report horizontal intent; a mouse wheel only has deltaY.
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(delta) < 2) return;
      nudge(delta > 0 ? 1 : -1);
    },
    [nudge]
  );

  const handleCardClick = useCallback(
    (item: T, index: number, offset: number) => {
      // Exactly the engine's rule: a gesture that moved is not a click, and a
      // click on a card that is not centred brings it to the centre instead of
      // opening it.
      const dragDistance = Math.abs(startX.current - lastX.current);
      if (dragDistance >= CLICK_SLOP_PX) return;
      if (Math.abs(offset) < ACTIVE_OFFSET) {
        onSelect?.(item, index);
      } else {
        targetRef.current = Math.round(positionRef.current + offset);
      }
    },
    [onSelect]
  );

  /**
   * THE ENDLESS FOLD. An index's distance from centre, wrapped into
   * [-N/2, +N/2] so the shortest way round is the way it is drawn. This is
   * what makes the strip have no ends.
   */
  const visible = useMemo(() => {
    if (total === 0) return [];
    const out: { item: T; index: number; offset: number }[] = [];
    for (let i = 0; i < total; i++) {
      const offset = foldOffset(i, scrollPosition, total);
      if (Math.abs(offset) <= VISIBLE_HALF) out.push({ item: items[i], index: i, offset });
    }
    // Furthest first, so the centre card paints over its neighbours.
    return out.sort((a, b) => Math.abs(b.offset) - Math.abs(a.offset));
  }, [items, total, scrollPosition]);

  if (total === 0) return null;

  return (
    <div className={`sp-carousel ${className ?? ''}`.trim()}>
      <div
        ref={trackRef}
        className="sp-carousel__track"
        style={{ ['--sp-carousel-item-w' as string]: `${resolvedItemWidth}px` } as CSSProperties}
        role="group"
        aria-roledescription="carousel"
        aria-label={ariaLabel}
        tabIndex={0}
        onWheel={onWheel}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            nudge(1);
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            nudge(-1);
          }
        }}
      >
        {visible.map(({ item, index, offset }) => {
          const absOffset = Math.abs(offset);
          const isActive = absOffset < ACTIVE_OFFSET;
          // Linear falloff, clamped. Flat: no Y, no Z, no rotation.
          const scale = Math.max(edgeScale, 1 - absOffset * (1 - edgeScale));
          return (
            <div
              key={getKey(item, index)}
              className={`sp-carousel__item${isActive ? ' is-active' : ''}`}
              style={{
                transform: `translate(-50%, -50%) translateX(${offset * step}px) scale(${scale})`,
                zIndex: Math.round(100 - absOffset * 10),
                opacity: Math.max(0, 1 - absOffset * 0.28),
              }}
              aria-hidden={!isActive}
              onClick={() => handleCardClick(item, index, offset)}
            >
              {renderItem(item, index, isActive)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default Carousel;
