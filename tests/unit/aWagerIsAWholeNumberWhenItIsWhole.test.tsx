/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A WAGER PRINTS AS A WHOLE NUMBER WHEN IT IS ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-23, from a live 1/2 table where will.marino had opened to 4:
 * '"RAISE 4.00" SHOULD BE "RAISE 4". NO DECIMAL POINTS FOR WHOLE NUMBERS.'
 *
 * The seat's action badge and its stack-change float printed through
 * `formatStack`, whose under-100 penny rule is Dan's STACK rule (2026-09-04:
 * a 5 stack reads "5.00" so a column of stacks lines up). A wager never had
 * that rule. It is `formatTableChips` - integers clean, a real fraction kept -
 * which is what the pot pill, the chip label in flight and the action bar's
 * buttons already print. This pins the seat to the same contract.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import SeatSlot, { type SeatPlayer } from '../../src/components/table/SeatSlot';

const villain = (over: Partial<SeatPlayer> = {}): SeatPlayer => ({
  id: 'u-marino',
  name: 'will.marino',
  avatar: '',
  stack: 144,
  status: 'active',
  isHero: false,
  showCards: false,
  ...over,
});

const badge = (lastAction: 'raise' | 'bet' | 'call', amount: number) => {
  const { container, unmount } = render(
    <SeatSlot
      seatNumber={2}
      player={villain()}
      position={null}
      isActive={false}
      lastAction={lastAction}
      lastBetAmount={amount}
    />
  );
  const text = container.querySelector('.seat__action')?.textContent ?? '';
  unmount();
  return text;
};

describe('the action badge prints a wager, not a stack', () => {
  it('a whole-number open at 1/2 reads "Raise 4", never "Raise 4.00"', () => {
    expect(badge('raise', 4)).toBe('Raise 4');
    expect(badge('bet', 13)).toBe('Bet 13');
    expect(badge('call', 2)).toBe('Call 2');
  });

  it('a real fraction is still kept, and a sub-chip wager still reads to the cent', () => {
    // Micro-stakes are exact (Dan 2026-08-28): a typed 13.37 stays 13.37.
    expect(badge('raise', 13.37)).toBe('Raise 13.37');
    expect(badge('bet', 0.5)).toBe('Bet 0.50');
  });

  it('the net-win float is a wager too: "+12", never "+12.00" (2026-09-24)', () => {
    // The one float item 9 missed: the winner's +N rode formatStack and read
    // +12.00 beside a stack delta that already read +12.
    const { container, unmount } = render(
      <SeatSlot
        seatNumber={2}
        player={villain({ stack: 156 })}
        position={null}
        isActive={false}
        lastAction={null}
        isWinner
        netWinAmount={12}
      />
    );
    expect(container.querySelector('.seat__net-win')?.textContent).toBe('+12');
    unmount();
    const fraction = render(
      <SeatSlot
        seatNumber={2}
        player={villain({ stack: 156 })}
        position={null}
        isActive={false}
        lastAction={null}
        isWinner
        netWinAmount={7.5}
      />
    );
    expect(fraction.container.querySelector('.seat__net-win')?.textContent).toBe('+7.5');
    fraction.unmount();
  });

  it('a whole stack of at least 100 still prints as a whole stack', () => {
    // Nothing here touches the STACK rule: 144 reads 144.
    const { container } = render(
      <SeatSlot
        seatNumber={2}
        player={villain({ stack: 144 })}
        position={null}
        isActive={false}
        lastAction={null}
      />
    );
    expect(container.querySelector('.seat__stack')?.textContent).toContain('144');
  });
});
