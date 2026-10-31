import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { expect, it } from 'vitest';

it.each([
  ['SeatSlot.css', '.seat', 'opacity 0.3s ease'],
  ['ChipPhysics.css', '.chip-physics', 'opacity 0.3s var(--cp-ease-smooth)'],
])(
  'lets %s release resting layers while preserving its opacity transition',
  (file, selector, transition) => {
    const css = postcss.parse(readFileSync(resolve('src/components/table', file), 'utf8'));
    const transitions: string[] = [];
    const hints: string[] = [];
    css.walkRules(selector, (rule) => {
      rule.walkDecls('will-change', (declaration) => {
        hints.push(declaration.value);
      });
      rule.walkDecls('transition', (declaration) => {
        transitions.push(declaration.value);
      });
    });
    expect(hints).toEqual([]);
    expect(transitions.some((value) => value.includes(transition))).toBe(true);
  }
);
