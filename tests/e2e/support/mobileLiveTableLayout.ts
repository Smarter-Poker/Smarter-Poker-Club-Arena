import { AVATAR_CROWN_TOP } from '../../../src/components/table/avatarCrownBounds';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** JSON reporter bodies are embedded, so retain files for the release artifact too. */
async function attachMobileProof(
  testInfo: TestInfo,
  name: string,
  body: Buffer,
  contentType: string
) {
  const path = testInfo.outputPath(`${name}.${contentType === 'image/png' ? 'png' : 'json'}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  await testInfo.attach(name, { path, contentType });
}

/** Read the deployed table through the isolated spectator's real mobile UI. */
export async function certifyMobileLiveTableLayout(
  page: Page,
  testInfo: TestInfo,
  options: { widths?: number[]; seatChangeToggle?: boolean } = {}
) {
  const capacity = await page.locator('.table-page:visible').first().getAttribute('data-seats');
  const proofTag = `mobile-live-table-${capacity || 'unknown'}max`;
  const originalViewport = page.viewportSize();
  try {
    for (const width of options.widths || [320, 375, 393, 430]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 852 });
      // Commit the resize and its observer-driven layout before measuring.
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))
          )
      );
      await expect(page.locator('.table-art-cover:visible')).toHaveCount(0);
      await page.locator('.table-page:visible .seat__avatar-img').evaluateAll(async (images) => {
        await Promise.all(
          images.map(async (image) => {
            if (!(image instanceof HTMLImageElement) || !image.getBoundingClientRect().width)
              return;
            image.loading = 'eager';
            await image.decode();
            if (!image.naturalWidth) throw new Error('Avatar did not decode before geometry proof');
          })
        );
      });
      const read = () => page.evaluate(readMobileTableLayout, AVATAR_CROWN_TOP);
      await expect
        .poll(async () => (await read()).violations, {
          timeout: 10_000,
          message: `${width}px live mobile table containment`,
        })
        .toEqual([]);
      const measured = await read();
      expect(
        measured.occupied,
        'Mobile proof requires actual occupied seats'
      ).toBeGreaterThanOrEqual(2);
      console.log(`MOBILE_LIVE_TABLE_LAYOUT ${JSON.stringify(measured)}`);
      await attachMobileProof(
        testInfo,
        `${proofTag}-${width}`,
        await page.screenshot(),
        'image/png'
      );
      await attachMobileProof(
        testInfo,
        `${proofTag}-${width}-measurements`,
        Buffer.from(JSON.stringify(measured)),
        'application/json'
      );
    }
    if (options.seatChangeToggle === false) return;
    const menu = page.getByRole('button', { name: 'Table Menu', exact: true });
    await menu.click();
    const toggle = page.getByRole('menuitemcheckbox', { name: /Seat Change/ });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(page.locator('.cch-seat-change-control:visible')).toHaveCount(0);
    await menu.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await menu.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await attachMobileProof(
      testInfo,
      `${proofTag}-seat-change-toggle`,
      await page.screenshot(),
      'image/png'
    );
    await page.keyboard.press('Escape');
  } finally {
    if (originalViewport) await page.setViewportSize(originalViewport);
  }
}

/** Observe real payouts during the existing hand/reconnect case; never inject a hand. */
export async function installMobileAwardJournal(page: Page) {
  await page.evaluate(() => {
    const evidence = {
      landings: [] as Array<{
        distance: number;
        recipient: string;
        targetProvenance?: 'live-recipient' | 'departed-recipient';
      }>,
      violations: [] as string[],
      multiBoardSamples: 0,
    };
    const seen = new Set<string>();
    const active = new Map<
      string,
      { chip: HTMLElement; recipient: string; distance: number | null }
    >();
    const targets = new Map<
      string,
      {
        node: HTMLElement;
        recipient: string;
        table: Element | null;
        hand: string | null;
        rect: DOMRect;
      }
    >();
    let frame = 0;
    let stopped = false;
    const inspect = () => {
      for (const chip of document.querySelectorAll<HTMLElement>('[data-chip-recipient]')) {
        const id = chip.dataset.chipFlight ?? '';
        if (!id) continue;
        const recipient = chip.dataset.chipRecipient ?? '';
        const flight = active.get(id) ?? { chip, recipient, distance: null };
        active.set(id, flight);
        const table = chip.closest('.table-page');
        const hand = table?.querySelector('.table-brand__hand')?.textContent ?? null;
        const seat = Array.from(
          (table ?? document).querySelectorAll<HTMLElement>('[data-player-id]')
        ).find((node) => node.dataset.playerId === recipient);
        let target = seat?.querySelector('.seat__info')?.getBoundingClientRect();
        let targetProvenance: 'live-recipient' | 'departed-recipient' = 'live-recipient';
        if (seat) {
          // A hidden/replacement seat cannot borrow an earlier visible target.
          if (target?.width && target.height)
            targets.set(id, { node: seat, recipient, table, hand, rect: target });
          else targets.delete(id);
        } else {
          const previous = targets.get(id);
          // A winner may leave after the award while its existing flight ends.
          // Retain only this flight's actual observed recipient in this hand;
          // an explicit landing must still reach that position within 2px.
          if (
            previous &&
            previous.recipient === recipient &&
            previous.table === table &&
            previous.hand === hand &&
            !previous.node.isConnected &&
            chip.dataset.chipPhase === 'landed'
          ) {
            target = previous.rect;
            targetProvenance = 'departed-recipient';
          }
        }
        if (!target || !target.width || !target.height) {
          flight.distance = null;
          if (chip.dataset.chipPhase === 'landed' && !seen.has(id)) {
            seen.add(id);
            evidence.violations.push('Payout Has No Rendered Recipient');
          }
          continue;
        }
        const actual = chip.getBoundingClientRect();
        const distance = Math.hypot(
          actual.left + actual.width / 2 - target.left - target.width / 2,
          actual.top + actual.height / 2 - target.top - target.height / 2
        );
        flight.distance = distance;
        // Keep the explicit endpoint witness, and also retain the last visible
        // position when a short-lived state attribute was not observed.
        if (!seen.has(id) && chip.dataset.chipPhase === 'landed') {
          seen.add(id);
          evidence.landings.push({ distance, recipient, targetProvenance });
          if (distance > 2) evidence.violations.push('Payout Missed Its Rendered Recipient');
        }
      }
      for (const [id, flight] of active) {
        if (flight.chip.isConnected) continue;
        active.delete(id);
        targets.delete(id);
        // An explicit endpoint witness completes this flight. Later seat
        // reflow cannot turn its recorded landing into a pre-arrival removal.
        if (seen.has(id)) continue;
        if (flight.distance === null || flight.distance > 2) {
          evidence.violations.push('Payout Disappeared Before Reaching Its Recipient');
        } else if (!seen.has(id)) {
          evidence.landings.push({ distance: flight.distance, recipient: flight.recipient });
        }
        seen.add(id);
      }
      for (const run of document.querySelectorAll('.community-area__run')) {
        if (!run.querySelector('.community-area__run-winner')) continue;
        evidence.multiBoardSamples++;
        if (
          run.querySelectorAll('.community-cards__card').length < 5 ||
          run.querySelector('.card-squeeze-host[data-rs-animating="true"]')
        )
          evidence.violations.push('Run Award Appeared Before Its River Finished');
      }
      if (!stopped && active.size && !frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          inspect();
        });
      }
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-chip-phase', 'data-rs-animating'],
    });
    (window as any).__mobileAwardJournal = {
      evidence,
      stop: () => {
        stopped = true;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        inspect();
        observer.disconnect();
        return evidence;
      },
    };
  });
}
export async function certifyMobileAwardJournal(page: Page, testInfo: TestInfo) {
  const evidence = await page.evaluate(() => (window as any).__mobileAwardJournal.stop());
  console.log(`MOBILE_LIVE_PAYOUT_PROOF ${JSON.stringify(evidence)}`);
  await attachMobileProof(
    testInfo,
    'mobile-live-table-payout-measurements',
    Buffer.from(JSON.stringify(evidence)),
    'application/json'
  );
  expect(evidence.violations, 'Actual mobile payout and river ordering').toEqual([]);
  expect(evidence.landings.length, 'Live proof requires an actual payout landing').toBeGreaterThan(
    0
  );
}

/** Shared by production proof and the real-asset geometry regression. */
export function readMobileTableLayout(crowns: Readonly<Record<string, number>>) {
  const table = Array.from(document.querySelectorAll<HTMLElement>('.table-page')).find(
    (element) => element.getBoundingClientRect().width > 0
  );
  if (!table) return { violations: ['Missing Table'], occupied: 0 };
  const box = (element: Element) => element.getBoundingClientRect();
  const visible = (element: Element) => box(element).width > 0 && box(element).height > 0;
  const intersects = (a: DOMRect, b: DOMRect) =>
    a.left < b.right - 0.5 &&
    a.right > b.left + 0.5 &&
    a.top < b.bottom - 0.5 &&
    a.bottom > b.top + 0.5;
  const plates = Array.from(table.querySelectorAll('.seat__info')).filter(visible);
  const protectedNodes = Array.from(
    table.querySelectorAll(
      '.community-area, .pot-display, .seat__info, .seat__bet-chips, .seat__strength, .action-panel'
    )
  ).filter(visible);
  const cards = Array.from(table.querySelectorAll('.seat__cards--revealed .seat__card')).filter(
    visible
  );
  const violations: string[] = [];
  for (const plate of plates) {
    const rect = box(plate);
    if (rect.width > innerWidth * 0.3 || rect.left < -1 || rect.right > innerWidth + 1)
      violations.push('Player Plate Outside Its Mobile Lane');
  }
  for (const card of cards) {
    const rect = box(card);
    if (rect.left < -1 || rect.right > innerWidth + 1) violations.push('Card Outside Viewport');
    for (const node of protectedNodes)
      if (intersects(rect, box(node))) violations.push(`Card Covers ${node.className}`);
  }
  const markers = Array.from(table.querySelectorAll('.seat__allin-puck')).filter(visible);
  if (table.querySelector('.seat__action--all_in'))
    violations.push('ALL IN Label Is Above A Player Head');
  const avatars = Array.from(table.querySelectorAll('.seat__avatar-img')).filter(visible);
  const centre = (element: Element) => {
    const r = box(element);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  for (const marker of markers) {
    const owner = marker.closest('.seat-wrapper');
    const point = centre(marker);
    const nearest = [...avatars].sort((a, b) => {
      const x = centre(a),
        y = centre(b);
      return Math.hypot(point.x - x.x, point.y - x.y) - Math.hypot(point.x - y.x, point.y - y.y);
    })[0];
    if (!owner || nearest?.closest('.seat-wrapper') !== owner)
      violations.push(
        `ALL IN Marker Reads As Another Player: owner=${owner?.querySelector('.seat__name')?.textContent} nearest=${nearest?.closest('.seat')?.querySelector('.seat__name')?.textContent} marker=${JSON.stringify(point)} bet=${JSON.stringify(centre(marker.parentElement!))}`
      );
    const canvas = table.querySelector('.table-scaler');
    const felt = table.querySelector('.table-surface');
    const art = table.querySelector('.table-art');
    if (!canvas || !felt || !art) {
      violations.push('ALL IN Marker Has No Painted Felt');
      continue;
    }
    const c = box(canvas),
      f = box(felt),
      r = box(marker);
    const inverse = new DOMMatrixReadOnly(getComputedStyle(art).transform).inverse();
    const radius = f.width / 2;
    const x0 = f.left - c.left + radius;
    const upper = f.top - c.top + radius;
    const lower = f.bottom - c.top - radius;
    for (const [x, y] of [
      [r.left, r.top],
      [r.right, r.top],
      [r.right, r.bottom],
      [r.left, r.bottom],
    ]) {
      const raw = new DOMPoint(x - c.left, y - c.top).matrixTransform(inverse);
      const px = raw.x / raw.w,
        py = raw.y / raw.w;
      if (Math.hypot(px - x0, py - Math.min(Math.max(py, upper), lower)) > radius - 0.5)
        violations.push('ALL IN Marker Is Outside Painted Felt');
    }
  }
  /* The character the player actually sees, not its letterbox
   (2026-10-23, post-deploy 39963913337). Bust art is a 125x170
   canvas drawn object-fit: contain into a square box, which the
   per-character gain then scales up; the box's transparent sides
   crossed the board on the acting side seat while the painted
   character stood 12px clear of it. Measure the painted art. */
  const paintedBox = (element: Element): DOMRect => {
    const rect = box(element);
    if (!(element instanceof HTMLImageElement)) return rect;
    const style = getComputedStyle(element);
    const nw = element.naturalWidth;
    const nh = element.naturalHeight;
    if (!nw || !nh || (style.objectFit !== 'contain' && style.objectFit !== 'scale-down'))
      return rect;
    const scale = Math.min(rect.width / nw, rect.height / nh);
    const w = nw * scale;
    const h = nh * scale;
    const [x = '50%', y = '50%'] = style.objectPosition.split(/\s+/);
    const fraction = (value: string) => (value.endsWith('%') ? parseFloat(value) / 100 : 0.5);
    const file = /\/avatars\/table\/((?:free|vip)_[\w-]+(?:@2x)?\.webp)(?:[?#]|$)/.exec(
      element.currentSrc || element.src
    )?.[1];
    const crown = (file && crowns[file]) || 0;
    return new DOMRect(
      rect.left + (rect.width - w) * fraction(x),
      rect.top + (rect.height - h) * fraction(y) + h * crown,
      w,
      h * (1 - crown)
    );
  };
  // Bounds include transparent canvas and the clipped baked-in nameplate.
  // Inspect the actual decoded bytes when those bounds touch the board. Each
  // alpha row is conservatively enclosed, transformed through the real 2D
  // ancestor matrices, and clipped before projection. Unknown pixels or 3D
  // transforms retain the old conservative refusal; they never become a pass.
  const imagePaintTouches = (image: HTMLImageElement, target: DOMRect): boolean => {
    try {
      const style = getComputedStyle(image);
      const width = parseFloat(style.width),
        height = parseFloat(style.height);
      const nw = image.naturalWidth,
        nh = image.naturalHeight;
      if (!(width > 0 && height > 0 && nw > 0 && nh > 0) || nw * nh > 4_000_000) return true;
      if (!['contain', 'scale-down', 'cover'].includes(style.objectFit)) return true;
      if (
        [
          'paddingLeft',
          'paddingRight',
          'paddingTop',
          'paddingBottom',
          'borderLeftWidth',
          'borderRightWidth',
          'borderTopWidth',
          'borderBottomWidth',
        ].some((key) => parseFloat(style[key as keyof CSSStyleDeclaration] as string) > 0)
      )
        return true;
      let linear = new DOMMatrix();
      for (let node: Element | null = image; node; node = node.parentElement) {
        const css = getComputedStyle(node);
        if (css.rotate && css.rotate !== 'none' && css.rotate !== '0deg') return true;
        if (css.scale && css.scale !== 'none' && css.scale !== '1') return true;
        const matrix = new DOMMatrix(css.transform === 'none' ? undefined : css.transform);
        if (
          [
            matrix.m13,
            matrix.m14,
            matrix.m23,
            matrix.m24,
            matrix.m31,
            matrix.m32,
            matrix.m34,
            matrix.m43,
          ].some((value) => value !== 0) ||
          matrix.m33 !== 1 ||
          matrix.m44 !== 1
        )
          return true;
        linear = new DOMMatrix([matrix.a, matrix.b, matrix.c, matrix.d, 0, 0]).multiply(linear);
      }
      const corners = [
        [0, 0],
        [width, 0],
        [width, height],
        [0, height],
      ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(linear));
      const rect = box(image);
      if (
        Math.abs(
          Math.max(...corners.map((point) => point.x)) -
            Math.min(...corners.map((point) => point.x)) -
            rect.width
        ) > 0.5 ||
        Math.abs(
          Math.max(...corners.map((point) => point.y)) -
            Math.min(...corners.map((point) => point.y)) -
            rect.height
        ) > 0.5
      )
        return true;
      const dx = rect.left - Math.min(...corners.map((point) => point.x));
      const dy = rect.top - Math.min(...corners.map((point) => point.y));
      const scale =
        style.objectFit === 'cover'
          ? Math.max(width / nw, height / nh)
          : Math.min(width / nw, height / nh, style.objectFit === 'scale-down' ? 1 : Infinity);
      const coordinate = (token: string, space: number) =>
        token.endsWith('%')
          ? (parseFloat(token) * space) / 100
          : token.endsWith('px')
            ? parseFloat(token)
            : token === 'center'
              ? space / 2
              : token === 'left' || token === 'top'
                ? 0
                : token === 'right' || token === 'bottom'
                  ? space
                  : NaN;
      const [px = '50%', py = '50%'] = style.objectPosition.split(/\s+/);
      const ox = coordinate(px, width - nw * scale),
        oy = coordinate(py, height - nh * scale);
      if (![ox, oy, scale].every(Number.isFinite)) return true;
      let left = 0,
        top = 0,
        right = width,
        bottom = height;
      if (style.clipPath && style.clipPath !== 'none') {
        const inset = /^inset\(([^)]*)\)$/.exec(style.clipPath);
        if (!inset || inset[1].includes('round')) return true;
        const values = inset[1].trim().split(/\s+/);
        const expanded =
          values.length === 1
            ? [values[0], values[0], values[0], values[0]]
            : values.length === 2
              ? [values[0], values[1], values[0], values[1]]
              : values.length === 3
                ? [values[0], values[1], values[2], values[1]]
                : values;
        if (expanded.length !== 4) return true;
        top = coordinate(expanded[0], height);
        right = width - coordinate(expanded[1], width);
        bottom = height - coordinate(expanded[2], height);
        left = coordinate(expanded[3], width);
        if (![left, top, right, bottom].every(Number.isFinite)) return true;
      }
      const canvas = document.createElement('canvas');
      canvas.width = nw;
      canvas.height = nh;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return true;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, nw, nh).data;
      for (let row = 0; row < nh; row++) {
        const y0 = Math.max(top, oy + row * scale),
          y1 = Math.min(bottom, oy + (row + 1) * scale);
        if (!(y1 > y0)) continue;
        let lo = nw,
          hi = -1;
        for (let column = 0; column < nw; column++)
          if (pixels[(row * nw + column) * 4 + 3] >= 16) {
            lo = Math.min(lo, column);
            hi = column;
          }
        if (hi < lo) continue;
        const x0 = Math.max(left, ox + lo * scale),
          x1 = Math.min(right, ox + (hi + 1) * scale);
        if (!(x1 > x0)) continue;
        const points = [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(linear));
        if (
          Math.max(...points.map((point) => point.x)) + dx > target.left + 0.5 &&
          Math.min(...points.map((point) => point.x)) + dx < target.right - 0.5 &&
          Math.max(...points.map((point) => point.y)) + dy > target.top + 0.5 &&
          Math.min(...points.map((point) => point.y)) + dy < target.bottom - 0.5
        )
          return true;
      }
      return false;
    } catch {
      return true;
    }
  };
  const paintTouches = (element: Element, target: DOMRect): boolean => {
    if (!intersects(box(element), target)) return false;
    if (element instanceof HTMLImageElement) return imagePaintTouches(element, target);
    if (!element.classList.contains('seat__action')) return true;
    if ((element as HTMLElement).scrollWidth > (element as HTMLElement).clientWidth + 0.5)
      return true;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const css = getComputedStyle(node);
      const matrix = new DOMMatrix(css.transform === 'none' ? undefined : css.transform);
      if (
        !matrix.is2D ||
        matrix.b !== 0 ||
        matrix.c !== 0 ||
        (css.rotate && css.rotate !== 'none' && css.rotate !== '0deg') ||
        (css.scale && css.scale !== 'none' && css.scale !== '1')
      )
        return true;
    }
    const rect = box(element),
      style = getComputedStyle(element);
    const radii = [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomLeftRadius,
      style.borderBottomRightRadius,
    ];
    if (!radii.every((radius) => radius === radii[0]) || !radii[0].endsWith('px')) return true;
    const cssWidth = parseFloat(style.width),
      cssHeight = parseFloat(style.height);
    const scaleX = rect.width / cssWidth,
      scaleY = rect.height / cssHeight;
    if (![scaleX, scaleY].every(Number.isFinite) || Math.abs(scaleX - scaleY) > 0.01) return true;
    const radius = Math.min(parseFloat(radii[0]) * scaleX, rect.width / 2, rect.height / 2);
    if (!(radius > 0)) return true;
    // The same half-pixel tolerance as the original rectangle predicate.
    const x0 = Math.max(rect.left, target.left + 0.5),
      x1 = Math.min(rect.right, target.right - 0.5);
    const y0 = Math.max(rect.top, target.top + 0.5),
      y1 = Math.min(rect.bottom, target.bottom - 0.5);
    if (!(x1 > x0 && y1 > y0)) return false;
    if (
      (x1 > rect.left + radius && x0 < rect.right - radius) ||
      (y1 > rect.top + radius && y0 < rect.bottom - radius)
    )
      return true;
    const cx = x1 <= rect.left + radius ? rect.left + radius : rect.right - radius;
    const cy = y1 <= rect.top + radius ? rect.top + radius : rect.bottom - radius;
    const x = Math.max(x0, Math.min(cx, x1)),
      y = Math.max(y0, Math.min(cy, y1));
    return (x - cx) ** 2 + (y - cy) ** 2 < radius ** 2;
  };
  const board = table.querySelector('.community-area');
  if (board && visible(board)) {
    for (const node of table.querySelectorAll(
      '.seat__info, .seat__avatar-img, .seat__action, .seat__bet-chips'
    ))
      if (visible(node) && paintTouches(node, box(board)))
        violations.push(
          `Player Or Bet Covers Board: ${node.className} ${JSON.stringify({
            seat: node.closest('.seat')?.getAttribute('data-seat-num'),
            name: node.closest('.seat')?.querySelector('.seat__name')?.textContent,
            src: node instanceof HTMLImageElement ? node.currentSrc || node.src : null,
            raw: box(node).toJSON(),
            painted: paintedBox(node).toJSON(),
            board: box(board).toJSON(),
            visibility: getComputedStyle(node).visibility,
            clip: getComputedStyle(node).clipPath,
            viewport: { width: innerWidth, height: innerHeight },
          })}`
        );
  }
  const mini = table.querySelector('.bbj-mini-plate');
  const head = table.querySelector(
    table.getAttribute('data-seats') === '6'
      ? '.seat-wrapper--cap .seat__avatar-img'
      : '.seat-wrapper--top .seat__avatar-img'
  );
  const topGap = mini && head && visible(head) ? box(head).top - box(mini).bottom : null;
  // A PLO5/PLO6 hand reserves a full card-height lane above the
  // top plate; keep its player close beneath that lane and the BBJ.
  const capPlate = head?.closest('.seat-wrapper')?.querySelector('.seat__info');
  const largeHand = table.querySelector(
    ".seat__cards:is([data-card-count='5'],[data-card-count='6'])"
  );
  const cardWidth = parseFloat(
    table
      .querySelector<HTMLElement>('.table-scaler')
      ?.style.getPropertyValue('--sp-tabled-card-w') || '0'
  );
  const gapLimit =
    largeHand && capPlate && head
      ? Math.max(12, (cardWidth * 92) / 64 + 10 - (box(capPlate).top - box(head).top))
      : 12;
  if (table.getAttribute('data-seats') === '6' && box(table).width > 480 && head && visible(head)) {
    const scaler = table.querySelector<HTMLElement>('.table-scaler')!;
    const scale = box(scaler).width / scaler.offsetWidth || 1;
    const source = (head as HTMLImageElement).currentSrc || (head as HTMLImageElement).src;
    const file = /\/avatars\/table\/((?:free|vip)_[\w-]+(?:@2x)?\.webp)(?:[?#]|$)/.exec(
      source
    )?.[1];
    const gap = box(head).top + box(head).height * ((file && crowns[file]) || 0) - box(table).top;
    if (gap < -12 * scale || gap > 2 * scale)
      violations.push('Six-Max Crown Does Not Meet The Top Bar');
  } else if (topGap !== null && (topGap < -1 || topGap > gapLimit))
    violations.push('Top Player Does Not Sit Immediately Below Mini BBJ');
  return {
    violations,
    occupied: plates.length,
    width: innerWidth,
    plateWidths: plates.map((plate) => box(plate).width),
    revealedCards: cards.length,
    allInMarkers: markers.length,
    height: innerHeight,
    topGap,
    boards: table.querySelectorAll('.community-cards__card').length,
  };
}
