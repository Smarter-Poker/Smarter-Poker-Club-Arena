/**
 * EVERY DIAMOND GAME TAP IS FELT UNDER THE FINGER (2026-09-26).
 *
 * A phone allows a buzz inside a tap, and an iPhone browser only under the
 * finger itself. So the tap targets of the Diamond games ask for their buzz in
 * their own click handler, and on an iPhone browser carry the TapHaptic switch
 * that is the buzz there.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const haptics = vi.hoisted(() => ({ triggerHaptic: vi.fn() }));
vi.mock('../../src/services/HapticService', () => haptics);
vi.mock('../../src/services/SoundService', () => ({
  soundService: new Proxy({}, { get: () => () => {} }),
}));
import MinesGrid from '../../src/components/games/MinesGrid';
import { GameConsole } from '../../src/components/games/GameConsole';
import { WheelCabinet } from '../../src/components/wheel/WheelCabinet';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const board = (extra: Partial<Parameters<typeof MinesGrid>[0]> = {}) => (
  <MinesGrid
    roundId="mines"
    picked={[]}
    mines={null}
    phase="open"
    busy={false}
    onPick={() => {}}
    prizes={[1.2, 1.5, 2]}
    betChips={1}
    {...extra}
  />
);

describe('Diamond Mines', () => {
  it('buzzes the pick inside the tap, then picks', () => {
    const onPick = vi.fn();
    render(board({ onPick }));
    fireEvent.click(screen.getByRole('button', { name: 'Tile 7' }));
    expect(haptics.triggerHaptic).toHaveBeenCalledExactlyOnceWith('selection');
    expect(onPick).toHaveBeenCalledWith(6);
    expect(haptics.triggerHaptic.mock.invocationCallOrder[0]).toBeLessThan(
      onPick.mock.invocationCallOrder[0]
    );
  });

  it('does not buzz a refused tap', () => {
    const onPick = vi.fn();
    render(board({ onPick, busy: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Tile 7' }));
    expect(haptics.triggerHaptic).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('puts the switch on every live tile on an iPhone browser, and none on a finished board', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE, maxTouchPoints: 5 });
    const { container } = render(board());
    expect(container.querySelectorAll('input[data-tap-haptic]').length).toBe(
      screen.getAllByRole('button', { name: /^Tile \d+$/ }).length
    );
    cleanup();
    const done = render(board({ phase: 'lost', picked: [3], mines: [3, 9] }));
    expect(done.container.querySelectorAll('input[data-tap-haptic]')).toHaveLength(0);
  });
});

describe('the console plates', () => {
  it('carry the switch on an iPhone browser, and never on a disabled or pending plate', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE, maxTouchPoints: 5 });
    const onClick = vi.fn();
    render(
      <GameConsole
        title="Diamond Plinko"
        bays={[{ label: 'Stake', value: '25', onPress: () => {} }]}
        secondary={{ label: 'Refresh', onClick: () => {}, disabled: true }}
        primary={{ label: 'Drop Diamonds', onClick }}
      />
    );
    const drop = screen.getByRole('button', { name: 'Drop Diamonds' });
    const input = drop.querySelector('input[data-tap-haptic]')!;
    expect(input).not.toBeNull();
    fireEvent.click(input);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Refresh' }).querySelector('input')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Change Stake' }).querySelector('input')
    ).not.toBeNull();
    cleanup();
    render(
      <GameConsole
        title="Diamond Plinko"
        bays={[]}
        primary={{ label: 'Dropping', onClick, 'aria-disabled': true }}
      />
    );
    expect(screen.getByRole('button', { name: 'Dropping' }).querySelector('input')).toBeNull();
  });

  it("the wheel's own plates carry it too", () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE, maxTouchPoints: 5 });
    const spin = vi.fn();
    render(
      <WheelCabinet
        {...({
          title: 'Diamond Spins',
          bays: [],
          primary: { label: 'Spin', onClick: spin },
          secondary: { label: 'Auto', onClick: () => {}, disabled: true },
          children: null,
        } as unknown as Parameters<typeof WheelCabinet>[0])}
      />
    );
    const button = screen.getByRole('button', { name: 'Spin' });
    fireEvent.click(button.querySelector('input[data-tap-haptic]')!);
    expect(spin).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Auto' }).querySelector('input')).toBeNull();
  });
});
