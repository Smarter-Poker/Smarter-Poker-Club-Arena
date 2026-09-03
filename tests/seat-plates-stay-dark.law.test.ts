/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SEAT PLATES STAY DARK — THE TABLE DOES NOT WEAR THE INTERFACE THEME
 *  (Dan 2026-08-30, binding)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The bug this pins: `data-theme` on <html> carries the INTERFACE mode
 * (dark/light chrome), but design-tokens.css uses the same attribute namespace
 * for the table color themes (blue/red/purple/black/gold). The light-mode
 * block declared --seat-bg: rgba(255,255,255,0.94) plus --seat-border,
 * --felt-color and --timer-* — so a player whose interface was in light mode
 * saw every seat "action box" on a live table go WHITE while the image-based
 * felt stayed dark. Cash games and tournaments both.
 *
 * The law: the in-game table always keeps its dark plates. The interface light
 * theme may restyle chrome tokens only. If you are adding a real "day table"
 * skin, do it through the table theme system (tableTheme.ts presets), not by
 * re-adding table tokens to the interface theme block.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../', p), 'utf8');

const TOKENS = read('src/styles/design-tokens.css');
const SEAT_CSS = read('src/components/table/SeatSlot.css');

/** The full `[data-theme='light']` rule block, brace to brace. */
function lightThemeBlock(): string {
  const start = TOKENS.indexOf("[data-theme='light']");
  expect(start, "design-tokens.css must still have a [data-theme='light'] block").toBeGreaterThan(
    -1
  );
  const open = TOKENS.indexOf('{', start);
  const close = TOKENS.indexOf('}', open);
  return TOKENS.slice(open, close);
}

describe('LAW: seat plates stay dark in every interface theme', () => {
  it('the light interface theme declares NO table-only tokens', () => {
    const block = lightThemeBlock();
    for (const token of [
      '--seat-bg',
      '--seat-border',
      '--seat-text',
      '--felt-color',
      '--rail-highlight',
      '--timer-color',
      '--timer-glow',
    ]) {
      expect(
        block,
        `[data-theme='light'] must not declare ${token} - that is what painted the seat plates white`
      ).not.toContain(token);
    }
  });

  it('the root seat plate background is dark, not white', () => {
    const m = TOKENS.match(/--seat-bg:\s*([^;]+);/);
    expect(m, 'root --seat-bg must exist').toBeTruthy();
    expect(m![1]).not.toMatch(/255,\s*255,\s*255|#fff/i);
  });

  it('seat plate text reads --seat-text, never the interface --text-primary', () => {
    const nameRule = SEAT_CSS.slice(
      SEAT_CSS.indexOf('.seat__name {'),
      SEAT_CSS.indexOf('}', SEAT_CSS.indexOf('.seat__name {'))
    );
    expect(nameRule).toContain('var(--seat-text');
    expect(nameRule).not.toContain('var(--text-primary)');
  });

  it('--seat-text is declared at root and is a light color', () => {
    const m = TOKENS.match(/--seat-text:\s*([^;]+);/);
    expect(m, 'root --seat-text must exist').toBeTruthy();
    expect(m![1].trim()).toBe('#f3f4f6');
  });
});
