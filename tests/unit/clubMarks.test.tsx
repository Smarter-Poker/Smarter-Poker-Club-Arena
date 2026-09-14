/**
 * Dan 2026-09-09: "YOU MUST CREATE AND USE DYNAMIC HIGH QUALITY ICON'S WITH
 * DEPTH AND 3D FEEL, NOT WHAT EVER THIS FLAT BORING BROKEN THING IS." The
 * diamond was recut that day; the other fourteen followed on 2026-09-10.
 * There is no wireframe left: every club icon is a lit object with an
 * extrusion, a chrome rim, a face, an underlight and a sheen, from one
 * recipe, and two of them on one page never share a gradient id.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ClubIcon, type ClubIconName } from '../../src/components/club-buttons/ClubButtons';
import { MARK_NAMES } from '../../src/components/club-buttons/marks';
import specs from '../../src/components/club-buttons/marks.json';

const EVERY_ICON: ClubIconName[] = [
  'spade',
  'diamond',
  'bank',
  'wallet',
  'treasury',
  'chat',
  'stats',
  'timer',
  'rabbit',
  'previous',
  'menu',
  'add',
  'settings',
  'sound',
  'info',
];

describe('every club icon is a mark', () => {
  it('has a mark for every icon but the stone, and no stray marks', () => {
    const expected = EVERY_ICON.filter((n) => n !== 'diamond').sort();
    expect([...MARK_NAMES].sort()).toEqual(expected);
  });

  it('every mark has a silhouette, and no wireframe stroke survives', () => {
    for (const name of EVERY_ICON) {
      const { container, unmount } = render(<ClubIcon name={name} />);
      const svg = container.querySelector('svg');
      expect(svg, name).not.toBeNull();
      expect(svg?.getAttribute('class')).toContain('cb-mark');
      expect(svg?.getAttribute('viewBox')).toBe('0 0 64 64');
      expect(container.innerHTML, `${name} is still a wireframe`).not.toContain('currentColor');
      expect(container.innerHTML, `${name} has no light on it`).toContain('linearGradient');
      // the extrusion is the depth: the silhouette drawn again, offset down and right
      if (name !== 'diamond') expect(container.innerHTML).toContain('translate(1.5 2.1)');
      unmount();
    }
  });

  it('every silhouette closes and stays inside the 64 box', () => {
    for (const [name, spec] of Object.entries(specs)) {
      expect(spec.shape.trim().endsWith('Z'), `${name} does not close`).toBe(true);
      const numbers = spec.shape.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
      expect(numbers.length, name).toBeGreaterThan(6);
      for (const n of numbers)
        expect(Math.abs(n), `${name} leaves the box`).toBeLessThanOrEqual(64);
    }
  });

  it('two marks on one page never share a gradient id', () => {
    const { container } = render(
      <>
        <ClubIcon name="bank" />
        <ClubIcon name="bank" />
      </>
    );
    const ids = Array.from(container.querySelectorAll('linearGradient')).map((g) => g.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
