/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SATELLITES TAB — the events that feed this tournament
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Everything that reads or maps a satellite row lives in `useSatellites`, which
 * this tab and Band 4 of the Detail tab now share. Before 2026-08-29 each had
 * its own copy of the fetch and a byte-identical copy of the mapper, so the
 * mapper's three dead column reads were shipped twice. That file carries the
 * full account; the short version is that every satellite card in production
 * showed a prize pool of zero, no speed badge, a hardcoded "regular" structure
 * and no late-registration countdown, and each card cost its own round trip.
 *
 * This file is now presentation only: states, and a list.
 */
import type { TournamentTabProps } from './types';
import TournamentLobbyCard from '../TournamentLobbyCard';
import { useSatellites } from './useSatellites';
import './SatellitesTab.css';

export default function SatellitesTab({ tournament, currentUserId }: TournamentTabProps) {
  const { cards, registration, loading, error, retry } = useSatellites(
    tournament?.id,
    currentUserId
  );

  if (loading) {
    return (
      <div className="tab-pane-content sat-state" role="status" aria-live="polite" aria-busy="true">
        Loading Satellites...
      </div>
    );
  }

  if (error) {
    return (
      /* role="alert" so the failure is announced, and a real retry so the tab
         is not a dead end -- the previous version set an error string and left
         the player with no way out but a page reload. */
      <div className="tab-pane-content sat-state sat-state--error" role="alert">
        <p className="sat-state__msg">{error}</p>
        <button type="button" className="sat-state__retry" onClick={retry}>
          Try Again
        </button>
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="tab-pane-content sat-state" role="status">
        No Upcoming Satellites Running For This Event.
      </div>
    );
  }

  return (
    <div className="tab-pane-content sat-list">
      {cards.map((sat) => (
        <TournamentLobbyCard
          key={sat.id}
          tournament={sat}
          /* `registration` is null when the batch query failed. Passing null
             makes the card fall back to its own lookup rather than render a
             live Register button at a player who is already in. */
          knownRegistration={registration ? Boolean(registration[sat.id]) : null}
        />
      ))}
    </div>
  );
}
