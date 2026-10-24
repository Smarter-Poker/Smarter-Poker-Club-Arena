/**
 * THE CONSOLE'S GLASS IS SOLID (Dan 2026-09-23)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "POST OR WAIT IS SEE THROUGH ... THIS SHOULD HAVE A SOLID BACK AND NOT SEE
 * THE TABLE THROUGH THE FONTS."
 *
 * The spade master was cut with a transparent window where the glass between
 * the rails should be: mid.png is alpha 0-1 across x 74-923 and the plates
 * foot is transparent above its closing rail. Over a dark page it passed; over
 * a live felt the board printed through the dialog's copy. The stylesheet now
 * lays the master's glass tone under the art on the body and the foot, inset
 * to the rail interior. This reads the ART to prove the window is real, then
 * pins the layer that closes it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p));
const CSS = read('src/components/console/SpadeConsole.css').toString('utf8');
const decls = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector: string) => {
  const start = decls.indexOf(`${selector} {`);
  expect(start, `${selector} exists`).toBeGreaterThanOrEqual(0);
  return decls.slice(start, decls.indexOf('}', start));
};

describe('the spade master has a window where its glass should be', () => {
  it('mid.png is transparent between its rails', async () => {
    const { data, info } = await sharp(
      read('public/assets/club-buttons/console/spade-console-v1/mid.png')
    )
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number) => data[(Math.floor(info.height / 2) * info.width + x) * 4 + 3];
    expect(alphaAt(500)).toBeLessThan(8); // the glass
    expect(alphaAt(40)).toBe(255); // the left rail
    expect(alphaAt(930)).toBeGreaterThan(200); // the right rail
  });
});

describe('the stylesheet closes it', () => {
  it('the body lays the glass tone under the rails, inset to the rail interior', () => {
    const body = rule('.sc__body');
    expect(body).toMatch(/spade-console-v2\/mid\.png'\) top center \/ 100% auto repeat-y,/);
    expect(body).toMatch(/linear-gradient\(#0a0b0d, #0a0b0d\) 50% 0 \/ 84\.9% 100% no-repeat/);
  });

  it('both feet keep the glass, and stop it inside the closing rail', () => {
    const foot = rule('.sc__foot');
    expect(foot).toMatch(/linear-gradient\(#0a0b0d, #0a0b0d\) 50% 0 \/ 84\.9% 80% no-repeat/);
    // A one-value background-image on the plates foot would collapse the
    // layer list and drop the glass; both layers are restated.
    const plates = rule('.sc--plates .sc__foot');
    expect(plates).toMatch(
      /background-image:\s*url\('\/assets\/club-buttons\/console\/spade-console-v2\/bottom-plates\.png'\),\s*linear-gradient\(#0a0b0d, #0a0b0d\)/
    );
  });

  it('the opaque families are left as their own art', () => {
    expect(rule('.sc--family-shark .sc__body')).not.toContain('linear-gradient');
    expect(rule('.sc--family-riveted .sc__body')).not.toContain('linear-gradient');
  });
});

/**
 * THE FRAME IS SOLID ALL THE WAY THROUGH (Dan 2026-10-24)
 *
 * "YOU SHOULDN'T SEE ANYTHING INSIDE THE FRAME OR IN THE CARD, IT SHOULD BE
 * 100% SOLID ALL THE WAY THROUGH THE FRAME AND INSIDE OF THE CARD." The glass
 * layer above only reaches the rectangle between the rails; on the Tournament
 * Break card the felt still printed through the gap under the crest, the band
 * under the head's chrome rule, the channels between the rail strands and the
 * chamfered corners. spade-console-v2 closes every one of them in the art.
 *
 * This stacks each head the kit ships over the rails and each foot, exactly as
 * the browser lays them, floods the outside of the card in from the border,
 * and requires every pixel the flood cannot reach to be fully opaque.
 */
describe('the v2 slices are solid inside the frame', () => {
  const ART = 'public/assets/club-buttons/console/spade-console-v2';
  const rgba = async (name: string) => {
    const { data, info } = await sharp(read(`${ART}/${name}.png`))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { a: data, w: info.width, h: info.height };
  };

  it('every crest the kit uses points at v2', () => {
    for (const name of ['top', 'top-flat', 'top-diamond', 'top-club', 'top-vip-v2']) {
      expect(CSS).toContain(`spade-console-v2/${name}.png`);
    }
    expect(CSS).not.toMatch(/spade-console-v1\/(top|mid|bottom)[\w-]*\.png'\)/);
  });

  it.each([
    ['top', 'bottom-plates'],
    ['top', 'bottom-foot'],
    ['top-flat', 'bottom-foot'],
    ['top-diamond', 'bottom-foot'],
    ['top-club', 'bottom-foot'],
    ['top-vip-v2', 'bottom-foot'],
  ])('%s over the rails over %s has no window', async (topName, footName) => {
    const parts = [await rgba(topName), ...Array(6).fill(await rgba('mid')), await rgba(footName)];
    const w = parts[0].w;
    const h = parts.reduce((sum, p) => sum + p.h, 0);
    const alpha = new Uint8Array(w * h);
    let row = 0;
    for (const p of parts) {
      expect(p.w).toBe(w);
      for (let i = 0; i < p.w * p.h; i++) alpha[row * w + i] = p.a[i * 4 + 3];
      row += p.h;
    }
    // Outside the card: reachable from the border through alpha < 128.
    const outside = new Uint8Array(w * h);
    const queue: number[] = [];
    const push = (i: number) => {
      if (!outside[i] && alpha[i] < 128) {
        outside[i] = 1;
        queue.push(i);
      }
    };
    for (let x = 0; x < w; x++) {
      push(x);
      push((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      push(y * w);
      push(y * w + w - 1);
    }
    while (queue.length) {
      const i = queue.pop()!;
      const x = i % w;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (i >= w) push(i - w);
      if (i < (h - 1) * w) push(i + w);
    }
    // The anti-aliased outer edge (two pixels in) keeps its softness.
    const nearOutside = (i: number) => {
      const x = i % w;
      const y = Math.floor(i / w);
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && xx < w && yy >= 0 && yy < h && outside[yy * w + xx]) return true;
        }
      return false;
    };
    let windows = 0;
    for (let i = 0; i < w * h; i++) if (alpha[i] < 255 && !nearOutside(i)) windows++;
    expect(windows).toBe(0);
  });
});
