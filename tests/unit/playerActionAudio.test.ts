import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

class Param {
  value = 0;
  points: [number, number][] = [];
  setValueAtTime(value: number, time: number) {
    if (!Number.isFinite(value) || !Number.isFinite(time)) throw new Error('Nonfinite AudioParam');
    this.points.push([value, time]);
  }
  exponentialRampToValueAtTime = this.setValueAtTime;
  linearRampToValueAtTime = this.setValueAtTime;
}
class AudioNode {
  gain = new Param();
  frequency = new Param();
  Q = new Param();
  type = 'sine';
  buffer: unknown;
  start = vi.fn();
  stop = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
}
class Context {
  state = 'running';
  currentTime = 10;
  sampleRate = 44100;
  destination = new AudioNode();
  tones: AudioNode[] = [];
  noises: AudioNode[] = [];
  createGain = () => new AudioNode();
  createOscillator = () => {
    const node = new AudioNode();
    this.tones.push(node);
    return node;
  };
  createBufferSource = () => {
    const node = new AudioNode();
    this.noises.push(node);
    return node;
  };
  createBiquadFilter = () => new AudioNode();
  createBuffer = (_channels: number, length: number) => ({
    getChannelData: () => new Float32Array(length),
  });
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
}

let service: (typeof import('../../src/services/SoundService'))['soundService'];
let context: Context;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  localStorage.clear();
  const instances: Context[] = [];
  vi.stubGlobal(
    'AudioContext',
    class extends Context {
      constructor() {
        super();
        instances.push(this);
      }
    }
  );
  ({ soundService: service } = await import('../../src/services/SoundService'));
  context = instances.at(-1)!;
});
afterEach(() => {
  service?.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Execute the real synthesizer; nodes record the Web Audio commands, not mocked cue methods.
describe('real table action audio', () => {
  it('keeps both distinct raises in a rapid sequence instead of losing the second one', () => {
    service.playRaise(3, 1);
    const first = context.tones.length;
    context.currentTime += 0.02;
    service.playRaise(3, 1);
    expect(context.tones.length).toBe(first * 2);
  });
  it('does not let a raise swallow the next player call', () => {
    service.playRaise(3, 1);
    const first = context.tones.length;
    context.currentTime += 0.02;
    service.playChips();
    expect(context.tones.length).toBe(first + 1);
    vi.advanceTimersByTime(35);
    expect(context.tones.length).toBe(first + 2);
  });
  it.each([
    [NaN, 1],
    [Infinity, 1],
    [3, NaN],
    [3, Infinity],
    [-3, 1],
    [3, 0],
  ])('renders a safe default for malformed amount/BB (%s/%s)', (amount, blind) => {
    expect(() => service.playRaise(amount, blind)).not.toThrow();
    expect(context.tones.length).toBeGreaterThan(0);
  });
  it('resumes an iOS interrupted context on the next action', () => {
    context.state = 'interrupted';
    service.playRaise(3, 1);
    expect(context.resume).toHaveBeenCalledOnce();
  });
  it('never schedules a source against a closed context', () => {
    context.state = 'closed';
    service.playRaise(3, 1);
    expect(context.tones).toEqual([]);
    expect(context.noises).toEqual([]);
  });
  it('preserves both sound preference keys for rapid actions', () => {
    service.setEnabled(false);
    service.playRaise(3, 1);
    service.playChips();
    expect(context.tones).toEqual([]);
    expect(context.noises).toEqual([]);
  });
  it('uses more chip hits and higher gain for a large raise, with an ascending signature', () => {
    service.playRaise(3, 1);
    const small = context.tones.splice(0);
    vi.advanceTimersByTime(51);
    service.playRaise(60, 1);
    const large = context.tones;
    expect(large.length).toBeGreaterThan(small.length);
    // The first two tones are the same wooden landing at both sizes.
    expect(large[0].frequency.points[0][0]).toBe(small[0].frequency.points[0][0]);
    const endings = large.slice(-2).map((n) => n.frequency.points[0][0]);
    expect(endings).toEqual([659, 880]);
    expect(large.every((n) => n.start.mock.calls[0][0] >= 10)).toBe(true);
  });
});

describe('accepted player_action cue routing', () => {
  it.each(['bet', 'raise', 'RAISE'])('%s reaches the real raise synthesizer', async (action) => {
    const { playPlayerActionSound } = await import('../../src/lib/playerActionSound');
    playPlayerActionSound(action, 3, 1);
    expect(context.noises).toHaveLength(1);
    expect(context.tones.slice(-2).map((n) => n.frequency.points[0][0])).toEqual([659, 880]);
  });
  it('a call keeps its dry two clinks and no stack sweep', async () => {
    const { playPlayerActionSound } = await import('../../src/lib/playerActionSound');
    playPlayerActionSound('call', 3, 1);
    vi.advanceTimersByTime(35);
    expect(context.noises).toHaveLength(0);
    expect(context.tones.map((n) => n.frequency.points[0][0])).toEqual([2200, 2600]);
  });
  it.each(['allin', 'all_in', 'check', 'fold', 'discard'])('%s remains audible', async (action) => {
    const { playPlayerActionSound } = await import('../../src/lib/playerActionSound');
    playPlayerActionSound(action, 3, 1);
    vi.advanceTimersByTime(250);
    expect(context.tones.length + context.noises.length).toBeGreaterThan(0);
  });
  it('an unknown verb cannot make a wager sound', async () => {
    const { playPlayerActionSound } = await import('../../src/lib/playerActionSound');
    playPlayerActionSound('snapshot', 3, 1);
    expect(context.tones.length + context.noises.length).toBe(0);
  });
  it('the gesture fallback survives a later iOS interruption', async () => {
    window.dispatchEvent(new Event('pointerdown'));
    context.state = 'interrupted';
    window.dispatchEvent(new Event('pointerdown'));
    expect(context.resume).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(context.state).toBe('running');
  });
});
