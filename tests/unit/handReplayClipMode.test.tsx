/**
 * HAND REPLAY CLIP MODE (Phase 9.1, 2026-09-30; the share page since
 * 2026-10-07): the replay as a camera subject.
 *
 * - With `clip`, the stage is the share page's replayer, pixel for pixel
 *   (owner decision, Dan, 2026-10-07): the header with the table name and the
 *   hand number, the tabs, the street jumps, the transport, the rate buttons
 *   and the seat strip are all there, every player keeps their screen name,
 *   and there is no clip class and no eyebrow of its own. The camera
 *   contract is the only addition.
 * - On mount the rate is the fit's, `data-clip-state` is ready (or too_long)
 *   and `window.__spClip` carries v, state, frames, rate, beats, holdMs,
 *   plannedMs, seek(i), start().
 * - seek(i) is the camera's step: frame i on the felt with no motion and no
 *   sound, `data-clip-step` confirming it; out of range or too_long is false.
 * - start() rewinds and plays with no sound cue; reaching the last frame,
 *   letting its beat settle and holding sets done, at exactly plannedMs.
 * - A hand that cannot fit is too_long: start() returns false, nothing plays.
 * - Without `clip` nothing changes (the same tree, no handle, no clip state).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act, waitFor, screen } from '@testing-library/react';
import { clipHandFrom, fitClipRate, readClipPayload, type ClipRow } from '@/lib/clipMode';
import { replayFromShareable, shareUserId } from '@/lib/shareHandModel';
import { buildReplayFrames } from '@/utils/replayFrames';
import { REPLAY_RATES, replayBeatMs } from '@/utils/replayMotion';
import type { ShareableHand } from '@/components/table/ShareHand';
import type { ClipHandle, ReplaySource } from '@/components/replay/HandReplay';

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
      tableName: 'Kingfish Club',
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

/**
 * What `sourceFrom` in src/pages/share/SharedHandReplayPage.tsx builds from a
 * ShareableHand: the link path, which a clip now goes through as well.
 */
function sourceOf(hand: ShareableHand): ReplaySource {
  const hero = hand.players.find((p) => p.isHero);
  const reveals: Record<string, { mucked?: boolean }> = {};
  for (const p of hand.players) {
    if (p.mucked) reveals[shareUserId(p.seat)] = { mucked: true };
  }
  return {
    model: replayFromShareable(hand),
    tableName: hand.tableName || null,
    handNumber: hand.handNumber ?? null,
    gameType: hand.variant,
    viewerId: hero ? shareUserId(hero.seat) : null,
    reveals,
    viewerFacts: null,
  };
}

const clipSource = (minMs: number, maxMs: number) => sourceOf(clipHandFrom(payload(minMs, maxMs)));

const handle = () => (window as unknown as { __spClip?: ClipHandle }).__spClip;
const stage = () => document.querySelector('.hand-replay') as HTMLElement | null;
const clipState = () => stage()?.getAttribute('data-clip-state') ?? null;

async function open(minMs: number, maxMs: number) {
  const { default: HandReplay } = await import('@/components/replay/HandReplay');
  const p = payload(minMs, maxMs);
  const source = clipSource(minMs, maxMs);
  render(<HandReplay source={source} clip={{ minMs: p.minMs, maxMs: p.maxMs }} />);
  await waitFor(() => expect(stage()?.getAttribute('data-clip-state')).toBeTruthy());
  return { source, frames: buildReplayFrames(source.model) };
}

/** The shape of a rendered stage: how many elements, which classes, what text. */
function shapeOf(root: HTMLElement) {
  const classes = new Set<string>();
  for (const el of root.querySelectorAll('*')) el.classList.forEach((c) => classes.add(c));
  return {
    elements: root.querySelectorAll('*').length,
    classes: [...classes].sort(),
    text: root.textContent,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  for (const fn of Object.values(sound)) fn.mockClear();
});

describe('the clip stage', () => {
  it('is the share page with the camera contract: header with table name and hand number, transport controls and the seat strip present, no eyebrow, no clip class', async () => {
    await open(15000, 40000);
    const root = stage()!;
    expect(root.classList.contains('hand-replay--clip')).toBe(false);
    expect(root.className).toBe('hand-replay');
    expect(root.getAttribute('data-clip-state')).toBe('ready');
    const header = root.querySelector('.hand-replay__header');
    expect(header).not.toBeNull();
    const eyebrow = header?.querySelector('.hand-replay__eyebrow')?.textContent ?? '';
    expect(eyebrow).toContain('Kingfish Club');
    expect(eyebrow).toContain('/');
    expect(eyebrow.toUpperCase()).toContain('NLH');
    expect(header?.querySelector('.hand-replay__title')?.textContent).toBe('Hand #4242');
    expect(root.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(root.querySelector('.hr-felt')).not.toBeNull();
    expect(root.querySelector('.hand-replay__jumps')).not.toBeNull();
    expect(root.querySelector('.hand-replay__controls')).not.toBeNull();
    expect(root.querySelector('input[type="range"]')).not.toBeNull();
    expect(
      screen.getByRole('group', { name: 'Replay Speed' }).querySelectorAll('.hr-rate')
    ).toHaveLength(3);
    expect(screen.getByLabelText('Play')).toBeTruthy();
    expect(root.querySelector('.hand-replay__seats')).not.toBeNull();
    expect(root.querySelectorAll('.player-hand-ranking')).toHaveLength(3);
    expect(root.querySelector('.hand-replay__clip-eyebrow')).toBeNull();
    /* Every player keeps their screen name; nobody is a seat number. */
    for (const name of ['kingfish', 'Emerson', 'Folder']) {
      expect(root.textContent).toContain(name);
    }
    expect(root.textContent).not.toContain('Seat 2');
    expect(root.textContent).not.toContain('Seat 3');
  });

  it('is the same tree the share page renders without clip, plus the camera attributes', async () => {
    const { default: HandReplay } = await import('@/components/replay/HandReplay');
    await open(15000, 40000);
    const withClip = shapeOf(stage()!);
    expect(stage()?.hasAttribute('data-clip-step')).toBe(true);
    cleanup();
    render(<HandReplay source={clipSource(15000, 40000)} />);
    await screen.findByText('Hand #4242');
    const withoutClip = shapeOf(stage()!);
    expect(stage()?.hasAttribute('data-clip-step')).toBe(false);
    expect(withClip).toEqual(withoutClip);
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
    expect(h?.beats).toEqual(fit.beats);
    expect(h?.holdMs).toBe(fit.holdMs);
    expect(h!.beats.reduce((a, b) => a + b, 0) + h!.holdMs).toBe(fit.plannedMs);
    expect(typeof h?.seek).toBe('function');
    expect(typeof h?.start).toBe('function');
    expect(stage()?.getAttribute('data-clip-step')).toBe('0');
    expect(stage()?.style.getPropertyValue('--hr-rate')).toBe(String(fit.rate));
    /* The rate buttons say so too: the share page's own control, on the fit's rate. */
    expect(
      screen.getByRole('group', { name: 'Replay Speed' }).querySelector('.hr-rate--current')
        ?.textContent
    ).toBe(fit.rate === 0.5 ? '½×' : `${fit.rate}×`);
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
    const natural = buildReplayFrames(clipSource(15000, 40000).model);
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

  it('seek(i) puts frame i on the felt with no motion and no sound, and data-clip-step says so', async () => {
    const { frames } = await open(15000, 40000);
    const last = frames.length - 1;
    const h = handle()!;
    for (const i of [3, last, 0, 1]) {
      let ok = false;
      await act(async () => {
        ok = h.seek(i);
      });
      expect(ok).toBe(true);
      expect(stage()?.getAttribute('data-clip-step')).toBe(String(i));
      expect(document.querySelector('.hand-replay__caption-street')?.textContent).toBe(
        frames[i].streetLabel
      );
      expect(document.querySelector('.hand-replay__caption-text')?.textContent).toBe(
        frames[i].caption
      );
      expect(clipState()).toBe('ready');
      /* A seek is a scrub: nothing slides, flips or flies. */
      expect(
        stage()?.querySelector(
          '.hr-bet--in, .hr-bet--sweep, .hr-seat__cards--flip, .hr-seat__cards--fold, .hr-felt__pot--award'
        )
      ).toBeNull();
      /* The share page's own scrubber follows the camera. */
      expect((stage()?.querySelector('input[type="range"]') as HTMLInputElement).value).toBe(
        String(i)
      );
    }
    expect(Object.values(sound).some((fn) => fn.mock.calls.length > 0)).toBe(false);
    /* Out of range, not an integer: refused, the felt unchanged. */
    for (const bad of [-1, last + 1, 1.5, NaN]) {
      let ok = true;
      await act(async () => {
        ok = h.seek(bad);
      });
      expect(ok).toBe(false);
      expect(stage()?.getAttribute('data-clip-step')).toBe('1');
    }
    /* A seek during playback stops it: the clock no longer moves the felt. */
    vi.useFakeTimers();
    await act(async () => {
      h.start();
    });
    expect(clipState()).toBe('playing');
    await act(async () => {
      h.seek(2);
    });
    expect(clipState()).toBe('ready');
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    expect(stage()?.getAttribute('data-clip-step')).toBe('2');
    expect(clipState()).toBe('ready');
  });

  it('seek(i) is false on a hand that cannot fit, and the plan is empty', async () => {
    await open(1000, 2000);
    const h = handle()!;
    expect(h.state).toBe('too_long');
    expect(h.beats).toEqual([]);
    expect(h.holdMs).toBe(0);
    let ok = true;
    await act(async () => {
      ok = h.seek(1);
    });
    expect(ok).toBe(false);
    expect(stage()?.getAttribute('data-clip-step')).toBe('0');
    expect(clipState()).toBe('too_long');
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
    render(<HandReplay source={clipSource(15000, 40000)} />);
    await screen.findByText('Hand #4242');
    const root = stage()!;
    expect(root.className).toBe('hand-replay');
    expect(root.getAttribute('data-clip-state')).toBeNull();
    expect(root.getAttribute('data-clip-step')).toBeNull();
    expect(root.querySelector('.hand-replay__controls')).not.toBeNull();
    expect(root.querySelector('.hand-replay__seats')).not.toBeNull();
    expect(
      screen.getByRole('group', { name: 'Replay Speed' }).querySelectorAll('.hr-rate')
    ).toHaveLength(3);
    expect(handle()).toBeUndefined();
  });
});
