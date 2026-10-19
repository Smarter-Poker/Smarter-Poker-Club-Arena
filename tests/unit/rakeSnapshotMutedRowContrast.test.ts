import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The unassigned agent row in Club Data is dimmed with `opacity` on the whole
 * row. Opacity scales every colour inside it, so the dimmest text in the row
 * sets the floor. At 0.7 the role and count text (#9aa5b3 on black) measured
 * 4.38:1 and the cost (#ffd700 on its gold chip) 4.36:1, and the production
 * axe check in tests/e2e/club-data-deep.spec.ts failed whenever a club had
 * unassigned players (post-deploy job 118153814498, 2026-10-19).
 */
const css = readFileSync('src/components/club/RakeSnapshotPanel.module.css', 'utf8');

const rule = (selector: string) => {
  const match = new RegExp(`\\n${selector.replace('.', '\\.')} \\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`${selector} is missing`);
  return match[1];
};
const value = (selector: string, property: string) => {
  const match = new RegExp(`(?:^|\\n)\\s*${property}:\\s*([^;]+);`).exec(rule(selector));
  if (!match) throw new Error(`${selector} has no ${property}`);
  return match[1].trim();
};
const hex = (text: string) => {
  const match = /^#([0-9a-f]{6})$/i.exec(text);
  if (!match) throw new Error(`${text} is not a six-digit colour`);
  return [0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16));
};
const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (rgb: number[], alpha: number) => {
  const [r, g, b] = rgb.map((c) => channel(Math.round(c * alpha)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (fg: number[], bg: number[], alpha: number) => {
  const [a, b] = [luminance(fg, alpha), luminance(bg, alpha)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

describe('the muted unassigned rake row keeps WCAG AA contrast', () => {
  const alpha = Number(value('.rowMuted', 'opacity'));

  it('dims, but not below the floor its dimmest text allows', () => {
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(1);
    for (const selector of ['.rowEm', '.rowCount']) {
      expect(ratio(hex(value(selector, 'color')), [0, 0, 0], alpha)).toBeGreaterThanOrEqual(4.5);
    }
    // The cost sits on a gold chip that axe measured as #3c3300 at 0.7.
    const chip = [0x3c / 0.7, 0x33 / 0.7, 0];
    expect(ratio(hex(value('.rowCost', 'color')), chip, alpha)).toBeGreaterThanOrEqual(4.5);
  });
});
