/**
 * THE DIAMOND GAMES CAN BE HEARD AND FELT (2026-09-26): the scene half.
 *
 * In the style of DiamondWheelAnimation.test.tsx: soundService is mocked and
 * each scene's own frame loop is driven by hand, so these pin WHEN each cue is
 * asked for. Every beat is asked for once, on the frame that shows it, and
 * never ahead of it; the Crash engine is one voice steered by the multiplier
 * and stopped on every ending, on unmount and on a hidden tab; Plinko ticks are
 * rate limited on the frame clock. What the service does with a request (the
 * gates, the voice reuse, the buzz) is pinned in tests/unit/diamondGameCues.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { crashMultiplierCents } from '../../src/utils/diamondGamesFairness';

const sounds = vi.hoisted(() => ({
  driveCrashEngine: vi.fn(),
  stopCrashEngine: vi.fn(),
  playCrashExplosion: vi.fn(),
  playCrashMax: vi.fn(),
  playBonusBooked: vi.fn(),
  playPlinkoPeg: vi.fn(),
  playPlinkoLanding: vi.fn(),
  playCrossingHoof: vi.fn(),
  driveCrossingCar: vi.fn(),
  stopCrossingCar: vi.fn(),
  playCrossingBrake: vi.fn(),
  playCrossingHorn: vi.fn(),
  playCrossingHit: vi.fn(),
  playCrossingLanded: vi.fn(),
  playMinesGem: vi.fn(),
  playMinesExplosion: vi.fn(),
}));
const motion = vi.hoisted(() => ({ reduced: false }));
const frames = vi.hoisted(() => ({
  render: vi.fn(() => true),
  cleanup: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('../../src/services/SoundService', () => ({ soundService: sounds, PLINKO_PEG_GAP_MS: 30 }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/animationSpeed', async (original) => ({
  ...(await original<typeof import('../../src/utils/animationSpeed')>()),
  getAnimationSpeed: () => 1,
  prefersReducedMotion: () => motion.reduced,
}));
vi.mock('../../src/components/games/sceneKit', async (original) => {
  const actual = await original<typeof import('../../src/components/games/sceneKit')>();
  const THREE = await import('three');
  return {
    ...actual,
    inscription: () => new THREE.Texture(),
    gameRenderer: (canvas: HTMLCanvasElement) => ({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      renderer: { domElement: canvas, setSize: vi.fn(), render: vi.fn() },
      render: frames.render,
      cleanup: frames.cleanup,
    }),
  };
});
vi.mock('../../src/components/games/gpuFrameRenderer', () => ({
  gpuFrameRenderer: () => ({ render: frames.render, dispose: frames.dispose }),
}));
vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>();
  return {
    ...actual,
    WebGLRenderer: class {
      domElement = document.createElement('canvas');
      shadowMap = {};
      setPixelRatio() {}
      setSize() {}
      render() {}
      dispose() {}
      forceContextLoss() {}
    },
    PMREMGenerator: class {
      fromScene() {
        return { texture: new actual.Texture(), dispose() {} };
      }
      dispose() {}
    },
  };
});
import CrashCurve, { type CrashCurveProps } from '../../src/components/crash/CrashCurve';
import PlinkoBoard from '../../src/components/plinko/PlinkoBoard';
import ChoiceScene from '../../src/components/games/ChoiceScene';
import MinesGrid from '../../src/components/games/MinesGrid';

let callback: FrameRequestCallback | null = null;
let now = 0;
let hidden = false;
/** Run one animation frame at `at` ms, with performance.now() agreeing. */
const frame = (at: number) =>
  act(() => {
    now = at;
    const run = callback;
    callback = null;
    run?.(at);
  });
beforeEach(() => {
  motion.reduced = false;
  hidden = false;
  now = 0;
  callback = null;
  frames.render.mockReturnValue(true);
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((fn) => {
    callback = fn;
    return 1;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {
    callback = null;
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    new Proxy({}, { get: () => () => ({ addColorStop() {} }) }) as CanvasRenderingContext2D
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Crash: the engine follows the flight, and each ending is heard once', () => {
  const flight = (props: Partial<CrashCurveProps>) => (
    <CrashCurve
      phase="idle"
      growthK={0.12}
      capCents={2500}
      startedAtLocalMs={100}
      finalCents={null}
      cashoutCents={null}
      crashCents={null}
      autoCashoutCents={null}
      {...props}
    />
  );
  /** Idle, then a flight launched at 100 ms and flown to 3 s. */
  const fly = () => {
    const view = render(flight({}));
    frame(50);
    expect(sounds.driveCrashEngine).not.toHaveBeenCalled();
    view.rerender(flight({ phase: 'open' }));
    for (let t = 200; t <= 3000; t += 100) frame(t);
    return view;
  };

  it('steers one engine voice to the multiplier each frame shows', () => {
    fly();
    const heard = sounds.driveCrashEngine.mock.calls.map(([cents]) => cents as number);
    const expected = [];
    for (let t = 200; t <= 3000; t += 100) expected.push(crashMultiplierCents(0.12, t - 100, 2500));
    expect(heard).toEqual(expected);
    for (let i = 1; i < heard.length; i++) expect(heard[i]).toBeGreaterThanOrEqual(heard[i - 1]);
    expect(heard[heard.length - 1]).toBeGreaterThan(heard[0]);
    expect(sounds.stopCrashEngine).not.toHaveBeenCalled();
  });

  it('stops the engine and bursts once on a crash, with no sting', () => {
    const view = fly();
    view.rerender(flight({ phase: 'crashed', finalCents: 140 }));
    frame(3100);
    expect(sounds.stopCrashEngine).toHaveBeenCalledTimes(1);
    expect(sounds.playCrashExplosion).toHaveBeenCalledExactlyOnceWith(1);
    const driven = sounds.driveCrashEngine.mock.calls.length;
    for (let t = 3200; t <= 6000; t += 100) frame(t);
    expect(sounds.playCrashExplosion).toHaveBeenCalledTimes(1);
    expect(sounds.stopCrashEngine).toHaveBeenCalledTimes(1);
    expect(sounds.driveCrashEngine).toHaveBeenCalledTimes(driven);
    expect(sounds.playBonusBooked).not.toHaveBeenCalled();
    expect(sounds.playCrashMax).not.toHaveBeenCalled();
    // A resize rebuilds the loop; a finished round is never announced again.
    view.rerender(flight({ phase: 'crashed', finalCents: 140, width: 420 }));
    for (let t = 6100; t <= 6500; t += 100) frame(t);
    expect(sounds.playCrashExplosion).toHaveBeenCalledTimes(1);
  });

  it('stops the engine and books the cash-out once, at its multiplier', () => {
    const view = fly();
    view.rerender(flight({ phase: 'cashed', finalCents: 257, cashoutCents: 257, crashCents: 950 }));
    frame(3100);
    expect(sounds.stopCrashEngine).toHaveBeenCalledTimes(1);
    expect(sounds.playBonusBooked).toHaveBeenCalledExactlyOnceWith(2.57);
    for (let t = 3200; t <= 8000; t += 100) frame(t);
    expect(sounds.playBonusBooked).toHaveBeenCalledTimes(1);
    expect(sounds.playCrashExplosion).not.toHaveBeenCalled();
    expect(sounds.playCrashMax).not.toHaveBeenCalled();
  });

  it('gives a round booked at the cap the gold fanfare instead of the sting', () => {
    const view = fly();
    view.rerender(
      flight({ phase: 'cashed', finalCents: 2500, cashoutCents: 2500, crashCents: 4000 })
    );
    for (let t = 3100; t <= 8000; t += 100) frame(t);
    expect(sounds.playCrashMax).toHaveBeenCalledExactlyOnceWith(1);
    expect(sounds.playBonusBooked).not.toHaveBeenCalled();
    expect(sounds.playCrashExplosion).not.toHaveBeenCalled();
  });

  it('holds an ending until the frame that shows it is drawn', () => {
    const view = fly();
    frames.render.mockReturnValue(false);
    view.rerender(flight({ phase: 'crashed', finalCents: 140 }));
    frame(3100);
    frame(3200);
    expect(sounds.playCrashExplosion).not.toHaveBeenCalled();
    frames.render.mockReturnValue(true);
    frame(3300);
    expect(sounds.playCrashExplosion).toHaveBeenCalledTimes(1);
  });

  it('stops the engine on unmount', () => {
    const view = fly();
    view.unmount();
    expect(sounds.stopCrashEngine).toHaveBeenCalledTimes(1);
  });

  it('stops the engine while the tab is hidden and picks the flight up again after', () => {
    fly();
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(sounds.stopCrashEngine).toHaveBeenCalledTimes(1);
    const driven = sounds.driveCrashEngine.mock.calls.length;
    frame(9000);
    expect(sounds.driveCrashEngine).toHaveBeenCalledTimes(driven);
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    frame(9100);
    expect(sounds.driveCrashEngine).toHaveBeenCalledTimes(driven + 1);
  });

  it('does not announce a round that was already over when the scene appeared', () => {
    render(flight({ phase: 'crashed', finalCents: 140 }));
    for (let t = 100; t <= 2000; t += 100) frame(t);
    expect(sounds.playCrashExplosion).not.toHaveBeenCalled();
    expect(sounds.driveCrashEngine).not.toHaveBeenCalled();
  });
});

describe('Plinko: a tick for each peg struck, a clink for each landing', () => {
  const board = (props: Partial<Parameters<typeof PlinkoBoard>[0]>) => (
    <PlinkoBoard
      multipliersCents={Array.from({ length: 17 }, (_, i) => (i === 16 ? 1000 : 100))}
      path={null}
      dropKey={1}
      batchPathBits={null}
      restingSlot={null}
      {...props}
    />
  );

  it('ticks every row of a single drop once, in order, then clinks its bucket once', () => {
    const onLanded = vi.fn();
    render(board({ path: Array(16).fill(1), onLanded }));
    for (let t = 100; t <= 4400; t += 40) frame(t);
    expect(sounds.playPlinkoPeg.mock.calls.map(([row]) => row)).toEqual(
      Array.from({ length: 16 }, (_, i) => i)
    );
    expect(onLanded).toHaveBeenCalledTimes(1);
    // Slot 17 pays 10x: a big win, with the big-win flag for its jackpot buzz.
    expect(sounds.playPlinkoLanding).toHaveBeenCalledExactlyOnceWith(1000, true);
    for (let t = 4440; t <= 5000; t += 40) frame(t);
    expect(sounds.playPlinkoLanding).toHaveBeenCalledTimes(1);
  });

  it('rate limits a falling batch to one tick every 30 ms', () => {
    const heardAt: number[] = [];
    sounds.playPlinkoPeg.mockImplementation(() => {
      heardAt.push(now);
    });
    const batch = Array.from({ length: 24 }, (_, i) => (i * 2654435761) & 0xffff);
    render(board({ batchPathBits: batch }));
    // A fast display: a frame every 8 ms, and the board is asked each time.
    let drawn = 0;
    for (let t = 100; t <= 9000; t += 8) {
      frame(t);
      drawn++;
    }
    expect(heardAt.length).toBeGreaterThan(20);
    // Twenty-four diamonds strike 384 pegs; the tick is a patter, not a machine gun.
    expect(heardAt.length).toBeLessThan(384);
    expect(heardAt.length).toBeLessThan(drawn);
    for (let i = 1; i < heardAt.length; i++)
      expect(heardAt[i] - heardAt[i - 1]).toBeGreaterThanOrEqual(30);
    const clinks = sounds.playPlinkoLanding.mock.calls;
    expect(clinks.length).toBeGreaterThanOrEqual(1);
    expect(clinks.length).toBeLessThanOrEqual(batch.length);
  });

  it('under reduced motion lands a whole batch as one beat, at its best bucket', () => {
    motion.reduced = true;
    // Two of the three land in slot 17 (10x), one in slot 1.
    render(board({ batchPathBits: [0xffff, 0, 0xffff] }));
    for (let t = 100; t <= 1500; t += 160) frame(t);
    expect(sounds.playPlinkoPeg).not.toHaveBeenCalled();
    expect(sounds.playPlinkoLanding).toHaveBeenCalledExactlyOnceWith(1000, true);
  });
});

describe('Donkey Cross: the walk, the car and the beat are heard where they are seen', () => {
  const road = (extra: Partial<Parameters<typeof ChoiceScene>[0]>) => (
    <ChoiceScene
      game="crossing"
      roundId="road"
      picked={[0]}
      mines={null}
      phase="open"
      roadEnd={null}
      busy={false}
      onPick={() => {}}
      {...extra}
    />
  );
  const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];

  it('steps, brings the car in, squeals it to a stop and lands the street once', () => {
    const onMoment = vi.fn();
    const view = render(road({ onMoment }));
    frame(100);
    view.rerender(road({ onMoment, picked: [0, 1] }));
    for (let t = 120; t <= 2000; t += 20) frame(t);
    expect(sounds.playCrossingHoof.mock.calls.map(([step]) => step)).toEqual([0, 1, 2, 3]);
    const closeness = sounds.driveCrossingCar.mock.calls.map(([near]) => near as number);
    expect(closeness.length).toBeGreaterThan(3);
    for (let i = 1; i < closeness.length; i++)
      expect(closeness[i]).toBeGreaterThanOrEqual(closeness[i - 1]);
    expect(sounds.playCrossingBrake).toHaveBeenCalledExactlyOnceWith(1);
    expect(sounds.stopCrossingCar).toHaveBeenCalled();
    expect(sounds.playCrossingLanded).toHaveBeenCalledExactlyOnceWith(2);
    expect(order(sounds.playCrossingBrake)).toBeLessThan(order(sounds.playCrossingLanded));
    expect(onMoment.mock.calls).toEqual([['landed', 2]]);
    expect(sounds.playCrossingHorn).not.toHaveBeenCalled();
    expect(sounds.playCrossingHit).not.toHaveBeenCalled();
  });

  it('sounds the horn as the car commits, then the impact once when it strikes', () => {
    const onMoment = vi.fn();
    const view = render(road({ onMoment }));
    frame(100);
    view.rerender(road({ onMoment, picked: [0, 1], phase: 'lost' }));
    for (let t = 120; t <= 2400; t += 20) frame(t);
    expect(sounds.playCrossingHorn).toHaveBeenCalledTimes(1);
    expect(sounds.playCrossingHit).toHaveBeenCalledExactlyOnceWith({ withHorn: false, speed: 1 });
    expect(order(sounds.playCrossingHorn)).toBeLessThan(order(sounds.playCrossingHit));
    expect(sounds.stopCrossingCar).toHaveBeenCalled();
    expect(sounds.playCrossingBrake).not.toHaveBeenCalled();
    expect(sounds.playCrossingLanded).not.toHaveBeenCalled();
    expect(onMoment.mock.calls).toEqual([['hit', 2]]);
  });

  it('books a win on the street it stands on with the sting, at that street', () => {
    const onMoment = vi.fn();
    const view = render(road({ onMoment, picked: [0, 1] }));
    frame(100);
    view.rerender(road({ onMoment, picked: [0, 1], phase: 'cashed' }));
    for (let t = 120; t <= 1500; t += 20) frame(t);
    // Street 2 on today's road pays 1.45x.
    expect(sounds.playBonusBooked).toHaveBeenCalledExactlyOnceWith(1.45);
    expect(onMoment.mock.calls).toEqual([['booked', 2]]);
  });

  it('keeps every beat under reduced motion, once, with the horn folded into the hit', () => {
    motion.reduced = true;
    // The scene also follows the media query live, so it has to agree.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    const onMoment = vi.fn();
    const view = render(road({ onMoment }));
    frame(100);
    view.rerender(road({ onMoment, picked: [0, 1], phase: 'lost' }));
    for (let t = 200; t <= 2000; t += 100) frame(t);
    expect(sounds.playCrossingHit).toHaveBeenCalledExactlyOnceWith({ withHorn: true, speed: 1 });
    expect(onMoment.mock.calls).toEqual([['hit', 2]]);
    expect(sounds.playCrossingHoof).not.toHaveBeenCalled();
    expect(sounds.driveCrossingCar).not.toHaveBeenCalled();
  });

  it('silences the approaching car on unmount', () => {
    const view = render(road({}));
    frame(100);
    view.rerender(road({ picked: [0, 1] }));
    for (let t = 120; t <= 400; t += 20) frame(t);
    expect(sounds.driveCrossingCar).toHaveBeenCalled();
    const stopped = sounds.stopCrossingCar.mock.calls.length;
    view.unmount();
    expect(sounds.stopCrossingCar).toHaveBeenCalledTimes(stopped + 1);
  });
});

describe('Diamond Mines: a chime per gem that climbs, a blast, a sting', () => {
  const mines = (extra: Partial<Parameters<typeof MinesGrid>[0]>) => (
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

  it('chimes each gem once, one step higher each time, and blasts the mine once', () => {
    const view = render(mines({}));
    expect(sounds.playMinesGem).not.toHaveBeenCalled();
    view.rerender(mines({ picked: [3] }));
    view.rerender(mines({ picked: [3] }));
    view.rerender(mines({ picked: [3, 8] }));
    expect(sounds.playMinesGem.mock.calls).toEqual([[1], [2]]);
    view.rerender(mines({ picked: [3, 8, 12], mines: [12, 20], phase: 'lost', payoutChips: 0.2 }));
    view.rerender(mines({ picked: [3, 8, 12], mines: [12, 20], phase: 'lost', payoutChips: 0.2 }));
    expect(sounds.playMinesExplosion).toHaveBeenCalledExactlyOnceWith(1);
    expect(sounds.playMinesGem).toHaveBeenCalledTimes(2);
    expect(sounds.playBonusBooked).not.toHaveBeenCalled();
  });

  it('books a win once, at the multiplier it paid', () => {
    const view = render(mines({ picked: [3, 8] }));
    view.rerender(mines({ picked: [3, 8], mines: [12, 20], phase: 'cashed', payoutChips: 1.5 }));
    view.rerender(mines({ picked: [3, 8], mines: [12, 20], phase: 'cashed', payoutChips: 1.5 }));
    expect(sounds.playBonusBooked).toHaveBeenCalledExactlyOnceWith(1.5);
    expect(sounds.playMinesGem).not.toHaveBeenCalled();
  });

  it('says nothing for a round already in progress when the board mounts, or a new round', () => {
    const view = render(mines({ picked: [1, 2, 3] }));
    view.rerender(mines({ roundId: 'next', picked: [] }));
    expect(sounds.playMinesGem).not.toHaveBeenCalled();
    expect(sounds.playMinesExplosion).not.toHaveBeenCalled();
    expect(sounds.playBonusBooked).not.toHaveBeenCalled();
  });
});
