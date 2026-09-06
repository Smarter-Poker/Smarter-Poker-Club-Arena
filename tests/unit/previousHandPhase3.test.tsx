/**
 * PREVIOUS HAND - PHASE 3 (2026-09-05): the replayer moves.
 *
 * - Motion and sound are owed to a STEP forward, never to a jump or a scrub.
 * - Chips slide in on the frame they are bet, sweep to the pot on a new
 *   street, cards flip when shown, a fold goes to the muck, the pot goes to
 *   the winner - and each carries the felt's own cue.
 * - The acting seat's pot odds are read off the frame BEFORE its decision.
 * - The replay's rate scales every beat; no rate reaches zero.
 * - The dealer button, the street jumps and the made-hand label are on the felt.
 * - The viewer sees their own cards from the deal.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildReplay, replayInputFromRow } from '@/utils/handReplay';
import { buildReplayFrames } from '@/utils/replayFrames';
import {
  ACTION_BEAT_MS,
  STREET_BEAT_MS,
  REPLAY_RATE_KEY,
  facingAt,
  frameCue,
  frameMotion,
  preflopHoleLabel,
  readReplayRate,
  replayBeatMs,
  streetJumps,
  writeReplayRate,
} from '@/utils/replayMotion';

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
vi.mock('@/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'h' } }) }));

const HAND = {
  handNumber: 1,
  playedAt: '2026-09-05T20:00:00.000Z',
  gameVariant: 'nlh',
  smallBlind: 1,
  bigBlind: 2,
  potSize: 200,
  rakeAmount: 0,
  bbjAmount: 0,
  buttonSeat: 1,
  board: ['7c', '2c', '9h', 'Kd', 'Tc'],
  players: [
    { seat: 1, userId: 'h', username: 'kingfish', stack: 200 },
    { seat: 2, userId: 'v', username: 'Emerson', stack: 0 },
    { seat: 3, userId: 'f', username: 'Folder', stack: 100 },
  ],
  actions: [
    { seat: 3, userId: 'f', action: 'fold', amount: 0, stage: 'preflop' },
    { seat: 1, userId: 'h', action: 'raise', amount: 6, stage: 'preflop' },
    { seat: 2, userId: 'v', action: 'call', amount: 4, stage: 'preflop' },
    { seat: 2, userId: 'v', action: 'check', amount: 0, stage: 'flop' },
    { seat: 1, userId: 'h', action: 'all_in', amount: 94, stage: 'flop' },
    { seat: 2, userId: 'v', action: 'call', amount: 94, stage: 'flop' },
  ],
  winners: [{ userId: 'h', amount: 200, potIndex: 0, hand: { name: 'Pair' } }],
  holeCards: { h: ['9c', '9d'], v: ['Ah', 'Kh'] },
  showdown: [
    { user_id: 'h', seat: 1, mucked: false, reveal_order: 0, hand_name: 'Three Of A Kind' },
    { user_id: 'v', seat: 2, mucked: false, reveal_order: 1, hand_name: 'Pair' },
  ],
};

const model = buildReplay(HAND as never);
const frames = buildReplayFrames(model);
const at = (key: string) => frames.findIndex((f) => f.key === key);
const pair = (key: string) => [frames[at(key) - 1], frames[at(key)]] as const;

vi.mock('@/services/HandHistoryService', () => ({
  handHistoryService: {
    getHand: vi.fn(async () => ({
      id: 'hand-1',
      hand_number: 1,
      table_name: 'Midway',
      game_type: 'NLH',
      replay: model,
      players: [
        { user_id: 'h', showdown_reveal: null, facts: null },
        { user_id: 'v', showdown_reveal: null, facts: null },
        { user_id: 'f', showdown_reveal: null, facts: null },
      ],
    })),
  },
}));

afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(sound)) fn.mockClear();
  try {
    window.localStorage.removeItem(REPLAY_RATE_KEY);
  } catch {
    /* jsdom */
  }
});

describe('what moves between two frames', () => {
  it('nothing moves without a frame before it (a jump, a scrub, the first frame)', () => {
    expect(frameMotion(null, frames[at('row-a-1')], [1])).toEqual({
      chipsIn: null,
      deadIn: null,
      sweep: [],
      flip: [],
      fold: null,
      potTo: [],
    });
  });

  it('chips slide in from the seat that bet, posted or called', () => {
    expect(frameMotion(...pair('row-post-sb'), [1]).chipsIn).toBe(2);
    expect(frameMotion(...pair('row-a-1'), [1]).chipsIn).toBe(1);
    expect(frameMotion(...pair('row-a-2'), [1]).chipsIn).toBe(2);
    // A returned uncalled bet is not chips going in.
    expect(frameMotion(...pair('row-return-preflop-1'), [1]).chipsIn).toBeNull();
    // A check puts nothing in.
    expect(frameMotion(...pair('row-a-3'), [1]).chipsIn).toBeNull();
  });

  it('a new street sweeps every committed stack into the pot, the folded blind included', () => {
    expect(frameMotion(...pair('street-flop'), [1]).sweep).toEqual([1, 2, 3]);
    expect(frameMotion(...pair('street-turn'), [1]).sweep).toEqual([1, 2]);
    // Nothing was bet on the turn, so nothing sweeps on the river.
    expect(frameMotion(...pair('street-river'), [1]).sweep).toEqual([]);
    // A returned bet mid-street is not a sweep.
    expect(frameMotion(...pair('row-return-preflop-1'), [1]).sweep).toEqual([]);
  });

  it('a fold goes to the muck; a show flips; the final frame sends the pot to the winner', () => {
    expect(frameMotion(...pair('row-a-0'), [1]).fold).toBe(3);
    expect(frameMotion(...pair('row-show-h'), [1]).flip).toEqual([1]);
    expect(frameMotion(...pair('row-show-v'), [1]).flip).toEqual([2]);
    expect(frameMotion(...pair('showdown'), [1]).potTo).toEqual([1]);
    expect(frameMotion(...pair('row-show-v'), [1]).potTo).toEqual([]);
  });
});

describe("the frame's sound cue is the felt's own", () => {
  it('one cue per verb, none for a jump', () => {
    expect(frameCue(null, frames[at('row-a-1')])).toBeNull();
    expect(frameCue(...pair('row-post-sb'))).toBe('chips');
    expect(frameCue(...pair('row-a-0'))).toBe('fold');
    expect(frameCue(...pair('row-a-1'))).toBe('raise');
    expect(frameCue(...pair('row-a-2'))).toBe('chips');
    expect(frameCue(...pair('row-a-3'))).toBe('check');
    expect(frameCue(...pair('row-a-4'))).toBe('all_in');
    expect(frameCue(...pair('row-return-preflop-1'))).toBeNull();
    expect(frameCue(...pair('street-flop'))).toBe('community');
    expect(frameCue(...pair('row-show-h'))).toBe('show');
    expect(frameCue(...pair('showdown'))).toBe('win');
  });
});

describe('what the acting seat was facing', () => {
  it('is read off the frame before the decision', () => {
    // The button opens into a 1/2 blind: 2 to call into 3.
    expect(facingAt(...pair('row-a-1'))).toEqual({
      seat: 1,
      toCall: 2,
      potIfCalled: 5,
      potOddsPct: 40,
      ratio: '1.5 : 1',
    });
    // The small blind (1 in) calls a raise to 6 with 9 in the middle.
    expect(facingAt(...pair('row-a-2'))).toMatchObject({ seat: 2, toCall: 5, potOddsPct: 35.7 });
    // Facing 94 with 106 in the middle.
    expect(facingAt(...pair('row-a-5'))).toMatchObject({ seat: 2, toCall: 94, potOddsPct: 47 });
  });

  it('is nothing on a posting, a check with no bet in front, an open, or the first frame of a street', () => {
    expect(facingAt(...pair('row-post-bb'))).toBeNull();
    expect(facingAt(...pair('row-a-3'))).toBeNull();
    expect(facingAt(...pair('row-a-4'))).toBeNull();
    expect(facingAt(...pair('row-show-h'))).toBeNull();
    expect(facingAt(null, frames[at('row-a-1')])).toBeNull();
  });

  it('the big blind folding to nothing owes nothing', () => {
    // Seat 3 posted 2 and folds with 2 the high commitment: no price.
    expect(facingAt(...pair('row-a-0'))).toBeNull();
  });
});

describe('dead money is in the pot, never in front of the seat', () => {
  /* Found in the phase 3 deep dive by running the real records through the
     pipeline. Both defects predate phase 3 and both are about money:

     1. `replayInputFromRow` dropped the engine's `dead` flag, so only a row
        whose verb was the literal string "ante" hit the fallback. A bomb
        pot's `bomb_ante` was read as live money.
     2. `buildReplayFrames` re-derived its own commitments and counted dead
        money among them. On real tournament hand #6703996 the big blind was
        drawn with 750 in front (400 blind + 350 ante) and phase 3's pot odds
        then told every player facing that blind they owed 750. */
  const ANTE_ROW = {
    hand_number: 6703996,
    game_variant: 'nlh',
    small_blind: 200,
    big_blind: 400,
    pot_size: 2550,
    button_seat: 4,
    community_cards: [],
    players: [
      { seat: 5, userId: 'sb', username: 'CallFox', stack: 19061 },
      { seat: 6, userId: 'bb', username: 'SlowViper', stack: 18628 },
      { seat: 7, userId: 'utg', username: 'CoolerRanger', stack: 54730.5 },
    ],
    actions: [
      { seat: 5, userId: 'sb', action: 'sb', amount: 200, stage: 'preflop', dead: false },
      { seat: 6, userId: 'bb', action: 'bb', amount: 400, stage: 'preflop', dead: false },
      { seat: 6, userId: 'bb', action: 'ante', amount: 350, stage: 'preflop', dead: true },
      { seat: 7, userId: 'utg', action: 'fold', amount: 0, stage: 'preflop' },
    ],
    winners: [{ userId: 'bb', amount: 950, potIndex: 0 }],
  };

  const BOMB_ROW = {
    hand_number: 6704153,
    game_variant: 'nlh',
    small_blind: 0.25,
    big_blind: 0.5,
    pot_size: 3,
    button_seat: 2,
    bomb_pot: { variant: 'nlh', ante_amount: 1.5, board_count: 2 },
    community_cards: ['7spades', '2clubs', 'Jspades'],
    community_cards2: ['8spades', '6spades', 'Qdiamonds'],
    players: [
      { seat: 2, userId: 'a', username: 'FlopFox', stack: 126.02 },
      { seat: 3, userId: 'b', username: 'CheckMonk', stack: 73.91 },
    ],
    actions: [
      { seat: 2, userId: 'a', action: 'bomb_ante', amount: 1.5, stage: 'preflop', dead: true },
      { seat: 3, userId: 'b', action: 'bomb_ante', amount: 1.5, stage: 'preflop', dead: true },
      { seat: 3, userId: 'b', action: 'bet', amount: 3.91, stage: 'flop' },
      { seat: 2, userId: 'a', action: 'fold', amount: 0, stage: 'flop' },
      { seat: 3, userId: 'b', action: 'return', amount: 3.91, stage: 'flop' },
    ],
    winners: [{ userId: 'b', amount: 2.85, potIndex: 0 }],
  };

  const framesOf = (row: unknown) =>
    buildReplayFrames(buildReplay(replayInputFromRow(row as never, {})));

  it('an ante is in the pot and not in the seat, so nobody is priced off it', () => {
    const fr = framesOf(ANTE_ROW);
    const ante = fr.find((f) => f.row?.verb === 'ante')!;
    expect(ante.row!.dead).toBe(true);
    expect(ante.pot).toBe(950);
    // 400 in front of the big blind, not 750.
    expect(ante.committed[6]).toBe(400);
    const fold = fr.find((f) => f.row?.verb === 'fold')!;
    expect(facingAt(ante, fold)).toMatchObject({ seat: 7, toCall: 400 });
  });

  it('the ante travels from the seat to the pot, and it is heard', () => {
    const fr = framesOf(ANTE_ROW);
    const i = fr.findIndex((f) => f.row?.verb === 'ante');
    const m = frameMotion(fr[i - 1], fr[i], []);
    expect(m.deadIn).toBe(6);
    // It never becomes a bet pill in front of the seat.
    expect(m.chipsIn).toBeNull();
    expect(frameCue(fr[i - 1], fr[i])).toBe('chips');
  });

  it('a bomb pot posts antes and no blinds, and none are invented', () => {
    const model = buildReplay(replayInputFromRow(BOMB_ROW as never, {}));
    // Blind synthesis used to fire here (the log has no blind rows), adding an
    // SB and a BB nobody posted: 3.75 against a stored pot of 3.00.
    expect(model.rebuiltPot).toBe(3);
    expect(model.reconciles).toBe(true);
    const fr = buildReplayFrames(model);
    expect(fr.some((f) => f.row?.verb === 'sb' || f.row?.verb === 'bb')).toBe(false);
    expect(fr[fr.length - 1].pot).toBe(3);
  });

  it('a verb we have no word for still sounds when it moves chips', () => {
    const fr = framesOf(BOMB_ROW);
    const i = fr.findIndex((f) => f.row?.dead);
    // `bomb_ante` is not in the verb table, so it renders as itself...
    expect(fr[i].row!.verb).toBe('unknown');
    expect(fr[i].row!.label).toBe('Bomb Ante');
    // ...but 1.50 went into the middle, so the chip cue is owed.
    expect(frameCue(fr[i - 1], fr[i])).toBe('chips');
    expect(frameMotion(fr[i - 1], fr[i], []).deadIn).toBe(2);
  });
});

describe('the beat and the rate', () => {
  it('scales by the table Animation Speed and divides by the replay rate', () => {
    const action = frames[at('row-a-1')];
    const street = frames[at('street-flop')];
    expect(replayBeatMs(action, 1, 1)).toBe(ACTION_BEAT_MS);
    expect(replayBeatMs(street, 1, 1)).toBe(STREET_BEAT_MS);
    expect(replayBeatMs(action, 1, 2)).toBe(ACTION_BEAT_MS / 2);
    expect(replayBeatMs(action, 1, 0.5)).toBe(ACTION_BEAT_MS * 2);
    expect(replayBeatMs(action, 3, 1)).toBe(ACTION_BEAT_MS * 3);
    // The fastest pair is still a beat, never zero.
    expect(replayBeatMs(action, 0.25, 2)).toBeGreaterThanOrEqual(112);
    expect(replayBeatMs(action, 0, 2)).toBe(ACTION_BEAT_MS / 2);
  });

  it('the remembered rate survives the round trip and nonsense reads as normal', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(readReplayRate(storage)).toBe(1);
    writeReplayRate(storage, 2);
    expect(readReplayRate(storage)).toBe(2);
    store.set(REPLAY_RATE_KEY, '7');
    expect(readReplayRate(storage)).toBe(1);
    store.set(REPLAY_RATE_KEY, 'fast');
    expect(readReplayRate(storage)).toBe(1);
    expect(readReplayRate(null)).toBe(1);
    const throwing = {
      getItem: () => {
        throw new Error('private mode');
      },
      setItem: () => {
        throw new Error('private mode');
      },
    };
    expect(readReplayRate(throwing)).toBe(1);
    expect(() => writeReplayRate(throwing, 2)).not.toThrow();
  });
});

describe('street jumps and the preflop label', () => {
  it('one jump per street the hand reached, in order', () => {
    expect(streetJumps(frames).map((j) => [j.key, j.label, j.index])).toEqual([
      ['deal', 'Deal', 0],
      ['preflop', 'PreFlop', 1],
      ['flop', 'Flop', at('street-flop')],
      ['turn', 'Turn', at('street-turn')],
      ['river', 'River', at('street-river')],
      ['showdown', 'Showdown', at('row-show-h')],
    ]);
  });

  it('names a two-card holding, and stays quiet on a bigger one', () => {
    const c = (s: string) => ({ rank: s[0] as never, suit: s[1] as never });
    expect(preflopHoleLabel([c('9c'), c('9d')])).toBe('Pocket Nines');
    expect(preflopHoleLabel([c('Ah'), c('Kh')])).toBe('Ace King Suited');
    expect(preflopHoleLabel([c('Kd'), c('Ah')])).toBe('Ace King Offsuit');
    expect(preflopHoleLabel([c('Ah'), c('Kh'), c('2c'), c('3c')])).toBeNull();
    expect(preflopHoleLabel(null)).toBeNull();
  });
});

describe('the replayer', () => {
  async function open() {
    const { default: HandReplay } = await import('@/components/replay/HandReplay');
    render(<HandReplay handId="hand-1" />);
    await screen.findByText('Hand #1');
  }

  it('shows the dealer button, the street jumps, the speed control, and the viewer their own cards from the deal', async () => {
    await open();
    expect(screen.getByLabelText('Dealer Button, Seat 1')).toBeTruthy();
    expect(
      screen.getByRole('group', { name: 'Jump To Street' }).querySelectorAll('.hr-jump')
    ).toHaveLength(6);
    const rates = screen.getByRole('group', { name: 'Replay Speed' });
    expect(rates.querySelectorAll('.hr-rate')).toHaveLength(3);
    expect(screen.getByLabelText('Normal Speed').getAttribute('aria-pressed')).toBe('true');
    // Frame 0 is the deal: the hero's own cards are face-up and named, the villain's are backs.
    const hero = document.querySelector('.hr-seat.is-hero')!;
    expect(hero.querySelectorAll('.hr-private')).toHaveLength(2);
    expect(hero.querySelector('.hr-seat__made')?.textContent).toBe('Pocket Nines');
    expect(hero.querySelector('.hr-seat__private')?.textContent).toBe('Yours');
    expect(
      document.querySelectorAll(
        '.hr-seat:not(.is-hero) .card-back, .hr-seat:not(.is-hero) [class*="card-back"]'
      ).length
    ).toBeGreaterThan(0);
    // No cue on opening: nothing was stepped into.
    expect(Object.values(sound).some((fn) => fn.mock.calls.length > 0)).toBe(false);
  });

  it('stepping forward moves and sounds; jumping and scrubbing do neither', async () => {
    await open();
    const next = screen.getByLabelText('Next Step');
    fireEvent.click(next); // post sb
    expect(sound.playChips).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.hr-bet--in')).toBeTruthy();
    fireEvent.click(next); // post bb
    fireEvent.click(next); // fold
    expect(sound.playFold).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.hr-seat__cards--fold')).toBeTruthy();
    fireEvent.click(next); // raise
    expect(sound.playRaise).toHaveBeenCalledWith(6, 2);
    const facing = document.querySelector('.hr-facing')!;
    expect(facing.textContent).toContain('To Call 2.00');
    expect(facing.textContent).toContain('Pot Odds 40%');

    for (const fn of Object.values(sound)) fn.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Flop' }));
    expect(document.querySelector('.hand-replay__caption-street')?.textContent).toBe('Flop');
    expect(Object.values(sound).some((fn) => fn.mock.calls.length > 0)).toBe(false);
    expect(document.querySelector('.hr-bet--sweep')).toBeNull();
    expect(document.querySelector('.hr-bet--in')).toBeNull();
    // The hero's made hand follows the street.
    expect(document.querySelector('.hr-seat.is-hero .hr-seat__made')?.textContent).toBe(
      'Three Of A Kind'
    );

    fireEvent.click(screen.getByLabelText('Previous Step')); // back to the return row
    fireEvent.click(next); // step INTO the flop: the sweep plays
    expect(sound.playCommunityCard).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.hr-bet--sweep')).toHaveLength(3);

    fireEvent.change(screen.getByLabelText('Replay Position'), {
      target: { value: String(frames.length - 1) },
    });
    expect(document.querySelector('.hr-pot-fly')).toBeNull();
    expect(sound.playWin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Previous Step'));
    fireEvent.click(next); // step INTO the result
    expect(sound.playWin).toHaveBeenCalledTimes(1);
    expect(sound.playPotCollect).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.hr-pot-fly')).toHaveLength(1);
    expect(document.querySelector('.hr-seat__stack--grow')).toBeTruthy();
  });

  it('the rate is remembered per viewer and written onto the replay for the stylesheet', async () => {
    await open();
    fireEvent.click(screen.getByLabelText('Half Speed'));
    expect(window.localStorage.getItem(REPLAY_RATE_KEY)).toBe('0.5');
    expect(
      (document.querySelector('.hand-replay') as HTMLElement).style.getPropertyValue('--hr-rate')
    ).toBe('0.5');
    expect(screen.getByLabelText('Half Speed').getAttribute('aria-pressed')).toBe('true');
  });

  it('arriving where you already are is not a step: no repeat cue, no repeat award', async () => {
    await open();
    fireEvent.click(screen.getByLabelText('Last Step'));
    for (const fn of Object.values(sound)) fn.mockClear();
    const root = document.querySelector('.hand-replay')!;
    // ArrowRight is not disabled the way the Next button is; three presses on
    // the final frame used to play the win fanfare three times and fly the pot
    // to the winner three times, on a hand that had already ended.
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(sound.playWin).not.toHaveBeenCalled();
    expect(sound.playPotCollect).not.toHaveBeenCalled();
    expect(document.querySelector('.hr-pot-fly')).toBeNull();
    // The same at the other end.
    fireEvent.click(screen.getByLabelText('First Step'));
    for (const fn of Object.values(sound)) fn.mockClear();
    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    expect(Object.values(sound).some((fn) => fn.mock.calls.length > 0)).toBe(false);
    expect(document.querySelector('.hand-replay__scrub-label')?.textContent).toBe(
      `1 / ${frames.length}`
    );
  });

  it('leaving the Replay tab stops playback, so no felt plays out of sight', async () => {
    await open();
    fireEvent.click(screen.getByLabelText('Play'));
    fireEvent.click(screen.getByRole('tab', { name: 'Rundown' }));
    vi.useFakeTimers();
    try {
      for (const fn of Object.values(sound)) fn.mockClear();
      await act(async () => {
        vi.advanceTimersByTime(STREET_BEAT_MS * 6);
      });
      expect(Object.values(sound).some((fn) => fn.mock.calls.length > 0)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    // Coming back, the hand is where it was left, not over.
    fireEvent.click(screen.getByRole('tab', { name: 'Replay' }));
    expect(document.querySelector('.hand-replay__scrub-label')?.textContent).toBe(
      `1 / ${frames.length}`
    );
    expect(screen.getByLabelText('Play')).toBeTruthy();
  });

  it('playing steps frame by frame at the beat, and each step is a step', async () => {
    await open();
    // Fake timers only once the hand is on screen: the load itself awaits real promises.
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByLabelText('Play'));
      await act(async () => {
        vi.advanceTimersByTime(STREET_BEAT_MS + 5);
      });
      expect(sound.playChips).toHaveBeenCalledTimes(1);
      expect(document.querySelector('.hand-replay__scrub-label')?.textContent).toBe(
        `2 / ${frames.length}`
      );
      await act(async () => {
        vi.advanceTimersByTime(ACTION_BEAT_MS + 5);
      });
      expect(document.querySelector('.hand-replay__scrub-label')?.textContent).toBe(
        `3 / ${frames.length}`
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the law: motion scales, it is never switched off, and reduced motion keeps the meaning', () => {
  const css = readFileSync(
    resolve(__dirname, '../../src/components/replay/HandReplay.css'),
    'utf8'
  );
  const tsx = readFileSync(
    resolve(__dirname, '../../src/components/replay/HandReplay.tsx'),
    'utf8'
  );

  it('every replay duration derives from the Animation Speed and the replay rate', () => {
    expect(css).toContain('--hr-move: calc(var(--animation-speed, 1) / var(--hr-rate, 1))');
    const phase3 = css.slice(css.indexOf('THE REPLAYER MOVES'));
    const literal = phase3.match(/animation:[^;]*\b\d+ms\b(?![^;]*var\(--hr-move\))/g) ?? [];
    expect(literal, 'a replay animation with a literal duration ignores the speed setting').toEqual(
      []
    );
  });

  it('no toggle reaches the replay motion, and the rates are all motion', () => {
    expect(tsx).not.toMatch(/skip_animations|reduce_motion|disableAnimations/);
    expect(tsx).toContain('REPLAY_RATES.map');
    expect(css.slice(css.indexOf('THE REPLAYER MOVES'))).not.toMatch(/animation:\s*none/);
  });

  it('each movement ends on the frame that carries the meaning', () => {
    // The sweep and the award end gone (opacity 0); the fold ends gone and STAYS gone (forwards);
    // the chips end at the bet spot; the flip ends face-up.
    expect(css).toMatch(/hrChipSweep[\s\S]*?to\s*\{[^}]*opacity:\s*0/);
    expect(css).toMatch(/\.hr-seat__cards--fold > \*\s*\{[^}]*forwards/);
    expect(css).toMatch(/hrFlip[\s\S]*?to\s*\{[^}]*rotateY\(0deg\)/);
    expect(css).toMatch(/\.hr-bet--in\s*\{[^}]*both/);
  });
});
