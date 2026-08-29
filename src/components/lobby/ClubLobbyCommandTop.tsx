import type { ReactNode } from 'react';
import './ClubLobbyCommandTop.css';

interface ClubLobbyCommandTopProps {
  welcome: ReactNode;
  controls: ReactNode;
  campaign: ReactNode;
}

/**
 * The approved three-area Club Arena command console.
 *
 * It deliberately stops before the game results. Desktop keeps the premium
 * joined-machine silhouette; mobile uses the same three full-width bars. The
 * existing result/table renderer remains outside this component.
 */
export function ClubLobbyCommandTop({ welcome, controls, campaign }: ClubLobbyCommandTopProps) {
  return (
    <section className="club-lobby-command-top" aria-label="Club Lobby Controls And Promotion">
      <img
        className="club-lobby-command-top__chassis"
        src="/assets/club-buttons/lobby/lobby-command-chassis-v2.png"
        alt=""
        aria-hidden="true"
      />
      <div className="club-lobby-command-top__welcome">{welcome}</div>
      <div className="club-lobby-command-top__controls">{controls}</div>
      <div className="club-lobby-command-top__campaign">{campaign}</div>
    </section>
  );
}

export default ClubLobbyCommandTop;
