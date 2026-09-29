import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WheelSegment, WheelSpinResult } from '../../src/services/DiamondWheelService';
import {
  UPGRADE_SPIN_INSTRUCTION,
  WheelExperience,
  wheelPrizeTitle,
} from '../../src/components/wheel/WheelExperience';

/* The mock wheel lands only while it is told to spin, so a ring that starts
   by itself would show up as an enabled Land Bonus Wheel button. */
vi.mock('../../src/components/wheel/DiamondWheel', () => ({
  default: ({
    upgraded,
    spinning,
    onLanded,
  }: {
    upgraded: boolean;
    spinning: boolean;
    onLanded: () => void;
  }) => (
    <button disabled={!spinning} onClick={onLanded}>
      {upgraded ? 'Land Bonus Wheel' : 'Land Main Wheel'}
    </button>
  ),
}));
afterEach(() => vi.useRealTimers());
vi.mock('../../src/components/common/Modal', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));
const outcome = (kind: string, game?: string) => ({
  ord: 1,
  label: kind,
  kind,
  game,
  amount: 100,
  value_chips: 1,
});
const upgradeToMines = () =>
  ({
    outcome: outcome('upgrade'),
    secondary: {
      outcome: { ...outcome('bonus', 'mines'), multiplier: 2 },
      segments: [{ ...outcome('bonus', 'mines'), multiplier: 2 }],
    },
  }) as unknown as WheelSpinResult;
const finishReveal = () =>
  fireEvent.animationEnd(screen.getByRole('dialog').querySelector('[data-motion="keep"]')!);

describe('wheel to prize to earned game', () => {
  it.each([
    ['plinko', 'Super Plinko'],
    ['crash', 'Super Crash'],
    ['crossing', 'Super Donkey Cross'],
    ['mines', 'Super Diamond Mines'],
  ])('keeps the awarded %s upgrade in its prize title', (game, title) => {
    expect(
      wheelPrizeTitle({ ...outcome('bonus', game), multiplier: 2 } as WheelSpinResult['outcome'])
    ).toBe(title);
  });
  it('shows the eight-option upper wheel before any entry is spent', () => {
    render(
      <WheelExperience
        segments={[]}
        upgradeSegments={
          Array.from({ length: 8 }, (_, i) => ({
            ...outcome('chips'),
            ord: i + 1,
          })) as WheelSegment[]
        }
        receipt={null}
        spinKey={0}
        spinning={false}
        onFinished={vi.fn()}
        size={500}
      />
    );
    expect(screen.getByRole('group', { name: 'Diamond Spins Prize Wheel' })).toHaveAttribute(
      'data-wheel-assembly',
      'concentric'
    );
    expect(screen.getByRole('button', { name: 'Land Bonus Wheel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Land Main Wheel' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Diamond Spins Prize Wheel' })).toHaveAttribute(
      'data-upgrade-reveal',
      'peek'
    );
  });
  it('opens an upgraded instant chip prize and waits for acknowledgement without entering a game', () => {
    const onFinished = vi.fn();
    const receipt = {
      outcome: outcome('upgrade'),
      secondary: { outcome: { ...outcome('chips'), amount: 2500 }, segments: [outcome('chips')] },
    } as unknown as WheelSpinResult;
    render(
      <WheelExperience
        segments={[]}
        receipt={receipt}
        spinKey={1}
        spinning
        onFinished={onFinished}
        size={500}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Land Main Wheel' }));
    finishReveal();
    fireEvent.click(screen.getByRole('button', { name: 'Open Upgrade Wheel' }));
    fireEvent.keyDown(screen.getByRole('button', { name: UPGRADE_SPIN_INSTRUCTION }), {
      key: 'Enter',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Land Bonus Wheel' }));
    expect(screen.getByRole('heading', { name: '2,500 Chips' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    finishReveal();
    expect(onFinished).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  /* Owner ruling 2026-09-21, R19: the upgrade ring never spins by itself. It
     waits under a flashing instruction for a swipe or a tap on the wheel, or
     Enter or Space from the keyboard, and R9: the won game then waits for
     Play Game. Both pins moved here from the auto-advancing versions. */
  it('waits for the player to swipe the upgrade ring, then for Play Game, before opening the game', () => {
    vi.useFakeTimers();
    const onFinished = vi.fn();
    render(
      <WheelExperience
        segments={[]}
        receipt={upgradeToMines()}
        spinKey={1}
        spinning
        onFinished={onFinished}
        size={500}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Land Main Wheel' }));
    expect(screen.getByRole('heading', { name: 'Bonus Upgrade' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Diamond Spins Prize Wheel' })).toHaveAttribute(
      'data-upgrade-reveal',
      'open'
    );
    expect(onFinished).not.toHaveBeenCalled();
    finishReveal();
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Upgrade Wheel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const stage = screen.getByRole('button', { name: UPGRADE_SPIN_INSTRUCTION });
    expect(stage).toHaveAttribute('tabindex', '0');
    expect(stage).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent(UPGRADE_SPIN_INSTRUCTION);
    expect(screen.getByRole('button', { name: 'Land Bonus Wheel' })).toBeDisabled();
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(screen.getByRole('button', { name: 'Land Bonus Wheel' })).toBeDisabled();
    // A pointer that only hovers, or moves less than a swipe, starts nothing.
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 44, clientY: 42 });
    expect(screen.getByRole('button', { name: 'Land Bonus Wheel' })).toBeDisabled();
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 80, clientY: 42 });
    expect(screen.getByRole('button', { name: 'Land Bonus Wheel' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: UPGRADE_SPIN_INSTRUCTION })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Land Bonus Wheel' }));
    expect(screen.getByRole('heading', { name: 'Super Diamond Mines' })).toBeInTheDocument();
    expect(onFinished).not.toHaveBeenCalled();
    finishReveal();
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(onFinished).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Play Game' }));
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('a tap on the ring, or Space, starts the upgrade spin; a cancelled pointer does not', () => {
    const tap = render(
      <WheelExperience
        segments={[]}
        receipt={upgradeToMines()}
        spinKey={1}
        spinning
        onFinished={vi.fn()}
        size={500}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Land Main Wheel' }));
    finishReveal();
    fireEvent.click(screen.getByRole('button', { name: 'Open Upgrade Wheel' }));
    let stage = screen.getByRole('button', { name: UPGRADE_SPIN_INSTRUCTION });
    fireEvent.pointerDown(stage, { pointerId: 7, clientX: 10, clientY: 10 });
    fireEvent.pointerCancel(stage, { pointerId: 7 });
    fireEvent.pointerUp(stage, { pointerId: 7, clientX: 10, clientY: 10 });
    expect(screen.getByRole('button', { name: 'Land Bonus Wheel' })).toBeDisabled();
    fireEvent.pointerDown(stage, { pointerId: 8, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(stage, { pointerId: 8, clientX: 12, clientY: 11 });
    expect(screen.getByRole('button', { name: 'Land Bonus Wheel' })).toBeEnabled();
    tap.unmount();

    render(
      <WheelExperience
        segments={[]}
        receipt={upgradeToMines()}
        spinKey={1}
        spinning
        onFinished={vi.fn()}
        size={500}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Land Main Wheel' }));
    finishReveal();
    fireEvent.click(screen.getByRole('button', { name: 'Open Upgrade Wheel' }));
    stage = screen.getByRole('button', { name: UPGRADE_SPIN_INSTRUCTION });
    fireEvent.keyDown(stage, { key: 'a' });
    expect(screen.getByRole('button', { name: 'Land Bonus Wheel' })).toBeDisabled();
    fireEvent.keyDown(stage, { key: ' ' });
    expect(screen.getByRole('button', { name: 'Land Bonus Wheel' })).toBeEnabled();
  });
  it('a fresh mount with an unrevealed upgrade replays into the waiting phase, never past it', () => {
    // The page's refresh recovery resubmits the same receipt and replays it:
    // the ring must wait for the gesture again rather than reveal its result.
    const onFinished = vi.fn();
    render(
      <WheelExperience
        segments={[]}
        receipt={upgradeToMines()}
        spinKey={3}
        spinning
        onFinished={onFinished}
        size={500}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Land Main Wheel' }));
    finishReveal();
    fireEvent.click(screen.getByRole('button', { name: 'Open Upgrade Wheel' }));
    expect(screen.getByRole('button', { name: UPGRADE_SPIN_INSTRUCTION })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Land Bonus Wheel' })).toBeDisabled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onFinished).not.toHaveBeenCalled();
  });
  it('opens a normal bonus only when Play Game is tapped after one complete wheel and reveal', () => {
    vi.useFakeTimers();
    const onFinished = vi.fn();
    render(
      <WheelExperience
        segments={[] as WheelSegment[]}
        receipt={{ outcome: outcome('bonus', 'crossing') } as unknown as WheelSpinResult}
        spinKey={2}
        spinning
        onFinished={onFinished}
        size={500}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Land Main Wheel' }));
    expect(screen.getByRole('heading', { name: 'Donkey Cross' })).toBeInTheDocument();
    expect(onFinished).not.toHaveBeenCalled();
    finishReveal();
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(onFinished).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Play Game' }));
    expect(onFinished).toHaveBeenCalledTimes(1);
  });
  it('a new spinKey starts the next spin at the main wheel without a remount', () => {
    const onFinished = vi.fn();
    const view = render(
      <WheelExperience
        segments={[]}
        receipt={{ outcome: outcome('chips') } as unknown as WheelSpinResult}
        spinKey={1}
        spinning
        onFinished={onFinished}
        size={500}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Land Main Wheel' }));
    finishReveal();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onFinished).toHaveBeenCalledTimes(1);
    view.rerender(
      <WheelExperience
        segments={[]}
        receipt={{ outcome: outcome('chips') } as unknown as WheelSpinResult}
        spinKey={2}
        spinning
        onFinished={onFinished}
        size={500}
      />
    );
    expect(screen.getByRole('button', { name: 'Land Main Wheel' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Land Main Wheel' }));
    expect(screen.getByRole('heading', { name: '100 Chips' })).toBeInTheDocument();
  });
});

describe('a run the player started lands its spins on the tally', () => {
  it('finishes an instant prize and a bonus game without a reveal, in run mode', () => {
    const onFinished = vi.fn();
    const view = render(
      <WheelExperience
        segments={[]}
        receipt={{ outcome: outcome('chips') } as unknown as WheelSpinResult}
        spinKey={1}
        spinning
        runMode
        onFinished={onFinished}
        size={500}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Land Main Wheel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onFinished).toHaveBeenCalledTimes(1);
    view.rerender(
      <WheelExperience
        segments={[]}
        receipt={{ outcome: outcome('bonus', 'plinko') } as unknown as WheelSpinResult}
        spinKey={2}
        spinning
        runMode
        onFinished={onFinished}
        size={500}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Land Main Wheel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onFinished).toHaveBeenCalledTimes(2);
  });
  it('still waits for the gesture on an upgrade inside a run', () => {
    vi.useFakeTimers();
    const onFinished = vi.fn();
    render(
      <WheelExperience
        segments={[]}
        receipt={upgradeToMines()}
        spinKey={1}
        spinning
        runMode
        onFinished={onFinished}
        size={500}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Land Main Wheel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const stage = screen.getByRole('button', { name: UPGRADE_SPIN_INSTRUCTION });
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(screen.getByRole('button', { name: 'Land Bonus Wheel' })).toBeDisabled();
    expect(onFinished).not.toHaveBeenCalled();
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Land Bonus Wheel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onFinished).toHaveBeenCalledTimes(1);
  });
});
