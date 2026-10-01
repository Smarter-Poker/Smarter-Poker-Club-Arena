/**
 * HAND REPLAY CLIP MODE (Phase 9.1, 2026-09-30): the replay as a camera subject.
 *
 * - With `clip`, the stage is `.hand-replay--clip`: no header, tabs, rundown,
 *   jumps, scrubber, rate buttons, close or seat strip; the variant and blinds
 *   line kept; the table name gone; the villains named by seat.
 * - On mount the rate is the fit's, `data-clip-state` is ready (or too_long)
 *   and `window.__spClip` carries v, state, frames, rate, plannedMs, start().
 * - start() rewinds and plays with no sound cue; reaching the last frame,
 *   letting its beat settle and holding sets done, at exactly plannedMs.
 * - A hand that cannot fit is too_long: start() returns false, nothing plays.
 * - Without `clip` nothing changes (the controls are there, no handle is set).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act, waitFor, screen } from '@testing-library/react';
import { buildClipSource, fitClipRate, readClipPayload, type ClipRow } from '@/lib/clipMode';
import { buildReplayFrames } from '@/utils/replayFrames';
import { REPLAY_RATES, replayBeatMs } from '@/utils/replayMotion';
import type { ClipHandle } from '@/components/replay/HandReplay';

const sound = {
  playDeal: vi.fn(),
  playCommunityCard: vi.fn(),
  playChips: vi.fn(),
  playRaise: vi.fn(),
  playCheck: vi.fn(),
  playFold: vi.fn(),
  playAllIn: vi.fn(),
  playDiscard: vi.fn(),
  playShowdown: vi.fn(),
  playWin: vi.fn(),
  playPotCollect: vi.fn(),
};
vi.mock('@/services/SoundService', () => ({ soundService: sound }));
vi.mock('@/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: null }) }));

const HERO = 'hero-uuid';
const SHOWN = 'shown-villain-uuid';
const FOLDED = 'folded-villain-uuid';

const ROW: ClipRow = {
  id: 'hand-uuid',
  hand_number: 4242,
  game_variant: 'nlh',
  small_blind: 1,
  big_blind: 2,
  pot_size: 200,
  button_seat: 1,
  started_at: '2026-09-30T12:00:00.000Z',
  community_cards: ['7c', '2c', '9h', 'Kd', 'Tc'],
  players: [
    { userId: HERO, username: 'kingfish', seat: 1, stack: 200, cards: [] },
    { userId: SHOWN, username: 'Emerson', seat: 2, stack: 0, cards: [] },
    { userId: FOLDED, username: 'Folder', seat: 3, stack: 100, cards: [] },
  ],
  actions: [
    { seat: 3, userId: FOLDED, action: 'fold', amount: 0, stage: 'preflop' },
    { seat: 1, userId: HERO, action: 'raise', amount: 6, stage: 'preflop' },
    { seat: 2, userId: SHOWN, action: 'call', amount: 4, stage: 'preflop' },
    { seat: 2, userId: SHOWN, action: 'check', amount: 0, stage: 'flop' },
    { seat: 1, userId: HERO, action: 'all_in', amount: 94, stage: 'flop' },
    { seat: 2, userId: SHOWN, action: 'call', amount: 94, stage: 'flop' },
  ],
  winners: [{ userId: HERO, amount: 200, potIndex: 0, hand: { name: 'Three Of A Kind' } }],
  winner_name: 'kingfish',
  hole_cards: { [HERO]: ['9c', '9d'], [SHOWN]: ['Ah', 'Kh'] },
  showdown: [
    { user_id: HERO, seat: 1, reveal_order: 0, mucked: false, hand_name: 'Three Of A Kind' },
    { user_id: SHOWN, seat: 2, reveal_order: 1, mucked: false, hand_name: 'Pair' },
  ],
};

function payload(minMs: number, maxMs: number) {
  const win = {
    __SP_CLIP__: {
      v: 1,
      style: 'felt-720p',
      heroId: HERO,
      row: ROW,
      privateHoleCards: {},
      discardedCards: {},
      minMs,
      maxMs,
    },
  } as unknown as Window;
  const p = readClipPayload(win);
  if (!p) throw new Error('fixture payload did not read');
  return p;
}

const handle = () => (window as unknown as { __spClip?: ClipHandle }).__spClip;
const stage = () => document.querySelector('.hand-replay') as HTMLElement | null;
const clipState = () => stage()?.getAttribute('data-clip-state') ?? null;

async function open(minMs: number, maxMs: number) {
  const { default: HandReplay } = await import('@/components/replay/HandReplay');
  const p = payload(minMs, maxMs);
  const source = buildClipSource(p);
  render(<HandReplay source={source} clip={{ minMs: p.minMs, maxMs: p.maxMs }} />);
  await waitFor(() => expect(stage()?.getAttribute('data-clip-state')).toBeTruthy());
  return { source, frames: buildReplayFrames(source.model) };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  for (const fn of Object.values(sound)) fn.mockClear();
});

describe('the clip stage', () => {
  it('is the felt and the variant and blinds line, with no controls, no seat strip and no table name', async () => {
    await open(15000, 40000);
    const root = stage()!;
    expect(root.classList.contains('hand-replay--clip')).toBe(true);
    expect(root.querySelector('.hand-replay__header')).toBeNull();
    expect(root.querySelector('[role="tab"]')).toBeNull();
    expect(root.querySelector('.hand-replay__rundown')).toBeNull();
    expect(root.querySelector('.hand-replay__jumps')).toBeNull();
    expect(root.querySelector('.hand-replay__controls')).toBeNull();
    expect(root.querySelector('input[type="range"]')).toBeNull();
    expect(root.querySelector('.hr-rate')).toBeNull();
    expect(root.querySelector('.hand-replay__seats')).toBeNull();
    expect(screen.queryByLabelText('Play')).toBeNull();
    expect(screen.queryByText('Close')).toBeNull();
    expect(root.querySelector('.hr-felt')).not.toBeNull();
    const eyebrow = root.querySelector('.hand-replay__clip-eyebrow')?.textContent ?? '';
    expect(eyebrow).toContain('/');
    expect(eyebrow.toUpperCase()).toContain('NLH');
    expect(root.textContent).not.toContain('Table');
    /* The villains are seats; the hero keeps a name. */
    expect(root.textContent).toContain('Seat 2');
    expect(root.textContent).toContain('Seat 3');
    expect(root.textContent).toContain('kingfish');
    expect(root.textContent).not.toContain('Emerson');
    expect(root.textContent).not.toContain('Folder');
  });

  it('is ready on mount, at the fitted rate, with the handle the renderer reads', async () => {
    const { frames } = await open(15000, 40000);
    const fit = fitClipRate(frames, REPLAY_RATES, 15000, 40000);
    expect(fit.tooLong).toBe(false);
    if (fit.tooLong) return;
    expect(clipState()).toBe('ready');
    const h = handle();
    expect(h).toBeDefined();
    expect(h?.v).toBe(1);
    expect(h?.state).toBe('ready');
    expect(h?.frames).toBe(frames.length);
    expect(h?.rate).toBe(fit.rate);
    expect(h?.plannedMs).toBe(fit.plannedMs);
    expect(typeof h?.start).toBe('function');
    expect(stage()?.style.getPropertyValue('--hr-rate')).toBe(String(fit.rate));
  });

  it('start() plays the hand through, silently, and lands on done at plannedMs', async () => {
    const { frames } = await open(15000, 40000);
    const fit = fitClipRate(frames, REPLAY_RATES, 15000, 40000);
    if (fit.tooLong) throw new Error('fixture hand must fit');
    vi.useFakeTimers();
    let started = false;
    await act(async () => {
      started = handle()!.start();
    });
    expect(started).toBe(true);
    expect(clipState()).toBe('playing');
    expect(handle()?.state).toBe('playing');
    const last = frames.length - 1;
    let elapsed = 0;
    /* One beat per frame, each its own step: the playback effect schedules
       the next beat only once React has committed the step before it. */
    for (let i = 0; i < last; i++) {
      const beat = replayBeatMs(frames[i], 1, fit.rate);
      await act(async () => {
        vi.advanceTimersByTime(beat);
      });
      elapsed += beat;
      expect(clipState()).toBe('playing');
    }
    expect(document.querySelector('.hand-replay__caption-street')?.textContent).toBe(
      frames[last].streetLabel
    );
    /* The last frame's own beat and the end hold: still playing just before it. */
    const settle = replayBeatMs(frames[last], 1, fit.rate) + fit.holdMs;
    await act(async () => {
      vi.advanceTimersByTime(settle - 20);
    });
    expect(clipState()).toBe('playing');
    await act(async () => {
      vi.advanceTimersByTime(40);
    });
    expect(clipState()).toBe('done');
    expect(handle()?.state).toBe('done');
    expect(elapsed + settle).toBe(fit.plannedMs);
    expect(Object.values(sound).some((fn) => fn.mock.calls.length > 0)).toBe(false);
  });

  it('extends the hold so a short run still reaches minMs', async () => {
    /* A window that starts 4 s after the natural run ends at half speed. */
    const natural = buildReplayFrames(buildClipSource(payload(15000, 40000)).model);
    const wide = fitClipRate(natural, REPLAY_RATES, 1000, 600000);
    if (wide.tooLong) throw new Error('fixture hand must fit');
    const minMs = wide.runMs + 4000;
    const maxMs = wide.runMs + 10000;
    const { frames } = await open(minMs, maxMs);
    const fit = fitClipRate(frames, REPLAY_RATES, minMs, maxMs);
    if (fit.tooLong) throw new Error('fixture hand must fit');
    expect(fit.rate).toBe(wide.rate);
    expect(fit.holdMs).toBe(4000);
    expect(fit.plannedMs).toBe(minMs);
    expect(handle()?.plannedMs).toBe(minMs);
    vi.useFakeTimers();
    await act(async () => {
      handle()!.start();
    });
    for (let i = 0; i < frames.length - 1; i++) {
      await act(async () => {
        vi.advanceTimersByTime(replayBeatMs(frames[i], 1, fit.rate));
      });
    }
    await act(async () => {
      vi.advanceTimersByTime(replayBeatMs(frames[frames.length - 1], 1, fit.rate) + 1500);
    });
    expect(clipState()).toBe('playing');
    await act(async () => {
      vi.advanceTimersByTime(fit.holdMs - 1500);
    });
    expect(clipState()).toBe('done');
  });

  it('refuses a hand that cannot fit: too_long, start() false, nothing plays', async () => {
    await open(1000, 2000);
    expect(clipState()).toBe('too_long');
    const h = handle()!;
    expect(h.state).toBe('too_long');
    expect(h.plannedMs).toBeGreaterThan(2000);
    vi.useFakeTimers();
    let started = true;
    await act(async () => {
      started = h.start();
    });
    expect(started).toBe(false);
    expect(clipState()).toBe('too_long');
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(clipState()).toBe('too_long');
    expect(document.querySelector('.hand-replay__caption-street')?.textContent).toBe('Deal');
  });

  it('removes the handle when the stage unmounts', async () => {
    await open(15000, 40000);
    expect(handle()).toBeDefined();
    cleanup();
    expect(handle()).toBeUndefined();
  });
});

describe('without clip, nothing changes', () => {
  it('shows the controls, sets no handle and no clip state', async () => {
    const { default: HandReplay } = await import('@/components/replay/HandReplay');
    const source = buildClipSource(payload(15000, 40000));
    render(<HandReplay source={source} />);
    await screen.findByText('Hand #4242');
    const root = stage()!;
    expect(root.classList.contains('hand-replay--clip')).toBe(false);
    expect(root.getAttribute('data-clip-state')).toBeNull();
    expect(root.querySelector('.hand-replay__controls')).not.toBeNull();
    expect(root.querySelector('.hand-replay__seats')).not.toBeNull();
    expect(root.querySelector('.hand-replay__clip-eyebrow')).toBeNull();
    expect(
      screen.getByRole('group', { name: 'Replay Speed' }).querySelectorAll('.hr-rate')
    ).toHaveLength(3);
    expect(handle()).toBeUndefined();
  });
});
