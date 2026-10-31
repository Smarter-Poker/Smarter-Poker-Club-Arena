// Rendered component regression only, never real engine/database acceptance.
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import ActionPanel from '../src/components/table/ActionPanel';
import { submitLegalAllInThroughUI } from '../operations/release/fixture/representative/player-browser-input.mjs';

const base = {
  canFold: true,
  canCheck: false,
  canCall: true,
  canRaise: true,
  canAllIn: true,
  currentBet: 10,
  callAmount: 10,
  minRaise: 20,
  maxRaise: 500,
  pot: 40,
  bigBlind: 2,
  isMyTurn: true,
};
// Only locator transport is adapted to this real rendered component. The
// product's conditional controls, disabled states and handlers are unchanged.
function componentPage(container: HTMLElement) {
  return {
    locator: (selector: string) => ({
      isVisible: async () => {
        const el = container.querySelector(selector);
        return !!el && !el.hasAttribute('hidden') && getComputedStyle(el).display !== 'none';
      },
      isEnabled: async () => {
        const el = container.querySelector(selector) as HTMLButtonElement | null;
        return !!el && !el.disabled;
      },
      click: async () => {
        const el = container.querySelector(selector);
        expect(el).toBeTruthy();
        await act(async () => {
          fireEvent.click(el!);
        });
      },
    }),
  };
}
describe('isolated NLH player browser input uses actual rendered ActionPanel paths', () => {
  it('opens normal Raise then submits its immediate All In preset', async () => {
    const onAction = vi.fn(),
      { container } = render(<ActionPanel {...base} onAction={onAction} />);
    expect(container.querySelector('.action-btn--allin')).toBeNull();
    expect(
      await submitLegalAllInThroughUI({ page: componentPage(container), isCurrentTurn: () => true })
    ).toBe(true);
    expect(onAction).toHaveBeenCalledExactlyOnceWith('allin', 500);
  });
  it('retains the short-stack direct All In path', async () => {
    const onAction = vi.fn(),
      { container } = render(<ActionPanel {...base} canRaise={false} onAction={onAction} />);
    expect(
      await submitLegalAllInThroughUI({ page: componentPage(container), isCurrentTurn: () => true })
    ).toBe(true);
    expect(onAction).toHaveBeenCalledExactlyOnceWith('allin', 500);
  });
  it('refuses a disabled shove, closes its overlay and submits a legal Call', async () => {
    const onAction = vi.fn(),
      { container } = render(<ActionPanel {...base} canAllIn={false} onAction={onAction} />);
    expect(
      await submitLegalAllInThroughUI({ page: componentPage(container), isCurrentTurn: () => true })
    ).toBe(true);
    expect(onAction).toHaveBeenCalledExactlyOnceWith('call');
  });
  it('uses the real action Check rather than a preaction toggle', async () => {
    const onAction = vi.fn(),
      preaction = vi.fn(),
      { container } = render(
        <>
          <button onClick={preaction}>Check</button>
          <ActionPanel
            {...base}
            canRaise={false}
            canAllIn={false}
            canCall={false}
            canCheck
            onAction={onAction}
          />
        </>
      );
    expect(
      await submitLegalAllInThroughUI({ page: componentPage(container), isCurrentTurn: () => true })
    ).toBe(true);
    expect(onAction).toHaveBeenCalledExactlyOnceWith('check');
    expect(preaction).not.toHaveBeenCalled();
  });
  it('does not count merely opening a panel after the turn changes', async () => {
    const onAction = vi.fn(),
      { container } = render(<ActionPanel {...base} onAction={onAction} />);
    expect(
      await submitLegalAllInThroughUI({
        page: componentPage(container),
        isCurrentTurn: () => !container.querySelector('.raise-preset--allin'),
      })
    ).toBe(false);
    expect(onAction).not.toHaveBeenCalled();
  });
  it('returns false when no legal enabled action exists', async () => {
    const onAction = vi.fn(),
      { container } = render(
        <ActionPanel
          {...base}
          canRaise={false}
          canAllIn={false}
          canCall={false}
          canCheck={false}
          onAction={onAction}
        />
      );
    expect(
      await submitLegalAllInThroughUI({ page: componentPage(container), isCurrentTurn: () => true })
    ).toBe(false);
    expect(onAction).not.toHaveBeenCalled();
  });
});
