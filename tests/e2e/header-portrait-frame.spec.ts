import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE HEADER PORTRAIT FRAME, RENDERED.
 *
 * Dan, 2026-09-07: "the profile pic is supposed to be a .5 pixel black frame
 * that 'appears invisible' instead of this thick broken frame that exists now."
 *
 * tests/the-header-portrait-frame-is-a-hairline.law.test.ts pins the CSS by
 * arithmetic. This spec pins what the browser actually paints: the shipped
 * GlobalHeader.module.css over the shipped artwork, with a pure-red stand-in
 * photo, at phone, tablet, laptop and authority widths. Around the photo,
 * where the artwork bakes a silver ring and a blue glow, every sampled pixel
 * must be black - the ring is silver and the glow blue, so ANY green or blue
 * there is the ornament showing through. The rails above and below must still
 * be bright (the mask did not swallow them) and the photo must reach the top
 * and bottom of its slot (it is not sliced).
 *
 * Same harness shape as footer-visual-regression.spec.ts: no server, no auth,
 * page.setContent with the real stylesheet and the real asset.
 */
const ROOT = process.cwd();
const css = readFileSync(join(ROOT, 'src/components/navigation/GlobalHeader.module.css'), 'utf8');
const art = readFileSync(
  join(ROOT, 'public/images/global-header/global-header-desktop.png')
).toString('base64');
// 1x1 pure red PNG. The artwork has no pure red anywhere near the ornament.
const PHOTO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

/* The ornament on the 1648x168 plane: centre, ring r 40-48, glow gone by 52,
   rails from 62. The photo is 72% of a 112-unit disc = r 40.3, so the sampled
   annulus starts at 43 to clear the photo's own anti-aliased edge. */
const PLANE = { w: 1648, h: 168, cx: 1159.75, cy: 80.5 };
const ANNULUS = [43, 45, 47, 49, 51, 52];
const RAIL_RANGE = { from: 64, to: 72 };

const VIEWPORTS = [375, 430, 768, 901, 1280, 1680];

const html = `
  <head>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <style>html, body { margin: 0; background: #0b1320; } ${css}</style>
  </head>
  <body>
  <header class="header" data-artwork="approved-global-header">
    <img class="desktopArtwork" alt="" width="1648" height="168" src="data:image/png;base64,${art}" />
    <div class="headerControls">
      <div class="headerRight">
        <button class="artButton profileBtn" aria-label="My Profile">
          <img src="${PHOTO}" alt="" />
          <span class="profileAvatarSlot" aria-hidden="true">
            <img src="${PHOTO}" alt="" class="profileAvatar" />
          </span>
        </button>
      </div>
    </div>
  </header>
  </body>`;

test.describe('Club Arena header portrait frame', () => {
  test('the baked ring never shows around the photo, the rails survive, the photo is whole', async ({
    page,
  }) => {
    for (const width of VIEWPORTS) {
      await page.setViewportSize({ width, height: 400 });
      await page.setContent(html);
      await page.waitForFunction(() => {
        const img = document.querySelector('.desktopArtwork') as HTMLImageElement | null;
        return !!img && img.complete && img.naturalWidth > 0;
      });

      const geo = await page.evaluate(() => {
        const rect = (sel: string) => {
          const b = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
          return { x: b.x, y: b.y, w: b.width, h: b.height };
        };
        return {
          art: rect('.desktopArtwork'),
          slot: rect('.profileAvatarSlot'),
          slotBorder: getComputedStyle(document.querySelector('.profileAvatarSlot')!)
            .borderTopStyle,
          buttonBackground: getComputedStyle(document.querySelector('.profileBtn')!)
            .backgroundColor,
        };
      });
      expect(geo.buttonBackground, `${width}px: the profile button paints the black mask`).toBe(
        'rgb(0, 0, 0)'
      );
      expect(geo.slotBorder, `${width}px: the slot has its hairline`).toBe('solid');

      // Paint the header and read the pixels back through a canvas - no
      // image library needed, and it is the composited result we care about.
      const shot = await page.screenshot({
        clip: { x: 0, y: 0, width, height: Math.ceil(geo.art.h) + 1 },
      });
      const pixels = await page.evaluate(
        async ({ png, w, h }) => {
          const img = new Image();
          img.src = `data:image/png;base64,${png}`;
          await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          return {
            data: Array.from(data),
            width: canvas.width,
            height: canvas.height,
            dpr: canvas.width / w,
            cssH: h,
          };
        },
        { png: shot.toString('base64'), w: width, h: Math.ceil(geo.art.h) + 1 }
      );

      const at = (x: number, y: number) => {
        const xi = Math.min(pixels.width - 1, Math.max(0, Math.round(x)));
        const yi = Math.min(pixels.height - 1, Math.max(0, Math.round(y)));
        const i = (yi * pixels.width + xi) * 4;
        return [pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]] as const;
      };
      const dpr = pixels.dpr;
      const sx = geo.art.w / PLANE.w;
      const sy = geo.art.h / PLANE.h; // 96/168 on the compressed desktop band
      const cx = (geo.art.x + PLANE.cx * sx) * dpr;
      const cy = (geo.art.y + PLANE.cy * sy) * dpr;

      // 1. The ring and its glow are black. Green or blue here = ornament.
      let worst = 0;
      let worstAt = '';
      for (const r of ANNULUS) {
        for (let k = 0; k < 48; k++) {
          const t = (2 * Math.PI * k) / 48;
          const [, g, b] = at(cx + r * sx * dpr * Math.cos(t), cy + r * sy * dpr * Math.sin(t));
          const v = Math.max(g, b);
          if (v > worst) {
            worst = v;
            worstAt = `r=${r} angle=${Math.round((t * 180) / Math.PI)}`;
          }
        }
      }
      expect(
        worst,
        `${width}px: the ornament ring/glow shows through at ${worstAt}`
      ).toBeLessThanOrEqual(24);

      // 2. The photo is there, centred on the ornament.
      const centre = at(cx, cy);
      expect(centre[0], `${width}px: the photo is under the ornament centre`).toBeGreaterThan(200);
      expect(Math.max(centre[1], centre[2])).toBeLessThan(40);

      // 3. The photo reaches the top and bottom of its slot: not sliced.
      const slotCx = (geo.slot.x + geo.slot.w / 2) * dpr;
      const top = at(slotCx, geo.slot.y * dpr + 4);
      const bottom = at(slotCx, (geo.slot.y + geo.slot.h) * dpr - 5);
      expect(top[0], `${width}px: the top of the photo is cut off`).toBeGreaterThan(150);
      expect(bottom[0], `${width}px: the bottom of the photo is cut off`).toBeGreaterThan(150);

      // 4. The silver rails straight above and below the ornament are intact.
      let above = 0;
      let below = 0;
      for (let r = RAIL_RANGE.from; r <= RAIL_RANGE.to; r++) {
        above = Math.max(above, ...at(cx, cy - r * sy * dpr));
        below = Math.max(below, ...at(cx, cy + r * sy * dpr));
      }
      expect(above, `${width}px: the mask has swallowed the upper rail`).toBeGreaterThan(90);
      expect(below, `${width}px: the mask has swallowed the lower rail`).toBeGreaterThan(90);
    }
  });
});
