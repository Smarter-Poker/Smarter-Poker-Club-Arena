import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ThrowablePlayer } from '../../src/components/table/ThrowablePlayer';
import type { ThrowEvent } from '../../src/services/ThrowableService';
import type { ThrowableSpec } from '../../src/throwables/spec';
const state = vi.hoisted(() => ({
  speed: 2,
  reduced: false,
  artwork: false,
  prepare: vi.fn(),
  cancel: vi.fn(),
  schedule: vi.fn(),
}));
vi.mock('../../src/throwables/artwork', () => ({
  hasThrowableArtwork: () => state.artwork,
  prepareThrowableArtwork: () => state.prepare(),
}));
vi.mock('../../src/utils/animationSpeed', () => ({
  getAnimationSpeed: () => state.speed,
  prefersReducedMotion: () => state.reduced,
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
  state.reduced = false;
  state.artwork = false;
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

it.each([
  [400, 100, '1px', '0px'],
  [300, 0, '0px', '-1px'],
  [600, 500, '0.6px', '0.8px'],
  [300, 100, '0px', '-1px'],
])('points return effects toward source (%s, %s)', (x, y, expectedX, expectedY) => {
  const view = render(
    <ThrowablePlayer
      event={event}
      spec={spec}
      rig={rig}
      seatPositions={
        new Map([
          [1, { x, y }],
          [2, { x: 300, y: 100 }],
        ])
      }
      onComplete={vi.fn()}
    />
  );
  const style = view.container.querySelector<HTMLElement>('.thr')!.style;
  expect(style.getPropertyValue('--thr-return-x')).toBe(expectedX);
  expect(style.getPropertyValue('--thr-return-y')).toBe(expectedY);
});

describe('immediate payload clock', () => {
  it.each([true, false])(
    'starts visible performance and sound together (reduced=%s)',
    (reduced) => {
      state.reduced = reduced;
      state.speed = 1;
      const immediateSpec: ThrowableSpec = {
        ...spec,
        flight: reduced ? spec.flight : { ms: 0, mode: 'none' },
        audio: reduced
          ? [
              { at: 50, sample: 'travel' },
              { at: 200, sample: 'land' },
              { at: 500, sample: 'act' },
            ]
          : [
              { at: 0, sample: 'land' },
              { at: 300, sample: 'act' },
            ],
      };
      const done = vi.fn();
      const view = render(
        <ThrowablePlayer
          event={event}
          spec={immediateSpec}
          rig={rig}
          seatPositions={positions}
          onComplete={done}
        />
      );
      expect(view.queryByTestId('payload')).not.toBeNull();
      const [audio, options] = state.schedule.mock.calls[0];
      expect(audio.map((cue: { sample: string }) => cue.sample)).toEqual(['land', 'act']);
      expect(audio.map((cue: { at: number }) => cue.at + options.offsetMs)).toEqual([0, 300]);
      act(() => vi.advanceTimersByTime(999));
      expect(done).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(done).toHaveBeenCalledOnce();
      expect(view.queryByTestId('payload')).toBeNull();
    }
  );
});

describe('cold artwork playback', () => {
  it('starts neither visuals nor sound until decoding completes, then uses a fresh clock', async () => {
    state.artwork = true;
    state.speed = 1;
    let ready!: () => void;
    state.prepare.mockReturnValue(
      new Promise<void>((resolve) => {
        ready = resolve;
      })
    );
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
    act(() => vi.advanceTimersByTime(4000));
    expect(view.queryByTestId('projectile')).toBeNull();
    expect(state.schedule).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    await act(async () => {
      ready();
    });
    expect(view.queryByTestId('projectile')).not.toBeNull();
    expect(state.schedule).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(300));
    expect(view.queryByTestId('payload')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1000));
    expect(done).toHaveBeenCalledOnce();
  });

  it('does not start a decoded throw after its table unmounts', async () => {
    state.artwork = true;
    let ready!: () => void;
    state.prepare.mockReturnValue(
      new Promise<void>((resolve) => {
        ready = resolve;
      })
    );
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
    await act(async () => {
      ready();
    });
    expect(state.schedule).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });
});
