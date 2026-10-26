import { soundService } from '../../../src/services/SoundService';
import { playPlayerActionSound } from '../../../src/lib/playerActionSound';

// Isolated browser fixture: real service, native Web Audio, no account or game writes.
const service = soundService as unknown as { ctx: BaseAudioContext; masterGain: GainNode };
async function render(actions: { action: string; amount?: number; at?: number }[], volume = 0.7) {
  const ctx = new OfflineAudioContext(1, 44100, 44100);
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  service.ctx = ctx;
  service.masterGain = gain;
  soundService.setMasterVolume(volume);
  soundService.setEnabled(true);
  // The call's existing timer owns its second clink. Drive that callback at
  // its intended audio time rather than allowing offline rendering to outrun
  // the main-thread timer. All sound methods and synthesis helpers remain real.
  const timers: { callback: () => void; at: number }[] = [];
  const originalTimeout = window.setTimeout;
  let time = 0;
  const scheduledContext = new Proxy(ctx, {
    get(target, property) {
      if (property === 'currentTime') return time;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  service.ctx = scheduledContext;
  window.setTimeout = ((callback: () => void, delay = 0) => {
    timers.push({ callback, at: time + delay / 1000 });
    return timers.length;
  }) as typeof setTimeout;
  try {
    for (const action of actions) {
      time = action.at ?? 0;
      playPlayerActionSound(action.action, action.amount ?? 3, 1);
    }
    for (const timer of timers.sort((a, b) => a.at - b.at)) {
      time = timer.at;
      timer.callback();
    }
  } finally {
    window.setTimeout = originalTimeout;
  }
  const buffer = await ctx.startRendering();
  const samples = buffer.getChannelData(0);
  let peak = 0,
    energy = 0,
    last = 0,
    lowEnergy = 0,
    low = 0;
  for (let i = 0; i < samples.length; i += 1) {
    if (!Number.isFinite(samples[i])) throw new Error('Nonfinite rendered audio');
    peak = Math.max(peak, Math.abs(samples[i]));
    energy += samples[i] ** 2;
    low += (1 - Math.exp((-2 * Math.PI * 600) / ctx.sampleRate)) * (samples[i] - low);
    lowEnergy += low ** 2;
    if (Math.abs(samples[i]) > 0.0001) last = i;
  }
  return {
    peak,
    rms: Math.sqrt(energy / samples.length),
    duration: last / ctx.sampleRate,
    lowFraction: lowEnergy / energy,
  };
}
Object.assign(window, {
  audioFixture: {
    render,
    state: () => soundService.audioState(),
    closeLive: () => soundService.destroy(),
  },
});
