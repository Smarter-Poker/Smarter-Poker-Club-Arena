import type { ReactNode } from 'react';
import './ClubLobbyCommandTop.css';

interface ClubLobbyCommandTopProps {
  welcome: ReactNode;
  controls: ReactNode;
  campaign: ReactNode;
}

/**
 * The live content layer for the top three bays of the approved four-zone
 * lobby chassis. The full generated chassis is mounted by ClubHomePage so the
 * desktop ledger and bottom poker-chip rail remain part of the same machine.
 */
export function ClubLobbyCommandTop({ welcome, controls, campaign }: ClubLobbyCommandTopProps) {
  return (
    <section className="club-lobby-command-top" aria-label="Club Lobby Controls And Promotion">
      <div className="club-lobby-command-top__welcome">{welcome}</div>
      <div className="club-lobby-command-top__controls">{controls}</div>
      <div className="club-lobby-command-top__campaign">{campaign}</div>
    </section>
  );
}

export default ClubLobbyCommandTop;
