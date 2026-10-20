import { useLayoutEffect, type RefObject } from 'react';
import { placeProtectedCardRow, type CardBox } from '../lib/protectedCardPlacement';

/** Layout belongs to the table that paints it; no global selectors or game-state writes. */
export function useProtectedCardLayout(root: RefObject<HTMLDivElement | null>, revision: string) {
  useLayoutEffect(() => {
    const scaler = root.current;
    const page = scaler?.closest('.table-page');
    if (!scaler || !page) return;
    const topPods = () => Array.from(scaler.querySelectorAll<HTMLElement>('.seat-wrapper--top'));
    const place = () => {
      const rows = Array.from(scaler.querySelectorAll<HTMLElement>('.seat__cards--revealed'));
      rows.forEach((row) => row.style.removeProperty('translate'));
      const scale = scaler.getBoundingClientRect().width / scaler.offsetWidth || 1;
      topPods().forEach((pod) => {
        pod.style.removeProperty('translate');
        pod.style.removeProperty('--sp-top-seat-shift');
      });
      const mini = page.querySelector('.bbj-mini-plate')?.getBoundingClientRect();
      // On phones the top player's head sits immediately below the actual
      // Mini BBJ frame, rather than below a guessed viewport-sized gap.
      if (page.getBoundingClientRect().width <= 768 && mini && mini.height > 0) {
        for (const pod of topPods()) {
          const image = pod.querySelector('.seat__avatar-img')?.getBoundingClientRect();
          if (image && image.height > 0) {
            const shift = (mini.bottom + 4 * scale - image.top) / scale;
            pod.style.translate = `0px ${shift}px`;
            // Bets use the scaler's rail coordinates. Moving the top avatar
            // below the jackpot must not carry its bet onto the player plate.
            pod.style.setProperty('--sp-top-seat-shift', `${shift}px`);
          }
        }
      }
      const visibleBox = (element: Element): CardBox | null => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 ? box : null;
      };
      const protectedBoxes = Array.from(
        page.querySelectorAll(
          '.community-area, .pot-area, .pot-display, .seat__info, .seat__bet-chips, .seat__strength, .seat__action, .seat__position-badge, .pot-display__pile, .action-panel, .bbj-mini-plate, .cch-column, .chat-collapsed'
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
    scaler.addEventListener('animationend', schedule);
    scaler.addEventListener('load', schedule, true);
    return () => {
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
