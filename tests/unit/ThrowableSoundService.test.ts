import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/SoundService', () => ({
  soundService: {
    isEnabled: () => true,
    getMasterVolume: () => 1,
    getEffectsVolume: () => 1,
  },
  haptic: {},
}));

const opts = {
  speed: 1,
  offsetMs: 0,
  panTarget: 0,
  panThrower: 0,
  urlFor: (name: string, ext: string) => `/sounds/${name}.${ext}`,
  isPlaceholder: () => false,
  playPlaceholder: vi.fn(),
};
const cue = [{ at: 0, sample: 'clink' }];
const bytes = () => new ArrayBuffer(8);
const response = () => ({ ok: true, arrayBuffer: async () => bytes() });

async function fixture() {
  const start = vi.fn();
  const stop = vi.fn();
  const decode = vi.fn().mockResolvedValue({ duration: 1 });
  const node = () => ({ connect: vi.fn(), gain: { value: 0 } });
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running';
      currentTime = 0;
      destination = {};
      decodeAudioData = decode;
      createGain = node;
      createBufferSource = () => ({ ...node(), start, stop });
      createDynamicsCompressor = () => ({
        ...node(),
        threshold: {},
        knee: {},
        ratio: {},
        attack: {},
        release: {},
      });
    }
  );
  const { throwableSoundService: service } =
    await import('../../src/services/ThrowableSoundService');
  return { service, start, stop, decode };
}

describe('recorded throwable cue lifecycle', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('does not start a cue whose fetch finishes after cancellation', async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      )
    );
    const { service, start, decode } = await fixture();
    const cancel = service.scheduleCues(cue, opts);
    cancel();
    finish(response());
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    expect(start).not.toHaveBeenCalled();
    expect(service.droppedCues).toEqual({ no_buffer: 0, late: 0, window_passed: 0 });
  });

  it('decodes AAC when the downloaded WebM is unsupported, and caches success', async () => {
    const fetcher = vi.fn().mockImplementation(async () => response());
    vi.stubGlobal('fetch', fetcher);
    const { service, start, decode } = await fixture();
    decode.mockRejectedValueOnce(new Error('Unsupported codec'));
    service.scheduleCues(cue, opts);
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/sounds/clink.webm',
      '/sounds/clink.m4a',
    ]);
    service.scheduleCues(cue, opts);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('allows a later throw to recover after both network requests fail', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetcher);
    const { service, start } = await fixture();
    service.scheduleCues(cue, opts);
    await vi.waitFor(() => expect(service.droppedCues.no_buffer).toBe(1));
    fetcher.mockImplementation(async () => response());
    service.scheduleCues(cue, opts);
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('stops an already scheduled cue on cancellation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => response())
    );
    const { service, start, stop } = await fixture();
    const cancel = service.scheduleCues(cue, opts);
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    cancel();
    expect(stop).toHaveBeenCalledOnce();
  });
});
