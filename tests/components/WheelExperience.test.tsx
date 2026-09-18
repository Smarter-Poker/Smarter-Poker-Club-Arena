import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WheelSegment, WheelSpinResult } from '../../src/services/DiamondWheelService';
import { WheelExperience } from '../../src/components/wheel/WheelExperience';

vi.mock('../../src/components/wheel/DiamondWheel', () => ({
  default: ({ upgraded, onLanded }: { upgraded: boolean; onLanded: () => void }) => (
    <button onClick={onLanded}>{upgraded ? 'Land Bonus Wheel' : 'Land Main Wheel'}</button>
  ),
}));
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
const finishReveal = () =>
  fireEvent.animationEnd(screen.getByRole('dialog').querySelector('[data-motion="keep"]')!);

describe('wheel to prize to earned game', () => {
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

  it('completes both wheels and both reveals before opening an upgraded game once', () => {
    const onFinished = vi.fn();
    const receipt = {
      outcome: outcome('upgrade'),
      secondary: {
        outcome: outcome('bonus', 'mines'),
        segments: [{ ...outcome('bonus', 'mines') }],
      },
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
    expect(screen.getByRole('heading', { name: 'Bonus Upgrade' })).toBeInTheDocument();
    expect(onFinished).not.toHaveBeenCalled();
    finishReveal();
    fireEvent.click(screen.getByRole('button', { name: 'Land Bonus Wheel' }));
    expect(screen.getByRole('heading', { name: 'Diamond Mines' })).toBeInTheDocument();
    expect(onFinished).not.toHaveBeenCalled();
    finishReveal();
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('opens a normal bonus after one complete wheel and reveal', () => {
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
    expect(onFinished).toHaveBeenCalledTimes(1);
  });
});
