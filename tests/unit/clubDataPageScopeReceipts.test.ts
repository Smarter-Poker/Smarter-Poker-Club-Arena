import { describe, expect, it } from 'vitest';
import { isVerifiedGamePage, isVerifiedPlayerPage } from '../../src/pages/club/ClubDataPage';

const CLUB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CLUB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const START = '2026-09-22';
const END = '2026-10-05';
const GAME_CURSOR = { value: 10, time: 20, kind: 'CASH', id: 'game-1' };
const PLAYER_CURSOR = { value: 10, id: 'player-1' };

const expectedGame = {
  clubId: CLUB_ID,
  start: START,
  end: END,
  game: 'HOLDEM' as const,
  stakes: 'SMALL' as const,
  search: 'shark',
  sort: 'fee' as const,
  cursor: GAME_CURSOR,
  limit: 100,
};

const gamePage = {
  contract: 'ca_club_game_page.v2',
  contract_version: 2,
  club_id: CLUB_ID,
  requested_start: START,
  requested_end: END,
  requested_game: 'HOLDEM',
  requested_stakes: 'SMALL',
  requested_search: 'shark',
  requested_sort: 'fee',
  requested_cursor: GAME_CURSOR,
  requested_limit: 100,
  sort: 'fee',
  rows: [],
  next_cursor: null,
  has_more: false,
  filtered_count: 0,
  generated_at: '2026-10-05T12:00:00.000Z',
};

const expectedPlayer = {
  clubId: CLUB_ID,
  start: START,
  end: END,
  sort: 'losers' as const,
  search: 'river',
  cursor: PLAYER_CURSOR,
  limit: 100,
};

const playerPage = {
  contract: 'ca_club_player_page.v2',
  contract_version: 2,
  club_id: CLUB_ID,
  requested_start: START,
  requested_end: END,
  requested_sort: 'losers',
  requested_search: 'river',
  requested_cursor: PLAYER_CURSOR,
  requested_limit: 100,
  sort: 'losers',
  rows: [],
  next_cursor: null,
  has_more: false,
  filtered_count: 0,
  generated_at: '2026-10-05T12:00:00.000Z',
};

describe('Club Data cursor-page scope receipts', () => {
  it('accepts an exactly bound empty game page and refuses every wrong request dimension', () => {
    expect(isVerifiedGamePage(gamePage, expectedGame)).toBe(true);
    for (const mutation of [
      { club_id: OTHER_CLUB_ID },
      { requested_start: '2026-09-21' },
      { requested_end: '2026-10-04' },
      { requested_game: 'OMAHA' },
      { requested_stakes: 'HIGH' },
      { requested_search: 'other' },
      { requested_sort: 'hands' },
      { requested_cursor: { ...GAME_CURSOR, id: 'other-game' } },
      { requested_limit: 99 },
      { contract: 'ca_club_game_page.v1' },
    ]) {
      expect(isVerifiedGamePage({ ...gamePage, ...mutation }, expectedGame)).toBe(false);
    }
  });

  it('accepts an exactly bound empty player page and refuses club, range, search, sort and cursor drift', () => {
    expect(isVerifiedPlayerPage(playerPage, expectedPlayer)).toBe(true);
    for (const mutation of [
      { club_id: OTHER_CLUB_ID },
      { requested_start: '2026-09-21' },
      { requested_end: '2026-10-04' },
      { requested_search: null },
      { requested_sort: 'winners' },
      { requested_cursor: { ...PLAYER_CURSOR, id: 'other-player' } },
      { requested_limit: 200 },
      { contract_version: 1 },
    ]) {
      expect(isVerifiedPlayerPage({ ...playerPage, ...mutation }, expectedPlayer)).toBe(false);
    }
  });
});
