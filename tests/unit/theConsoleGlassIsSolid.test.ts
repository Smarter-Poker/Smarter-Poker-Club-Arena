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
    expect(body).toMatch(/spade-console-v1\/mid\.png'\) top center \/ 100% auto repeat-y,/);
    expect(body).toMatch(/linear-gradient\(#0a0b0d, #0a0b0d\) 50% 0 \/ 84\.9% 100% no-repeat/);
  });

  it('both feet keep the glass, and stop it inside the closing rail', () => {
    const foot = rule('.sc__foot');
    expect(foot).toMatch(/linear-gradient\(#0a0b0d, #0a0b0d\) 50% 0 \/ 84\.9% 80% no-repeat/);
    // A one-value background-image on the plates foot would collapse the
    // layer list and drop the glass; both layers are restated.
    const plates = rule('.sc--plates .sc__foot');
    expect(plates).toMatch(
      /background-image:\s*url\('\/assets\/club-buttons\/console\/spade-console-v1\/bottom-plates\.png'\),\s*linear-gradient\(#0a0b0d, #0a0b0d\)/
    );
  });

  it('the opaque families are left as their own art', () => {
    expect(rule('.sc--family-shark .sc__body')).not.toContain('linear-gradient');
    expect(rule('.sc--family-riveted .sc__body')).not.toContain('linear-gradient');
  });
});
