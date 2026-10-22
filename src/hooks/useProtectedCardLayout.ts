import { useLayoutEffect, type RefObject } from 'react';
import { placeProtectedCardRow, type CardBox } from '../lib/protectedCardPlacement';
import {
  assignProtectedWagers,
  greedyProtectedWagers,
  wagerBoxesOverlap,
} from '../lib/protectedWagerPlacement';
import {
  FELT_WINDOW,
  projectPortraitTable,
  unprojectPortraitTable,
  chipRadiusWidthPct,
} from '../components/table/tableGeometry';

/** Layout belongs to the table that paints it; no global selectors or game-state writes. */
export function useProtectedCardLayout(root: RefObject<HTMLDivElement | null>, revision: string) {
  useLayoutEffect(() => {
    const scaler = root.current;
    const page = scaler?.closest('.table-page');
    if (!scaler || !page) return;
    const topPods = () => Array.from(scaler.querySelectorAll<HTMLElement>('.seat-wrapper--top'));
    const wagers = () => Array.from(scaler.querySelectorAll<HTMLElement>('.seat__bet-chips'));
    const resetWagers = () =>
      wagers().forEach((bet) => {
        for (const name of ['--bet-offset-x', '--bet-offset-y', '--collect-dx', '--collect-dy'])
          bet.style.removeProperty(name);
      });
    const place = () => {
      resetWagers();
      scaler.querySelector<HTMLElement>('.dealer-button')?.style.removeProperty('translate');
      const rows = Array.from(scaler.querySelectorAll<HTMLElement>('.seat__cards--revealed'));
      rows.forEach((row) => row.style.removeProperty('translate'));
      const scale = scaler.getBoundingClientRect().width / scaler.offsetWidth || 1;
      topPods().forEach((pod) => {
        pod.style.removeProperty('translate');
        pod.style.removeProperty('--sp-top-seat-shift');
      });
      const pageBox = page.getBoundingClientRect();
      const chrome = Array.from(page.querySelectorAll('.bbj-widget, .bbj-mini-plate'))
        .map((element) => element.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.height > 0);
      // Every phone table needs the top-seat lane, including tables without
      // a payable Mini BBJ or any jackpot. Keep the declared plate band when
      // chrome is absent; the embedded page already starts below the tab bar.
      const plateHeight =
        parseFloat(getComputedStyle(page).getPropertyValue('--sp-bbj-plate-h')) || 0;
      const chromeBottom = chrome.length
        ? Math.max(...chrome.map((box) => box.bottom))
        : pageBox.top + plateHeight;
      if (pageBox.width <= 768) {
        for (const pod of topPods()) {
          const image = pod.querySelector('.seat__avatar-img')?.getBoundingClientRect();
          if (image && image.height > 0) {
            // Dan 2026-10-22: "pull the table down so the top player isn't
            // scrunched up." The pod's highest painted part (the art, or the
            // position chip on its corner) keeps 8px of air below the jackpot
            // plate rather than 4px against it.
            const badge = pod.querySelector('.seat__position-badge')?.getBoundingClientRect();
            const highest = Math.min(image.top, badge && badge.height > 0 ? badge.top : Infinity);
            const shift = (chromeBottom + 8 * scale - highest) / scale;
            pod.style.translate = `0px ${shift}px`;
            // Bets use the scaler's rail coordinates. Moving the top avatar
            // within its lane must not carry its bet onto the player plate.
            pod.style.setProperty('--sp-top-seat-shift', `${shift}px`);
          }
        }
      }
      const visibleBox = (element: Element): CardBox | null => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 ? box : null;
      };
      if (window.innerWidth <= 480 && window.innerHeight > window.innerWidth) {
        const canvas = scaler.getBoundingClientRect();
        const size = { w: canvas.width, h: canvas.height };
        const inset = (chipRadiusWidthPct(size) * canvas.width) / 100 + 3;
        const radius = (FELT_WINDOW.width * canvas.width) / 200 - inset;
        const cx = ((FELT_WINDOW.left + FELT_WINDOW.width / 2) * canvas.width) / 100;
        const upper =
          (FELT_WINDOW.top * canvas.height) / 100 + (FELT_WINDOW.width * canvas.width) / 200;
        const lower =
          ((FELT_WINDOW.top + FELT_WINDOW.height) * canvas.height) / 100 -
          (FELT_WINDOW.width * canvas.width) / 200;
        const points: { x: number; y: number; depth: number }[] = [];
        let depth = 0;
        const add = (x: number, y: number) => {
          const projected = projectPortraitTable({
            x: (x / canvas.width) * 100,
            y: (y / canvas.height) * 100,
          });
          points.push({
            x: canvas.left + (projected.x * canvas.width) / 100,
            y: canvas.top + (projected.y * canvas.height) / 100,
            depth,
          });
        };
        /* Dan 2026-10-21: "MAKE SURE WHEN CHIPS ARE PUT IN THE POT THEY ARE
           ACTUALLY ON THE TABLE, AND NOT ON THE RAIL ... THEY NEED TO BE
           FARTHER IN." The bands are CENTRES, and a wager is a disc with its
           amount printed beside it (plus the ALL IN puck when the player is
           all in), so a centre a few pixels inside the felt still printed half
           the stack on the rail. Candidates now walk further in, and one is
           only eligible when the WHOLE wager box is on the painted felt with
           daylight to spare (see `wagerOnFelt`). */
        const feltMarginPx = Math.max(8, canvas.width * 0.025);
        const wagerOnFelt = (box: CardBox): boolean =>
          [
            [box.left, box.top],
            [box.left + box.width, box.top],
            [box.left, box.top + box.height],
            [box.left + box.width, box.top + box.height],
          ].every(([x, y]) => {
            const flat = unprojectPortraitTable({
              x: ((x - canvas.left) / canvas.width) * 100,
              y: ((y - canvas.top) / canvas.height) * 100,
            });
            const px = (flat.x * canvas.width) / 100;
            const py = (flat.y * canvas.height) / 100;
            const spineY = Math.min(Math.max(py, upper), lower);
            return Math.hypot(px - cx, py - spineY) <= radius + inset - feltMarginPx;
          });
        for (const extra of [0, 10, 20, 28, 36, 44, 52, 64, 76, 88, 100]) {
          depth = extra;
          const band = radius - extra;
          for (let angle = 0; angle < 360; angle += 2) {
            const radians = (angle * Math.PI) / 180;
            add(
              cx + Math.cos(radians) * band,
              (Math.sin(radians) < 0 ? upper : lower) + Math.sin(radians) * band
            );
          }
          for (let y = upper; y <= lower; y += 3) {
            add(cx - band, y);
            add(cx + band, y);
          }
        }
        const obstacles = Array.from(
          page.querySelectorAll(
            '.community-area, .table-brand, .pot-display, .pot-display__pile, .seat__avatar-img, .seat__info, .seat__action, .seat__bounty, .seat__position-badge, .seat__cards--hero .seat__card, .bbj-widget, .bbj-mini-plate'
          )
        )
          .map(visibleBox)
          .filter((box): box is CardBox => box !== null);
        // The printed table name is the one obstacle a marker may stand on as a
        // last resort: on the smallest phones (320px) the players, the board and
        // the pot leave almost no bare felt, and printing over the felt's own
        // lettering beats stacking two players' chips in one spot.
        const printing = Array.from(page.querySelectorAll('.table-brand'))
          .map(visibleBox)
          .filter((box): box is CardBox => box !== null);
        const hardObstacles = obstacles.filter(
          (box) =>
            !printing.some(
              (mark) =>
                mark.left === box.left &&
                mark.top === box.top &&
                mark.width === box.width &&
                mark.height === box.height
            )
        );

        /* Dan 2026-10-22: "that 50 cents to my left is actually my bet, it's
           sitting in front of the other player." The nearest clear felt spot
           can be nearer a neighbour than its owner when the owner's own front
           is crowded, and then the wager reads as the neighbour's. A wager may
           only stand where its OWN player is the nearest player (avatar
           centres), on every pool but the last-resort one. */
        const playerCentres = Array.from(page.querySelectorAll('.seat-wrapper'))
          .map((wrapper) => wrapper.querySelector('.seat:not(.seat--empty) .seat__avatar-img'))
          .filter((img): img is Element => img !== null)
          .map((img) => {
            const r = img.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          })
          .filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y));
        const entries = wagers().flatMap((bet) => {
          const box = visibleBox(bet);
          const owner = bet
            .closest('.seat-wrapper')
            ?.querySelector('.seat__avatar-img')
            ?.getBoundingClientRect();
          if (!box || !owner) return [];
          const desired = { x: owner.left + owner.width / 2, y: owner.top + owner.height / 2 };
          const placed = points.map((point) => ({
            left: point.x - box.width / 2,
            top: point.y - box.height / 2,
            width: box.width,
            height: box.height,
            depth: point.depth,
          }));
          const clearOfTable = placed.filter(
            (candidate) => !obstacles.some((obstacle) => wagerBoxesOverlap(candidate, obstacle))
          );
          // Wholly on the felt whenever every wager fits there together. On a
          // small, crowded phone they may not, and then the nearest spots that
          // still clear every player, the board, the pot and each other are
          // used, rail band included, rather than leaving a wager on a player.
          const byCost = (a: (typeof clearOfTable)[number], b: (typeof clearOfTable)[number]) =>
            Math.hypot(a.left + a.width / 2 - desired.x, a.top + a.height / 2 - desired.y) +
            2 * a.depth -
            (Math.hypot(b.left + b.width / 2 - desired.x, b.top + b.height / 2 - desired.y) +
              2 * b.depth);
          const distinct = (list: typeof clearOfTable, cap: number): CardBox[] => {
            const kept: CardBox[] = [];
            for (const candidate of list) {
              if (
                kept.every(
                  (other) => Math.hypot(candidate.left - other.left, candidate.top - other.top) >= 4
                )
              )
                kept.push(candidate);
              if (kept.length >= cap) break;
            }
            return kept;
          };
          const ownedBy = (candidate: (typeof clearOfTable)[number]): boolean => {
            const cx0 = candidate.left + candidate.width / 2;
            const cy0 = candidate.top + candidate.height / 2;
            const own = Math.hypot(cx0 - desired.x, cy0 - desired.y);
            return playerCentres.every(
              (other) =>
                Math.hypot(other.x - desired.x, other.y - desired.y) < 1 ||
                own < Math.hypot(cx0 - other.x, cy0 - other.y)
            );
          };
          const nearest = [...clearOfTable].sort(byCost);
          const owned = nearest.filter(ownedBy);
          const overPrinting = placed
            .filter(
              (candidate) =>
                !hardObstacles.some((obstacle) => wagerBoxesOverlap(candidate, obstacle))
            )
            .sort(byCost)
            .filter(ownedBy);
          return [
            {
              bet,
              box,
              felt: distinct(owned.filter(wagerOnFelt), 96),
              // Exactly the rail-band slots this placer has always offered.
              candidates: distinct(
                owned.filter((candidate) => candidate.depth <= 20),
                96
              ),
              wide: distinct(owned, 160),
              any: distinct(nearest, 160),
              printing: distinct(overPrinting, 160),
              // Last resort on the smallest felts: this player's own spots, the
              // least covered first, so two players' wagers never share one.
              least: distinct(
                placed
                  .filter(ownedBy)
                  .map((candidate) => ({
                    candidate,
                    covered: hardObstacles.reduce(
                      (sum, o) =>
                        sum +
                        Math.max(
                          0,
                          Math.min(candidate.left + candidate.width, o.left + o.width) -
                            Math.max(candidate.left, o.left)
                        ) *
                          Math.max(
                            0,
                            Math.min(candidate.top + candidate.height, o.top + o.height) -
                              Math.max(candidate.top, o.top)
                          ),
                      0
                    ),
                  }))
                  .sort(
                    (a, b) =>
                      a.covered - b.covered ||
                      byCost(a.candidate, b.candidate)
                  )
                  .map((entry) => entry.candidate),
                160
              ),
            },
          ];
        });
        // Every wager on the felt at once when the table allows it. A crowded
        // short phone (three players all in on one side) can leave no joint
        // solution; then each wager still takes its own best clear spot in
        // turn, instead of every wager staying wherever it first landed.
        const placements =
          assignProtectedWagers(entries.map((entry) => entry.felt)) ??
          assignProtectedWagers(entries.map((entry) => entry.candidates)) ??
          assignProtectedWagers(entries.map((entry) => entry.wide)) ??
          // The exact search has a fixed budget; a crowded ring can exhaust it
          // while each player's own spots still fit side by side greedily.
          cleanGreedyWagers(entries.map((entry) => entry.wide)) ??
          assignProtectedWagers(entries.map((entry) => entry.any)) ??
          // The smallest felts: over the felt's own lettering before two
          // players' wagers are stacked in one spot.
          assignProtectedWagers(entries.map((entry) => entry.printing)) ??
          greedyProtectedWagers(
            entries.map((entry) => [...entry.wide, ...entry.any, ...entry.least])
          );
        const placedWagers: CardBox[] = [];
        for (let i = 0; i < entries.length; i++) {
          const { bet, box } = entries[i];
          const next = placements?.[i];
          if (!next) continue;
          const dx = (next.left - box.left) / scale;
          const dy = (next.top - box.top) / scale;
          const style = getComputedStyle(bet);
          const number = (name: string) => parseFloat(style.getPropertyValue(name)) || 0;
          const base = {
            x: number('--bet-offset-x'),
            y: number('--bet-offset-y'),
            cx: number('--collect-dx'),
            cy: number('--collect-dy'),
          };
          bet.style.setProperty('--bet-offset-x', `${base.x + dx}px`);
          bet.style.setProperty('--bet-offset-y', `${base.y + dy}px`);
          bet.style.setProperty('--collect-dx', `${base.cx - dx}px`);
          bet.style.setProperty('--collect-dy', `${base.cy - dy}px`);
          obstacles.push(next);
          hardObstacles.push(next);
          placedWagers.push(next);
        }
        // The button goes last: it is the smallest marker and the freest to
        // move, so it takes a spot beside its own player that the wagers left.
        placeDealerButton(scaler, canvas, scale, points, obstacles, hardObstacles, placedWagers);
      }
      const protectedBoxes = Array.from(
        page.querySelectorAll(
          '.community-area, .table-brand, .seat__avatar-img, .pot-area, .pot-display, .seat__info, .seat__bet-chips, .seat__strength, .seat__action, .seat__bounty, .seat__position-badge, .pot-display__pile, .action-panel, .bbj-mini-plate, .cch-column, .chat-collapsed'
        )
      )
        .map(visibleBox)
        .filter((box): box is CardBox => box !== null);
      const dealer = scaler.querySelector<HTMLElement>('.dealer-button');
      if (dealer) {
        const settled = dealerSettledBox(scaler, dealer);
        if (settled) protectedBoxes.push(settled);
      }
      const bounds = page.getBoundingClientRect();
      for (const row of rows) {
        // Hero containers span the reserved bottom strip; only the painted
        // cards are obstacles, not that transparent flex alignment space.
        const cards = Array.from(row.querySelectorAll('.seat__card'))
          .map(visibleBox)
          .filter((box): box is CardBox => box !== null);
        if (!cards.length) continue;
        const left = Math.min(...cards.map((card) => card.left));
        const top = Math.min(...cards.map((card) => card.top));
        const box = {
          left,
          top,
          width: Math.max(...cards.map((card) => card.left + card.width)) - left,
          height: Math.max(...cards.map((card) => card.top + card.height)) - top,
        };
        const next = placeProtectedCardRow(box, protectedBoxes, bounds);
        if (next) {
          // translate is independent of the deal/flip transform and preserves animations.
          row.style.translate = `${(next.left - box.left) / scale}px ${(next.top - box.top) / scale}px`;
          protectedBoxes.push(next);
        }
      }
    };
    place();
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        place();
      });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(scaler);
    observer.observe(page);
    // SeatSlot reveals on its own animation clock, after the parent's commit.
    // React's child insertion/class change is the layout event to consume.
    const mutations = new MutationObserver(schedule);
    mutations.observe(scaler, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    document.fonts?.addEventListener('loadingdone', schedule);
    scaler.addEventListener('animationend', schedule);
    scaler.addEventListener('transitionend', schedule);
    scaler.addEventListener('load', schedule, true);
    return () => {
      document.fonts?.removeEventListener('loadingdone', schedule);
      resetWagers();
      observer.disconnect();
      mutations.disconnect();
      scaler.removeEventListener('animationend', schedule);
      scaler.removeEventListener('transitionend', schedule);
      scaler.querySelector<HTMLElement>('.dealer-button')?.style.removeProperty('translate');
      scaler.removeEventListener('load', schedule, true);
      if (frame !== null) cancelAnimationFrame(frame);
      topPods().forEach((pod) => {
        pod.style.removeProperty('translate');
        pod.style.removeProperty('--sp-top-seat-shift');
      });
      scaler
        .querySelectorAll<HTMLElement>('.seat__cards--revealed')
        .forEach((row) => row.style.removeProperty('translate'));
    };
  }, [root, revision]);
}

/**
 * Where the dealer button will stand once its left/top glide settles, in page
 * pixels, including any translate this hook gave it. Read from the inline
 * percentages rather than the live box, because during the 0.6s glide between
 * seats the live box is somewhere on the way.
 */
function dealerSettledBox(scaler: HTMLElement, dealer: HTMLElement): CardBox | null {
  const canvas = scaler.getBoundingClientRect();
  const left = parseFloat(dealer.style.left);
  const top = parseFloat(dealer.style.top);
  if (!Number.isFinite(left) || !Number.isFinite(top) || canvas.width <= 0) return null;
  const scale = canvas.width / (scaler.offsetWidth || canvas.width);
  const size = (dealer.offsetWidth || 0) * scale;
  if (size <= 0) return null;
  const shift = (dealer.style.translate || '0px 0px').split(/\s+/).map((v) => parseFloat(v) || 0);
  const x = canvas.left + (left / 100) * canvas.width + (shift[0] || 0) * scale;
  const y = canvas.top + (top / 100) * canvas.height + (shift[1] || 0) * scale;
  return { left: x - size / 2, top: y - size / 2, width: size, height: size };
}

/**
 * Dan 2026-10-22, from a real phone: "I'm actually one behind the button and
 * the button is right in front of me." The button's rest point is computed in
 * ring geometry, which on a phone does not know where the tags, bounties and
 * dropped hero actually landed, so its keep-outs can push it across the felt
 * until it stands nearer the next player than its own. This pass runs on the
 * painted layout: the button keeps its rest point when that point is clear of
 * every player, the board and the pot AND its own player is the nearest one;
 * otherwise it takes the nearest felt point that satisfies both. It runs
 * after the wagers are placed, and keeps clear of them too.
 */
function placeDealerButton(
  scaler: HTMLElement,
  canvas: DOMRect,
  scale: number,
  points: ReadonlyArray<{ x: number; y: number; depth: number }>,
  obstacles: ReadonlyArray<CardBox>,
  hardObstacles: ReadonlyArray<CardBox> = obstacles,
  wagers: ReadonlyArray<CardBox> = []
): CardBox | null {
  const dealer = scaler.querySelector<HTMLElement>('.dealer-button');
  if (!dealer) return null;
  const rest = dealerSettledBox(scaler, dealer);
  if (!rest) return null;
  const left = parseFloat(dealer.style.left);
  const top = parseFloat(dealer.style.top);
  const ownerX = parseFloat(dealer.dataset.ownerX ?? '');
  const ownerY = parseFloat(dealer.dataset.ownerY ?? '');
  if (!Number.isFinite(ownerX) || !Number.isFinite(ownerY)) return rest;
  const centreOf = (element: Element | null | undefined) => {
    const r = element?.getBoundingClientRect();
    return r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  };
  let owner: { x: number; y: number } | null = null;
  const others: { x: number; y: number }[] = [];
  for (const wrapper of Array.from(scaler.querySelectorAll<HTMLElement>('.seat-wrapper'))) {
    const centre = centreOf(wrapper.querySelector('.seat:not(.seat--empty) .seat__avatar-img'));
    if (!centre) continue;
    const mine =
      Math.abs(parseFloat(wrapper.style.left) - ownerX) < 0.01 &&
      Math.abs(parseFloat(wrapper.style.top) - ownerY) < 0.01;
    if (mine) owner = centre;
    else others.push(centre);
  }
  if (!owner) return rest;
  const own = owner;
  const size = rest.width;
  const air = 3 * scale;
  const boxAt = (x: number, y: number): CardBox => ({
    left: x - size / 2,
    top: y - size / 2,
    width: size,
    height: size,
  });
  const clearOf = (list: ReadonlyArray<CardBox>) => (box: CardBox) =>
    !list.some(
      (o) =>
        box.left < o.left + o.width + air &&
        box.left + box.width > o.left - air &&
        box.top < o.top + o.height + air &&
        box.top + box.height > o.top - air
    );
  const owned = (x: number, y: number) => {
    const mine = Math.hypot(x - own.x, y - own.y);
    return others.every((o) => mine < Math.hypot(x - o.x, y - o.y));
  };
  const restX = rest.left + size / 2;
  const restY = rest.top + size / 2;
  let best: { x: number; y: number } | null = null;
  if (clearOf(obstacles)(rest) && owned(restX, restY)) best = { x: restX, y: restY };
  // Off the felt's printing if possible; over it only when nothing else is
  // this player's (the smallest phones).
  for (const clear of [clearOf(obstacles), clearOf(hardObstacles)]) {
    if (best) break;
    let cost = Infinity;
    for (const point of points) {
      if (point.depth < 10) continue; // off the rail band, wholly on the felt
      if (!owned(point.x, point.y) || !clear(boxAt(point.x, point.y))) continue;
      const next = Math.hypot(point.x - own.x, point.y - own.y);
      if (next < cost) {
        cost = next;
        best = { x: point.x, y: point.y };
      }
    }
  }
  if (!best) {
    // The smallest felts: still this player's button, on the spot it covers
    // least of, rather than a clear spot in front of somebody else.
    const covered = (box: CardBox) =>
      hardObstacles.reduce(
        (sum, o) =>
          sum +
          Math.max(0, Math.min(box.left + box.width, o.left + o.width) - Math.max(box.left, o.left)) *
            Math.max(0, Math.min(box.top + box.height, o.top + o.height) - Math.max(box.top, o.top)),
        0
      );
    // Never on a wager: this player's spot first, anyone's only if not.
    const offWagers = clearOf(wagers);
    for (const mine of [true, false]) {
      if (best) break;
      let cost = Infinity;
      for (const point of points) {
        if (point.depth < 10 || (mine && !owned(point.x, point.y))) continue;
        const box = boxAt(point.x, point.y);
        if (!offWagers(box)) continue;
        const next = covered(box) * 4 + Math.hypot(point.x - own.x, point.y - own.y);
        if (next < cost) {
          cost = next;
          best = { x: point.x, y: point.y };
        }
      }
    }
  }
  if (!best) return rest;
  const baseX = canvas.left + (left / 100) * canvas.width;
  const baseY = canvas.top + (top / 100) * canvas.height;
  dealer.style.translate = `${(best.x - baseX) / scale}px ${(best.y - baseY) / scale}px`;
  return boxAt(best.x, best.y);
}

/** The greedy fallback, accepted only when every wager found its own spot and
 *  no two of them touch. */
function cleanGreedyWagers(options: ReadonlyArray<ReadonlyArray<CardBox>>): CardBox[] | null {
  const result = greedyProtectedWagers(options);
  for (let i = 0; i < result.length; i++) {
    const a = result[i];
    if (!a) return null;
    for (let j = i + 1; j < result.length; j++) {
      const b = result[j];
      if (b && wagerBoxesOverlap(a, b)) return null;
    }
  }
  return result as CardBox[];
}
