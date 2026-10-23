import { channelHub } from '../hub/ChannelHub.js';
import { reportError } from '../services/errorReporter.js';

/** Called only after the hand owner proves exact atomic acceptance. */
export function publishSettledTournamentHand(
  tournamentId: string,
  tableId: string,
  handNumber: number
): void {
  try {
    channelHub.broadcastToTournament(tournamentId, {
      type: 'TOURNAMENT_EVENT',
      tournamentId,
      event: {
        type: 'standings_changed',
        payload: { tableId, handNumber },
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    // A presentation transport failure cannot turn an accepted hand into a
    // settlement failure. Rejoin reads recover the latest committed field.
    reportError(error, 'TournamentStandings.broadcast', { tournamentId, tableId, handNumber });
  }
}
