/**
 * Dan 2026-08-23, bug list item 9, verbatim:
 *
 *   "THE BET SLIDER SHOULD GO UP IN SMALLER INCRIMENTS, IT SNAP GOES TO THE
 *    NEXT BB AMOUNT INSTEAD OF ALLOWING THE USER TO CHOSE AN AMOUNT INBETWEEN
 *    THE BLINDS. THERE SHOULD ALSO BE AN AREA TO 'CLICK AND TYPE' IF A USER
 *    WANTS A VERY SPECIFIC AMOUNT... ALSO 2.5X SHOULD BE AN OPTION."
 *
 * WHAT WAS WRONG. The slider was `min={minRaise} max={maxRaise}
 * step={bigBlind || 1}`. An `<input type="range">` only ever emits
 * `min + n * step`, so on a 1/2 table with a min-raise of 12 the drag could
 * produce 12, 14, 16, 18 and NOTHING ELSE. Every amount between two blinds was
 * unreachable, which is precisely the snap Dan describes. The `+` / `-` nudges
 * had the same defect and were worse: they added a whole big blind and then
 * re-rounded, so from 13 the panel jumped to 15 and 14 could not be reached by
 * any control on the screen.
 *
 * WHY A FINER STEP IS LEGAL. The engine imposes no chip-granularity rule at
 * all. `validateAction` in server/src/engine/PokerEngine.ts checks
 * `raiseAmount >= minRaise` and `amount <= maxRaiseTo` (plus the pot-limit
 * ceiling), each with a half-cent tolerance, and nothing else. So any cent
 * value inside [minRaise, maxRaise] is accepted; the step is a usability
 * choice. It is the table's small blind - the smallest amount the table ever
 * forces onto the felt - and the type-in field covers what falls between two
 * steps.
 *
 * Sibling spec: actionpanel-slider-reaches-max.test.ts, which pins the OTHER
 * half of the grid problem - that the top stop must resolve to maxRaise.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ActionPanel, {
  betSliderStep,
  sliderUnitFor,
  sanitizeAmountDraft,
  MAX_SLIDER_POSITIONS,
} from '../src/components/table/ActionPanel';

/** 1/2 no-limit, hero facing an open to 10 with 200 behind. */
const base = {
  canFold: true,
  canCheck: false,
  canCall: true,
  canRaise: true,
  canAllIn: true,
  currentBet: 10,
  callAmount: 10,
  minRaise: 12,
  maxRaise: 200,
  pot: 30,
  bigBlind: 2,
  isMyTurn: true,
};

const openPanel = () => {
  const opener =
    screen.queryByLabelText('Open Bet Panel') ?? screen.getByLabelText('Open Raise Panel');
  fireEvent.click(opener);
};

const slider = () => screen.getByLabelText('Raise Amount') as HTMLInputElement;

/** The amount the panel is currently sized to, read off the editable field. */
const shownAmount = (): string =>
  screen.getByRole('button', { name: /^Edit Bet Amount/ }).textContent ?? '';

/**
 * The confirm button, whichever of its three labels it is wearing.
 *
 * The naive /^(Raise|Bet|All in) / also matched the ALL IN PRESET, whose label
 * is "Bet All In For 200" - two buttons, and getByRole throws. Requiring a
 * digit straight after the verb separates them: the confirm reads "Raise 15",
 * "Bet 15" or "All in for 200"; the preset never does.
 */
const confirmBtn = () =>
  screen.queryByRole('button', { name: /^(Raise|Bet) [\d.,]/ }) ??
  screen.getByRole('button', { name: /^All In For [\d.,]/ });

describe('betSliderStep - the step is one chip, never one big blind', () => {
  it('is the small blind on a 1/2 table, not the big blind', () => {
    // THE REGRESSION. A step of 2 here is the bug Dan reported.
    expect(betSliderStep(12, 200, 1)).toBe(1);
  });

  it('respects 0.25/0.50 stakes, the smallest the platform runs', () => {
    expect(betSliderStep(3, 63.25, 0.25)).toBe(0.25);
  });

  it('never returns zero, which would make the slider inert', () => {
    expect(betSliderStep(12, 200, 0)).toBeGreaterThan(0);
    expect(betSliderStep(12, 12, 1)).toBeGreaterThan(0);
  });

  it('keeps a coarsened step a whole number of chips', () => {
    // A 1.5K/3K tournament table with a 30,000,000 chip leader. One chip per
    // step would be 20,000 positions, so the step doubles - but ONLY doubles,
    // so it stays an amount the table can actually make.
    const step = betSliderStep(6000, 30_000_000, 1500);
    expect(step % 1500).toBe(0);
    expect((30_000_000 - 6000) / step).toBeLessThanOrEqual(MAX_SLIDER_POSITIONS);
  });

  it('leaves realistic cash ranges alone - coarsening is the exception', () => {
    const cases: Array<[number, number, number]> = [
      [12, 200, 1],
      [3, 63.25, 0.25],
      [60, 431, 5],
      [6000, 300_000, 1500],
    ];
    for (const [min, max, chip] of cases) {
      expect(betSliderStep(min, max, chip)).toBe(chip);
    }
  });
});

describe('the slider offers amounts between the blinds', () => {
  it('renders a step of one small blind, not one big blind', () => {
    render(<ActionPanel {...base} onAction={vi.fn()} />);
    openPanel();
    const el = slider();
    expect(el.step).toBe('1');
    expect(el.min).toBe('12');
    expect(el.max).toBe('200');
  });

  it('accepts an odd amount that the old whole-blind grid could not produce', () => {
    render(<ActionPanel {...base} onAction={vi.fn()} />);
    openPanel();
    fireEvent.change(slider(), { target: { value: '13' } });
    expect(shownAmount()).toBe('13');
  });

  it('commits that in-between amount to the server unchanged', () => {
    const onAction = vi.fn();
    render(<ActionPanel {...base} onAction={onAction} />);
    openPanel();
    fireEvent.change(slider(), { target: { value: '15' } });
    fireEvent.click(confirmBtn());
    expect(onAction).toHaveBeenCalledWith('raise', 15);
  });

  it('can still be dragged all the way to the all-in, off-grid ceiling and all', () => {
    // 187.50 is not 12 + n*1, so the browser's own maximum is 187. The panel
    // treats the top grid stop as maxRaise so the shove stays reachable.
    const onAction = vi.fn();
    render(<ActionPanel {...base} maxRaise={187.5} allInTo={187.5} onAction={onAction} />);
    openPanel();
    fireEvent.change(slider(), { target: { value: '187' } });
    fireEvent.click(confirmBtn());
    expect(onAction).toHaveBeenCalledWith('allin', 187.5);
  });

  it('a dollar-stakes CASH table steps by exactly one dollar (Dan 2026-08-26)', () => {
    /* Dan 2026-08-26: "in cash games it should go out by DOLLARS one at a
       time." This replaces the 2026-08-23 rule this test used to pin (step =
       the table's small blind): a 2/5 cash table now steps 1 at a time, not
       2 at a time. Tournaments keep the chip-scaled step - the case below. */
    render(<ActionPanel {...base} bigBlind={5} smallBlind={2} onAction={vi.fn()} />);
    openPanel();
    expect(slider().step).toBe('1');
  });

  it('a TOURNAMENT steps by the level chip unit, scaled with depth', () => {
    // A 1500/3000 level: the drag walks 1500-chip denominations, not dollars.
    render(
      <ActionPanel
        {...base}
        isTournament
        bigBlind={3000}
        smallBlind={1500}
        currentBet={3000}
        callAmount={3000}
        minRaise={6000}
        maxRaise={90000}
        allInTo={90000}
        onAction={vi.fn()}
      />
    );
    openPanel();
    expect(slider().step).toBe('1500');
  });

  it('nudges by one chip, not by one big blind', () => {
    render(<ActionPanel {...base} onAction={vi.fn()} />);
    openPanel();
    fireEvent.click(screen.getByLabelText('Increase By 1'));
    // Was 14 - one whole big blind - so 13 could not be reached at all.
    expect(shownAmount()).toBe('13');
    fireEvent.click(screen.getByLabelText('Decrease By 1'));
    expect(shownAmount()).toBe('12');
  });
});

describe('sliderUnitFor - dollars in cash, chip depth in tournaments', () => {
  it('cash at a dollar big blind or better walks whole dollars', () => {
    expect(sliderUnitFor(false, 2, 1)).toBe(1);
    expect(sliderUnitFor(false, 5, 2)).toBe(1); // 2/5: dollar steps, not 2-chip steps
    expect(sliderUnitFor(false, 1, 0.5)).toBe(1);
  });

  it('sub-dollar cash keeps the chip grid - a dollar step would leave two positions', () => {
    expect(sliderUnitFor(false, 0.1, 0.05)).toBe(0.05);
    expect(sliderUnitFor(false, 0.5, 0.25)).toBe(0.25);
  });

  it('tournaments scale with the level, whatever the number', () => {
    expect(sliderUnitFor(true, 200, 100)).toBe(100);
    expect(sliderUnitFor(true, 3000, 1500)).toBe(1500);
    expect(sliderUnitFor(true, 2, 1)).toBe(1);
  });

  it('never returns a unit of zero', () => {
    expect(sliderUnitFor(true, 0, 0)).toBeGreaterThan(0);
  });
});

describe('sanitizeAmountDraft - the typed field can only hold a number', () => {
  it('drops letters rather than letting Number() read an exponent', () => {
    // Number('12e5') is 1,200,000. On a bet box that is a silent shove.
    expect(sanitizeAmountDraft('12e5')).toBe('125');
    expect(sanitizeAmountDraft('abc')).toBe('');
  });

  it('keeps one decimal separator and normalises a comma', () => {
    expect(sanitizeAmountDraft('1.2.3')).toBe('1.23');
    expect(sanitizeAmountDraft('1,50')).toBe('1.50');
  });

  it('drops a sign, so a negative bet cannot be typed', () => {
    expect(sanitizeAmountDraft('-5')).toBe('5');
  });

  it('stops at two decimals, because the engine chips are whole cents', () => {
    expect(sanitizeAmountDraft('12.3456')).toBe('12.34');
  });
});

describe('click and type an exact amount', () => {
  const typeAmount = (text: string) => {
    fireEvent.click(screen.getByRole('button', { name: /^Edit Bet Amount/ }));
    const input = screen.getByLabelText(/^Type Exact Bet Amount/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };

  it('offers a decimal keypad on a phone', () => {
    render(<ActionPanel {...base} onAction={vi.fn()} />);
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: /^Edit Bet Amount/ }));
    expect(screen.getByLabelText(/^Type Exact Bet Amount/).getAttribute('inputmode')).toBe(
      'decimal'
    );
  });

  it('commits the typed amount EXACTLY, without snapping it to the slider step', () => {
    // The entire point of the field. Snapping 13.37 onto the 1-chip grid would
    // send 13, and then there would be no way to reach 13.37 at all.
    const onAction = vi.fn();
    render(<ActionPanel {...base} onAction={onAction} />);
    openPanel();
    typeAmount('13.37');
    fireEvent.click(confirmBtn());
    expect(onAction).toHaveBeenCalledWith('raise', 13.37);
  });

  it('caps an over-stack amount at the all-in rather than sending an illegal bet', () => {
    const onAction = vi.fn();
    render(<ActionPanel {...base} onAction={onAction} />);
    openPanel();
    typeAmount('9999');
    fireEvent.click(confirmBtn());
    expect(onAction).toHaveBeenCalledWith('allin', 200);
  });

  it('raises a below-minimum amount to the minimum legal raise', () => {
    const onAction = vi.fn();
    render(<ActionPanel {...base} onAction={onAction} />);
    openPanel();
    typeAmount('1');
    fireEvent.click(confirmBtn());
    expect(onAction).toHaveBeenCalledWith('raise', 12);
  });

  it('keeps the prior amount when the field is left unparseable', () => {
    render(<ActionPanel {...base} onAction={vi.fn()} />);
    openPanel();
    fireEvent.change(slider(), { target: { value: '40' } });
    typeAmount('abc');
    expect(shownAmount()).toBe('40');
  });

  it('escapes back to the prior amount without committing', () => {
    render(<ActionPanel {...base} onAction={vi.fn()} />);
    openPanel();
    fireEvent.change(slider(), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: /^Edit Bet Amount/ }));
    const input = screen.getByLabelText(/^Type Exact Bet Amount/);
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(shownAmount()).toBe('40');
  });

  it('does not fight the slider - a drag after a typed value wins and lands on the grid', () => {
    render(<ActionPanel {...base} onAction={vi.fn()} />);
    openPanel();
    typeAmount('13.37');
    expect(shownAmount()).toBe('13.37');
    fireEvent.change(slider(), { target: { value: '20' } });
    expect(shownAmount()).toBe('20');
  });
});

describe('a preset amount reaches the server exactly as labelled', () => {
  it('sends 2.5X of the bet faced, fraction and all', () => {
    // 5/10, facing an open to 15: 2.5X is 37.50. The chip grid is 5, and
    // re-snapping the preset on the way out used to turn this into 40.
    const onAction = vi.fn();
    render(
      <ActionPanel
        {...base}
        bigBlind={10}
        smallBlind={5}
        currentBet={15}
        callAmount={15}
        minRaise={30}
        maxRaise={500}
        allInTo={500}
        isPreflop
        onAction={onAction}
      />
    );
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: /^2\.5X\b/ }));
    fireEvent.click(confirmBtn());
    expect(onAction).toHaveBeenCalledWith('raise', 37.5);
  });
});
