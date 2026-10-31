import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PotDisplay from '../src/components/table/PotDisplay';
import ActionPanel from '../src/components/table/ActionPanel';
import { displayBigBlind } from '../src/utils/handBlinds';

const action = {
  canFold: true,
  canCheck: false,
  canCall: true,
  canRaise: false,
  canAllIn: true,
  currentBet: 1200,
  callAmount: 1200,
  minRaise: 2400,
  maxRaise: 4800,
  allInTo: 4800,
  pot: 2400,
  bigBlind: 1200,
  isMyTurn: true,
};

describe('missing hand denomination uses one explicit chip display', () => {
  it('labels the pot CHIPS and preserves canonical chip actions while BB is unavailable', () => {
    const preference = true;
    const bb = displayBigBlind(null, 'table-a', 12, true, 1000);
    const effectiveBB = preference && bb > 0;
    const onAction = vi.fn();
    const { container } = render(
      <>
        <PotDisplay
          mainPot={2400}
          displayMode={effectiveBB ? 'bb' : 'chips'}
          bigBlind={bb}
          showChipsFallbackLabel={preference && !effectiveBB}
        />
        <ActionPanel
          {...action}
          showStackInBB={effectiveBB}
          displayBigBlind={bb}
          onAction={onAction}
        />
      </>
    );
    expect(screen.getByText('CHIPS')).toBeTruthy();
    expect(container.querySelector('.pot-display__amount')?.textContent).toBe('2,400');
    expect(container.textContent).not.toMatch(/\d\s*BB/);
    expect(screen.getByLabelText('All In').textContent).toContain('4,800');
    fireEvent.click(screen.getByLabelText('All In'));
    expect(onAction).toHaveBeenCalledWith('allin', 4800);
    expect(preference).toBe(true);
  });
});
