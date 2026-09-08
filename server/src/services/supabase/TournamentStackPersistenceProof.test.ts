import { describe, expect, it } from 'vitest';
import { tournamentStackProofIsExact, type TournamentStackProof } from './tables.js';

const TOURNAMENT_ID = '00000000-0000-4000-8000-000000000001';
const PLAYER_A = '00000000-0000-4000-8000-000000000002';
const PLAYER_B = '00000000-0000-4000-8000-000000000003';

const exactProof = (): TournamentStackProof => ({
  tournament_id: TOURNAMENT_ID,
  tournament_players_synced: true,
  tournament_player_count: 2,
  tournament_player_user_ids: [PLAYER_A, PLAYER_B],
  tournament_player_chips: [
    { user_id: PLAYER_A, chips: 0 },
    { user_id: PLAYER_B, chips: 3000 },
  ],
});

describe('tournament hand persistence proof', () => {
  it('accepts only the canonical complete result for every dealt player', () => {
    expect(tournamentStackProofIsExact(exactProof(), TOURNAMENT_ID, [PLAYER_B, PLAYER_A])).toBe(
      true
    );
  });

  it.each([
    ['missing sync marker', { tournament_players_synced: undefined }],
    ['wrong tournament', { tournament_id: PLAYER_A }],
    ['wrong count', { tournament_player_count: 1 }],
    ['missing player list', { tournament_player_user_ids: [PLAYER_A] }],
    ['noncanonical player list', { tournament_player_user_ids: [PLAYER_B, PLAYER_A] }],
    [
      'noncanonical chip list',
      {
        tournament_player_chips: [
          { user_id: PLAYER_B, chips: 3000 },
          { user_id: PLAYER_A, chips: 0 },
        ],
      },
    ],
    [
      'fraction beyond cents',
      {
        tournament_player_chips: [
          { user_id: PLAYER_A, chips: 0 },
          { user_id: PLAYER_B, chips: 2999.999 },
        ],
      },
    ],
  ])('rejects %s', (_name, mutation) => {
    expect(
      tournamentStackProofIsExact({ ...exactProof(), ...mutation }, TOURNAMENT_ID, [
        PLAYER_A,
        PLAYER_B,
      ])
    ).toBe(false);
  });

  it('rejects duplicate input identities even if the receipt deduplicates them', () => {
    expect(tournamentStackProofIsExact(exactProof(), TOURNAMENT_ID, [PLAYER_A, PLAYER_A])).toBe(
      false
    );
  });
});
