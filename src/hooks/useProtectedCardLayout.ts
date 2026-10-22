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
            const shift = (chromeBottom + 4 * scale - image.top) / scale;
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
        for (const extra of [0, 8, 16, 24, 32, 40, 48, 60, 72, 84, 96]) {
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
            '.community-area, .table-brand, .pot-display, .pot-display__pile, .seat__avatar-img, .seat__info, .seat__action, .seat__bounty, .seat__position-badge, .dealer-button, .seat__cards--hero .seat__card, .bbj-widget, .bbj-mini-plate'
          )
        )
          .map(visibleBox)
          .filter((box): box is CardBox => box !== null);
        const wordmarks = Array.from(page.querySelectorAll('.table-brand'))
          .map(visibleBox)
          .filter((box): box is CardBox => box !== null)
          .map((box) => obstacles.find((o) => o.left === box.left && o.top === box.top) ?? box);
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
          // Last resort on the smallest felt: the printed wordmark is the one
          // thing a wager may rest on, never a player, the board or the pot.
          const overWordmark = placed.filter(
            (candidate) =>
              !obstacles.some(
                (obstacle) =>
                  !wordmarks.includes(obstacle) && wagerBoxesOverlap(candidate, obstacle)
              ) && wordmarks.some((mark) => wagerBoxesOverlap(candidate, mark))
          );
          // Wholly on the felt whenever the felt has room. On a small, crowded
          // phone it may not, and then a spot near the rail that clears every
          // player and every other wager beats one printed over either, so
          // those come after every on-felt spot rather than not at all.
          const byCost = (a: (typeof clearOfTable)[number], b: (typeof clearOfTable)[number]) =>
            Math.hypot(a.left + a.width / 2 - desired.x, a.top + a.height / 2 - desired.y) +
            2 * a.depth -
            (Math.hypot(b.left + b.width / 2 - desired.x, b.top + b.height / 2 - desired.y) +
              2 * b.depth);
          const candidates = [
            ...clearOfTable.filter(wagerOnFelt).sort(byCost),
            ...clearOfTable.filter((candidate) => !wagerOnFelt(candidate)).sort(byCost),
            ...overWordmark.filter(wagerOnFelt).sort(byCost),
          ];
          const distinct: CardBox[] = [];
          for (const candidate of candidates) {
            if (
              distinct.every(
                (other) => Math.hypot(candidate.left - other.left, candidate.top - other.top) >= 4
              )
            )
              distinct.push(candidate);
            if (distinct.length >= 800) break;
          }
          return [{ bet, box, candidates: distinct }];
        });
        // Every wager on the felt at once when the table allows it. A crowded
        // short phone (three players all in on one side) can leave no joint
        // solution; then each wager still takes its own best clear spot in
        // turn, instead of every wager staying wherever it first landed.
        const placements =
          assignProtectedWagers(entries.map((entry) => entry.candidates)) ??
          greedyProtectedWagers(entries.map((entry) => entry.candidates));
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
        }
      }
      const protectedBoxes = Array.from(
        page.querySelectorAll(
          '.community-area, .table-brand, .seat__avatar-img, .dealer-button, .pot-area, .pot-display, .seat__info, .seat__bet-chips, .seat__strength, .seat__action, .seat__bounty, .seat__position-badge, .pot-display__pile, .action-panel, .bbj-mini-plate, .cch-column, .chat-collapsed'
        )
      )
        .map(visibleBox)
        .filter((box): box is CardBox => box !== null);
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
    scaler.addEventListener('load', schedule, true);
    return () => {
      document.fonts?.removeEventListener('loadingdone', schedule);
      resetWagers();
      observer.disconnect();
      mutations.disconnect();
      scaler.removeEventListener('animationend', schedule);
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
