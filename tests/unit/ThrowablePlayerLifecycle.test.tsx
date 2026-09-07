import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ThrowablePlayer } from '../../src/components/table/ThrowablePlayer';
import type { ThrowEvent } from '../../src/services/ThrowableService';
import type { ThrowableSpec } from '../../src/throwables/spec';
const state = vi.hoisted(() => ({ speed: 2, cancel: vi.fn(), schedule: vi.fn() }));
vi.mock('../../src/utils/animationSpeed', () => ({
  getAnimationSpeed: () => state.speed,
  prefersReducedMotion: () => false,
}));
vi.mock('../../src/services/ThrowableSoundService', () => ({
  throwableSoundService: {
    scheduleCues: (...args: unknown[]) => {
      state.schedule(...args);
      return state.cancel;
    },
  },
}));
vi.mock('../../src/throwables/cues', () => ({
  cueUrl: () => '',
  isPlaceholderCue: () => false,
  placeholderRecipe: () => undefined,
}));
const spec: ThrowableSpec = {
  id: 'test',
  name: 'Test',
  tier: 'free',
  category: 'objects',
  spawn: 'avatar-face',
  spawnMs: 100,
  flight: { ms: 200, mode: 'straight' },
  arrival: 'land',
  payload: { ms: 1000, sizeU: 1, anchor: 'face', coversAvatar: false },
  beats: [],
  audio: [],
};
const rig = {
  Projectile: () => <svg data-testid="projectile" />,
  Payload: () => <svg data-testid="payload" />,
};
const event = { id: 'test-event', fromSeat: 1, toSeat: 2 } as ThrowEvent;
const positions = new Map([
  [1, { x: 100, y: 100 }],
  [2, { x: 300, y: 100 }],
]);
beforeEach(() => {
  vi.useFakeTimers();
  state.speed = 2;
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('throwable player lifecycle', () => {
  it('keeps CSS, audio and phase timers on the mount-time speed after a setting change', () => {
    const done = vi.fn();
    const view = render(
      <ThrowablePlayer
        event={event}
        spec={spec}
        rig={rig}
        seatPositions={positions}
        onComplete={done}
      />
    );
    expect(
      view.container.querySelector<HTMLElement>('.thr')?.style.getPropertyValue('--animation-speed')
    ).toBe('2');
    expect(state.schedule.mock.calls[0][1].speed).toBe(2);
    state.speed = 0.5;
    view.rerender(
      <ThrowablePlayer
        event={event}
        spec={spec}
        rig={rig}
        seatPositions={positions}
        onComplete={done}
      />
    );
    act(() => vi.advanceTimersByTime(599));
    expect(view.queryByTestId('payload')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(view.queryByTestId('payload')).not.toBeNull();
    expect(
      view.container.querySelector<HTMLElement>('.thr')?.style.getPropertyValue('--animation-speed')
    ).toBe('2');
    act(() => vi.advanceTimersByTime(2000));
    expect(view.queryByTestId('payload')).toBeNull();
    expect(done).toHaveBeenCalledOnce();
  });
  it('cancels audio and phase timers when the table unmounts', () => {
    const done = vi.fn();
    const view = render(
      <ThrowablePlayer
        event={event}
        spec={spec}
        rig={rig}
        seatPositions={positions}
        onComplete={done}
      />
    );
    view.unmount();
    act(() => vi.runAllTimers());
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
  });
  it('completes an unresolved target without starting audio', () => {
    const done = vi.fn();
    render(
      <ThrowablePlayer
        event={event}
        spec={spec}
        rig={rig}
        seatPositions={new Map()}
        onComplete={done}
      />
    );
    expect(done).toHaveBeenCalledOnce();
    expect(state.schedule).not.toHaveBeenCalled();
  });
});
