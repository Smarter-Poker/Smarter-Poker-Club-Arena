import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import SeatSlot from '../../src/components/table/SeatSlot';

const player = {
  id: 'energy-seat',
  name: 'Player',
  stack: 100,
  status: 'active' as const,
  showCards: false,
  isHero: true,
};
describe('live-table countdown energy', () => {
  it('uses compositor wipes instead of an inherited per-frame gradient clock', () => {
    const now = Date.now();
    const { container, rerender } = render(
      <SeatSlot
        seatNumber={1}
        player={player}
        position={'BTN' as never}
        isActive
        lastAction={null as never}
        turnStartTimeMs={now}
        turnDeadlineMs={now + 15000}
      />
    );
    const info = container.querySelector('.seat__info')!;
    expect(info.querySelectorAll('.seat__timer-wipe')).toHaveLength(5);
    expect(info.querySelectorAll('.seat__timer-ink')).toHaveLength(5);
    expect(info.querySelector('.seat__timer-ring')?.getAttribute('aria-hidden')).toBe('true');
    rerender(
      <SeatSlot
        seatNumber={1}
        player={player}
        position={'BTN' as never}
        isActive={false}
        lastAction={null as never}
      />
    );
    expect(container.querySelector('.seat__timer-ring')).toBeNull();
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
it('the repeating pot shine never animates layout', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/components/table/PotDisplay.css'), 'utf8');
  const a = css.indexOf('@keyframes pdGlassSweep'),
    b = css.indexOf('\n}', a) + 2;
  const frames = css.slice(a, b);
  expect(frames).not.toMatch(/\bleft\s*:/);
  expect(frames).toMatch(/translateX\(-200%\)/);
  expect(frames).toMatch(/translateX\(400%\)/);
  expect(css).toContain('animation: pdGlassSweep 8s ease-in-out infinite');
});
it('the on-turn avatar scan moves cached pixels rather than its masked background', () => {
  const css = readFileSync(
    resolve(process.cwd(), 'src/components/table/avatarChoreography.css'),
    'utf8'
  );
  const start = css.indexOf('@keyframes spAvatarHolo'),
    end = css.indexOf('\n}', start) + 2;
  const frames = css.slice(start, end);
  expect(frames).not.toMatch(/background-position\s*:/);
  expect(frames).toMatch(/translateY\(480%\)/);
  expect(css).toContain('mask-image: var(--sp-avatar-src)');
});

import { act } from '@testing-library/react';
import { ActionTimerRing } from '../../src/components/table/ActionTimerRing';
it('rejoins the authoritative clock after Safari hides and restores the page', () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const { container, unmount } = render(
    <ActionTimerRing
      timing={{ '--sp-timer-duration': '15s', '--sp-timer-delay': '-2s' } as React.CSSProperties}
    />
  );
  const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  try {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    vi.setSystemTime(105000);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(
      container
        .querySelector<HTMLElement>('.seat__timer-sector')
        ?.style.getPropertyValue('--sp-segment-delay')
    ).toBe('-7s');
  } finally {
    unmount();
    if (original) Object.defineProperty(document, 'visibilityState', original);
    else delete (document as any).visibilityState;
    vi.useRealTimers();
  }
});
