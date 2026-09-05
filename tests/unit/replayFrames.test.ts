/**
 * REPLAY FRAMES (2026-09-04, Previous Hand second sweep)
 *
 * The animated replay used to build its own timeline from the raw action
 * list and got four things wrong: the blinds were dropped from the pot, a
 * raise-TO level was added on top of what the seat had already committed, the
 * board only advanced on a street with actions (an all-in froze it on the
 * flop), and the board was switched on the STEP index as if it were a street
 * index. The frames now come off the one model; these pin each of the four.
 */
import { describe, expect, it } from 'vitest';
import { buildReplay } from '../../src/utils/handReplay';
import { buildReplayFrames } from '../../src/utils/replayFrames';

const HERO = 'h';
const VIL = 'v';

/** Heads-up, button (hero) posts SB, raises to 6, villain calls; hero jams
 *  the flop for 94 more, villain calls; turn and river run out with no
 *  action; hero shows and takes it. */
const HAND = {
  handNumber: 9,
  playedAt: '2026-09-04T20:00:00.000Z',
  gameVariant: 'nlh',
  smallBlind: 1,
  bigBlind: 2,
  potSize: 200,
  rakeAmount: 0,
  bbjAmount: 0,
  buttonSeat: 1,
  board: ['7c', '2c', '9h', 'Kd', 'Tc'],
  players: [
    { seat: 1, userId: HERO, username: 'kingfish', stack: 200 },
    { seat: 2, userId: VIL, username: 'Emerson', stack: 0 },
  ],
  actions: [
    { seat: 1, userId: HERO, action: 'raise', amount: 6, stage: 'preflop' },
    { seat: 2, userId: VIL, action: 'call', amount: 4, stage: 'preflop' },
    { seat: 2, userId: VIL, action: 'check', amount: 0, stage: 'flop' },
    { seat: 1, userId: HERO, action: 'all_in', amount: 94, stage: 'flop' },
    { seat: 2, userId: VIL, action: 'call', amount: 94, stage: 'flop' },
  ],
  winners: [{ userId: HERO, amount: 200, potIndex: 0, hand: { name: 'Pair' } }],
  holeCards: { [HERO]: ['9c', '9d'] },
  showdown: [
    { user_id: HERO, seat: 1, mucked: false, reveal_order: 0, hand_name: 'Three Of A Kind' },
    { user_id: VIL, seat: 2, mucked: true, reveal_order: 1 },
  ],
};

const frames = buildReplayFrames(buildReplay(HAND as never));
const byKey = (k: string) => frames.find((f) => f.key === k)!;

describe('the replay frames come off the one model', () => {
  it('starts with the deal and ends with the showdown', () => {
    expect(frames[0].key).toBe('deal');
    expect(frames[0].board).toEqual([]);
    expect(frames[frames.length - 1].isShowdown).toBe(true);
    expect(frames[frames.length - 1].board).toHaveLength(5);
  });

  it('the blinds are in the pot before anyone acts', () => {
    const sb = frames.find((f) => f.row?.verb === 'sb')!;
    const bb = frames.find((f) => f.row?.verb === 'bb')!;
    expect(sb.pot).toBe(1);
    expect(bb.pot).toBe(3);
  });

  it('a raise-TO adds only what the seat had not yet committed', () => {
    const raise = frames.find((f) => f.row?.verb === 'raise' && f.activeSeat === 1)!;
    // Hero had 1 in (the small blind); raising TO 6 adds 5, not 6.
    expect(raise.row?.amount).toBe(5);
    expect(raise.committed[1]).toBe(6);
    expect(raise.pot).toBe(8);
  });

  it('the board belongs to the street, never to the step number', () => {
    for (const f of frames) {
      if (f.streetKey === 'preflop') expect(f.board).toHaveLength(0);
      if (f.streetKey === 'flop') expect(f.board).toHaveLength(3);
      if (f.streetKey === 'turn') expect(f.board).toHaveLength(4);
      if (f.streetKey === 'river') expect(f.board).toHaveLength(5);
    }
  });

  it('a street with no action still turns its card', () => {
    // After the flop all-in nobody acts on the turn or river; both still
    // appear as frames with their card, so the runout is watched, not skipped.
    expect(byKey('street-turn').board).toHaveLength(4);
    expect(byKey('street-river').board).toHaveLength(5);
  });

  it('a new street sweeps the bets into the pot and clears the seats', () => {
    const flop = byKey('street-flop');
    expect(flop.committed[1]).toBe(0);
    expect(flop.committed[2]).toBe(0);
    expect(flop.pot).toBe(12);
  });

  it('the pot on the last frame is the pot the model reports', () => {
    expect(frames[frames.length - 1].pot).toBe(200);
  });

  it('a shown hand is revealed only from its show row on', () => {
    const show = frames.find((f) => f.row?.verb === 'show')!;
    const before = frames[frames.indexOf(show) - 1];
    expect(before.revealed).not.toContain(1);
    expect(show.revealed).toContain(1);
    // The mucked seat is never revealed.
    expect(frames[frames.length - 1].revealed).not.toContain(2);
  });

  it('every frame has a caption a player can read', () => {
    for (const f of frames) expect(f.caption.length).toBeGreaterThan(0);
    expect(frames[frames.length - 1].caption).toContain('kingfish Takes Main 200.00');
  });
});
