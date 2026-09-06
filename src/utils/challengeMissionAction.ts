import type { ChallengeType } from '../services/DailyChallengeService';

export interface ChallengeMissionAction {
  label: string;
  path: string;
}

function unsupportedChallengeType(value: never): never {
  throw new Error(`Unsupported Challenge Type: ${String(value)}`);
}

const CASH_GAME_ACTION: ChallengeMissionAction = {
  label: 'Find A Table',
  path: '/',
};

/**
 * Every incomplete mission points at the canonical surface that can advance it.
 * Keep this exhaustive so a new challenge type cannot silently inherit a dead
 * or misleading CTA.
 */
export function getChallengeMissionAction(type: ChallengeType): ChallengeMissionAction {
  switch (type) {
    case 'tournaments_played':
      return { label: 'Open Tournaments', path: '/tournaments' };
    case 'friends_added':
      return { label: 'Find Friends', path: '/friends' };
    case 'hands_played':
    case 'hands_won':
    case 'showdowns':
    case 'showdowns_won':
    case 'hands_won_no_showdown':
    case 'big_pots':
    case 'strong_hands':
    case 'chips_won':
      return CASH_GAME_ACTION;
    default:
      // The service rejects unknown server rows before render. Throw here as a
      // final runtime boundary, while the `never` parameter makes adding a
      // declared challenge type without its destination a compile-time error.
      return unsupportedChallengeType(type);
  }
}
