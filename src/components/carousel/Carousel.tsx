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
import { CarouselDots } from './CarouselDots';
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

/**
 * |offset| within this is a card the player can actually see and therefore
 * click.
 *
 * Every card used to be `inert` unless it was dead centre, which is what made
 * "click the side card" do nothing at all: `inert` removes an element from hit
 * testing AND from the tab order, so the onClick sitting on it never fired.
 * Opening a neighbour was impossible rather than merely two taps.
 *
 * 1.5 is one full step plus half, so at three-up it covers exactly the three
 * cards on stage and nothing beyond them. The outer pair the strip keeps
 * mounted for a smooth wrap sit at ±2 with 44% opacity, largely off-stage -
 * those stay inert, because a tab stop on a card nobody can see is noise.
 */
const INTERACTIVE_OFFSET = 1.5;

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
   * Fired once, the moment a gesture is judged to be a DRAG rather than a tap.
   *
   * Exists because a card can own press-and-hold behaviour of its own. The
   * club cards open a context menu after 500ms of touch, and a deliberate slow
   * swipe is easily longer than that, so without this the menu opens in the
   * middle of the swipe and the gesture is lost. The carousel is the only
   * thing that knows the difference between a hold and a drag, so it is the
   * thing that has to say so.
   */
  onDragStart?: () => void;
  /**
   * The centred card changed. Fires on the SETTLED index, not on every frame
   * of the animation, so it is a "you landed on a card" signal rather than a
   * scroll position. The World Hub engine exposes the same callback for the
   * same reason.
   */
  onIndexChange?: (index: number) => void;
  /**
   * Card width. Omit to size responsively from the track, mirroring the
   * card's own `clamp(200px, 55vw, 300px)`.
   */
  itemWidth?: number;
  /** Horizontal distance between adjacent card centres, in px. */
  spacing?: number;
  /** Fraction of the item width between adjacent card centres. */
  spacingRatio?: number;
  /**
   * How many cards should be VISIBLE at once, sized from the track.
   *
   * Dan 2026-08-21: "IT NEEDS TO DISPLAY 3 CARDS AT ONCE... NOT ONLY DISPLAY
   * ONE AT A TIME." The old sizing was `min(300, max(200, track * 0.55))`,
   * which is a ONE-UP rule: at over half the track per card there is no room
   * for a neighbour to sit beside the centre, so the strip reads as a single
   * card even though the neighbours are mounted.
   *
   * When set, each card is sized so this many fit across the track with a
   * little breathing room, which is what actually makes three of them show.
   * Left undefined the previous behaviour is unchanged, so no other carousel
   * on the site moves.
   */
  visibleCards?: number;
  /** Scale of a card one step off centre. 1 disables the size falloff. */
  edgeScale?: number;
  className?: string;
  ariaLabel?: string;
  /**
   * Which card to open on. Clamped and folded, so an index from stale storage
   * or a club that has since been left cannot put the strip somewhere odd.
   * The World Hub engine takes the same prop for the same reason.
   */
  initialIndex?: number;
  /** Show the position indicator below the strip. */
  showIndicator?: boolean;
  /** What one item is called, for the indicator's screen-reader labels. */
  itemNoun?: string;
}

export function Carousel<T>({
  items,
  renderItem,
  getKey,
  onSelect,
  onDragStart,
  onIndexChange,
  itemWidth,
  spacing,
  spacingRatio = 0.88,
  edgeScale = 0.82,
  visibleCards,
  className,
  ariaLabel = 'Cards',
  initialIndex = 0,
  showIndicator = true,
  itemNoun = 'Card',
}: CarouselProps<T>) {
  const total = items.length;
  const trackRef = useRef<HTMLDivElement>(null);
  /* The loop is bound once; it reads the live count through this. */
  const totalRef = useRef(total);
  totalRef.current = total;

  /* Opening position. Read once: this is where the strip STARTS, not a
     controlled value, so a later change must not yank a card out from under a
     player mid-swipe. */
  const [scrollPosition, setScrollPosition] = useState(() =>
    total > 0 ? ((Math.round(initialIndex) % total) + total) % total : 0
  );
  const targetRef = useRef(scrollPosition);
  const positionRef = useRef(scrollPosition);

  const isDragging = useRef(false);
  const startX = useRef(0);
  const lastX = useRef(0);
  const velocityX = useRef(0);
  const lastTime = useRef(0);
  const rafRef = useRef<number | null>(null);
  /** Guards onDragStart to one call per gesture. */
  const announcedDrag = useRef(false);
  /* Held in a ref so the pointer listeners, which are bound once, always call
     the CURRENT callback without re-binding on every render. */
  const onDragStartRef = useRef(onDragStart);
  onDragStartRef.current = onDragStart;

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

  /**
   * Card width.
   *
   * Solved from the composition rather than guessed at. A strip of
   * `visibleCards` cards, centre at scale 1 and the outer pair at `edgeScale`,
   * spaced `spacingRatio` of a card apart, occupies exactly
   *
   *     span = w * ((visibleCards - 1) * spacingRatio + edgeScale)
   *
   * measured outer edge to outer edge - because the outermost card is DRAWN
   * SCALED, so it contributes `edgeScale * w` of visible width, not `w`. Set
   * span = trackWidth and the width falls out.
   *
   * The old rule was `trackWidth / (visibleCards + 0.5)`, a divisor that knew
   * nothing about either scale or spacing. At three-up it reserved a phantom
   * half-card of margin that the scale falloff had already paid for, so the
   * cards came out ~30% narrower than the stage they sat in and the lobby read
   * as three small cards adrift in a wide empty band. Dan 2026-08-22: "IT
   * SHOULD SHOW 1-3 CARDS ON THE PAGE, WITH THE CARD IN THE MIDDLE THE
   * LARGEST."
   *
   * Below NARROW_TRACK_PX there is not enough room for three readable club
   * cards - a phone would get three ~110px slivers - so it falls back to a
   * centre card with peeking neighbours. Mobile-first means the small screen
   * gets the layout that works on it, not a scaled-down copy of the desktop.
   */
  const NARROW_TRACK_PX = 620;
  const effectiveVisible =
    visibleCards && trackWidth > 0 && trackWidth < NARROW_TRACK_PX
      ? Math.min(visibleCards, 1.6)
      : visibleCards;

  /* Guarded at 1: a divisor below one would make a card WIDER than its own
     track, which is how a "make them bigger" tweak becomes overflow. */
  const spanDivisor = effectiveVisible
    ? Math.max(1, (effectiveVisible - 1) * spacingRatio + edgeScale)
    : 0;

  /* Dan 2026-08-24 (lobby round 2, from a phone screenshot): "THE CLUB CARDS
     MUST BE LOWERED AND NEED TO BE SMALLER." On a narrow track the span
     formula hands the centre card ~84% of the track — a 294px monolith on a
     390px phone that shoved the tile row off screen. Cap it at 66% of the
     track on narrow viewports; desktop keeps the pure span solution. */
  const narrowCap =
    trackWidth > 0 && trackWidth < NARROW_TRACK_PX ? trackWidth * 0.66 : Number.POSITIVE_INFINITY;
  const resolvedItemWidth =
    itemWidth ??
    (trackWidth > 0
      ? effectiveVisible
        ? Math.min(420, narrowCap, Math.max(190, trackWidth / spanDivisor))
        : Math.min(300, narrowCap, Math.max(200, trackWidth * 0.55))
      : 300);
  /* Adjacent centres sit `spacingRatio` of a card apart. Anything below
     (1 + edgeScale) / 2 makes a neighbour physically overlap the centre card,
     which flat cards carrying a club name and live stats cannot survive - the
     3D engine can pack tighter only because depth does the separating. */
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
    /* Someone who has asked the OS for reduced motion should not be given a
       spring. Snapping straight to the target still moves the carousel and
       still answers the swipe; it just does not animate the travel. */
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

    const tick = () => {
      if (!isDragging.current) {
        const diff = targetRef.current - positionRef.current;
        if (reduced && Math.abs(diff) > 0.001) {
          setPosition(targetRef.current);
        } else if (Math.abs(diff) > 0.001) {
          setPosition(positionRef.current + diff * SNAP_EASING);
        } else if (positionRef.current !== targetRef.current) {
          setPosition(targetRef.current);
        } else if (totalRef.current > 0) {
          /* SETTLED: fold the position back into one lap.
             Nothing bounds it otherwise. Every fling adds whole cards to it
             and it is never subtracted, so a long session walks it upward
             indefinitely and float precision degrades under the modulo that
             every frame depends on. Doing it only once the animation has come
             to rest means the fold can never produce a visible jump: the
             rendered layout is a function of the FOLDED offset, which this
             does not change. */
          const total = totalRef.current;
          const wrapped = ((positionRef.current % total) + total) % total;
          if (wrapped !== positionRef.current) {
            positionRef.current = wrapped;
            targetRef.current = wrapped;
            setScrollPosition(wrapped);
          }
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
      announcedDrag.current = false;
      el.classList.add('sp-carousel--grabbing');
    };

    const handleMove = (clientX: number) => {
      if (!isDragging.current) return;
      const deltaX = clientX - lastX.current;
      const now = Date.now();
      const deltaTime = now - lastTime.current;
      if (deltaTime > 0) velocityX.current = deltaX / deltaTime;

      // Announce the drag exactly once, at the same threshold that decides a
      // tap is not a click, so "this is a drag" means one thing everywhere.
      if (!announcedDrag.current && Math.abs(clientX - startX.current) >= CLICK_SLOP_PX) {
        announcedDrag.current = true;
        onDragStartRef.current?.();
      }

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

  /**
   * Announce the centred card, once it has actually settled there.
   *
   * Deliberately keyed off the ROUNDED position rather than the raw one: mid
   * swipe the position sweeps continuously through every value between two
   * cards, and firing on that would be a scroll event wearing a different
   * name. The consumer wants "the player landed on this club".
   */
  const settledIndex = total > 0 ? ((Math.round(scrollPosition) % total) + total) % total : 0;
  const lastAnnouncedIndex = useRef<number | null>(null);
  useEffect(() => {
    if (total === 0) return;
    if (lastAnnouncedIndex.current === settledIndex) return;
    const isFirst = lastAnnouncedIndex.current === null;
    lastAnnouncedIndex.current = settledIndex;
    // Never on mount. The old scroll-based version fired its snap sound on
    // page load, with the player having touched nothing.
    if (!isFirst) onIndexChange?.(settledIndex);
  }, [settledIndex, total, onIndexChange]);

  /**
   * Go to a specific card, the short way.
   *
   * Naively setting the target to the index would walk the long way round
   * whenever the wrap is closer: from card 1 of 20, tapping card 20 would
   * animate backwards through eighteen cards instead of forward through one.
   * The fold already knows which direction is nearer, so reuse it.
   */
  const goTo = useCallback((index: number) => {
    const offset = foldOffset(index, targetRef.current, totalRef.current);
    targetRef.current = Math.round(targetRef.current + offset);
  }, []);

  /** Move by whole cards. Used by the keyboard and the wheel. */
  const nudge = useCallback((by: number) => {
    targetRef.current = Math.round(targetRef.current) + by;
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      /* HORIZONTAL INTENT ONLY. Reading deltaY here as well felt clever and
         was a trap: the carousel is one section of a scrolling page, so every
         ordinary mouse wheel scroll over it moved the cards INSTEAD of
         scrolling the page, and there was no way past it with a wheel. A
         trackpad two-finger swipe reports deltaX and still works. */
      if (Math.abs(e.deltaX) < 2 || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      nudge(e.deltaX > 0 ? 1 : -1);
    },
    [nudge]
  );

  const handleCardClick = useCallback(
    (item: T, index: number, _offset: number) => {
      /* A gesture that MOVED is still not a click - that part of the engine's
         rule stays, or every swipe would open whatever it started on.

         What is gone is the second half: "a click on a card that is not centred
         brings it to the centre instead of opening it." Dan 2026-08-23: "even
         though the one card is front and center, you should still be able to
         click on any card to go to that club or union."

         That rule came from the World Hub's 3D carousel, where the off-centre
         orbs are small, angled and half behind the centre one - there, centring
         first is genuinely the only sane reading of a tap. Here the neighbours
         are full club cards at 0.8 scale with a readable name and live stats.
         Tapping one and being made to tap again is a toll, not a safeguard. */
      const dragDistance = Math.abs(startX.current - lastX.current);
      if (dragDistance >= CLICK_SLOP_PX) return;
      void _offset;
      onSelect?.(item, index);
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

  /**
   * Render each card ONCE per (identity, active) pair, not once per frame.
   *
   * `visible` recomputes on every animation frame because it depends on the
   * scroll position, so the map below re-invoked renderItem 5 times a frame
   * during a drag. Each of those is a ClubCardPanel: a lazy component with an
   * image, live stats and its own effects. At 60fps that is ~300 renders a
   * second of some of the heaviest markup on the page, to change nothing but a
   * transform on the wrapper.
   *
   * Keyed on `isActive` as well as identity so a card entering or leaving the
   * centre still re-renders: that is two renders per snap instead of five per
   * frame. The wrapper's transform and opacity keep updating every frame, as
   * they must, but they are compositor-only properties on an element whose
   * children React now leaves alone.
   */
  const renderedRef = useRef(new Map<string, { active: boolean; node: ReactNode }>());

  /* -- THE CACHE MUST DIE WHEN renderItem DOES (Dan 2026-08-22) -------------
     Bug this fixes: LEVEL read 1 and ACTIVE read 0 on every club and union
     card, permanently, while MEMBERS was correct.

     Nothing was wrong with the data. clubs.member_count was 588, the ladder
     puts that at level 29, and fn_batch_active_player_counts returned 112 -
     all verified against production. The card simply never showed them,
     because the cache below is a plain ref keyed on identity ALONE. The
     lobby's first paint happens BEFORE the stats query resolves, so it renders
     the `?? 1` / `?? 0` fallbacks in CarouselSection, and THAT node is what got
     stored. A second later the stats land, `clubStats` changes, `renderItem`
     gets a new identity - and `renderCard` handed back the frozen node anyway.
     The 20-second poll then re-fetched correct numbers forever and could not
     put a single one of them on screen. MEMBERS looked fine only because ITS
     fallback (club.member_count, already loaded) was already the right answer.

     A cache keyed on less than its inputs is not a cache, it is a snapshot. So
     drop everything the moment the render function itself changes. This costs
     nothing the cache was bought for: `renderItem` is memoised by its caller
     and changes only when the DATA changes (a few times per page), never per
     frame. The drag path - `visible` recomputing 60 times a second with a
     stable `renderItem` - still hits the cache every time.

     Done in the render body rather than in an effect ON PURPOSE: an effect runs
     AFTER this render is already committed with stale children, so the new
     numbers would be a frame late and would only appear at all if something
     else re-rendered afterwards. */
  const lastRenderItemRef = useRef(renderItem);
  if (lastRenderItemRef.current !== renderItem) {
    lastRenderItemRef.current = renderItem;
    renderedRef.current.clear();
  }

  const renderCard = useCallback(
    (item: T, index: number, isActive: boolean): ReactNode => {
      const key = getKey(item, index);
      const cached = renderedRef.current.get(key);
      if (cached && cached.active === isActive) return cached.node;
      const node = renderItem(item, index, isActive);
      renderedRef.current.set(key, { active: isActive, node });
      return node;
    },
    [getKey, renderItem]
  );

  /**
   * The sizer's copy, memoised SEPARATELY from the visible cards.
   *
   * It must not share the cache above: the sizer always asks for isActive
   * false while the same card, when centred, asks for true, so two calls with
   * one key and different flags would invalidate each other on every single
   * render. That is worse than no cache at all, and only for the first card,
   * which is exactly the sort of bug that looks like "the carousel is janky on
   * some clubs and not others".
   *
   * It is never interactive and never active, so identity is the only input.
   */
  const sizerNode = useMemo(
    () => (items.length > 0 ? renderItem(items[0], 0, false) : null),
    [items, renderItem]
  );

  /* Drop cached nodes for items that no longer exist, so leaving a club does
     not leak its card for the life of the page. */
  useEffect(() => {
    const live = new Set(items.map((it, i) => getKey(it, i)));
    for (const key of renderedRef.current.keys()) {
      if (!live.has(key)) renderedRef.current.delete(key);
    }
  }, [items, getKey]);

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
        {/* HEIGHT SIZER. Every real card is absolutely positioned, so the track
            has no intrinsic height; it used to carry a hand-picked
            `clamp(320px, 62vw, 430px)` and `overflow: hidden`, which is a
            guess about a card whose height is content-driven (club name, logo,
            live stats). Guess low and the card is silently clipped.

            One extra copy of the first card, in normal flow and invisible,
            gives the track exactly the height of a real card at whatever the
            current width is, with no magic number and no measurement code to
            drift. visibility:hidden still occupies layout, which is the whole
            point; aria-hidden and pointer-events:none keep it out of the
            accessibility tree and out of the way of the pointer. */}
        <div className="sp-carousel__sizer" aria-hidden="true">
          {sizerNode}
        </div>

        {visible.map(({ item, index, offset }) => {
          const absOffset = Math.abs(offset);
          const isActive = absOffset < ACTIVE_OFFSET;
          const isInteractive = absOffset <= INTERACTIVE_OFFSET;
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
              /* `inert` rather than aria-hidden. The club card inside is
                 focusable (role="button", tabIndex 0), and aria-hidden on
                 something reachable by Tab is an outright a11y violation: a
                 keyboard user lands on a control screen readers were told does
                 not exist. inert removes it from BOTH, and React 19 passes it
                 through to the DOM.

                 Scoped to INTERACTIVE_OFFSET rather than to the centre card:
                 every card the player can SEE is a club they can open, by
                 pointer or by keyboard. Only the off-stage pair kept mounted
                 for the wrap is inert. */
              inert={!isInteractive}
              onClick={() => handleCardClick(item, index, offset)}
            >
              {renderCard(item, index, isActive)}
            </div>
          );
        })}
      </div>

      {showIndicator && (
        <CarouselDots total={total} current={settledIndex} onChange={goTo} itemNoun={itemNoun} />
      )}
    </div>
  );
}

export default Carousel;
