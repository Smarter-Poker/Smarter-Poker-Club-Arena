/**
 * THE TABLE'S COMMITTING TAPS BUZZ ON AN iPHONE BROWSER TOO (2026-09-26).
 * Pre-actions and the shared console plate (Insure, Cash Out) carry the
 * TapHaptic switch there; a tap on it still reaches the control.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import PreActionBar from '../../src/components/table/PreActionBar';
import { PlateButton } from '../../src/components/console/SpadeConsole';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the pre-action bar', () => {
  it('puts the switch on every pre-action on an iPhone browser, and a tap on it arms the action', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE, maxTouchPoints: 5 });
    const onPreActionChange = vi.fn();
    render(
      <PreActionBar
        canCheck
        isMyTurn={false}
        preAction={null}
        onPreActionChange={onPreActionChange}
        currentBet={0}
      />
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(1);
    for (const b of buttons) expect(b.querySelector('input[data-tap-haptic]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Check$/ }).querySelector('input')!);
    expect(onPreActionChange).toHaveBeenCalledWith('check');
  });

  it('draws no switch off an iPhone', () => {
    render(
      <PreActionBar canCheck isMyTurn={false} preAction={null} onPreActionChange={() => {}} />
    );
    expect(document.querySelector('input[data-tap-haptic]')).toBeNull();
  });
});

describe('the console plate', () => {
  it('carries the switch only when asked, never on a disabled plate, and never leaks the prop to the DOM', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE, maxTouchPoints: 5 });
    const onClick = vi.fn();
    const zone = { x: 0, y: 0, w: 100, h: 40 };
    render(
      <>
        <PlateButton zone={zone as never} canvasH={40} label="Insure" haptic onClick={onClick} />
        <PlateButton zone={zone as never} canvasH={40} label="No" onClick={() => {}} />
        <PlateButton zone={zone as never} canvasH={40} label="Cash Out" haptic disabled />
      </>
    );
    const insure = screen.getByRole('button', { name: 'Insure' });
    expect(insure).not.toHaveAttribute('haptic');
    fireEvent.click(insure.querySelector('input[data-tap-haptic]')!);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'No' }).querySelector('input')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cash Out' }).querySelector('input')).toBeNull();
  });
});
