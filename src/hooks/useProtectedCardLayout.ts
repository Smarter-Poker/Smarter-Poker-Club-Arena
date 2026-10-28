import { useLayoutEffect, useRef, type RefObject } from 'react';
import { avatarRestPose, restingAvatarTop } from '../components/table/avatarCrownBounds';
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
  PORTRAIT_CARD_LANE_MAX_VIEWPORT_PX,
} from '../components/table/tableGeometry';

/** Layout belongs to the table that paints it; no global selectors or game-state writes. */
export function useProtectedCardLayout(
  root: RefObject<HTMLDivElement | null>,
  revision: string,
  handKey = 'current'
) {
  // A runout changes the board, pot and highlights, never the hand's slot.
  // Retain placements across effect revisions; only a new hand or viewport
  // geometry may allocate a new slot. Removed DOM rows expire naturally.
  const settled = useRef({
    key: '',
    rows: new WeakMap<HTMLElement, string>(),
    pods: new WeakMap<HTMLElement, string>(),
    podPoses: new WeakMap<HTMLElement, string>(),
  });
  useLayoutEffect(() => {
    const scaler = root.current;
    const page = scaler?.closest('.table-page');
    if (!scaler || !page) return;
    const refreshGeometry = () => {
      const box = scaler.getBoundingClientRect();
      const key = [
        handKey,
        Math.round(box.width),
        Math.round(box.height),
        Math.round(page.getBoundingClientRect().width),
        // Orientation, not the raw viewport height: a phone browser's toolbar
        // showing or hiding changes innerHeight without moving the felt. When
        // it does resize the table, the scaler box above changes and resets.
        window.innerHeight > window.innerWidth ? 'portrait' : 'landscape',
        scaler.style.getPropertyValue('--table-w'),
        scaler.style.getPropertyValue('--table-h'),
        scaler.style.getPropertyValue('--sp-board-card-w'),
        scaler.style.getPropertyValue('--sp-tabled-card-w'),
      ].join(':');
      if (settled.current.key !== key) {
        settled.current = {
          key,
          rows: new WeakMap(),
          pods: new WeakMap(),
          podPoses: new WeakMap(),
        };
      }
    };
    refreshGeometry();
    const topPods = () =>
      Array.from(
        scaler.querySelectorAll<HTMLElement>(
          page.getAttribute('data-seats') === '6' && page.getBoundingClientRect().width > 480
            ? '.seat-wrapper--cap, .seat-wrapper--top'
            : '.seat-wrapper--top'
        )
      );
    const wagers = () => Array.from(scaler.querySelectorAll<HTMLElement>('.seat__bet-chips'));
    const resetWagers = () =>
      wagers().forEach((bet) => {
        for (const name of ['--bet-offset-x', '--bet-offset-y', '--collect-dx', '--collect-dy'])
          bet.style.removeProperty(name);
      });
    /* The tabled hands. On a phone they are placed BEFORE the wagers and the
       dealer button (Dan 2026-10-22: a shown hand must be clearly displayed at
       its own player), which are then placed round them; elsewhere, after. */
    const placeRows = (withMarkers: boolean) => {
      const rows = Array.from(scaler.querySelectorAll<HTMLElement>('.seat__cards--revealed')).sort(
        (a, b) =>
          Number(Boolean(b.closest('.seat-wrapper--top'))) -
          Number(Boolean(a.closest('.seat-wrapper--top')))
      );
      const scale = scaler.getBoundingClientRect().width / scaler.offsetWidth || 1;
      const visibleBox = (element: Element): CardBox | null => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 ? box : null;
      };
      const protectedEntries = Array.from(
        page.querySelectorAll(
          (withMarkers ? '.seat__bet-chips, ' : '') +
            '.community-area, .seat__avatar-img, .pot-area, .pot-display, .seat__info, .seat__strength, .seat__action, .seat__bounty, .seat__position-badge, .pot-display__pile, .action-panel, .bbj-widget, .bbj-mini-plate, .cch-column, .chat-collapsed'
        )
      ).flatMap((element) => {
        const box = visibleBox(element);
        return box ? [{ element, box }] : [];
      });
      const protectedBoxes = protectedEntries.map(({ box }) => box);
      // A later seat can reveal before an earlier DOM sibling. Reserve every
      // already-settled hand before allocating any new one, regardless of order.
      for (const fixedRow of rows) {
        if (!settled.current.rows.has(fixedRow)) continue;
        const boxes = Array.from(fixedRow.querySelectorAll('.seat__card'))
          .map(visibleBox)
          .filter((box): box is CardBox => box !== null);
        if (!boxes.length) continue;
        const left = Math.min(...boxes.map((box) => box.left));
        const top = Math.min(...boxes.map((box) => box.top));
        protectedBoxes.push({
          left,
          top,
          width: Math.max(...boxes.map((box) => box.left + box.width)) - left,
          height: Math.max(...boxes.map((box) => box.top + box.height)) - top,
        });
      }
      const dealer = withMarkers ? scaler.querySelector<HTMLElement>('.dealer-button') : null;
      if (dealer) {
        const settled = dealerSettledBox(scaler, dealer);
        if (settled) protectedBoxes.push(settled);
      }
      const pageBounds = page.getBoundingClientRect();
      for (const row of rows) {
        // Top-cap reveals need daylight below the mobile page's clipping
        // edge. Jackpot rectangles remain individual keep-outs: reserving
        // their entire horizontal band would push a centred hand to a neighbour.
        const mobileTop =
          pageBounds.top +
          (row.closest('.seat-wrapper--cap') && window.innerWidth <= 768 ? 8 * scale : 0);
        const bounds = {
          left: pageBounds.left,
          top: mobileTop,
          width: pageBounds.width,
          height: Math.max(0, pageBounds.bottom - mobileTop),
        };

        const fixed = settled.current.rows.get(row);
        if (fixed !== undefined) {
          row.style.translate = fixed;
          const cards = Array.from(row.querySelectorAll('.seat__card'))
            .map(visibleBox)
            .filter((box): box is CardBox => box !== null);
          if (cards.length) {
            const left = Math.min(...cards.map((card) => card.left));
            const top = Math.min(...cards.map((card) => card.top));
            protectedBoxes.push({
              left,
              top,
              width: Math.max(...cards.map((card) => card.left + card.width)) - left,
              height: Math.max(...cards.map((card) => card.top + card.height)) - top,
            });
          }
          continue;
        }
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
        // Dan 2026-10-22: a tabled hand must be clearly shown, and shown at
        // its own player. A villain's tabled row is drawn over that player's
        // own art (the bust, the action tag, the bounty and position chips),
        // never its plate, so a full-size PLO5 or PLO6 row stays beside its
        // owner instead of being pushed across the table to the first empty
        // patch of felt.
        const seat = row.classList.contains('seat__cards--opponent') ? row.closest('.seat') : null;
        // Keep DOM ownership, not a second animated rectangle measurement:
        // equal boxes are not identity, and one avatar/action can change its
        // painted box between layout reads without becoming another player.
        const ownBoxes = new Set(
          protectedEntries
            .filter(
              ({ element }) =>
                seat?.contains(element) &&
                element.matches(
                  '.seat__avatar-img, .seat__action, .seat__bounty, .seat__position-badge'
                )
            )
            .map(({ box }) => box)
        );
        const others = protectedBoxes.filter((other) => !ownBoxes.has(other));
        // The hand stands nearer its own player than any other (avatar
        // centres), whenever any such spot exists.
        const mineAt = seat?.querySelector('.seat__avatar-img')?.getBoundingClientRect();
        const centres = Array.from(
          scaler.querySelectorAll('.seat:not(.seat--empty) .seat__avatar-img')
        )
          .map((img) => img.getBoundingClientRect())
          .filter((r) => r.width > 0 && r !== mineAt)
          .map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }));
        const ownsIt = (candidate: CardBox) => {
          if (!mineAt || !mineAt.width) return true;
          const x = candidate.left + candidate.width / 2;
          const y = candidate.top + candidate.height / 2;
          const own = Math.hypot(
            x - (mineAt.left + mineAt.width / 2),
            y - (mineAt.top + mineAt.height / 2)
          );
          return centres.every(
            (c) =>
              Math.hypot(
                c.x - (mineAt.left + mineAt.width / 2),
                c.y - (mineAt.top + mineAt.height / 2)
              ) < 1 || own + 4 < Math.hypot(x - c.x, y - c.y)
          );
        };
        // Prefer the owner's lane with zero extra padding before moving a
        // shown hand beside another chair. Rectangles still cannot overlap.
        const place = (candidate: CardBox) =>
          placeProtectedCardRow(candidate, others, bounds, cards.length >= 5 ? 3 : 4, ownsIt) ??
          placeProtectedCardRow(candidate, others, bounds, 0, ownsIt) ??
          placeProtectedCardRow(candidate, others, bounds);
        let natural = box;
        let next = place(box);
        // Shorter tabled rows that cannot stay at their own player
        // at full spacing closes up, a step at a time, before it is allowed to
        // leave: every card keeps the board's size and its rank and suit
        // corner, the row just overlaps more. Only when no spacing is this
        // player's does it drop to 85 percent of the board's size. Widths are
        // computed rather than measured, because cards glide over 0.2s.
        const count = cards.length;
        if (seat && count >= 2 && count < 5) {
          // The spacing and card size this hand was drawn at, and the ones the
          // stylesheet gives it, so a closed-up hand can be judged at full size.
          const inlineStep = parseFloat(row.style.getPropertyValue('--vh-step-f'));
          const inlineWidth = row.style.getPropertyValue('--vh-card-w');
          const drawnW = Math.max(...cards.map((card) => card.width));
          if (!Number.isFinite(inlineStep)) {
            row.dataset.baseStep = getComputedStyle(row).getPropertyValue('--vh-step-f').trim();
          }
          if (!inlineWidth) row.dataset.baseCardW = String(drawnW / scale);
          const base = parseFloat(row.dataset.baseStep ?? '') || 0.5;
          const fullW = (parseFloat(row.dataset.baseCardW ?? '') || drawnW / scale) * scale;
          const anchor = row.closest('.seat-wrapper--top')
            ? 'centre'
            : seat.classList.contains('seat--cards-right')
              ? 'right'
              : 'left';
          // The row's own anchors: its bottom edge, and its outboard edge (or
          // its centre on a top-cap chair).
          const anchorX =
            anchor === 'left'
              ? box.left
              : anchor === 'right'
                ? box.left + box.width
                : box.left + box.width / 2;
          const bottom = box.top + box.height;
          const heightPerW = box.height / drawnW;
          const at = (step: number, size: number): CardBox => {
            const cardW = fullW * size;
            const width = cardW * (1 + (count - 1) * step);
            const height = cardW * heightPerW;
            const left =
              anchor === 'left'
                ? anchorX
                : anchor === 'right'
                  ? anchorX - width
                  : anchorX - width / 2;
            return { left, top: bottom - height, width, height };
          };
          const shifted = (from: CardBox, to: CardBox) =>
            Math.hypot(to.left - from.left, to.top - from.top);
          // Board size first, at its own spacing, then closing up, then (only
          // when nothing else is this player's) 85 percent of the board's size.
          const tries: Array<[number, number]> = [];
          for (const size of [1, 0.85])
            for (const step of [base, 0.6, 0.5, 0.4, 0.32, 0.27])
              if (step <= base && !tries.some(([a, b]) => a === step && b === size))
                tries.push([step, size]);
          let pick: { step: number; size: number; from: CardBox; to: CardBox } | null = null;
          for (const [step, size] of tries) {
            const from = at(step, size);
            const to =
              placeProtectedCardRow(from, others, bounds, 4, ownsIt) ??
              placeProtectedCardRow(from, others, bounds, 0, ownsIt);
            if (!to) continue;
            if (!pick || shifted(from, to) < shifted(pick.from, pick.to))
              pick = { step, size, from, to };
            if (shifted(from, to) <= fullW * size * 1.5) break;
          }
          if (!pick) {
            const from = at(base, 1);
            const to = placeProtectedCardRow(from, others, bounds);
            if (to) pick = { step: base, size: 1, from, to };
          }
          if (pick) {
            if (pick.step === base) row.style.removeProperty('--vh-step-f');
            else row.style.setProperty('--vh-step-f', String(pick.step));
            if (pick.size === 1) row.style.removeProperty('--vh-card-w');
            else row.style.setProperty('--vh-card-w', `${(fullW * pick.size) / scale}px`);
            natural = pick.from;
            next = pick.to;
          }
        }
        if (next) {
          // translate is independent of the deal/flip transform and preserves animations.
          row.style.translate = `${(next.left - natural.left) / scale}px ${(next.top - natural.top) / scale}px`;
          protectedBoxes.push(next);
        } else {
          // No clearer spot on this felt: the hand stays where it is drawn.
          row.style.removeProperty('translate');
          protectedBoxes.push(natural);
        }
        // Dan 2026-10-23: shown cards never move once they are on the table.
        // Every tabled hand (Hold'em through PLO6) keeps this slot, spacing and
        // size for the rest of the hand; only a new hand or a real change in
        // the table's own geometry may place it again.
        settled.current.rows.set(row, row.style.translate || '');
      }
    };
    const place = () => {
      refreshGeometry();
      resetWagers();
      scaler.querySelector<HTMLElement>('.dealer-button')?.style.removeProperty('translate');
      const rows = Array.from(scaler.querySelectorAll<HTMLElement>('.seat__cards--revealed'));
      rows.forEach((row) => {
        const fixed = settled.current.rows.get(row);
        if (fixed === undefined) row.style.removeProperty('translate');
        else row.style.translate = fixed;
      });
      // A closed-up spacing belongs to one tabled hand; the same element holds
      // the next hand face down.
      scaler
        .querySelectorAll<HTMLElement>('.seat__cards:not(.seat__cards--revealed)')
        .forEach((cluster) => {
          settled.current.rows.delete(cluster);
          cluster.style.removeProperty('--vh-step-f');
          cluster.style.removeProperty('--vh-card-w');
          delete cluster.dataset.baseStep;
          delete cluster.dataset.baseCardW;
        });
      const scale = scaler.getBoundingClientRect().width / scaler.offsetWidth || 1;
      const pageBox = page.getBoundingClientRect();
      // Production uses the desktop-width viewport on phones. Preserve the
      // legacy <=480px fallback for browsers that ignore that viewport.
      const sixMax = page.getAttribute('data-seats') === '6' && pageBox.width > 480;
      for (const pod of scaler.querySelectorAll('.seat-wrapper--cap, .seat-wrapper--top')) {
        const seat = pod.querySelector<HTMLElement>('.seat');
        // Keep the character connected to its plate with the existing 3px
        // minimum overlap. Reclaim only the extra overlap for the full PLO
        // row, whose bottom reads this same shared token.
        if (sixMax) seat?.style.setProperty('--sp-wrap-overlap', '3px');
        else seat?.style.removeProperty('--sp-wrap-overlap');
      }
      topPods().forEach((pod) => {
        if (sixMax) {
          const avatar = pod.querySelector<HTMLImageElement>('.seat__avatar-img');
          const pose = `${avatar ? avatarRestPose(avatar) : ''}:${window.innerWidth <= 768 && Boolean(pod.querySelector('.seat__cards--revealed'))}`;
          // Folded/resting posture is a layout input. Gesture frames are not.
          if (settled.current.podPoses.get(pod) !== pose) settled.current.pods.delete(pod);
          settled.current.podPoses.set(pod, pose);
        }
        const shift = settled.current.pods.get(pod);
        if (shift === undefined) {
          pod.style.removeProperty('translate');
          pod.style.removeProperty('--sp-top-seat-shift');
        } else {
          pod.style.translate = `0px ${shift}px`;
          pod.style.setProperty('--sp-top-seat-shift', `${shift}px`);
        }
      });
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
      if (sixMax || pageBox.width <= 768) {
        for (const pod of topPods()) {
          if (settled.current.pods.has(pod)) continue;
          const avatar = pod.querySelector<HTMLImageElement>('.seat__avatar-img');
          const image = avatar?.getBoundingClientRect();
          if (image && image.height > 0) {
            // Dan 2026-10-22: "pull the table down so the top player isn't
            // scrunched up." The pod's highest painted part (the art, or the
            // position chip on its corner) keeps 8px of air below the jackpot
            // plate rather than 4px against it.
            const badge = pod.querySelector('.seat__position-badge')?.getBoundingClientRect();
            const highest = Math.min(image.top, badge && badge.height > 0 ? badge.top : Infinity);
            // On the shortest nine-seat phones a board-sized PLO hand needs
            // a full card-height lane between the jackpot and its own plate.
            const largeHand = scaler.querySelector(
              ".seat__cards:is([data-card-count='5'], [data-card-count='6'])"
            );
            const cardHeight =
              ((parseFloat(
                scaler.style.getPropertyValue('--sp-tabled-card-w') ||
                  scaler.style.getPropertyValue('--sp-board-card-w')
              ) || 0) *
                92) /
              64;
            const plateTop =
              pod.querySelector('.seat__info')?.getBoundingClientRect().top ?? highest;
            const clearance =
              largeHand && window.innerHeight > window.innerWidth
                ? Math.max(8, cardHeight + 9 - (plateTop - highest))
                : 8;
            // Dan 2026-10-26: the six-max top-centre villain rises to the
            // tab/action bar, with only the crown clipped. Corner jackpot
            // plates do not reserve a band across this centred seat. Anchor
            // the actual art, not its transparent slot or position badge.
            const anchorTop = sixMax && avatar ? restingAvatarTop(avatar, scale) : highest;
            const naturalTarget = sixMax
              ? pageBox.top - 2 * scale
              : chromeBottom + clearance * scale;
            // A revealed top hand needs its full height above its own plate.
            // Lower the pod as one unit instead of forcing the cards sideways
            // into a neighbour when the compact crown anchor clips that lane.
            const target =
              window.innerWidth <= 768 && pod.querySelector('.seat__cards--revealed')
                ? Math.max(
                    naturalTarget,
                    Math.max(pageBox.top, chromeBottom) +
                      (cardHeight + 9) * scale -
                      (plateTop - anchorTop)
                  )
                : naturalTarget;
            const shift = (target - anchorTop) / scale;
            pod.style.translate = `0px ${shift}px`;
            // Bets use the scaler's rail coordinates. Moving the top avatar
            // within its lane must not carry its bet onto the player plate.
            pod.style.setProperty('--sp-top-seat-shift', `${shift}px`);
            settled.current.pods.set(pod, String(shift));
          }
        }
      }
      const visibleBox = (element: Element): CardBox | null => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 ? box : null;
      };
      // 2026-10-24: every portrait viewport up to 768px, not only phones up to
      // 480. Above 480 the desktop order placed the shown hands AFTER the
      // wagers and the button, and a board-sized PLO5/PLO6 row that could not
      // stand at its owner fell through to the unowned fallback: parked under
      // the hero or in front of another player. Here the hands are placed
      // first, at their own players, and the markers are placed round them.
      const phoneMarkers =
        window.innerWidth <= PORTRAIT_CARD_LANE_MAX_VIEWPORT_PX &&
        window.innerHeight > window.innerWidth;
      if (phoneMarkers) {
        // Dan 2026-10-22: a tabled hand is the SAME SIZE AS THE BOARD's cards,
        // overlapped but never covered. The board is drawn through the felt's
        // perspective. TablePage publishes the settled board width from table geometry.
        // Measuring an animated board card here fed its transient scale back
        // into every shown hand's dimensions during the runout.
        placeRows(false);
        const canvas = scaler.getBoundingClientRect();
        // The painted chassis is tapered on a portrait phone only (TablePage.css,
        // 480px); a wider portrait felt is drawn flat, and the marker grid must
        // follow the felt actually painted.
        const portraitTaper =
          page.getAttribute('data-hero') === 'false' || window.innerWidth > 480 ? 0 : undefined;
        const size = { w: canvas.width, h: canvas.height, portraitTaper };
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
          const projected = projectPortraitTable(
            {
              x: (x / canvas.width) * 100,
              y: (y / canvas.height) * 100,
            },
            portraitTaper
          );
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
        const wagerOnFeltWithMargin = (box: CardBox, margin: number): boolean =>
          [
            [box.left, box.top],
            [box.left + box.width, box.top],
            [box.left, box.top + box.height],
            [box.left + box.width, box.top + box.height],
          ].every(([x, y]) => {
            const flat = unprojectPortraitTable(
              {
                x: ((x - canvas.left) / canvas.width) * 100,
                y: ((y - canvas.top) / canvas.height) * 100,
              },
              portraitTaper
            );
            const px = (flat.x * canvas.width) / 100;
            const py = (flat.y * canvas.height) / 100;
            const spineY = Math.min(Math.max(py, upper), lower);
            return Math.hypot(px - cx, py - spineY) <= radius + inset - margin;
          });
        const wagerOnFelt = (box: CardBox) => wagerOnFeltWithMargin(box, feltMarginPx);
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
            '.community-area, .table-brand, .pot-display, .pot-display__pile, .seat__avatar-img, .seat__info, .seat__action, .seat__bounty, .seat__position-badge, .seat__cards--hero .seat__card, .seat__cards--revealed .seat__card, .bbj-widget, .bbj-mini-plate'
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
        /* Dan 2026-10-25, with two phone screenshots: "CHIPS ARE STILL
           DISPLAYING IN THE WRONG LOCATIONS INSTEAD OF ALWAYS 100% OF THE TIME
           BEING IN FRONT OF THE USER WHO BET THE CHIPS ... MAKE THE MOBILE
           LAYOUT AND CHIP POSITIONS THE SAME AS DESKTOP AND IPAD." Three
           things let a wager leave its owner here, all closed:
             1. an EMPTY chair counted as nobody, so a raise could settle in an
                empty chair's lane (his screenshot: CactusDenim's raise beside
                the empty seat on the far rail). Every chair counts now;
             2. the search was centred on the owner's AVATAR, so the best spot
                could be anywhere around the player, behind or beside them. It
                is centred on the wager's own rest point now: the desktop's
                spot in front of the player, moved only as far as it must;
             3. the last fallback tiers dropped the ownership rule. Every tier
                keeps it, and a wager with no clear spot of its own stays at
                its rest point in front of its player.
           Pinned by tests/a-bet-sits-in-front-of-its-own-player.law.test.ts. */
        const playerCentres = Array.from(page.querySelectorAll('.seat-wrapper'))
          .map(
            (wrapper) =>
              wrapper.querySelector('.seat:not(.seat--empty) .seat__avatar-img') ??
              wrapper.querySelector('.seat') ??
              wrapper
          )
          .map((element) => {
            const r = element.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
          })
          .filter((c) => c.w > 0 && Number.isFinite(c.x) && Number.isFinite(c.y));
        const entries = wagers()
          .flatMap((bet) => {
            const box = visibleBox(bet);
            const owner = bet
              .closest('.seat-wrapper')
              ?.querySelector('.seat__avatar-img')
              ?.getBoundingClientRect();
            if (!box || !owner) return [];
            const desired = { x: owner.left + owner.width / 2, y: owner.top + owner.height / 2 };
            // The wager's own rest point, where the seat geometry puts it in
            // front of its player (desktop's spot): the live box less any
            // nudge an earlier pass wrote on the element itself.
            const own = getComputedStyle(bet);
            const inherited = getComputedStyle(bet.parentElement ?? bet);
            const nudge = (axis: 'x' | 'y') =>
              ((parseFloat(own.getPropertyValue(`--bet-offset-${axis}`)) || 0) -
                (parseFloat(inherited.getPropertyValue(`--bet-offset-${axis}`)) || 0)) *
              scale;
            const anchor = {
              x: box.left + box.width / 2 - nudge('x'),
              y: box.top + box.height / 2 - nudge('y'),
            };
            const hasAllInMarker = Boolean(bet.querySelector('.seat__allin-puck'));
            const placed = [
              {
                left: anchor.x - box.width / 2,
                top: anchor.y - box.height / 2,
                width: box.width,
                height: box.height,
                depth: 0,
              },
              ...points.map((point) => ({
                left: point.x - box.width / 2,
                top: point.y - box.height / 2,
                width: box.width,
                height: box.height,
                depth: point.depth,
              })),
            ];
            // Full captions can narrow any short-phone lane, including Holdem.
            // Sample exact obstacle edges as well as the oval, so a clear slot
            // beside a label is found before the overlapping last-resort tier.
            // Wider portrait side pods need the same exact slots.
            if (sixMax || window.innerWidth > 480 || window.innerWidth <= 375) {
              const xs = new Set([anchor.x - box.width / 2]);
              const ys = new Set([anchor.y - box.height / 2]);
              for (const obstacle of hardObstacles) {
                for (const air of sixMax ? [3, 1] : [3]) {
                  xs.add(obstacle.left - box.width - air);
                  xs.add(obstacle.left + obstacle.width + air);
                  ys.add(obstacle.top - box.height - air);
                  ys.add(obstacle.top + obstacle.height + air);
                }
              }
              // A wider portrait page has bare screen beyond the table; a wager
              // stays on the table's own canvas there, never out in the margin.
              const minLeft = window.innerWidth > 480 ? canvas.left : pageBox.left;
              const maxRight = window.innerWidth > 480 ? canvas.right : pageBox.right;
              for (const left of xs)
                for (const top of ys) {
                  const candidate = { left, top, width: box.width, height: box.height, depth: 20 };
                  if (
                    left >= minLeft &&
                    top >= chromeBottom &&
                    left + box.width <= maxRight &&
                    top + box.height <= canvas.bottom
                  )
                    placed.push(candidate);
                }
            }
            // ALL IN is a felt marker, never a label in the avatar lane. Even
            // crowded-table fallbacks must keep its entire wager slot on felt.
            // A marker's entire disc stays on felt. On a crowded cap lane,
            // one pixel of edge clearance fits where the chips' eight-pixel
            // decoration margin does not; never fall back off felt or to a neighbour.
            const eligible = hasAllInMarker
              ? placed.filter((candidate) => wagerOnFeltWithMargin(candidate, 1))
              : placed;
            const clearOfTable = eligible.filter(
              (candidate) => !obstacles.some((obstacle) => wagerBoxesOverlap(candidate, obstacle))
            );
            // Wholly on the felt whenever every wager fits there together. On a
            // small, crowded phone they may not, and then the nearest spots that
            // still clear every player, the board, the pot and each other are
            // used, rail band included, rather than leaving a wager on a player.
            // Nearest the wager's own rest point: it moves as little as it can.
            const byCost = (a: (typeof clearOfTable)[number], b: (typeof clearOfTable)[number]) =>
              Math.hypot(a.left + a.width / 2 - anchor.x, a.top + a.height / 2 - anchor.y) -
              Math.hypot(b.left + b.width / 2 - anchor.x, b.top + b.height / 2 - anchor.y);
            const distinct = (list: typeof clearOfTable, cap: number): CardBox[] => {
              const kept: CardBox[] = [];
              for (const candidate of list) {
                if (
                  kept.every(
                    (other) =>
                      Math.hypot(candidate.left - other.left, candidate.top - other.top) >= 4
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
                  own + 1.5 < Math.hypot(cx0 - other.x, cy0 - other.y)
              );
            };
            const nearest = [...clearOfTable].sort(byCost);
            const owned = nearest.filter(ownedBy);
            const overPrinting = eligible
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
                hasAllInMarker,
                felt: distinct(owned.filter(wagerOnFelt), 96),
                // Exactly the rail-band slots this placer has always offered.
                candidates: distinct(
                  owned.filter((candidate) => candidate.depth <= 20),
                  96
                ),
                wide: distinct(owned, 160),
                any: distinct(nearest.filter(ownedBy), 160),
                printing: distinct(overPrinting, 160),
                // Last resort on the smallest felts: this player's own spots, the
                // least covered first, so two players' wagers never share one.
                least: distinct(
                  eligible
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
                    .sort((a, b) => a.covered - b.covered || byCost(a.candidate, b.candidate))
                    .map((entry) => entry.candidate),
                  160
                ),
              },
            ];
          })
          .sort((a, b) => Number(b.hasAllInMarker) - Number(a.hasAllInMarker));
        // Every wager on the felt at once when the table allows it. A crowded
        // short phone (three players all in on one side) can leave no joint
        // solution; then each wager still takes its own best clear spot in
        // turn, instead of every wager staying wherever it first landed.
        const compactNine =
          page.getAttribute('data-seats') === '9' &&
          window.innerWidth <= 340 &&
          Boolean(
            page.querySelector('.seat__cards--opponent.seat__cards--revealed > :nth-child(5)')
          );
        const placements =
          assignProtectedWagers(entries.map((entry) => entry.felt)) ??
          assignProtectedWagers(entries.map((entry) => entry.candidates)) ??
          assignProtectedWagers(entries.map((entry) => entry.wide)) ??
          // The exact search has a fixed budget; a crowded ring can exhaust it
          // while each player's own spots still fit side by side greedily.
          cleanGreedyWagers(entries.map((entry) => entry.wide)) ??
          assignProtectedWagers(
            entries.map((entry) => (compactNine ? entry.printing : entry.any))
          ) ??
          // The smallest felts: over the felt's own lettering before two
          // players' wagers are stacked in one spot.
          assignProtectedWagers(entries.map((entry) => entry.printing)) ??
          greedyProtectedWagers(
            entries.map((entry) => [
              ...entry.wide,
              ...(compactNine ? entry.printing : entry.any),
              ...entry.least,
            ])
          );
        const placedWagers: CardBox[] = [];
        for (let i = 0; i < entries.length; i++) {
          const { bet, box } = entries[i];
          const next = placements?.[i];
          if (!next) {
            // No clear spot of its own: it stays at its rest point in front of
            // its player, never in front of somebody else.
            for (const name of ['--bet-offset-x', '--bet-offset-y', '--collect-dx', '--collect-dy'])
              bet.style.removeProperty(name);
            continue;
          }
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
      if (!phoneMarkers) placeRows(true);
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
      scaler
        .querySelectorAll<HTMLElement>('.seat-wrapper--cap .seat, .seat-wrapper--top .seat')
        .forEach((seat) => seat.style.removeProperty('--sp-wrap-overlap'));
      topPods().forEach((pod) => {
        pod.style.removeProperty('translate');
        pod.style.removeProperty('--sp-top-seat-shift');
      });
      scaler
        .querySelectorAll<HTMLElement>('.seat__cards--revealed')
        .forEach((row) => row.style.removeProperty('translate'));
    };
  }, [root, revision, handKey]);
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
      if (point.depth < 0) continue; // include the clear rail band before covering protected content
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
          Math.max(
            0,
            Math.min(box.left + box.width, o.left + o.width) - Math.max(box.left, o.left)
          ) *
            Math.max(
              0,
              Math.min(box.top + box.height, o.top + o.height) - Math.max(box.top, o.top)
            ),
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
