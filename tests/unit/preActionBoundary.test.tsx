import React, { useCallback, useEffect, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import PreActionBar from '../../src/components/table/PreActionBar';
import {
  usePreActionBoundary,
  acceptedActionSpendsPreAction,
  latestHeroActionTimestamp,
} from '../../src/hooks/usePreActionBoundary';
import { PreActionEngine } from '../../server/src/engine/PreActionEngine';

function Harness({
  label,
  hand = 20,
  stage = 'flop',
  engine,
}: {
  label: string | null;
  hand?: number;
  stage?: string;
  engine: PreActionEngine;
}) {
  const [choice, setChoice] = useState<'call' | 'callAny' | null>(null);
  const clear = useCallback(() => setChoice(null), []);
  usePreActionBoundary(hand, stage, true, clear);
  useEffect(() => {
    if (choice)
      engine.setPreAction(
        'table',
        'hero',
        choice === 'call' ? 'auto_call' : 'auto_call_any',
        choice === 'call' ? 50 : undefined,
        50
      );
    else engine.clearPreAction('table', 'hero');
  }, [choice, engine]);
  return (
    <>
      <span>{label}</span>
      <PreActionBar
        canCheck={false}
        isMyTurn={false}
        currentBet={50}
        preAction={choice}
        onPreActionChange={setChoice as any}
      />
    </>
  );
}
describe('a call pre-action is spent by an accepted action, not a display label', () => {
  it.each(['Call 50', 'Call Any'])(
    '%s survives a same-street snapshot label change and executes once',
    async (name) => {
      const engine = new PreActionEngine();
      const { rerender } = render(<Harness label={null} engine={engine} />);
      fireEvent.click(screen.getByRole('button', { name }));
      rerender(<Harness label="call" engine={engine} />);
      expect(screen.getByRole('button', { name }).getAttribute('aria-pressed')).toBe('true');
      const result = engine.executePreAction('table', 'hero', false, 50, 1000);
      expect(result).toMatchObject({ executed: true, action: 'call', amount: 50 });
      expect(engine.executePreAction('table', 'hero', false, 50, 1000).executed).toBe(false);
    }
  );
  it('still clears at the next hand or street', () => {
    const engine = new PreActionEngine();
    const { rerender } = render(<Harness label={null} engine={engine} />);
    fireEvent.click(screen.getByRole('button', { name: 'Call Any' }));
    rerender(<Harness label={null} stage="turn" engine={engine} />);
    expect(engine.getPreAction('table', 'hero')).toBeNull();
  });
  it('uses the last server action as the arm boundary even when browser clocks disagree', () => {
    const known = latestHeroActionTimestamp(
      [
        { seat: 9, timestamp: 500 },
        { seat: 8, timestamp: 2000 },
        { seat: 9, timestamp: 1000 },
      ],
      9
    );
    expect(known).toBe(1000);
    // The client clock could be hours ahead; the new server action still spends it.
    expect(
      acceptedActionSpendsPreAction({
        heroSeat: 9,
        handNumber: 20,
        knownHeroActionAtArm: known,
        event: { seat: 9, hand_number: 20, timestamp: 1001 },
      })
    ).toBe(true);
    expect(
      acceptedActionSpendsPreAction({
        heroSeat: 9,
        handNumber: 20,
        knownHeroActionAtArm: known,
        event: { seat: 9, hand_number: 20, timestamp: 1000 },
      })
    ).toBe(false);
  });
  it('does not let a previous hand, an old hero echo, or another seat cancel a later tap', () => {
    const base = { heroSeat: 9, handNumber: 20, knownHeroActionAtArm: 1000 };
    expect(
      acceptedActionSpendsPreAction({
        ...base,
        event: { seat: 8, hand_number: 20, timestamp: 1100 },
      })
    ).toBe(false);
    expect(
      acceptedActionSpendsPreAction({
        ...base,
        event: { seat: 9, hand_number: 19, timestamp: 1100 },
      })
    ).toBe(false);
    expect(
      acceptedActionSpendsPreAction({
        ...base,
        event: { seat: 9, hand_number: 20, timestamp: 900 },
      })
    ).toBe(false);
    expect(
      acceptedActionSpendsPreAction({
        ...base,
        event: { seat: 9, hand_number: 20, timestamp: 1100 },
      })
    ).toBe(true);
  });
});
