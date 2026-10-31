import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  movePlayerFollow,
  readPlayerFollow,
  writePlayerFollow,
} from '../src/utils/followTournamentPlayer';
const target = {
  tournamentId: 'aaaaaaaa-1111-2222-3333-444444444444',
  userId: 'bbbbbbbb-1111-2222-3333-444444444444',
  username: 'Player Four',
};
const source = { id: 'old', followPlayer: target, seated: false };
const played = { id: 'played', seated: true };
const destination = { id: 'new' };
describe('explicit player following', () => {
  it('replaces the observer in place without consuming another slot', () => {
    const result = movePlayerFollow([played, source], 1, 'old', target, destination, 2)!;
    expect(result.tabs).toEqual([played, { ...destination, followPlayer: target }]);
    expect(result.activeIndex).toBe(1);
  });
  it('keeps background moves in the background', () => {
    const result = movePlayerFollow([source, played], 1, 'old', target, destination, 2)!;
    expect(result.tabs[result.activeIndex]).toEqual(played);
  });
  it('deduplicates an already open destination and preserves active identity', () => {
    const result = movePlayerFollow(
      [source, played, destination],
      1,
      'old',
      target,
      destination,
      3
    )!;
    expect(result.tabs.map((t) => t.id)).toEqual(['played', 'new']);
    expect(result.tabs[result.activeIndex]).toEqual(played);
    expect(result.tabs[1].followPlayer).toEqual(target);
  });
  it('focuses the existing destination only when the followed source was active', () => {
    const result = movePlayerFollow(
      [source, played, destination],
      0,
      'old',
      target,
      destination,
      3
    )!;
    expect(result.tabs[result.activeIndex].id).toBe('new');
  });
  it('keeps a played source and adds an observer when capacity permits', () => {
    const result = movePlayerFollow(
      [{ ...source, seated: true }],
      0,
      'old',
      target,
      destination,
      2
    )!;
    expect(result.tabs[0]).toEqual({ ...source, seated: true, followPlayer: undefined });
    expect(result.tabs[result.activeIndex].id).toBe('new');
  });
  it('stops at capacity without dropping any played seat', () => {
    const result = movePlayerFollow(
      [{ ...source, seated: true }, played],
      0,
      'old',
      target,
      destination,
      2
    )!;
    expect(result.full).toBe(true);
    expect(result.tabs.map((t) => t.id)).toEqual(['old', 'played']);
    expect(result.tabs[0].followPlayer).toBeUndefined();
  });
  it('ignores duplicate moves, stopped follows and another target', () => {
    expect(movePlayerFollow([source], 0, 'old', target, source, 4)).toBeNull();
    expect(movePlayerFollow([{ id: 'old' }], 0, 'old', target, destination, 4)).toBeNull();
    expect(
      movePlayerFollow([source], 0, 'old', { ...target, userId: 'other' }, destination, 4)
    ).toBeNull();
  });
  it('carries explicit follow through refresh but ordinary table URLs never follow', () => {
    const params = new URLSearchParams();
    writePlayerFollow(params, target);
    expect(readPlayerFollow(params)).toEqual(target);
    expect(readPlayerFollow(new URLSearchParams())).toBeUndefined();
    params.set('followPlayer', 'not-a-user');
    expect(readPlayerFollow(params)).toBeUndefined();
  });
});

it('follows the maintained engine feed because the player table is not WAL-published', () => {
  const source = readFileSync('src/components/table/PlayerFollowSubscription.tsx', 'utf8');
  expect(source).toContain('subscribeTournamentStandings(target.tournamentId');
  expect(source).not.toContain("'postgres_changes'");
});
