/**
 * THE DIAMOND GAMES CAN BE HEARD AND FELT (2026-09-26): the SoundService half.
 *
 * The scenes decide WHEN a cue plays (tests/components/DiamondGamesSound.test.tsx
 * drives their frame loops). This file pins what the service does with a cue
 * once it is asked: the Crash engine and the approaching car are ONE voice each,
 * built once and then only steered, and stopped on request, when sound is
 * switched off mid flight and when the tab is hidden; the Plinko peg tick is
 * rate limited however often it is asked; every buzz goes through the vibration
 * gate and keeps working with the sound muted; a muted gate and a hidden tab
 * play nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const audio = vi.hoisted(() => {
  const param = () => ({
    value: 0.5,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  });
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const created = { oscillators: [] as Array<{ stop: ReturnType<typeof vi.fn> }>, sources: 0 };
  class FakeAudioContext {
    state = 'running';
    currentTime = 1;
    sampleRate = 8000;
    destination = {};
    createGain() {
      return { ...node(), gain: param() };
    }
    createOscillator() {
      const osc = {
        ...node(),
        type: 'sine',
        frequency: param(),
        detune: param(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      created.oscillators.push(osc);
      return osc;
    }
    createBiquadFilter() {
      return { ...node(), type: 'lowpass', frequency: param(), Q: param() };
    }
    createBufferSource() {
      created.sources += 1;
      return { ...node(), buffer: null, loop: false, start: vi.fn(), stop: vi.fn() };
    }
    createBuffer(_channels: number, length: number) {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  }
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  Object.defineProperty(globalThis.navigator, 'vibrate', {
    value: vi.fn(() => true),
    configurable: true,
    writable: true,
  });
  return { created };
});

import { soundService } from '../../src/services/SoundService';
import { __resetVibrationCoalescing } from '../../src/utils/vibrationGate';

const vibrate = () => navigator.vibrate as unknown as ReturnType<typeof vi.fn>;
let hidden = false;
let clock = 1_000_000;

beforeEach(() => {
  localStorage.clear();
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  // Every cue has its own short throttle; each case starts well clear of the last.
  clock += 60_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  audio.created.oscillators.length = 0;
  audio.created.sources = 0;
  vibrate().mockClear();
  __resetVibrationCoalescing();
});
afterEach(() => {
  soundService.stopCrashEngine(0);
  soundService.stopCrossingCar(0);
  vi.restoreAllMocks();
});

describe('the Crash engine is one voice, steered by the multiplier', () => {
  it('builds its oscillators once and only writes targets on later frames', () => {
    soundService.driveCrashEngine(100);
    const built = audio.created.oscillators.length;
    expect(built).toBeGreaterThan(0);
    expect(soundService.isMotorRunning('crash')).toBe(true);
    const root = audio.created.oscillators[0] as unknown as {
      frequency: { setTargetAtTime: ReturnType<typeof vi.fn> };
    };
    for (let cents = 110; cents <= 2500; cents += 40) {
      clock += 33;
      soundService.driveCrashEngine(cents);
    }
    // No new node for any of the sixty frames that followed.
    expect(audio.created.oscillators.length).toBe(built);
    // The pitch rose with the multiplier, every write higher than the last.
    const targets = root.frequency.setTargetAtTime.mock.calls.map(([hz]) => hz as number);
    expect(targets.length).toBeGreaterThan(30);
    for (let i = 1; i < targets.length; i++) expect(targets[i]).toBeGreaterThan(targets[i - 1]);
    expect(targets[targets.length - 1] / targets[0]).toBeGreaterThan(3.5);
  });

  it('stops the voice when asked, and a stopped voice can be started again', () => {
    soundService.driveCrashEngine(250);
    const voice = [...audio.created.oscillators];
    soundService.stopCrashEngine(0.1);
    expect(soundService.isMotorRunning('crash')).toBe(false);
    for (const osc of voice) expect(osc.stop).toHaveBeenCalledTimes(1);
    // Stopping twice is harmless.
    soundService.stopCrashEngine(0.1);
    clock += 33;
    soundService.driveCrashEngine(260);
    expect(soundService.isMotorRunning('crash')).toBe(true);
  });

  it('falls silent when sound is switched off mid flight', () => {
    soundService.driveCrashEngine(150);
    localStorage.setItem('ca_sound_enabled', 'false');
    clock += 300;
    soundService.driveCrashEngine(160);
    expect(soundService.isMotorRunning('crash')).toBe(false);
    clock += 300;
    soundService.driveCrashEngine(170);
    expect(soundService.isMotorRunning('crash')).toBe(false);
  });

  it('stops when the tab is hidden, and never starts in a hidden tab', () => {
    soundService.driveCrashEngine(150);
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(soundService.isMotorRunning('crash')).toBe(false);
    soundService.driveCrashEngine(160);
    expect(soundService.isMotorRunning('crash')).toBe(false);
  });

  it('drives the approaching car as its own voice, alongside the engine', () => {
    soundService.driveCrossingCar(0.2);
    soundService.driveCrashEngine(120);
    expect(soundService.isMotorRunning('car')).toBe(true);
    expect(soundService.isMotorRunning('crash')).toBe(true);
    soundService.stopCrossingCar(0.2);
    expect(soundService.isMotorRunning('car')).toBe(false);
    expect(soundService.isMotorRunning('crash')).toBe(true);
  });
});

describe('Plinko peg ticks are rate limited', () => {
  it('plays at most one tick every 30 ms however often a peg is struck', () => {
    const start = clock;
    const heard: number[] = [];
    // A hundred diamonds striking pegs: a request every 5 ms for a second.
    for (let at = 0; at < 1000; at += 5) {
      clock = start + at;
      const before = audio.created.oscillators.length;
      soundService.playPlinkoPeg(at % 16, 3);
      if (audio.created.oscillators.length > before) heard.push(at);
    }
    expect(heard.length).toBeGreaterThan(20);
    expect(heard.length).toBeLessThanOrEqual(34);
    for (let i = 1; i < heard.length; i++)
      expect(heard[i] - heard[i - 1]).toBeGreaterThanOrEqual(30);
  });
});

describe('every buzz goes through the vibration gate', () => {
  it('buzzes each beat once, with the pattern that beat owns', () => {
    soundService.playCrashExplosion();
    expect(vibrate()).toHaveBeenCalledTimes(1);
    expect(vibrate().mock.calls[0][0]).toEqual([25, 20, 40]);
    // A re-render asking again inside the throttle is the same beat: no second buzz.
    soundService.playCrashExplosion();
    expect(vibrate()).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a booked win', () => soundService.playBonusBooked(2.5), [15, 30, 15]],
    ['the cap', () => soundService.playCrashMax(), [20, 20, 30, 20, 40, 20, 50, 20, 70]],
    ['a plain landing', () => soundService.playPlinkoLanding(120, false), 10],
    [
      'a big landing',
      () => soundService.playPlinkoLanding(900, true),
      [20, 20, 30, 20, 40, 20, 50, 20, 70],
    ],
    ['a street crossed', () => soundService.playCrossingLanded(3), 10],
    ['a hit', () => soundService.playCrossingHit(), [25, 20, 40]],
    ['a gem', () => soundService.playMinesGem(2), 10],
    ['a mine', () => soundService.playMinesExplosion(), [25, 20, 40]],
  ])('%s', (_name, play, pattern) => {
    play();
    expect(vibrate()).toHaveBeenCalledExactlyOnceWith(pattern);
  });

  it('keeps the buzz with the sound muted, and plays no sound', () => {
    localStorage.setItem('club_arena_sounds', 'false');
    soundService.playMinesExplosion();
    soundService.playCrossingLanded(2);
    expect(audio.created.oscillators).toHaveLength(0);
    expect(audio.created.sources).toBe(0);
    expect(vibrate()).toHaveBeenCalled();
  });

  it('keeps the sound with vibration off, and never buzzes', () => {
    localStorage.setItem('vibrationsEnabled', 'false');
    soundService.playMinesExplosion();
    expect(audio.created.oscillators.length).toBeGreaterThan(0);
    expect(vibrate()).not.toHaveBeenCalled();
  });
});

describe('a muted gate and a hidden tab play nothing', () => {
  const everyCue = () => {
    soundService.driveCrashEngine(300);
    soundService.playCrashExplosion();
    soundService.playCrashMax();
    soundService.playBonusBooked(3);
    soundService.playPlinkoPeg(4);
    soundService.playPlinkoLanding(700, true);
    soundService.playCrossingHoof(1);
    soundService.driveCrossingCar(0.5);
    soundService.playCrossingBrake();
    soundService.playCrossingHorn();
    soundService.playCrossingHit({ withHorn: true });
    soundService.playCrossingLanded(4);
    soundService.playMinesGem(3);
    soundService.playMinesExplosion();
  };

  it('is silent with sound switched off', () => {
    localStorage.setItem('ca_sound_enabled', 'false');
    everyCue();
    expect(audio.created.oscillators).toHaveLength(0);
    expect(audio.created.sources).toBe(0);
    expect(soundService.isMotorRunning('crash')).toBe(false);
    expect(soundService.isMotorRunning('car')).toBe(false);
  });

  it('is silent and still in a hidden tab', () => {
    hidden = true;
    everyCue();
    expect(audio.created.oscillators).toHaveLength(0);
    expect(audio.created.sources).toBe(0);
    expect(vibrate()).not.toHaveBeenCalled();
  });

  it('plays every cue when sound is on', () => {
    everyCue();
    expect(audio.created.oscillators.length).toBeGreaterThan(20);
    expect(audio.created.sources).toBeGreaterThan(10);
  });
});
