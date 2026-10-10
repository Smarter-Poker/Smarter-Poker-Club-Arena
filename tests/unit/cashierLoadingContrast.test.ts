import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, '../..', path), 'utf8');
const rgb = (hex: string) => hex.match(/../g)!.map((channel) => parseInt(channel, 16));
const luminance = (color: number[]) =>
  color
    .map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);

it('keeps the cashier loading message readable throughout its pulse', () => {
  const css = read('src/pages/CashierPage.module.css');
  const ink = read('src/components/console/SpadeConsole.css').match(
    /\.sc-ink--muted\s*\{[\s\S]*?color:\s*#([a-f0-9]{6})/i
  )?.[1];
  expect(ink).toBeDefined();
  expect(css).toMatch(/\.loading\s*\{\s*animation:\s*cashierPulse/);
  const frames = css.match(/@keyframes cashierPulse\s*\{([\s\S]*?)\n\}/)?.[1];
  expect(frames).toBeDefined();
  const opacity = [...frames!.matchAll(/opacity:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  expect(opacity.length).toBeGreaterThanOrEqual(2);
  // WCAG normal-text contrast after alpha compositing at the darkest pulse.
  // Include both the page black and the brightest cashier directory surface.
  for (const background of ['000000', '0d1218']) {
    const bg = rgb(background);
    for (let frame = 0; frame <= 100; frame++) {
      const alpha =
        Math.min(...opacity) + ((Math.max(...opacity) - Math.min(...opacity)) * frame) / 100;
      const composed = rgb(ink!).map((channel, index) => channel * alpha + bg[index] * (1 - alpha));
      expect((luminance(composed) + 0.05) / (luminance(bg) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  }
});
