import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  foldRevealed,
  hasCommittedSeatFold,
  nextFoldReveal,
  turnPassedSeat,
  type FoldRevealTracker,
} from '../../src/utils/committedSeatFold';

const snapshot = {
  table_id: 'table',
  hand_number: 12,
  stage: 'preflop',
  players: [{ seat: 2, user_id: 'player', is_folded: false }],
};
const folded = { ...snapshot, players: [{ ...snapshot.players[0], is_folded: true }] };
const hidden = (value: Record<string, unknown> | null) =>
  hasCommittedSeatFold(value, 'table', 12, 2, 'player');

describe('a player disappears only after their actual fold', () => {
  it('keeps a selected fold and an unaccepted optimistic action visible', () => {
    expect(hidden({ ...snapshot, pre_action: 'auto_fold', last_action: 'fold' })).toBe(false);
  });
  it('accepts the engine fold on the same preflop hand, including reconnect', () => {
    expect(hidden(folded)).toBe(true);
    expect(hidden(JSON.parse(JSON.stringify(folded)))).toBe(true);
  });
  it.each(['flop', 'turn', 'river', 'showdown', 'waiting'])(
    'keeps a committed fold hidden on %s',
    (stage) => {
      expect(hidden({ ...folded, stage })).toBe(true);
    }
  );
  it.each([
    null,
    { ...folded, table_id: 'another-table' },
    { ...folded, hand_number: 11 },
    { ...folded, players: [{ ...folded.players[0], user_id: 'replacement' }] },
    { ...folded, players: [{ ...folded.players[0], seat: 3 }] },
    { ...folded, players: [{ ...folded.players[0], is_folded: 'true' }] },
    { ...folded, players: [null] },
  ])('never hides a player from an unknown or different occupancy: %j', (value) => {
    expect(hidden(value)).toBe(false);
  });
  it('restores a legitimately seated player for the next hand', () => {
    expect(hasCommittedSeatFold({ ...snapshot, hand_number: 13 }, 'table', 13, 2, 'player')).toBe(
      false
    );
  });
  it('the maintained table supplies authoritative state to the real seat', () => {
    const source = readFileSync('src/pages/TablePage.tsx', 'utf8').replace(/\s+/g, ' ');
    expect(source).toMatch(
      /foldCommitted=\{ lightningRoom != null && hasCommittedSeatFold\(\s*engineSnapshot, tableId, tableState.handNumber, seatNumber, displayPlayer\?\.id\s*\) && foldRevealed\(foldReveal, seatNumber\) \}/
    );
    expect(source).toContain('nextFoldReveal( foldRevealRef.current,');
    const css = readFileSync('src/components/table/SeatSlot.css', 'utf8');
    const rule = css.slice(css.indexOf('.seat--fold-hidden >'));
    expect(rule).toContain('visibility: hidden');
    expect(rule).not.toMatch(/seat__wager-group|seat__cards/);
  });
});

/* Dan 2026-10-24, on a player report that avatars on Classic tables vanished
   and came back every hand: "NO PART OF THE LIGHTNING GAMES OR FUNCTIONALITY
   SHOULD BE TOUCHING THE CLASSIC GAMES." Hiding a folded player is a Lightning
   rule. A Classic table is normal poker: the folded player stays seated, with
   avatar and plate, for the whole hand. */
describe('a Classic table never hides a folded player', () => {
  const source = readFileSync('src/pages/TablePage.tsx', 'utf8').replace(/\s+/g, ' ');
  it('the seat is told a fold is committed only inside a Lightning room', () => {
    const prop = source.slice(source.indexOf('foldCommitted={'));
    expect(prop.slice(0, 60)).toContain('foldCommitted={ lightningRoom != null &&');
    expect(source.match(/foldCommitted=\{/g)?.length).toBe(1);
  });
  it('the fold reveal tracker does not run on a Classic table', () => {
    const memo = source.slice(source.indexOf('const foldReveal = useMemo('));
    expect(memo.slice(0, 200)).toMatch(
      /if \(!lightningRoom\) \{ foldRevealRef.current = null; return null; \}/
    );
    expect(memo).toMatch(
      /^const foldReveal = useMemo\([\s\S]*?\}, \[engineSnapshot, lightningRoom\]\);/
    );
  });
  it('the Lightning room flag is the pool-session lookup, which is null for every Classic table', () => {
    expect(source).toContain('const lightningRoom = useLightningPoolSession(tableId);');
  });
  it('the table asks whether its game is Lightning once, and stops for a Classic game', () => {
    expect(source).toMatch(
      /useLightningLobbyStates\(anchorLightningClusterIds, \{ settleClassic: true, \}\)/
    );
  });
});

/* Dan 2026-10-24: "IF THEY HIT THE FOLD BUTTON, DON'T REMOVE THEM UNTIL ITS
   THERE TURN TO FOLD". A Lightning fold is committed the instant it is
   pressed (#7896), so the table waits for the action to reach the seat. */
describe('a fold pressed early stays on the felt until the turn reaches the seat', () => {
  const frame = (actor: string | null, folded: number[], stage = 'preflop', hand = 40) => ({
    table_id: 'table',
    hand_number: hand,
    stage,
    current_player: actor,
    players: [1, 2, 3, 4, 5, 6].map((seat) => ({
      seat,
      user_id: `p${seat}`,
      is_folded: folded.includes(seat),
    })),
  });
  const run = (...frames: Array<Record<string, unknown>>) =>
    frames.reduce<FoldRevealTracker | null>((t, f) => nextFoldReveal(t, f), null);

  it('an early fold by seat 5 while seat 2 acts is kept until the turn passes seat 5', () => {
    let t = run(frame('p2', []), frame('p2', [5]));
    expect(foldRevealed(t, 5)).toBe(false);
    t = nextFoldReveal(t, frame('p3', [5]));
    expect(foldRevealed(t, 5)).toBe(false);
    t = nextFoldReveal(t, frame('p4', [5]));
    expect(foldRevealed(t, 5)).toBe(false);
    t = nextFoldReveal(t, frame('p6', [5]));
    expect(foldRevealed(t, 5)).toBe(true);
  });
  it('a fold on the player own turn is shown at once', () => {
    const t = run(frame('p3', []), frame('p4', [3]));
    expect(foldRevealed(t, 3)).toBe(true);
  });
  it('the turn wrapping past the seat reveals it', () => {
    let t = run(frame('p5', []), frame('p5', [2]));
    expect(foldRevealed(t, 2)).toBe(false);
    t = nextFoldReveal(t, frame('p6', [2]));
    expect(foldRevealed(t, 2)).toBe(false);
    t = nextFoldReveal(t, frame('p3', [2]));
    expect(foldRevealed(t, 2)).toBe(true);
  });
  it('a new street or the end of the hand reveals every pending fold', () => {
    const t = run(frame('p2', []), frame('p2', [5]));
    expect(foldRevealed(nextFoldReveal(t, frame('p1', [5], 'flop')), 5)).toBe(true);
    expect(foldRevealed(nextFoldReveal(t, frame(null, [5])), 5)).toBe(true);
  });
  it('a viewer arriving mid-hand shows the folds already made, and a new hand starts clean', () => {
    const t = run(frame('p2', [5]));
    expect(foldRevealed(t, 5)).toBe(true);
    const next = nextFoldReveal(
      run(frame('p2', []), frame('p2', [5])),
      frame('p1', [], 'preflop', 41)
    );
    expect(next?.pending).toEqual([]);
  });
  it('replaying the same snapshot changes nothing', () => {
    const t = run(frame('p2', []), frame('p2', [5]));
    expect(nextFoldReveal(t, frame('p2', [5]))).toEqual(t);
  });
  it('turn passage is upward with wrap', () => {
    expect(turnPassedSeat(2, 6, 5)).toBe(true);
    expect(turnPassedSeat(2, 4, 5)).toBe(false);
    expect(turnPassedSeat(5, 2, 1)).toBe(true);
    expect(turnPassedSeat(5, 2, 3)).toBe(false);
    expect(turnPassedSeat(3, 3, 5)).toBe(false);
    expect(turnPassedSeat(null, 3, 5)).toBe(true);
  });
  it('treats horses and humans alike', () => {
    const src = readFileSync('src/utils/committedSeatFold.ts', 'utf8');
    expect(src).not.toMatch(/is_horse|isHorse/);
  });
});
