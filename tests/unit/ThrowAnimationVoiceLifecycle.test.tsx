import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ThrowAnimation } from '../../src/components/table/ThrowAnimation';
import type { ThrowEvent } from '../../src/services/ThrowableService';
const state = vi.hoisted(() => ({ cancel: vi.fn(), speak: vi.fn(), speed: 1 }));
vi.mock('../../src/services/ThrowableVoice', () => ({
  throwableVoice: {
    speakFor: (...args: unknown[]) => {
      state.speak(...args);
      return state.cancel;
    },
  },
}));
vi.mock('../../src/services/ThrowableSoundService', () => ({
  throwableSoundService: { playLaunch: vi.fn(), playFlight: vi.fn(), playImpact: vi.fn() },
}));
vi.mock('../../src/services/SoundService', () => ({
  soundService: { playKnockoutFlurry: vi.fn() },
}));
vi.mock('../../src/components/table/ThrowableImage', () => ({ ThrowableImage: () => <span /> }));
vi.mock('../../src/components/table/SeatKnockout', () => ({ KnockoutFlurry: () => null }));
vi.mock('../../src/components/table/ThrowablePlayer', () => ({ ThrowablePlayer: () => null }));
vi.mock('../../src/throwables/registry', () => ({ riggedThrowable: () => undefined }));
vi.mock('../../src/utils/animationSpeed', () => ({ getAnimationSpeed: () => state.speed }));
const event: ThrowEvent = {
  id: 'voice-test',
  fromSeat: 1,
  toSeat: 2,
  throwableId: 'anvil',
  timestamp: 0,
  throwable: {
    id: 'anvil',
    name: 'Anvil',
    category: 'throws',
    physics: 'arc',
    impact: 'thud',
    sound: 'anvil',
    weight: 'light',
    linger: false,
    color: '#999',
    spin: 0,
  },
};
const positions = new Map([
  [1, { x: 100, y: 100 }],
  [2, { x: 300, y: 100 }],
]);
beforeEach(() => {
  state.speed = 1;
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('cancels the landed throw voice when its component leaves the table', () => {
  const view = render(
    <ThrowAnimation event={event} seatPositions={positions} onComplete={vi.fn()} />
  );
  act(() => vi.advanceTimersByTime(840));
  expect(state.speak).toHaveBeenCalledWith('anvil');
  view.unmount();
  expect(state.cancel).toHaveBeenCalledOnce();
});
it('never starts a voice for a throw removed before landing', () => {
  const view = render(
    <ThrowAnimation event={event} seatPositions={positions} onComplete={vi.fn()} />
  );
  view.unmount();
  act(() => vi.runAllTimers());
  expect(state.speak).not.toHaveBeenCalled();
});
it('keeps legacy CSS and impact on the starting speed after a setting change', () => {
  state.speed = 2;
  const view = render(
    <ThrowAnimation event={event} seatPositions={positions} onComplete={vi.fn()} />
  );
  state.speed = 0.5;
  view.rerender(<ThrowAnimation event={event} seatPositions={positions} onComplete={vi.fn()} />);
  expect(
    view.container
      .querySelector<HTMLElement>('.throw-animation')
      ?.style.getPropertyValue('--animation-speed')
  ).toBe('2');
  act(() => vi.advanceTimersByTime(1679));
  expect(state.speak).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(state.speak).toHaveBeenCalledWith('anvil');
});
