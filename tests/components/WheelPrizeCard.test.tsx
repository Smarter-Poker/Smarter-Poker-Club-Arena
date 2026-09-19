import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WheelPrizeCard, wheelCardLabel } from '../../src/components/wheel/WheelPrizeCard';
import type { WheelSegment } from '../../src/services/DiamondWheelService';
import receipts from '../fixtures/diamond-spins/wheel-v3-postgres-receipts.json';

const main = receipts.records.find(
  (r) => r.kind === 'wheel' && (r.value as any).outcome.kind === 'chips'
)!.value as any;
const upgrade = (
  receipts.records.find((r) => r.kind === 'wheel' && (r.value as any).secondary)!.value as any
).secondary;
const mainIndex = (segment: WheelSegment) =>
  segment.kind === 'bonus'
    ? { plinko: 0, crash: 1, crossing: 2, mines: 3 }[segment.game!]
    : segment.kind === 'chips'
      ? 4 + segment.multiplier!
      : { upgrade: 4, throwables: 8, time_bank: 9, rabbit_hunt: 10, diamonds: 11 }[
          segment.kind as 'upgrade'
        ];
afterEach(cleanup);

describe('approved wheel prize cards', () => {
  it.each([
    [false, main.segments],
    [true, upgrade.segments],
  ] as const)(
    'maps every catalog outcome to its correct approved card; upgraded=%s',
    (upgraded, segments: WheelSegment[]) => {
      const count = segments.length;
      const view = render(
        <svg>
          {[...segments].reverse().map((segment, index) => (
            <WheelPrizeCard
              key={segment.ord}
              segment={segment}
              upgraded={upgraded}
              startAngle={(index * 360) / count}
              endAngle={((index + 1) * 360) / count}
              outerRadius={upgraded ? 468 : 344}
              innerRadius={upgraded ? 358 : 88}
            />
          ))}
        </svg>
      );
      expect(screen.getAllByRole('img')).toHaveLength(upgraded ? 8 : 12);
      for (const segment of segments) {
        const element = screen.getByRole('img', {
          name: wheelCardLabel(segment, upgraded),
          exact: true,
        });
        const index = upgraded
          ? segment.kind === 'bonus'
            ? { plinko: 0, crash: 1, crossing: 2, mines: 3 }[segment.game!]
            : 4 + [5, 10, 25, 100].indexOf(segment.multiplier!)
          : mainIndex(segment);
        expect(element).toHaveAttribute('data-card-index', String(index));
        expect(element.querySelector('image')).toHaveAttribute(
          'href',
          `/assets/diamond-spins/${upgraded ? 'wheel-upgrade-cards-v1.png' : 'wheel-main-cards-v1.png'}`
        );
        expect(element.querySelector('g[clip-path]')).toBeTruthy();
      }
      const ids = [...view.container.querySelectorAll('[id]')].map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(view.container.innerHTML).not.toMatch(/NaN|Infinity/);
    }
  );
  it('prints the server amount directly with cents and replaces quoted values on a stake change', () => {
    const chips = main.segments.find((s: WheelSegment) => s.kind === 'chips');
    const props = { startAngle: 0, endAngle: 30, outerRadius: 344, innerRadius: 88 };
    const view = render(
      <svg>
        <WheelPrizeCard {...props} segment={{ ...chips, amount: 0.25, multiplier: 3 }} />
      </svg>
    );
    expect(screen.getByRole('img')).toHaveAccessibleName('0.25 Chips');
    expect(view.container.querySelector('textPath')).toHaveTextContent('0.25 CHIPS');
    view.rerender(
      <svg>
        <WheelPrizeCard {...props} segment={{ ...chips, amount: 27.53, multiplier: 3 }} />
      </svg>
    );
    expect(screen.getByRole('img')).toHaveAccessibleName('27.53 Chips');
    expect(view.container.querySelector('textPath')).toHaveTextContent('27.53 CHIPS');
    expect(view.container.textContent).not.toMatch(/3[xX]/);
  });
  it('keeps MINI, MINOR, MAJOR and GRAND attached to their known upper-ring tiers', () => {
    const chips = main.segments.find((s: WheelSegment) => s.kind === 'chips');
    for (const [multiplier, tier] of [
      [5, 'MINI'],
      [10, 'MINOR'],
      [25, 'MAJOR'],
      [100, 'GRAND'],
    ] as const) {
      expect(wheelCardLabel({ ...chips, multiplier, amount: 12.34 }, true)).toBe(
        `${tier} 12.34 Chips`
      );
    }
    expect(wheelCardLabel(main.segments.find((s: WheelSegment) => s.kind === 'upgrade'))).toBe(
      'UPGRADE'
    );
  });
});
